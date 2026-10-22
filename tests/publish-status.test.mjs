import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishStatus } from "../scripts/publish-status.mjs";

test("publica con OIDC y comprueba la misma versión por la URL pública; reintenta un ACK perdido", async () => {
  const dir = await mkdtemp(join(tmpdir(), "status-publish-"));
  try {
    const snapshot = { revision: "a".repeat(40), status: { checkedAt: new Date().toISOString() }, incidents: { incidents: [] } };
    await writeFile(join(dir, "status.json"), JSON.stringify(snapshot.status));
    await writeFile(join(dir, "incidents.json"), JSON.stringify(snapshot.incidents));
    let writes = 0;
    const result = await publishStatus({ env: {
      STATUS_DATA_DIR: dir, STATUS_DATA_REVISION: snapshot.revision,
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.test/token?api-version=2",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-secret",
    }, sleep: async () => {}, fetchImpl: async (url, options) => {
      if (String(url).startsWith("https://actions.test")) {
        assert.equal(new URL(url).searchParams.get("audience"), "https://estado.sinergius.coop.ar/data/publish");
        assert.equal(options.headers.Authorization, "Bearer request-secret");
        return Response.json({ value: "temporary-identity" });
      }
      if (String(url).endsWith("/data/publish")) {
        assert.equal(options.headers.Authorization, "Bearer temporary-identity");
        assert.deepEqual(JSON.parse(options.body), snapshot);
        if (++writes === 1) throw new Error("Lost ACK");
        return Response.json({ revision: snapshot.revision });
      }
      assert.equal(url, "https://estado.sinergius.coop.ar/data/snapshot.json");
      assert.equal(options.cache, "no-store");
      return Response.json(snapshot);
    } });
    assert.equal(writes, 2);
    assert.deepEqual(result, { published: true, revision: snapshot.revision, checkedAt: snapshot.status.checkedAt });
    assert.equal(JSON.stringify(result).includes("identity"), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
