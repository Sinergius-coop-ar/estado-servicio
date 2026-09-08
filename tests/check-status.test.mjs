import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  applyMeasurement,
  checkTarget,
  dayStatusFromCounts,
  hasNetworkAccess,
  overallFromResults,
  TARGETS,
  updateDailyHistory,
  updateIncidentsDocument,
  updateStatusDocument,
} from "../scripts/check-status.mjs";

const baseStatus = {
  overall: "operational",
  checkedAt: "2026-07-29T20:00:00.000Z",
  message: "Todo bien.",
  components: [
    { id: "status_page", name: "Estado", description: "", status: "operational" },
    { id: "public_site", name: "Sitio", description: "", status: "operational" },
    { id: "meeting_api", name: "Reuniones", description: "", status: "operational" },
    { id: "alternate_domain", name: "Dominio alternativo", description: "", status: "operational" },
  ],
};

test("controla únicamente superficies públicas de Sinergius", () => {
  assert.deepEqual(
    TARGETS.map((target) => target.id),
    ["status_page", "public_site", "meeting_api", "alternate_domain"],
  );
  assert.deepEqual(
    new Set(TARGETS.map((target) => new URL(target.url).hostname)),
    new Set(["estado.sinergius.coop.ar", "sinergius.coop.ar", "sinergius.com.ar"]),
  );
  assert.ok(
    TARGETS.every((target) => new URL(target.url).hostname !== "app.sanezeit.com"),
  );
  assert.deepEqual(TARGETS[0].additionalChecks, [{
    url: "https://estado.sinergius.coop.ar/data/status.json",
    acceptedStatuses: [200],
    expectedText: '"checkedAt"',
  }]);
});

test("la página de estado requiere que carguen la web y los datos frescos", async () => {
  let calls = 0;
  const result = await checkTarget(TARGETS[0], async (url) => {
    calls += 1;
    return new Response(
      url.endsWith("status.json") ? '{"checkedAt":"2026-08-18T01:00:00.000Z"}' : "Estado de los servicios",
      { status: url.endsWith("status.json") ? 503 : 200 },
    );
  }, async () => {});

  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 503);
  assert.equal(calls, 6);
});

test("el control usa cabeceras compatibles con el perímetro de Cloudflare", async () => {
  let capturedOptions;
  const target = TARGETS.find(({ id }) => id === "public_site");
  const result = await checkTarget(target, async (_url, options) => {
    capturedOptions = options;
    return new Response("Sinergius", { status: 200 });
  }, async () => {});

  assert.equal(result.ok, true);
  assert.match(capturedOptions.headers["User-Agent"], /^Mozilla\/5\.0/);
  assert.match(capturedOptions.headers["User-Agent"], /Chrome\//);
  assert.match(capturedOptions.headers.Accept, /text\/html/);
  assert.equal(capturedOptions.headers["Accept-Language"], "es-AR,es;q=0.9,en;q=0.7");
});

test("el control SMTP requiere un token fuera del repositorio", () => {
  const meeting = TARGETS.find(({ id }) => id === "meeting_api");
  assert.equal(meeting.requiredEnv, "MEETING_HEALTH_TOKEN");
  assert.equal(JSON.stringify(meeting).includes("Bearer"), false);
});

test("clasifica el estado general según los controles", () => {
  assert.equal(
    overallFromResults([
      { id: "public_site", ok: true },
      { id: "meeting_api", ok: true },
      { id: "alternate_domain", ok: true },
      { id: "status_page", ok: true },
    ]),
    "operational",
  );
  assert.equal(
    overallFromResults([
      { id: "public_site", ok: true },
      { id: "meeting_api", ok: false },
      { id: "alternate_domain", ok: true },
      { id: "status_page", ok: true },
    ]),
    "partial_outage",
  );
  assert.equal(
    overallFromResults([
      { id: "public_site", ok: false },
      { id: "meeting_api", ok: false },
      { id: "alternate_domain", ok: false },
      { id: "status_page", ok: false },
    ]),
    "major_outage",
  );
});

test("actualiza componentes sin publicar diagnósticos internos", () => {
  const next = updateStatusDocument(
    baseStatus,
    [
      { id: "public_site", ok: true, httpStatus: 200 },
      { id: "meeting_api", ok: false, httpStatus: 503 },
      { id: "alternate_domain", ok: true, httpStatus: 200 },
    ],
    "2026-07-29T21:00:00.000Z",
  );

  assert.equal(next.overall, "partial_outage");
  assert.equal(next.components.find(({ id }) => id === "public_site").status, "operational");
  assert.equal(next.components.find(({ id }) => id === "meeting_api").status, "major_outage");
  assert.equal(next.components.find(({ id }) => id === "alternate_domain").status, "operational");
  assert.equal(JSON.stringify(next).includes("503"), false);
});

test("renueva la hora en cada control aunque todo siga operativo", () => {
  const checkedAt = "2026-07-29T20:15:00.000Z";
  const next = updateStatusDocument(
    baseStatus,
    [
      { id: "public_site", ok: true, httpStatus: 200 },
      { id: "meeting_api", ok: true, httpStatus: 405 },
      { id: "alternate_domain", ok: true, httpStatus: 200 },
    ],
    checkedAt,
  );

  assert.equal(next.overall, "operational");
  assert.equal(next.checkedAt, checkedAt);
  assert.notEqual(next.checkedAt, baseStatus.checkedAt);
});

test("abre y resuelve un incidente automático", () => {
  const startedAt = "2026-07-29T21:00:00.000Z";
  const opened = updateIncidentsDocument(
    { incidents: [] },
    "operational",
    "major_outage",
    startedAt,
  );

  assert.equal(opened.incidents.length, 1);
  assert.equal(opened.incidents[0].resolvedAt, null);

  const resolvedAt = "2026-07-29T21:10:00.000Z";
  const resolved = updateIncidentsDocument(
    opened,
    "major_outage",
    "operational",
    resolvedAt,
  );

  assert.equal(resolved.incidents[0].resolvedAt, resolvedAt);
  assert.match(resolved.incidents[0].message, /restablecido/i);
});

test("conserva un único incidente durante controles fallidos consecutivos", () => {
  const firstCheck = "2026-07-29T21:00:00.000Z";
  const secondCheck = "2026-07-29T21:15:00.000Z";
  const opened = updateIncidentsDocument(
    { incidents: [] },
    "operational",
    "partial_outage",
    firstCheck,
    "2026-07-29T20:45:00.000Z",
  );
  const continued = updateIncidentsDocument(
    opened,
    "partial_outage",
    "partial_outage",
    secondCheck,
  );

  assert.equal(continued.incidents.length, 1);
  assert.equal(continued.incidents[0].id, opened.incidents[0].id);
  assert.equal(continued.incidents[0].startedAt, firstCheck);
  assert.equal(continued.incidents[0].resolvedAt, null);
});

test("el workflow persiste el estado sin abrir main ni repetir un despliegue Pages", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/check-status.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /refs\/heads\/status-data:refs\/remotes\/origin\/status-data/);
  assert.match(workflow, /concurrency:\s*\n\s*group: service-status-check\s*\n\s*cancel-in-progress: false/);
  assert.match(workflow, /\.persistRequired \/\/ false/);
  assert.match(workflow, /ref: status-data/);
  assert.match(workflow, /git add -- data\/status\.json data\/incidents\.json/);
  assert.match(workflow, /git push origin HEAD:status-data/);
  assert.equal(workflow.match(/git push/g)?.length, 1);
  assert.doesNotMatch(workflow, /git push(?:\s+origin)?(?:\s+HEAD)?:?main/);

  assert.doesNotMatch(workflow, /upload-pages-artifact|deploy-pages|github-pages/);
  assert.match(workflow, /test "\$\(find "\$\{RUNNER_TEMP\}\/monitor-state" -type f \| wc -l\)" -eq 2/);
  assert.match(workflow, /\$2 != "data\/incidents\.json" && \$2 != "data\/status\.json"/);
  assert.match(workflow, /git diff --quiet -- data\/status\.json data\/incidents\.json/);
});

test("registra disponibilidad diaria sin inventar días anteriores", () => {
  const history = updateDailyHistory(
    undefined,
    {
      overall: "operational",
      components: baseStatus.components,
    },
    "2026-07-29T23:00:00.000Z",
  );

  assert.equal(history.startedAt, "2026-07-29");
  assert.equal(history.days.length, 1);
  assert.equal(history.days[0].checks, 1);
  assert.equal(history.days[0].failed.public_site, 0);
  assert.equal(history.days[0].overall, "operational");
});

test("acumula los controles del día en lugar de quedarse con el peor", () => {
  const caido = baseStatus.components.map((component) => ({
    ...component,
    status: "major_outage",
  }));
  let history = updateDailyHistory(
    undefined,
    { overall: "major_outage", components: caido },
    "2026-07-29T01:00:00.000Z",
  );

  for (let i = 0; i < 19; i += 1) {
    history = updateDailyHistory(
      history,
      { overall: "operational", components: baseStatus.components },
      `2026-07-29T${String(2 + i).padStart(2, "0")}:00:00.000Z`,
    );
  }

  assert.equal(history.days.length, 1);
  assert.equal(history.days[0].checks, 20);
  assert.equal(history.days[0].failed.public_site, 1);
  // Un control fallido de veinte no puede publicarse como caída total.
  assert.equal(history.days[0].overall, "degraded");
});

test("marca caída total el día en que la mayoría de los controles falla", () => {
  const caido = baseStatus.components.map((component) => ({
    ...component,
    status: "major_outage",
  }));
  let history = updateDailyHistory(
    undefined,
    { overall: "operational", components: baseStatus.components },
    "2026-07-29T01:00:00.000Z",
  );

  for (let i = 0; i < 9; i += 1) {
    history = updateDailyHistory(
      history,
      { overall: "major_outage", components: caido },
      `2026-07-29T${String(2 + i).padStart(2, "0")}:00:00.000Z`,
    );
  }

  assert.equal(history.days[0].checks, 10);
  assert.equal(history.days[0].failed.public_site, 9);
  assert.equal(history.days[0].overall, "major_outage");
});

test("cuenta controles fallidos aunque fallen componentes distintos", () => {
  let history;
  for (let index = 0; index < 3; index += 1) {
    const components = baseStatus.components.map((component, componentIndex) => ({
      ...component,
      status: componentIndex === index ? "major_outage" : "operational",
    }));
    history = updateDailyHistory(
      history,
      { overall: "partial_outage", components },
      `2026-07-29T0${index + 1}:00:00.000Z`,
    );
  }

  assert.equal(history.days[0].failedChecks, 3);
  assert.equal(history.days[0].overall, "major_outage");
});

test("tres corridas persistidas suman tres controles y conservan un incidente", () => {
  const failedResults = baseStatus.components.map(({ id }) => ({
    id,
    ok: id !== "meeting_api",
  }));
  let status = { ...baseStatus, history: { startedAt: "2026-07-29", days: [] } };
  let incidents = { incidents: [] };

  for (const checkedAt of [
    "2026-07-29T20:15:00.000Z",
    "2026-07-29T20:30:00.000Z",
    "2026-07-29T20:45:00.000Z",
  ]) {
    ({ nextStatus: status, nextIncidents: incidents } = applyMeasurement(
      status,
      incidents,
      failedResults,
      checkedAt,
    ));
  }

  assert.equal(status.history.days[0].checks, 3);
  assert.equal(status.history.days[0].failedChecks, 3);
  assert.equal(status.history.days[0].failed.meeting_api, 3);
  assert.equal(incidents.incidents.length, 1);
  assert.equal(incidents.incidents[0].startedAt, "2026-07-29T20:15:00.000Z");
  assert.equal(incidents.incidents[0].resolvedAt, null);

  const healthyResults = baseStatus.components.map(({ id }) => ({ id, ok: true }));
  ({ nextStatus: status, nextIncidents: incidents } = applyMeasurement(
    status,
    incidents,
    healthyResults,
    "2026-07-29T21:00:00.000Z",
  ));

  assert.equal(status.history.days[0].checks, 4);
  assert.equal(status.overall, "operational");
  assert.equal(incidents.incidents.length, 1);
  assert.equal(incidents.incidents[0].resolvedAt, "2026-07-29T21:00:00.000Z");
});

test("rechaza respuestas mayores al límite sin leerlas completas", async () => {
  const result = await checkTarget(
    { id: "grande", url: "https://example.test", acceptedStatuses: [200], expectedText: "ok" },
    async () => ({
      status: 200,
      headers: { get: () => String(300 * 1024) },
      text: async () => "ok",
    }),
    async () => {},
  );
  assert.equal(result.ok, false);
});

test("clasifica el día según la proporción de controles fallidos", () => {
  assert.equal(dayStatusFromCounts(30, 0), "operational");
  assert.equal(dayStatusFromCounts(30, 1), "degraded");
  assert.equal(dayStatusFromCounts(30, 12), "partial_outage");
  assert.equal(dayStatusFromCounts(30, 25), "major_outage");
  assert.equal(dayStatusFromCounts(0, 0), "operational");
});

test("no da por buena una caída si el control se quedó sin internet", async () => {
  const sinRed = async () => {
    throw new Error("getaddrinfo EAI_AGAIN");
  };

  assert.equal(await hasNetworkAccess(sinRed), false);
});

test("confirma que hay red cuando responde al menos un destino externo", async () => {
  let llamadas = 0;
  const mitad = async () => {
    llamadas += 1;
    if (llamadas === 1) {
      throw new Error("timeout");
    }
    return { ok: true, status: 200 };
  };

  assert.equal(await hasNetworkAccess(mitad), true);
});

test("anota entre qué controles se detectó el incidente", () => {
  const abierto = updateIncidentsDocument(
    { incidents: [] },
    "operational",
    "major_outage",
    "2026-07-29T04:00:00.000Z",
    "2026-07-29T01:00:00.000Z",
  );

  assert.equal(abierto.incidents[0].lastHealthyAt, "2026-07-29T01:00:00.000Z");
  assert.equal(abierto.incidents[0].startedAt, "2026-07-29T04:00:00.000Z");
});

test("valida código y contenido con un fetch reemplazable", async () => {
  const target = {
    id: "web",
    url: "https://example.test",
    acceptedStatuses: [200],
    expectedText: "<html",
  };
  const result = await checkTarget(target, async () => ({
    status: 200,
    text: async () => "<!doctype html><html></html>",
  }));

  assert.deepEqual(result, { id: "web", ok: true, httpStatus: 200 });
});
