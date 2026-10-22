import test from "node:test";
import assert from "node:assert/strict";
import { SnapshotStore, createSnapshotWorker } from "../worker/snapshot-handler.mjs";

const base = "https://estado.sinergius.coop.ar";
const revision = "a".repeat(40);
function snapshot(time = Date.now(), rev = revision) {
  return { revision: rev, status: {
    overall: "operational", checkedAt: new Date(time).toISOString(), message: "Operativo",
    components: ["status_page", "public_site", "meeting_api", "alternate_domain"].map(id =>
      ({ id, name: id, description: id, status: "operational" })),
    history: { startedAt: "2026-08-11", days: [] },
  }, incidents: { incidents: [] } };
}
function store() {
  let value;
  const storage = {
    async get() { return structuredClone(value); },
    async put(key, next) { value = structuredClone(next); },
    async transaction(fn) { return fn(storage); },
  };
  const object = new SnapshotStore({ storage }, {});
  const env = { STATUS_SNAPSHOT: { idFromName: name => name, get: () => object } };
  return { storage, object, env };
}
function publish(value) {
  return new Request(`${base}/data/publish`, { method: "POST",
    headers: { Authorization: "Bearer identity" }, body: JSON.stringify(value) });
}

test("publica los dos JSON atómicamente y los lee enseguida sin caché ni origen externo", async () => {
  const { env } = store();
  const handle = createSnapshotWorker({ verify: async token => token === "identity" });
  const value = snapshot();
  assert.equal((await handle(publish(value), env)).status, 200);
  for (const [path, expected] of [["snapshot", value], ["status", value.status], ["incidents", value.incidents]]) {
    const response = await handle(new Request(`${base}/data/${path}.json`), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-status-revision"), revision);
    assert.deepEqual(await response.json(), expected);
  }
  const next = snapshot(Date.now() + 1000, "b".repeat(40));
  assert.equal((await handle(publish(next), env)).status, 200);
  assert.deepEqual(await (await handle(new Request(`${base}/data/snapshot.json`), env)).json(), next);
});

test("rechaza retrocesos y cambios en una medición ya publicada, permite reintentos idénticos", async () => {
  const { object } = store();
  const value = snapshot();
  assert.equal((await object.fetch(publish(value))).status, 200);
  assert.equal((await object.fetch(publish(value))).status, 200);
  assert.equal((await object.fetch(publish(snapshot(Date.parse(value.status.checkedAt) - 1000)))).status, 409);
  assert.equal((await object.fetch(publish({ ...value, revision: "c".repeat(40) }))).status, 409);
  assert.equal((await object.fetch(publish({ ...value, status: { ...value.status, overall: "unknown" } }))).status, 409);
});

test("no permite escritura anónima, otros métodos, rutas ni snapshots inválidos", async () => {
  const { env } = store();
  const denied = createSnapshotWorker({ verify: async () => false });
  assert.equal((await denied(publish(snapshot()), env)).status, 401);
  assert.equal((await denied(new Request(`${base}/data/publish`, { method: "POST" }), env)).status, 401);
  assert.equal((await denied(new Request(`${base}/data/status.json`, { method: "PUT" }), env)).status, 405);
  assert.equal((await denied(new Request(`${base}/data/private.json`), env)).status, 404);
  const handle = createSnapshotWorker({ verify: async () => true });
  assert.equal((await handle(publish({}), env)).status, 400);
  assert.equal((await handle(publish({ ...snapshot(), privateToken: "never publish" }), env)).status, 400);
  const extra = snapshot(); extra.status.components[0].privateToken = "never publish";
  assert.equal((await handle(publish(extra), env)).status, 400);
  assert.equal((await handle(publish(snapshot(Date.now() - 3 * 60 * 60 * 1000)), env)).status, 400);
  assert.equal((await handle(publish({ ...snapshot(), incidents: { incidents: [{ id: "invalid" }] } }), env)).status, 400);
});

test("HEAD no tiene cuerpo y un almacén vencido o inaccesible falla cerrado", async () => {
  const { env, object, storage } = store();
  const handle = createSnapshotWorker({ verify: async () => true, logger: { warn() {} } });
  await object.fetch(publish(snapshot()));
  const head = await handle(new Request(`${base}/data/status.json`, { method: "HEAD" }), env);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  await storage.put("snapshot", snapshot(Date.now() - 3 * 60 * 60 * 1000));
  assert.equal((await handle(new Request(`${base}/data/status.json`), env)).status, 503);
  const broken = { STATUS_SNAPSHOT: { idFromName() { throw new Error("secret detail"); } } };
  const response = await handle(new Request(`${base}/data/status.json`), broken);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "status_unavailable" });
});
