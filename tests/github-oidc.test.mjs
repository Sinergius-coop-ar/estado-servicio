import test from "node:test";
import assert from "node:assert/strict";
import { createGithubOidcVerifier, PUBLISH_URL } from "../worker/github-oidc.mjs";

const now = Date.now();
const seconds = Math.floor(now / 1000);
const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "test", alg: "RS256", use: "sig" };
const claims = { iss: "https://token.actions.githubusercontent.com", aud: PUBLISH_URL,
  repository: "Sinergius-coop-ar/estado-servicio", repository_id: "1316630269", repository_owner_id: "315786944",
  ref: "refs/heads/main", ref_type: "branch", event_name: "workflow_dispatch", runner_environment: "github-hosted",
  workflow_ref: "Sinergius-coop-ar/estado-servicio/.github/workflows/check-status.yml@refs/heads/main",
  workflow_sha: "a".repeat(40), iat: seconds, nbf: seconds - 1, exp: seconds + 300 };
async function token(overrides = {}, header = {}) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", kid: "test", ...header })}.${encode({ ...claims, ...overrides })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(unsigned));
  return `${unsigned}.${Buffer.from(signature).toString("base64url")}`;
}

test("sólo acepta identidad firmada del repo, rama, workflow y audiencia autorizados", async () => {
  let fetches = 0;
  const verify = createGithubOidcVerifier({ now: () => now, fetchImpl: async url => {
    assert.equal(url, "https://token.actions.githubusercontent.com/.well-known/jwks");
    fetches++;
    return new Response(JSON.stringify({ keys: [jwk] }));
  } });
  assert.equal(await verify(await token()), true);
  assert.equal(await verify(await token({ event_name: "schedule" })), true);
  for (const override of [
    { repository_id: "1" }, { repository_owner_id: "2" }, { repository: "attacker/repo" },
    { ref: "refs/heads/attack" }, { workflow_ref: "other-workflow" }, { aud: "wrong" },
    { event_name: "pull_request" }, { exp: seconds - 1 }, { iat: seconds - 1000 },
    { nbf: seconds + 60 }, { runner_environment: "self-hosted" },
  ]) assert.equal(await verify(await token(override)), false);
  assert.equal(await verify(await token({}, { alg: "HS256" })), false);
  const genuine = await token();
  const parts = genuine.split(".");
  parts[1] = Buffer.from(JSON.stringify({ ...claims, exp: seconds + 301 })).toString("base64url");
  assert.equal(await verify(parts.join(".")), false);
  assert.equal(await verify("not-a-token"), false);
  assert.equal(fetches, 1);
});

test("un kid inventado no fuerza una petición JWKS por intento", async () => {
  let fetches = 0;
  const verify = createGithubOidcVerifier({ now: () => now, fetchImpl: async () => {
    fetches++; return new Response(JSON.stringify({ keys: [jwk] }));
  } });
  for (let i = 0; i < 3; i++) assert.equal(await verify(await token({}, { kid: `unknown-${i}` })), false);
  assert.equal(fetches, 1);
});
