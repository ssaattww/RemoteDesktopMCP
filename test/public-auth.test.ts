import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import {
  CHATGPT_CLIENT_ID,
  CHATGPT_REDIRECT_URI,
  GoogleOidcClient,
  PublicAuthService,
  type GoogleIdentity,
  type OAuthState,
  type OAuthStateStore,
  type OidcVerifier,
} from "../src/public-auth.js";
import { configFromEnv, createApp, RemoteDesktopService } from "../src/index.js";
import { fixture } from "./fixture.js";

const baseUrl = "https://remote.example.test";
const resource = `${baseUrl}/mcp`;
const clientId = CHATGPT_CLIENT_ID;
const verifier = "v".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const subject: GoogleIdentity = { iss: "https://accounts.google.com", sub: "allowed-subject", email: "owner@example.test" };

async function runCli(cwd: string, args: string[]) {
  const workspace = path.resolve(process.cwd());
  await mkdir(cwd, { recursive: true });
  const loader = pathToFileURL(path.join(workspace, "node_modules", "tsx", "dist", "loader.mjs")).href;
  const cli = path.join(workspace, "src", "remote-auth-cli.ts").replaceAll(path.sep, "/");
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", loader, cli, ...args], { cwd, windowsHide: true });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject).once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function json(value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json", ...headers } });
}

function memoryStore(initial?: OAuthState): OAuthStateStore {
  let state = initial;
  return {
    async load() {
      return state ?? { version: 1, epoch: 1, allowedSubjects: [], refreshes: [], families: {} };
    },
    async save(next) {
      state = structuredClone(next);
    },
  };
}

function publicAuth(options: { verifier?: OidcVerifier; store?: OAuthStateStore; now?: () => number; request?: typeof fetch } = {}) {
  const oidc: OidcVerifier = options.verifier ?? {
    authorizationUrl(input) {
      return `https://accounts.google.com/mock?state=${encodeURIComponent(input.state)}&nonce=${encodeURIComponent(input.nonce)}`;
    },
    async exchangeCode(input) {
      assert.equal(input.code, "google-code");
      return subject;
    },
  };
  return new PublicAuthService({ baseUrl, tokenSecret: "test-secret-that-is-long-enough", dataDir: "unused", googleClientId: "google-client", googleClientSecret: "not-a-real-secret", googleRedirectUri: `${baseUrl}/google/callback` }, {
    store: options.store ?? memoryStore(), verifier: oidc, now: options.now,
    request: options.request ?? (async (input) => {
      assert.equal(String(input), CHATGPT_CLIENT_ID, "only the fixed CIMD URL is requested during initialization");
      return json({ client_id: CHATGPT_CLIENT_ID, redirect_uris: [CHATGPT_REDIRECT_URI], token_endpoint_auth_methods_supported: ["none"] });
    }),
  });
}

async function authorizedCode(auth: PublicAuthService) {
  const begun = await auth.begin({ clientId, redirectUri: CHATGPT_REDIRECT_URI, resource, state: "chatgpt-state", challenge });
  const googleState = new URL(begun.redirect).searchParams.get("state");
  assert.ok(googleState);
  const callback = await auth.googleCallback({ state: googleState, code: "google-code", cookie: begun.cookie });
  assert.ok(callback.transaction);
  const consent = auth.consent({ transaction: callback.transaction, cookie: begun.cookie, allow: true });
  assert.ok(consent.redirect);
  return new URL(consent.redirect).searchParams.get("code") ?? "";
}

test("RA-03: Google ID token verifies its RSA signature and bound claims", async () => {
  const now = Date.now();
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "fixture-key";
  const sign = async (claims: Record<string, unknown> = {}) => {
    const { iss = "https://accounts.google.com", aud = "google-client", iat = Math.floor(now / 1000), exp = Math.floor(now / 1000) + 60, ...payload } = claims;
    return new SignJWT({ nonce: "expected-nonce", sub: "google-subject", ...payload })
    .setProtectedHeader({ alg: "RS256", kid: "fixture-key" })
    .setIssuer(String(iss))
    .setAudience(Array.isArray(aud) ? aud.map(String) : String(aud))
    .setIssuedAt(Number(iat))
    .setExpirationTime(Number(exp))
    .sign(privateKey);
  };
  let requested = 0;
  const oidc = new GoogleOidcClient("google-client", "not-a-real-secret", async (input, init) => {
    requested += 1;
    assert.equal(String(input), "https://www.googleapis.com/oauth2/v3/certs");
    assert.equal(init?.redirect, "error");
    return json({ keys: [jwk] });
  }, () => now);
  const valid = await sign();
  assert.deepEqual(await oidc.verifyIdToken(valid, "expected-nonce"), { iss: "https://accounts.google.com", sub: "google-subject" });
  const [header, payload, signature] = valid.split(".");
  const alteredSignature = Buffer.from(signature, "base64url");
  alteredSignature[0] ^= 1;
  await assert.rejects(oidc.verifyIdToken(`${header}.${payload}.${alteredSignature.toString("base64url")}`, "expected-nonce"), /signature|verification/i);
  await assert.rejects(oidc.verifyIdToken(await sign({ iss: "https://attacker.example.test" }), "expected-nonce"), /issuer|claim/i);
  await assert.rejects(oidc.verifyIdToken(await sign({ aud: "other-client" }), "expected-nonce"), /audience|claim/i);
  await assert.rejects(oidc.verifyIdToken(await sign({ aud: ["google-client", "other-client"] }), "expected-nonce"), /client/i);
  await assert.rejects(oidc.verifyIdToken(await sign({ nonce: "wrong" }), "expected-nonce"), /claim/i);
  await assert.rejects(oidc.verifyIdToken(await sign({ exp: Math.floor(now / 1000) - 60 }), "expected-nonce"), /exp|expired|claim/i);
  await assert.rejects(oidc.verifyIdToken(await sign({ iat: Math.floor(now / 1000) + 60 }), "expected-nonce"), /claim/i);
  assert.equal(requested, 1, "JWKS is cached only after a bounded fixed-URL fetch");
});

test("RA-10: Google fetch rejects an oversized identity response and forbids redirects", async () => {
  let received: RequestInit | undefined;
  const oidc = new GoogleOidcClient("google-client", "not-a-real-secret", async (_input, init) => {
    received = init;
    return json({ id_token: "ignored" }, { "content-length": "65537" });
  });
  await assert.rejects(oidc.exchangeCode({ code: "google-code", redirectUri: `${baseUrl}/google/callback`, state: "state", nonce: "nonce" }), /too large/i);
  assert.equal(received?.redirect, "error");
  assert.ok(received?.signal, "outbound identity requests have a timeout signal");
});

test("RA-02: CIMD metadata uses only the fixed URL and revalidates after its bounded lifetime", async () => {
  let now = 1_700_000_000_000;
  let requests = 0;
  const auth = publicAuth({ now: () => now, request: async (input, init) => {
    requests += 1;
    assert.equal(String(input), CHATGPT_CLIENT_ID);
    assert.equal(init?.redirect, "error");
    return json({ client_id: CHATGPT_CLIENT_ID, redirect_uris: [CHATGPT_REDIRECT_URI], token_endpoint_auth_methods_supported: ["none"] }, { "cache-control": "max-age=1" });
  } });
  await auth.initialize();
  await auth.begin({ clientId, redirectUri: CHATGPT_REDIRECT_URI, resource, challenge });
  assert.equal(requests, 1, "the bounded cache avoids an unnecessary immediate fetch");
  now += 60_000;
  await auth.begin({ clientId, redirectUri: CHATGPT_REDIRECT_URI, resource, challenge });
  assert.equal(requests, 2, "CIMD is revalidated after the minimum permitted lifetime");
});

test("RA-04 and RA-05: Google callback requires cookie and state, then binds the one-time code", async () => {
  const auth = publicAuth();
  await auth.initialize();
  await auth.addAllowedSubject(subject);
  const begun = await auth.begin({ clientId, redirectUri: CHATGPT_REDIRECT_URI, resource, state: "chatgpt-state", challenge });
  const googleState = new URL(begun.redirect).searchParams.get("state") ?? "";
  assert.deepEqual(await auth.googleCallback({ state: googleState, code: "google-code" }), { error: "The sign-in session was invalid." });
  assert.deepEqual(await auth.googleCallback({ state: "forged-state", code: "google-code", cookie: begun.cookie }), { error: "The sign-in session was invalid." });
  const callback = await auth.googleCallback({ state: googleState, code: "google-code", cookie: begun.cookie });
  assert.ok(callback.transaction);
  const replay = await auth.googleCallback({ state: googleState, code: "google-code", cookie: begun.cookie });
  assert.match(replay.error ?? "", /invalid|used/i, "a Google callback state is one use");
  const denied = auth.consent({ transaction: callback.transaction, cookie: "forged-cookie", allow: true });
  assert.deepEqual(denied, { error: "The authorization request was invalid." });
});

test("RA-05 through RA-08: PKCE/client/resource bindings, refresh replay revocation, and restart persistence", async () => {
  const store = memoryStore();
  const first = publicAuth({ store });
  await first.initialize();
  await first.addAllowedSubject(subject);
  const code = await authorizedCode(first);
  const invalid = await first.token({ grantType: "authorization_code", code, verifier, clientId, redirectUri: CHATGPT_REDIRECT_URI, resource: `${resource}/other` });
  assert.deepEqual(invalid, { error: "invalid_grant" });
  const freshCode = await authorizedCode(first);
  const issued = await first.token({ grantType: "authorization_code", code: freshCode, verifier, clientId, redirectUri: CHATGPT_REDIRECT_URI, resource });
  assert.ok("access_token" in issued && "refresh_token" in issued);
  if (!("access_token" in issued && "refresh_token" in issued)) throw new Error("token was not issued");
  assert.equal(await first.authenticate(`Bearer ${issued.access_token}`), `google:${subject.iss}:${subject.sub}`);
  const second = publicAuth({ store });
  await second.initialize();
  const rotated = await second.token({ grantType: "refresh_token", refreshToken: issued.refresh_token, clientId, resource });
  assert.ok("access_token" in rotated && "refresh_token" in rotated);
  const replay = await second.token({ grantType: "refresh_token", refreshToken: issued.refresh_token, clientId, resource });
  assert.deepEqual(replay, { error: "invalid_grant" });
  assert.equal(await second.authenticate(`Bearer ${issued.access_token}`), undefined, "family replay revokes the original access token");
  if ("access_token" in rotated) assert.equal(await second.authenticate(`Bearer ${rotated.access_token}`), undefined, "family replay revokes the rotated access token too");
});

test("RA-03 and RA-09: an unapproved subject cannot bootstrap access", async () => {
  const auth = publicAuth({ verifier: { authorizationUrl: (input) => `https://accounts.google.com/mock?state=${encodeURIComponent(input.state)}`, async exchangeCode() { return { iss: subject.iss, sub: "unapproved" }; } } });
  await auth.initialize();
  const begun = await auth.begin({ clientId, redirectUri: CHATGPT_REDIRECT_URI, resource, challenge });
  const googleState = new URL(begun.redirect).searchParams.get("state") ?? "";
  assert.equal((await auth.googleCallback({ state: googleState, code: "google-code", cookie: begun.cookie })).redirect?.includes("error=access_denied"), true);
  assert.equal(auth.hasAllowedSubject(), false);
});

test("RA-01, RA-02, RA-04, and RA-06: loopback HTTP flow reaches actual protected MCP tools", async () => {
  const f = await fixture();
  let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;
  let client: Client | undefined;
  let publicService: RemoteDesktopService | undefined;
  try {
    await f.service.close();
    publicService = new RemoteDesktopService({
      ...f.service.cfg, baseUrl, users: [], authMode: "google",
      publicAuth: { baseUrl, tokenSecret: "test-secret-that-is-long-enough", dataDir: f.data, googleClientId: "google-client", googleClientSecret: "not-a-real-secret", googleRedirectUri: `${baseUrl}/google/callback` },
      publicAuthOptions: {
        store: memoryStore({ version: 1, epoch: 1, allowedSubjects: [subject], refreshes: [], families: {} }),
        verifier: {
          authorizationUrl(input) { return `https://accounts.google.com/mock?state=${encodeURIComponent(input.state)}&nonce=${encodeURIComponent(input.nonce)}`; },
          async exchangeCode(input) { assert.equal(input.code, "google-code"); return subject; },
        },
        request: async (input) => {
          assert.equal(String(input), CHATGPT_CLIENT_ID);
          return json({ client_id: CHATGPT_CLIENT_ID, redirect_uris: [CHATGPT_REDIRECT_URI], token_endpoint_auth_methods_supported: ["none"] });
        },
      },
    });
    await publicService.initialize();
    const app = createApp(publicService);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const local = `http://127.0.0.1:${address.port}`;
    const metadata = await fetch(`${local}/.well-known/oauth-authorization-server`, { headers: { host: "attacker.example.test", forwarded: "host=attacker.example.test" } });
    const metadataBody = await metadata.json() as { issuer: string; client_id_metadata_document_supported: boolean; grant_types_supported: string[] };
    assert.equal(metadataBody.issuer, baseUrl, "metadata identity is configured, not derived from request headers");
    assert.equal(metadataBody.client_id_metadata_document_supported, true);
    assert.deepEqual(metadataBody.grant_types_supported, ["authorization_code", "refresh_token"]);
    const unauthenticated = await fetch(`${local}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers.get("www-authenticate"), `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`);
    const denied = await fetch(`${local}/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent("https://chatgpt.com/not-the-callback")}&response_type=code&scope=mcp&resource=${encodeURIComponent(resource)}&code_challenge_method=S256&code_challenge=${challenge}`, { redirect: "manual" });
    assert.equal(denied.status, 400, "same-origin redirect lookalikes are rejected");
    const begin = await fetch(`${local}/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(CHATGPT_REDIRECT_URI)}&response_type=code&scope=mcp&state=chatgpt-state&resource=${encodeURIComponent(resource)}&code_challenge_method=S256&code_challenge=${challenge}`, { redirect: "manual" });
    assert.equal(begin.status, 303);
    assert.equal(begin.headers.get("cache-control"), "no-store");
    const cookie = begin.headers.get("set-cookie") ?? "";
    assert.match(cookie, /HttpOnly; Secure; SameSite=Lax/);
    const googleState = new URL(begin.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const callback = await fetch(`${local}/google/callback?state=${encodeURIComponent(googleState)}&code=google-code`, { headers: { cookie } });
    assert.equal(callback.status, 200);
    const transaction = /name="transaction" value="([^"]+)"/.exec(await callback.text())?.[1];
    assert.ok(transaction);
    const consent = await fetch(`${local}/authorize/consent`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie }, body: new URLSearchParams({ transaction, allow: "yes" }) });
    assert.equal(consent.status, 303);
    assert.equal(consent.headers.get("cache-control"), "no-store");
    assert.match(consent.headers.get("set-cookie") ?? "", /Max-Age=0/);
    const redirect = new URL(consent.headers.get("location") ?? "");
    assert.equal(redirect.origin, "https://chatgpt.com");
    assert.equal(redirect.pathname, "/connector_platform_oauth_redirect");
    assert.equal(redirect.searchParams.get("iss"), baseUrl);
    assert.equal(redirect.searchParams.get("state"), "chatgpt-state");
    const code = redirect.searchParams.get("code") ?? "";
    const token = await fetch(`${local}/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: CHATGPT_REDIRECT_URI, resource }) });
    assert.equal(token.status, 200);
    assert.equal(token.headers.get("cache-control"), "no-store");
    const tokenBody = await token.json() as { access_token: string };
    client = new Client({ name: "public-auth-regression", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${local}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokenBody.access_token}` } } }));
    const opened = await client.callTool({ name: "session_open", arguments: {} });
    const session = JSON.parse(opened.content.find((item) => item.type === "text")?.text ?? "{}") as { session_id: string };
    assert.ok(session.session_id);
    const nodes = await client.callTool({ name: "node_list", arguments: { session_id: session.session_id } });
    assert.equal(nodes.isError, undefined);
  } finally {
    await client?.close();
    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()) ?? resolve());
    await publicService?.close();
    await f.cleanup();
  }
});

test("RA-09: configure writes only a new isolated .env and never prints the Google secret", async () => {
  const base = await mkdtemp(path.join(path.resolve(process.cwd(), "reference", "validation"), "rdmcp-cli-"));
  const root = path.join(base, "workspace");
  const data = path.join(base, "data");
  const clientFile = path.join(base, "google-client.json");
  const clientSecret = "cli-fixture-secret-must-not-print";
  await Promise.all([mkdir(root), mkdir(data), writeFile(clientFile, JSON.stringify({ web: { client_id: "fixture-client", client_secret: clientSecret } }))]);
  try {
    const configured = await runCli(base, ["configure", clientFile, "--base-url", baseUrl, "--root", root, "--data-dir", data]);
    assert.equal(configured.code, 0, configured.stderr);
    assert.equal(`${configured.stdout}${configured.stderr}`.includes(clientSecret), false);
    const env = await readFile(path.join(base, ".env"), "utf8");
    assert.match(env, /^REMOTE_AUTH_MODE=google$/m);
    assert.match(env, new RegExp(`^GOOGLE_REDIRECT_URI=${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/google/callback$`, "m"));
    const existing = await runCli(base, ["configure", clientFile, "--base-url", baseUrl, "--root", root, "--data-dir", data]);
    assert.notEqual(existing.code, 0, "an existing .env must never be overwritten");
    assert.equal(`${existing.stdout}${existing.stderr}`.includes(clientSecret), false);
    const overlap = await runCli(path.join(base, "overlap"), ["configure", clientFile, "--base-url", baseUrl, "--root", root, "--data-dir", root]);
    assert.notEqual(overlap.code, 0, "DATA_DIR cannot overlap a permitted root");
    const badUrl = await runCli(path.join(base, "bad-url"), ["configure", clientFile, "--base-url", "http://not-public.example.test", "--root", root, "--data-dir", data]);
    assert.notEqual(badUrl.code, 0, "public configuration requires HTTPS");
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("RA-09: password mode and incomplete Google settings fail closed for a public URL", () => {
  const shared = {
    BASE_URL: baseUrl,
    TOKEN_SECRET: "x".repeat(32),
    AUTHORIZED_USERS_JSON: JSON.stringify([{ email: "owner@example.test", passwordHash: "scrypt$fixture$fixture" }]),
    FILE_ROOTS_JSON: JSON.stringify([{ id: "workspace", path: path.resolve("reference", "validation") }]),
  };
  assert.throws(() => configFromEnv({ ...shared, REMOTE_AUTH_MODE: "password" }), /loopback/i);
  assert.throws(() => configFromEnv({ ...shared, REMOTE_AUTH_MODE: "google" }), /GOOGLE_CLIENT_ID/i);
  assert.throws(() => configFromEnv({ ...shared, REMOTE_AUTH_MODE: "google", GOOGLE_CLIENT_ID: "fixture-client", GOOGLE_CLIENT_SECRET: "fixture-secret", GOOGLE_REDIRECT_URI: `${baseUrl}/wrong` }), /GOOGLE_CLIENT_ID/i);
});
