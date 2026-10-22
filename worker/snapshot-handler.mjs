import {
  createStatusDataProxy, jsonResponse, readLimitedBody, validatePublicDocuments,
} from "./status-data-proxy.mjs";
import { createGithubOidcVerifier } from "./github-oidc.mjs";

const FILES = new Map([
  ["/data/status.json", "status"],
  ["/data/incidents.json", "incidents"],
  ["/data/snapshot.json", null],
]);

function reply(document, status = 200, method = "GET", headers = {}) {
  return jsonResponse(`${JSON.stringify(document)}\n`, status, method, headers);
}

function validSnapshot(value, now) {
  return value !== null && typeof value === "object" &&
    /^[a-f0-9]{40}$/.test(value.revision ?? "") &&
    Object.keys(value).every(key => ["revision", "status", "incidents"].includes(key)) &&
    validatePublicDocuments(value.status, value.incidents, now);
}

// One named object stores both public documents in a single atomic value.
// Durable Object storage survives deploys and provides consistent reads.
export class SnapshotStore {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/data/publish") {
      let next;
      try { next = JSON.parse(await readLimitedBody(request)); }
      catch { return reply({ error: "invalid_snapshot" }, 400); }
      if (!validSnapshot(next, Date.now())) return reply({ error: "invalid_snapshot" }, 400);
      const result = await this.ctx.storage.transaction(async txn => {
        const current = await txn.get("snapshot");
        if (current) {
          const delta = Date.parse(next.status.checkedAt) - Date.parse(current.status.checkedAt);
          if (delta < 0 || (delta === 0 && JSON.stringify(next) !== JSON.stringify(current))) return false;
          if (delta === 0) return true; // retry after a lost acknowledgment
        }
        await txn.put("snapshot", next);
        return true;
      });
      return result
        ? reply({ published: true, revision: next.revision, checkedAt: next.status.checkedAt })
        : reply({ error: "older_snapshot" }, 409);
    }

    const key = FILES.get(path);
    if (!FILES.has(path) || !["GET", "HEAD"].includes(request.method)) return reply({ error: "not_found" }, 404);
    const snapshot = await this.ctx.storage.get("snapshot");
    if (!snapshot) {
      // Only an empty store can bootstrap. An unavailable or stale initialized
      // store must never silently fall back to an earlier green status.
      const bootstrap = createStatusDataProxy({ revision: this.env.BOOTSTRAP_DATA_REVISION });
      if (key !== null) return bootstrap(request);
      const responses = await Promise.all([
        bootstrap(new Request("https://estado.sinergius.coop.ar/data/status.json")),
        bootstrap(new Request("https://estado.sinergius.coop.ar/data/incidents.json")),
      ]);
      if (responses.some(response => response.status !== 200)) return reply({ error: "status_unavailable" }, 503, request.method);
      return reply({ revision: this.env.BOOTSTRAP_DATA_REVISION,
        status: await responses[0].json(), incidents: await responses[1].json() }, 200, request.method,
      { "X-Status-Revision": this.env.BOOTSTRAP_DATA_REVISION });
    }
    if (!validSnapshot(snapshot, Date.now())) return reply({ error: "status_unavailable" }, 503, request.method);
    return reply(key === null ? snapshot : snapshot[key], 200, request.method,
      { "X-Status-Revision": snapshot.revision });
  }
}

export function createSnapshotWorker({ verify = createGithubOidcVerifier(), logger = console } = {}) {
  return async function handle(request, env) {
    const path = new URL(request.url).pathname;
    const publish = path === "/data/publish" && request.method === "POST";
    if (!publish && !FILES.has(path)) return reply({ error: "not_found" }, 404, request.method);
    if (!publish && !["GET", "HEAD"].includes(request.method)) return reply({ error: "method_not_allowed" }, 405, request.method);
    try {
      if (publish) {
        const authorization = request.headers.get("Authorization") ?? "";
        if (!authorization.startsWith("Bearer ") || !await verify(authorization.slice(7))) {
          return reply({ error: "unauthorized" }, 401);
        }
      }
      const id = env.STATUS_SNAPSHOT.idFromName("public-status-v1");
      return await env.STATUS_SNAPSHOT.get(id).fetch(request);
    } catch {
      logger.warn?.("status_snapshot_unavailable", { operation: publish ? "publish" : "read" });
      return reply({ error: "status_unavailable" }, 503, request.method);
    }
  };
}

