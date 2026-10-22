import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ENDPOINT = "https://estado.sinergius.coop.ar/data/publish";

export async function publishStatus({ env = process.env, fetchImpl = fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const revision = env.STATUS_DATA_REVISION;
  if (!/^[a-f0-9]{40}$/.test(revision ?? "") || !env.STATUS_DATA_DIR ||
      !env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error("Missing publication configuration");
  }
  const [status, incidents] = await Promise.all(["status.json", "incidents.json"].map(async filename =>
    JSON.parse(await readFile(join(env.STATUS_DATA_DIR, filename), "utf8"))));
  const body = JSON.stringify({ revision, status, incidents });
  if (Buffer.byteLength(body) > 256 * 1024) throw new Error("Snapshot exceeds size limit");
  const tokenUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  tokenUrl.searchParams.set("audience", ENDPOINT);
  const identity = await fetchImpl(tokenUrl, {
    headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  if (!identity.ok) throw new Error("Unable to obtain publication identity");
  const { value: token } = await identity.json();
  if (typeof token !== "string" || token.length > 16_384) throw new Error("Invalid publication identity");

  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const response = await fetchImpl(ENDPOINT, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body,
      });
      if (!response.ok) throw new Error("Publication was rejected");
      const result = await response.json();
      if (result.revision !== revision) throw new Error("Publication acknowledgment mismatch");
      // A successful write must be immediately visible through the public path.
      const live = await fetchImpl("https://estado.sinergius.coop.ar/data/snapshot.json", {
        cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      if (!live.ok || JSON.stringify(await live.json()) !== body) throw new Error("Public snapshot mismatch");
      return { published: true, revision, checkedAt: status.checkedAt };
    } catch {
      if (attempt === 5) throw new Error("Publication or immediate public verification failed");
      await sleep(10_000);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await publishStatus())); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
