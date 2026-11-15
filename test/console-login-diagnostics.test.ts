import assert from "node:assert/strict";
import test from "node:test";
import { createApp, RemoteDesktopService, configFromEnv } from "../src/index.js";
import { GoogleOidcClient, GoogleOidcError, type OAuthState } from "../src/public-auth.js";

test("console callback logs distinct failures without credentials, and still rejects when audit storage fails", async () => {
  const secret = "DO-NOT-LOG-CREDENTIAL";
  const identity = { iss: "https://accounts.google.com", sub: secret, email: `${secret}@example.test` };
  const state: OAuthState = { version: 1, epoch: 1, allowedSubjects: [identity], refreshes: [], families: {} };
  const cfg = configFromEnv({ BASE_URL: "https://example.test", TOKEN_SECRET: "x".repeat(40), REMOTE_AUTH_MODE: "google", GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: secret, FILE_ROOTS_JSON: '[{"id":"files","path":"reference"}]' });
  let exchangeError: Error | undefined;
  let approvalFails = false;
  cfg.publicAuthOptions = {
    store: { load: async () => { if (approvalFails) throw new Error(secret); return structuredClone(state); }, save: async () => undefined },
    verifier: { authorizationUrl: ({ state }) => `https://accounts.google.com/?state=${state}`, exchangeCode: async () => { if (exchangeError) throw exchangeError; return identity; } },
  };
  const service = new RemoteDesktopService(cfg);
  const logs: Array<Record<string, unknown>> = [];
  let auditFails = false;
  service.audit = async (event, fields) => { if (auditFails) throw new Error(secret); logs.push({ event, ...fields }); };
  const server = createApp(service).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const begin = async () => {
    const response = await fetch(`${base}/user/login`, { method: "POST", headers: { origin: cfg.baseUrl }, redirect: "manual" });
    assert.equal(response.status, 303);
    return { state: new URL(response.headers.get("location")!).searchParams.get("state")!, binding: /rdmcp_user_google_binding=([^;,]+)/.exec(response.headers.get("set-cookie")!)![1]! };
  };
  const callback = async (flow: { state: string; binding?: string }, extra = `code=${secret}`) => fetch(`${base}/google/callback?state=${flow.state}&${extra}`, { headers: flow.binding ? { cookie: `rdmcp_user_google_binding=${flow.binding}` } : {}, redirect: "manual" });
  const rejected = async (flow: { state: string; binding?: string }, reason: string, extra?: string) => {
    const before = logs.length;
    const response = await callback(flow, extra);
    assert.equal(response.status, 403);
    assert.equal(await response.text(), "ログインできません。");
    assert.equal(logs.length, before + 1);
    assert.equal(logs.at(-1)?.reason, reason);
    assert.match(String(logs.at(-1)?.diagnosticId), /^[A-Za-z0-9_-]{43}$/);
  };
  try {
    await rejected({ state: `user_${secret}`, binding: secret }, "flow_missing");
    const flow = await begin();
    await rejected({ state: flow.state }, "binding_cookie_missing");
    await rejected({ ...flow, binding: secret }, "binding_cookie_mismatch");
    await rejected(flow, "google_error", `error=${secret}`);
    await rejected(flow, "code_missing", "");
    const clock = Date.now;
    try { const now = clock(); Date.now = () => now + 301_000; await rejected(flow, "flow_expired"); }
    finally { Date.now = clock; }
    for (const reason of ["google_token_exchange_failed", "google_signing_keys_failed", "google_id_token_invalid"] as const) {
      exchangeError = new GoogleOidcError(reason, new Error(secret));
      await rejected(await begin(), reason);
    }
    exchangeError = new Error(secret);
    await rejected(await begin(), "google_exchange_failed");
    exchangeError = undefined;
    state.allowedSubjects = [];
    await rejected(await begin(), "identity_not_allowed");
    state.allowedSubjects = [identity]; approvalFails = true;
    await rejected(await begin(), "approval_check_failed");
    approvalFails = false;
    const success = await begin(); const before = logs.length;
    assert.equal((await callback(success)).status, 303);
    assert.equal(logs.length, before, "successful login does not emit a failure");
    await rejected(success, "flow_missing");
    const fallback: string[] = []; const original = console.error;
    try {
      auditFails = true; console.error = (line: string) => { fallback.push(line); };
      const response = await callback({ state: `user_${secret}`, binding: secret });
      assert.equal(response.status, 403);
      assert.equal(fallback.length, 1);
      const event = JSON.parse(fallback[0]!);
      assert.equal(event.event, "user.login_failed"); assert.equal(event.reason, "flow_missing"); assert.equal(event.audit_write_failed, true);
      assert.doesNotMatch(fallback[0]!, new RegExp(secret));
    } finally { console.error = original; }
    const serialized = JSON.stringify(logs);
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.doesNotMatch(serialized, new RegExp(flow.state));
    assert.doesNotMatch(serialized, new RegExp(flow.binding));
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("real Google client classifies token exchange, signing key fetch and token validation failures", async () => {
  const input = { code: "private-code", state: "private-state", nonce: "private-nonce", redirectUri: "https://example.test/google/callback" };
  const failsWith = (reason: string) => (error: unknown) => error instanceof GoogleOidcError && error.reason === reason;
  const tokenFailure = new GoogleOidcClient("client", "secret", async () => { throw new Error("private-fetch-error"); });
  await assert.rejects(tokenFailure.exchangeCode(input), failsWith("google_token_exchange_failed"));
  for (const [keys, reason] of [[new Response("denied", { status: 503 }), "google_signing_keys_failed"], [Response.json({ keys: [] }), "google_id_token_invalid"]] as const) {
    const oidc = new GoogleOidcClient("client", "secret", async (url) => String(url).includes("/token") ? Response.json({ id_token: "invalid-token" }) : keys);
    await assert.rejects(oidc.exchangeCode(input), failsWith(reason));
  }
});
