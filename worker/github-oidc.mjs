import { readLimitedBody } from "./status-data-proxy.mjs";

export const PUBLISH_URL = "https://estado.sinergius.coop.ar/data/publish";
const ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_URL = `${ISSUER}/.well-known/jwks`;
const REPOSITORY = "Sinergius-coop-ar/estado-servicio";
const WORKFLOW = `${REPOSITORY}/.github/workflows/check-status.yml@refs/heads/main`;

function decode(segment) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error("invalid_jwt");
  return Uint8Array.from(atob(segment.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
}

export function createGithubOidcVerifier({ fetchImpl = fetch, now = Date.now } = {}) {
  let cachedKeys = [];
  let fetchedAt = -Infinity;

  return async function verify(token) {
    let header, claims, signature, parts;
    try {
      if (typeof token !== "string" || token.length > 16_384) return false;
      parts = token.split(".");
      if (parts.length !== 3) return false;
      header = JSON.parse(new TextDecoder().decode(decode(parts[0])));
      claims = JSON.parse(new TextDecoder().decode(decode(parts[1])));
      signature = decode(parts[2]);
    } catch { return false; }

    const seconds = Math.floor(now() / 1000);
    if (
      header?.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length > 200 ||
      claims?.iss !== ISSUER || claims.aud !== PUBLISH_URL ||
      claims.repository !== REPOSITORY || claims.repository_id !== "1316630269" ||
      claims.repository_owner_id !== "315786944" ||
      claims.ref !== "refs/heads/main" || claims.ref_type !== "branch" ||
      claims.workflow_ref !== WORKFLOW ||
      !["schedule", "workflow_dispatch"].includes(claims.event_name) ||
      claims.runner_environment !== "github-hosted" ||
      !/^[a-f0-9]{40}$/.test(claims.workflow_sha ?? "") ||
      ![claims.exp, claims.iat, claims.nbf].every(Number.isFinite) ||
      claims.exp <= seconds || claims.nbf > seconds + 30 || claims.iat > seconds + 30 ||
      claims.exp - claims.iat > 600 || claims.iat < seconds - 600
    ) return false;

    // Cache GitHub's signing keys, not status data. Rate-limit unknown-kid
    // refreshes so fabricated tokens cannot cause one network request each.
    let jwk = cachedKeys.find(key => key.kid === header.kid);
    if (now() - fetchedAt >= 3_600_000 || (!jwk && now() - fetchedAt >= 60_000)) {
      const response = await fetchImpl(JWKS_URL, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(6_000),
      });
      if (response.status !== 200 || response.redirected) throw new Error("oidc_unavailable");
      const document = JSON.parse(await readLimitedBody(response));
      if (!Array.isArray(document.keys) || document.keys.length > 20) throw new Error("oidc_unavailable");
      cachedKeys = document.keys;
      fetchedAt = now();
      jwk = cachedKeys.find(key => key.kid === header.kid);
    }
    if (!jwk || jwk.kty !== "RSA" || jwk.alg !== "RS256" || jwk.use !== "sig") return false;
    try {
      const key = await crypto.subtle.importKey("jwk", jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature,
        new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    } catch { return false; }
  };
}
