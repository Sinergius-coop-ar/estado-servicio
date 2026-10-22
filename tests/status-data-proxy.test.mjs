import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createStatusDataProxy as createProxy } from "../worker/status-data-proxy.mjs";

const REVISION = "a".repeat(40);
function createStatusDataProxy(options) { return createProxy({ revision: REVISION, ...options }); }

const NOW = Date.parse("2026-08-18T01:00:00.000Z");

const validStatus = {
  overall: "operational",
  checkedAt: "2026-08-18T00:45:00.000Z",
  message: "Todo operativo.",
  components: [
    { id: "status_page", name: "Estado", description: "Página", status: "operational" },
    { id: "public_site", name: "Sitio", description: "Web", status: "operational" },
    { id: "meeting_api", name: "Reuniones", description: "Canal", status: "operational" },
    { id: "alternate_domain", name: "Alternativo", description: "Dominio", status: "operational" },
  ],
  history: { startedAt: "2026-08-11", days: [] },
};

function upstream(document, init = {}) {
  return new Response(JSON.stringify(document), {
    status: 200,
    headers: { "Content-Type": "application/json", ...init.headers },
    ...init,
  });
}

test("sirve sólo los dos JSON públicos desde la rama de datos", async () => {
  const calls = [];
  const handle = createStatusDataProxy({
    now: () => NOW,
    fetchImpl: async (...args) => {
      calls.push(args);
      return upstream(validStatus);
    },
  });

  const response = await handle(new Request("https://estado.sinergius.coop.ar/data/status.json?x=1"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).checkedAt, validStatus.checkedAt);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], `https://raw.githubusercontent.com/Sinergius-coop-ar/estado-servicio/${REVISION}/data/status.json`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-status-revision"), REVISION);
  assert.deepEqual(calls[0][1].headers, { Accept: "application/json" });
  assert.equal(Object.hasOwn(calls[0][1], "cache"), false);
  assert.equal(Object.hasOwn(calls[0][1], "credentials"), false);
  assert.equal(Object.hasOwn(calls[0][1], "redirect"), false);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");

  const missing = await handle(new Request("https://estado.sinergius.coop.ar/CNAME"));
  assert.equal(missing.status, 404);
  assert.equal(calls.length, 1);
});

test("rechaza métodos con escritura y HEAD no devuelve cuerpo", async () => {
  let calls = 0;
  const handle = createStatusDataProxy({
    now: () => NOW,
    fetchImpl: async () => {
      calls += 1;
      return upstream(validStatus);
    },
  });

  const post = await handle(new Request("https://estado.sinergius.coop.ar/data/status.json", { method: "POST" }));
  assert.equal(post.status, 405);
  assert.equal(calls, 0);

  const head = await handle(new Request("https://estado.sinergius.coop.ar/data/status.json", { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("falla cerrado ante datos viejos, futuros, incompletos o demasiado grandes", async () => {
  const cases = [
    { ...validStatus, checkedAt: "2026-08-17T22:00:00.000Z" },
    { ...validStatus, checkedAt: "2026-08-18T01:06:00.000Z" },
    { ...validStatus, components: validStatus.components.slice(1) },
  ];

  for (const document of cases) {
    const handle = createStatusDataProxy({ now: () => NOW, fetchImpl: async () => upstream(document) });
    const response = await handle(new Request("https://estado.sinergius.coop.ar/data/status.json"));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }

  const huge = createStatusDataProxy({
    now: () => NOW,
    fetchImpl: async () => upstream(validStatus, { headers: { "Content-Length": String(300 * 1024) } }),
  });
  assert.equal((await huge(new Request("https://estado.sinergius.coop.ar/data/status.json"))).status, 503);
});

test("valida incidentes y oculta fallos del origen", async () => {
  const validIncidents = {
    incidents: [{
      id: "automatic-1",
      title: "Interrupción",
      message: "Restablecido.",
      lastHealthyAt: "2026-08-18T00:00:00.000Z",
      startedAt: "2026-08-18T00:15:00.000Z",
      resolvedAt: null,
    }],
  };
  const good = createStatusDataProxy({ now: () => NOW, fetchImpl: async () => upstream(validIncidents) });
  assert.equal((await good(new Request("https://estado.sinergius.coop.ar/data/incidents.json"))).status, 200);

  const warnings = [];
  const redirect = createStatusDataProxy({
    now: () => NOW,
    logger: { warn: (...args) => warnings.push(args) },
    fetchImpl: async () => new Response(null, { status: 302, headers: { Location: "https://example.test" } }),
  });
  const failed = await redirect(new Request("https://estado.sinergius.coop.ar/data/incidents.json"));
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "status_unavailable" });
  assert.deepEqual(warnings, [[
    "status_data_proxy_failure",
    { file: "incidents.json", reason: "upstream_status" },
  ]]);
});

test("rechaza una respuesta que fue redirigida", async () => {
  const warnings = [];
  const response = upstream(validStatus);
  Object.defineProperty(response, "redirected", { value: true });
  const handle = createStatusDataProxy({
    now: () => NOW,
    logger: { warn: (...args) => warnings.push(args) },
    fetchImpl: async () => response,
  });

  assert.equal((await handle(new Request("https://estado.sinergius.coop.ar/data/status.json"))).status, 503);
  assert.deepEqual(warnings, [[
    "status_data_proxy_failure",
    { file: "status.json", reason: "upstream_redirect" },
  ]]);
});

test("la telemetría no expone mensajes de errores inesperados", async () => {
  const warnings = [];
  const handle = createStatusDataProxy({
    now: () => NOW,
    logger: { warn: (...args) => warnings.push(args) },
    fetchImpl: async () => {
      throw new Error("token-super-secreto");
    },
  });

  const failed = await handle(new Request("https://estado.sinergius.coop.ar/data/status.json"));
  assert.equal(failed.status, 503);
  assert.deepEqual(warnings, [[
    "status_data_proxy_failure",
    { file: "status.json", reason: "unknown" },
  ]]);
  assert.equal(JSON.stringify(warnings).includes("token-super-secreto"), false);
});

test("el workflow persiste los JSON pero no intenta redesplegar el mismo SHA", async () => {
  const workflow = await readFile(new URL("../.github/workflows/check-status.yml", import.meta.url), "utf8");
  const wrangler = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");

  assert.doesNotMatch(workflow, /upload-pages-artifact|deploy-pages|github-pages/);
  assert.match(workflow, /git push origin HEAD:status-data/);
  assert.match(wrangler, /estado\.sinergius\.coop\.ar\/data\/\*/);
  assert.match(wrangler, /workers_dev\s*=\s*false/);
});
