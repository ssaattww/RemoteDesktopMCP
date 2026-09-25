import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
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
  createFileOAuthStateStore,
  GoogleOidcClient,
  PublicAuthService,
  type GoogleIdentity,
  type OAuthState,
  type OAuthStateStore,
  type OidcVerifier,
} from "../src/public-auth.js";
import { configFromEnv, createApp, RemoteDesktopService } from "../src/index.js";
import { assertPrivateFile, createPrivateFile, protectPrivateDirectory } from "../src/private-storage.js";
import { fixture } from "./fixture.js";

const baseUrl = "https://remote.example.test";
const resource = `${baseUrl}/mcp`;
const clientId = CHATGPT_CLIENT_ID;
const verifier = "v".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const subject: GoogleIdentity = { iss: "https://accounts.google.com", sub: "allowed-subject", email: "owner@example.test" };
const authSecret = "test-secret-that-is-long-enough";

async function runCli(cwd: string, args: string[], timeoutMs = 0) {
  const workspace = path.resolve(process.cwd());
  await mkdir(cwd, { recursive: true });
  const loader = pathToFileURL(path.join(workspace, "node_modules", "tsx", "dist", "loader.mjs")).href;
  const cli = path.join(workspace, "src", "remote-auth-cli.ts").replaceAll(path.sep, "/");
  return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", loader, cli, ...args], { cwd, windowsHide: true });
    let stdout = ""; let stderr = "";
    let timedOut = false;
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs) : undefined;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => { if (timer) clearTimeout(timer); reject(error); }).once("close", (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

async function runBootstrap(cwd: string, timeoutMs: number) {
  const workspace = path.resolve(process.cwd());
  const loader = pathToFileURL(path.join(workspace, "node_modules", "tsx", "dist", "loader.mjs")).href;
  const bootstrap = path.join(workspace, "src", "bootstrap.ts").replaceAll(path.sep, "/");
  return new Promise<{ code: number | null; timedOut: boolean }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", loader, bootstrap], { cwd, windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); }).once("close", (code) => { clearTimeout(timer); resolve({ code, timedOut }); });
  });
}

async function grantBuiltinUsersRead(target: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("icacls.exe", [target, "/grant", "*S-1-5-32-545:(RX)"], { windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
    child.once("error", reject).once("close", (code) => code === 0 ? resolve() : reject(new Error("Unable to broaden the fixture ACL.")));
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

function publicAuth(options: { verifier?: OidcVerifier; store?: OAuthStateStore; now?: () => number; request?: typeof fetch; dataDir?: string; fileStore?: boolean } = {}) {
  const oidc: OidcVerifier = options.verifier ?? {
    authorizationUrl(input) {
      return `https://accounts.google.com/mock?state=${encodeURIComponent(input.state)}&nonce=${encodeURIComponent(input.nonce)}`;
    },
    async exchangeCode(input) {
      assert.equal(input.code, "google-code");
      return subject;
    },
  };
  return new PublicAuthService({ baseUrl, tokenSecret: authSecret, dataDir: options.dataDir ?? "unused", googleClientId: "google-client", googleClientSecret: "not-a-real-secret", googleRedirectUri: `${baseUrl}/google/callback` }, {
    ...(options.store ? { store: options.store } : options.fileStore ? {} : { store: memoryStore() }), verifier: oidc, now: options.now,
    request: options.request ?? (async (input) => {
      assert.equal(String(input), CHATGPT_CLIENT_ID, "only the fixed CIMD URL is requested during initialization");
      return json({ client_id: CHATGPT_CLIENT_ID, redirect_uris: [CHATGPT_REDIRECT_URI], token_endpoint_auth_methods_supported: ["none"] });
    }),
  });
}

function requireTokens(value: Awaited<ReturnType<PublicAuthService["token"]>>) {
  assert.ok("access_token" in value && "refresh_token" in value, "a valid grant must issue an access and refresh token");
  if (!("access_token" in value && "refresh_token" in value)) throw new Error("token was not issued");
  return value;
}

function signedAccess(payload: Record<string, unknown>) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${createHmac("sha256", authSecret).update(encoded).digest("base64url")}`;
}

async function authorizedCode(auth: PublicAuthService) {
  const begun = await auth.begin({ clientId, redirectUri: CHATGPT_REDIRECT_URI, resource, state: "chatgpt-state", challenge });
  const googleState = new URL(begun.redirect).searchParams.get("state");
  assert.ok(googleState);
  const callback = await auth.googleCallback({ state: googleState, code: "google-code", cookie: begun.cookie });
  assert.ok(callback.transaction);
  const consent = await auth.consent({ transaction: callback.transaction, cookie: begun.cookie, allow: true });
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
  const denied = await auth.consent({ transaction: callback.transaction, cookie: "forged-cookie", allow: true });
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

test("REMOTE-NR-001: a seven-day refresh family rotates beyond 256 uses, detects replay, and cleans expired families", async () => {
  let now = 1_700_000_000_000;
  const auth = publicAuth({ now: () => now });
  await auth.initialize();
  await auth.addAllowedSubject(subject);
  const initial = requireTokens(await auth.token({ grantType: "authorization_code", code: await authorizedCode(auth), verifier, clientId, redirectUri: CHATGPT_REDIRECT_URI, resource }));
  const firstRefresh = initial.refresh_token;
  let current = initial;
  for (let rotation = 0; rotation < 1_008; rotation += 1) {
    now += 10 * 60_000;
    current = requireTokens(await auth.token({ grantType: "refresh_token", refreshToken: current.refresh_token, clientId, resource }));
  }
  const concurrent = await Promise.all([
    auth.token({ grantType: "refresh_token", refreshToken: current.refresh_token, clientId, resource }),
    auth.token({ grantType: "refresh_token", refreshToken: current.refresh_token, clientId, resource }),
  ]);
  const successful = concurrent.filter((value) => "access_token" in value);
  assert.equal(successful.length, 1, "only one concurrent rotation may win");
  const winner = requireTokens(successful[0]!);
  assert.deepEqual(await auth.token({ grantType: "refresh_token", refreshToken: firstRefresh, clientId, resource }), { error: "invalid_grant" }, "a historical refresh token revokes its family on replay");
  assert.equal(await auth.authenticate(`Bearer ${winner.access_token}`), undefined, "replay revocation invalidates the winning access token too");
  now += 8 * 24 * 60 * 60_000;
  const replacement = requireTokens(await auth.token({ grantType: "authorization_code", code: await authorizedCode(auth), verifier, clientId, redirectUri: CHATGPT_REDIRECT_URI, resource }));
  assert.equal(await auth.authenticate(`Bearer ${replacement.access_token}`), `google:${subject.iss}:${subject.sub}`, "expired family state is cleaned before a new grant");
});

test("REMOTE-NR-004 and REMOTE-NR-005: subject replacement revokes old grants and unexchanged codes", async () => {
  const other: GoogleIdentity = { iss: subject.iss, sub: "replacement-subject" };
  const auth = publicAuth();
  await auth.initialize();
  assert.equal(await auth.addAllowedSubject(subject), "added");
  await assert.rejects(auth.addAllowedSubject(other), /different Google subject/i);
  const issued = requireTokens(await auth.token({ grantType: "authorization_code", code: await authorizedCode(auth), verifier, clientId, redirectUri: CHATGPT_REDIRECT_URI, resource }));
  const pending = await authorizedCode(auth);
  assert.equal(await auth.addAllowedSubject(other, { replace: true }), "replaced");
  assert.deepEqual(await auth.token({ grantType: "authorization_code", code: pending, verifier, clientId, redirectUri: CHATGPT_REDIRECT_URI, resource }), { error: "invalid_grant" });
  assert.equal(await auth.authenticate(`Bearer ${issued.access_token}`), undefined);
  assert.deepEqual(await auth.token({ grantType: "refresh_token", refreshToken: issued.refresh_token, clientId, resource }), { error: "invalid_grant" });
});

test("REMOTE-NR-005 and REMOTE-NR-007: code bindings and signed access claims fail closed", async () => {
  const auth = publicAuth();
  await auth.initialize();
  await auth.addAllowedSubject(subject);
  const exchange = async (changes: Partial<{ clientId: string; redirectUri: string; resource: string; verifier: string }>) => auth.token({
    grantType: "authorization_code", code: await authorizedCode(auth), verifier: changes.verifier ?? verifier,
    clientId: changes.clientId ?? clientId, redirectUri: changes.redirectUri ?? CHATGPT_REDIRECT_URI, resource: changes.resource ?? resource,
  });
  assert.deepEqual(await exchange({ clientId: "https://attacker.example/client.json" }), { error: "invalid_grant" });
  assert.deepEqual(await exchange({ redirectUri: "https://chatgpt.com/other" }), { error: "invalid_grant" });
  assert.deepEqual(await exchange({ resource: "https://remote.example.test/other" }), { error: "invalid_grant" });
  assert.deepEqual(await exchange({ verifier: "x".repeat(43) }), { error: "invalid_grant" });
  const issued = requireTokens(await auth.token({ grantType: "authorization_code", code: await authorizedCode(auth), verifier, clientId, redirectUri: CHATGPT_REDIRECT_URI, resource }));
  const base = JSON.parse(Buffer.from(issued.access_token.split(".")[0]!, "base64url").toString("utf8")) as Record<string, unknown>;
  for (const malformed of [
    (() => { const value = { ...base }; delete value.iat; return value; })(),
    { ...base, nbf: Math.floor(Date.now() / 1000) + 600 },
    { ...base, iat: Math.floor(Date.now() / 1000) + 600 },
    { ...base, client_id: "https://attacker.example/client.json" },
    { ...base, exp: Number(base.iat) + 601 },
  ]) assert.equal(await auth.authenticate(`Bearer ${signedAccess(malformed)}`), undefined);
});

test("REMOTE-NR-008: file-state restart preserves a valid grant, while a failed save cannot issue or revive a code", async () => {
  const base = await mkdtemp(path.join(path.resolve(process.cwd(), "reference", "validation"), "rdmcp-auth-state-"));
  try {
    await protectPrivateDirectory(base);
    const first = publicAuth({ dataDir: base, fileStore: true });
    await first.initialize(); await first.addAllowedSubject(subject);
    const issued = requireTokens(await first.token({ grantType: "authorization_code", code: await authorizedCode(first), verifier, clientId, redirectUri: CHATGPT_REDIRECT_URI, resource }));
    const restarted = publicAuth({ dataDir: base, fileStore: true });
    await restarted.initialize();
    const persisted = await restarted.token({ grantType: "refresh_token", refreshToken: issued.refresh_token, clientId, resource });
    const savedState = JSON.parse(await readFile(path.join(base, "oauth-state.json"), "utf8")) as { epoch?: unknown; refreshes?: unknown[]; families?: Record<string, { active?: unknown; epoch?: unknown }> };
    const details = `epoch=${String(savedState.epoch)} refreshes=${String(savedState.refreshes?.length)} families=${Object.values(savedState.families ?? {}).map((family) => `${String(family.active)}:${String(family.epoch)}`).join(",")}`;
    assert.ok("access_token" in persisted, `a file-backed refresh grant survives restart: ${"error" in persisted ? persisted.error : "unexpected response"}; ${details}`);
    const failed = publicAuth({ store: { load: async () => ({ version: 1, epoch: 1, allowedSubjects: [subject], refreshes: [], families: {} }), save: async () => { throw new Error("fixture save failure"); } } });
    await failed.initialize();
    const begun = await failed.begin({ clientId, redirectUri: CHATGPT_REDIRECT_URI, resource, challenge });
    const state = new URL(begun.redirect).searchParams.get("state") ?? "";
    const callback = await failed.googleCallback({ state, code: "google-code", cookie: begun.cookie });
    assert.ok(callback.transaction);
    const consent = await failed.consent({ transaction: callback.transaction, cookie: begun.cookie, allow: true });
    const code = new URL(consent.redirect ?? "https://invalid.example").searchParams.get("code") ?? "";
    await assert.rejects(failed.token({ grantType: "authorization_code", code, verifier, clientId, redirectUri: CHATGPT_REDIRECT_URI, resource }), /fixture save failure/);
    assert.deepEqual(await failed.token({ grantType: "authorization_code", code, verifier, clientId, redirectUri: CHATGPT_REDIRECT_URI, resource }), { error: "invalid_grant" }, "a failed issuance consumes its code rather than reviving it");
  } finally { await rm(base, { recursive: true, force: true, maxRetries: 3 }); }
});

test("REMOTE-NR-001: a v1 state with one approved subject and no refresh records remains usable", async () => {
  const legacy: OAuthState = { version: 1, epoch: 7, allowedSubjects: [subject], refreshes: [], families: {} };
  const auth = publicAuth({ store: memoryStore(legacy) });
  await auth.initialize();
  assert.equal(auth.hasAllowedSubject(), true);
  const issued = requireTokens(await auth.token({ grantType: "authorization_code", code: await authorizedCode(auth), verifier, clientId, redirectUri: CHATGPT_REDIRECT_URI, resource }));
  assert.equal(await auth.authenticate(`Bearer ${issued.access_token}`), `google:${subject.iss}:${subject.sub}`);
});

test("RA-01, RA-02, RA-04, RA-06; REMOTE-NR-003, REMOTE-NR-006, REMOTE-NR-008, and IFR001/P2: loopback HTTP flow reaches actual protected MCP tools", async () => {
  const f = await fixture();
  let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;
  let client: Client | undefined;
  let publicService: RemoteDesktopService | undefined;
  const sentinel = "fixture-secret-must-never-reach-public-output";
  let stateLoads = 0;
  let state: OAuthState = { version: 1, epoch: 1, allowedSubjects: [subject], refreshes: [], families: {} };
  try {
    await f.service.close();
    publicService = new RemoteDesktopService({
      ...f.service.cfg, baseUrl, users: [], authMode: "google",
      publicAuth: { baseUrl, tokenSecret: sentinel, dataDir: f.data, googleClientId: "google-client", googleClientSecret: sentinel, googleRedirectUri: `${baseUrl}/google/callback` },
      publicAuthOptions: {
        store: { load: async () => { stateLoads += 1; return structuredClone(state); }, save: async (next) => { state = structuredClone(next); } },
        verifier: {
          authorizationUrl(input) { return `https://accounts.google.com/mock?state=${encodeURIComponent(input.state)}&nonce=${encodeURIComponent(input.nonce)}`; },
          async exchangeCode(input) { if (input.code === "secret-error") throw new Error(sentinel); assert.equal(input.code, "google-code"); return subject; },
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
    const protectedResource = await fetch(`${local}/.well-known/oauth-protected-resource`);
    assert.deepEqual(await protectedResource.json(), { resource, authorization_servers: [baseUrl], scopes_supported: ["mcp"] });
    const rejectedRegistration = await fetch(`${local}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [CHATGPT_REDIRECT_URI] }) });
    assert.equal(rejectedRegistration.status, 404, "public mode rejects dynamic client registration");
    const rejectedPassword = await fetch(`${local}/authorize/confirm`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "email=owner%40example.test&password=fixture" });
    assert.equal(rejectedPassword.status, 404, "public mode has no password authorization endpoint");
    const unauthenticated = await fetch(`${local}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers.get("www-authenticate"), `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`);
    const denied = await fetch(`${local}/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent("https://chatgpt.com/not-the-callback")}&response_type=code&scope=mcp&resource=${encodeURIComponent(resource)}&code_challenge_method=S256&code_challenge=${challenge}`, { redirect: "manual" });
    assert.equal(denied.status, 400, "same-origin redirect lookalikes are rejected");
    const invalidScope = await fetch(`${local}/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(CHATGPT_REDIRECT_URI)}&response_type=code&scope=files&resource=${encodeURIComponent(resource)}&code_challenge_method=S256&code_challenge=${challenge}`, { redirect: "manual" });
    assert.equal(invalidScope.status, 400, "public authorization rejects a scope other than mcp");
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
    const tokenBody = await token.json() as { access_token: string; refresh_token: string };
    assert.ok(tokenBody.refresh_token);
    const rawToolList = await fetch(`${local}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tokenBody.access_token}`, accept: "application/json, text/event-stream", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }) });
    assert.equal(rawToolList.status, 200);
    const rawToolWire = await rawToolList.text();
    const rawTools = JSON.parse(/^data: (.+)$/m.exec(rawToolWire)?.[1] ?? rawToolWire) as { result?: { tools?: Array<{ securitySchemes?: unknown }> } };
    assert.ok(rawTools.result?.tools?.length);
    for (const tool of rawTools.result?.tools ?? []) assert.deepEqual(tool.securitySchemes, [{ type: "oauth2", scopes: ["mcp"] }], "the tools/list MCP wire response has the protocol top-level OAuth security scheme");
    client = new Client({ name: "public-auth-regression", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${local}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokenBody.access_token}` } } }));
    const listed = await client.listTools();
    assert.ok(listed.tools.length > 0);
    for (const tool of listed.tools as Array<{ _meta?: { securitySchemes?: unknown; "openai/securitySchemes"?: unknown } }>) {
      assert.deepEqual(tool._meta?.securitySchemes, [{ type: "oauth2", scopes: ["mcp"] }], "every tool exposes OAuth metadata for linking");
      assert.deepEqual(tool._meta?.["openai/securitySchemes"], [{ type: "oauth2", scopes: ["mcp"] }], "every tool exposes the OpenAI OAuth metadata alias");
    }
    const opened = await client.callTool({ name: "session_open", arguments: {} });
    const session = JSON.parse(opened.content.find((item) => item.type === "text")?.text ?? "{}") as { session_id: string };
    assert.ok(session.session_id);
    const nodes = await client.callTool({ name: "node_list", arguments: { session_id: session.session_id } });
    assert.equal(nodes.isError, undefined);
    const expired = await fetch(`${local}/mcp`, { method: "POST", headers: { authorization: "Bearer expired-token", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "node_list", arguments: {} } }) });
    assert.equal(expired.status, 200);
    const expiredBody = await expired.json() as { result?: { isError?: boolean; _meta?: Record<string, unknown> } };
    assert.equal(expiredBody.result?.isError, true);
    const renewalChallenges = expiredBody.result?._meta?.["mcp/www_authenticate"];
    assert.ok(Array.isArray(renewalChallenges) && renewalChallenges.length === 1);
    const renewalChallenge = String(renewalChallenges[0]);
    assert.match(renewalChallenge, new RegExp(`resource_metadata="${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.well-known/oauth-protected-resource"`));
    assert.match(renewalChallenge, /error="invalid_token"/);
    assert.match(renewalChallenge, /error_description="[^"]+"/);
    for (let request = 0; request < 11; request += 1) {
      const flooded = await fetch(`${local}/authorize?client_id=${encodeURIComponent("https://attacker.example/client.json")}&redirect_uri=${encodeURIComponent(CHATGPT_REDIRECT_URI)}&response_type=code&scope=mcp&resource=${encodeURIComponent(resource)}&code_challenge_method=S256&code_challenge=${challenge}`, { redirect: "manual" });
      if (request === 10) assert.equal(flooded.status, 429);
    }
    const normalAfterFlood = await fetch(`${local}/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(CHATGPT_REDIRECT_URI)}&response_type=code&scope=mcp&resource=${encodeURIComponent(resource)}&code_challenge_method=S256&code_challenge=${challenge}`, { redirect: "manual" });
    assert.equal(normalAfterFlood.status, 303, "unknown-client flooding does not consume the fixed ChatGPT bucket");
    const callbackBegin = await fetch(`${local}/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(CHATGPT_REDIRECT_URI)}&response_type=code&scope=mcp&resource=${encodeURIComponent(resource)}&code_challenge_method=S256&code_challenge=${challenge}`, { redirect: "manual" });
    assert.equal(callbackBegin.status, 303);
    const callbackCookie = callbackBegin.headers.get("set-cookie") ?? "";
    const callbackState = new URL(callbackBegin.headers.get("location") ?? "").searchParams.get("state") ?? "";
    for (let request = 0; request < 31; request += 1) {
      const floodedCallback = await fetch(`${local}/google/callback?state=forged-${request}&code=google-code`, { redirect: "manual" });
      if (request === 30) assert.equal(floodedCallback.status, 429);
    }
    const callbackAfterFlood = await fetch(`${local}/google/callback?state=${encodeURIComponent(callbackState)}&code=google-code`, { headers: { cookie: callbackCookie } });
    assert.equal(callbackAfterFlood.status, 200, "invalid callbacks do not consume the existing cookie-bound transaction bucket");
    const callbackAfterFloodTransaction = /name="transaction" value="([^"]+)"/.exec(await callbackAfterFlood.text())?.[1];
    assert.ok(callbackAfterFloodTransaction);
    for (let request = 0; request < 11; request += 1) {
      const floodedConsent = await fetch(`${local}/authorize/consent`, {
        method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: callbackCookie },
        body: new URLSearchParams({ transaction: `forged-consent-${request}`, allow: "yes" }),
      });
      if (request === 10) assert.equal(floodedConsent.status, 429, "invalid consent requests share only the invalid bucket");
    }
    const consentAfterFlood = await fetch(`${local}/authorize/consent`, {
      method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: callbackCookie },
      body: new URLSearchParams({ transaction: callbackAfterFloodTransaction, allow: "yes" }),
    });
    assert.equal(consentAfterFlood.status, 303, "invalid consent flooding does not consume the cookie-bound transaction bucket");
    const issuedAfterConsentFlood = new URL(consentAfterFlood.headers.get("location") ?? "https://invalid.example").searchParams.get("code") ?? "";
    assert.ok(issuedAfterConsentFlood);
    for (let request = 0; request < 11; request += 1) {
      const floodedToken = await fetch(`${local}/token`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "authorization_code", client_id: clientId, code: `forged-code-${request}`, code_verifier: verifier, redirect_uri: CHATGPT_REDIRECT_URI, resource }),
      });
      if (request === 10) assert.equal(floodedToken.status, 429, "invalid fixed-client token requests share only the invalid bucket");
    }
    const issuedAfterTokenFlood = await fetch(`${local}/token`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", client_id: clientId, code: issuedAfterConsentFlood, code_verifier: verifier, redirect_uri: CHATGPT_REDIRECT_URI, resource }),
    });
    assert.equal(issuedAfterTokenFlood.status, 200, "invalid token flooding does not consume a valid authorization-code bucket");
    const refreshedAfterTokenFlood = await fetch(`${local}/token`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokenBody.refresh_token, resource }),
    });
    assert.equal(refreshedAfterTokenFlood.status, 200, "invalid token flooding does not consume a valid signed-refresh bucket");
    const loadsBeforeMcpFlood = stateLoads;
    const floodedMcp = await Promise.all(Array.from({ length: 32 }, async (_, request) => fetch(`${local}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: request, method: "tools/list" }) })));
    assert.equal(floodedMcp.filter((response) => response.status === 429).length, 4, "the unknown MCP bucket accounts for the two earlier unauthenticated requests and admits only its configured bounded prefix");
    assert.ok(stateLoads - loadsBeforeMcpFlood <= 30, "MCP admission limits unknown requests before further persistent-state reads");
    const secretBegin = await fetch(`${local}/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(CHATGPT_REDIRECT_URI)}&response_type=code&scope=mcp&resource=${encodeURIComponent(resource)}&code_challenge_method=S256&code_challenge=${challenge}`, { redirect: "manual" });
    const secretCookie = secretBegin.headers.get("set-cookie") ?? "";
    const secretState = new URL(secretBegin.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const hiddenVerifierError = await fetch(`${local}/google/callback?state=${encodeURIComponent(secretState)}&code=secret-error`, { headers: { cookie: secretCookie }, redirect: "manual" });
    const malformed = await fetch(`${local}/token`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    const publicOutputs = [hiddenVerifierError.headers.get("location") ?? "", await hiddenVerifierError.text(), await malformed.text(), await readFile(path.join(f.data, "audit.jsonl"), "utf8")];
    for (const output of publicOutputs) assert.equal(output.includes(sentinel), false, "fixture secret is absent from HTTP responses, exceptions, and audit records");
    const chunked = await fetch(`${local}/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(`grant_type=${"x".repeat(17 * 1024)}`)); controller.close(); } }), duplex: "half",
    } as RequestInit);
    assert.equal(chunked.status, 413, "chunked authentication bodies are bounded even without content-length");
    let slowBodyTimer: NodeJS.Timeout | undefined;
    const slowBody = new ReadableStream<Uint8Array>({
      start(controller) { slowBodyTimer = setInterval(() => controller.enqueue(new TextEncoder().encode("x")), 1_000); },
      cancel() { if (slowBodyTimer) clearInterval(slowBodyTimer); },
    });
    const slowBodyBegan = Date.now();
    try {
      await assert.rejects(fetch(`${local}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: slowBody, duplex: "half" } as RequestInit).then((response) => response.text()));
    } finally { if (slowBodyTimer) clearInterval(slowBodyTimer); }
    assert.ok(Date.now() - slowBodyBegan >= 14_000, "a trickling body is held to the absolute receive deadline");
    const originalAudit = publicService.audit.bind(publicService);
    publicService.audit = async (event, fields) => {
      if (event === "session.open") await new Promise<void>((resolve) => setTimeout(resolve, 15_100));
      await originalAudit(event, fields);
    };
    try {
      const began = Date.now();
      const completedBody = await fetch(`${local}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenBody.access_token}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "session_open", arguments: {} } }),
      });
      assert.equal(completedBody.status, 200, "a completed request body is not timed out while its handler runs");
      const completedPayload = JSON.parse(/^data: (.+)$/m.exec(await completedBody.text())?.[1] ?? "{}") as { result?: { content?: Array<{ type?: string; text?: string }> } };
      const completedContent = completedPayload.result?.content?.find((item) => item.type === "text")?.text ?? "{}";
      assert.ok(JSON.parse(completedContent).session_id, "the completed handler response is usable");
      assert.ok(Date.now() - began >= 15_000);
    } finally { publicService.audit = originalAudit; }
  } finally {
    await client?.close();
    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()) ?? resolve());
    await publicService?.close();
    await f.cleanup();
  }
});

test("REMOTE-NR-002: startup, CLI, and state loading reject broad existing secret files", { skip: process.platform !== "win32" }, async () => {
  const base = await mkdtemp(path.join(path.resolve(process.cwd(), "reference", "validation"), "rdmcp-existing-secret-"));
  const data = path.join(base, "data");
  const root = path.join(base, "workspace");
  const stateFile = path.join(data, "oauth-state.json");
  const envFile = path.join(base, ".env");
  const sentinel = "fixture-existing-secret-must-not-be-loaded";
  try {
    await protectPrivateDirectory(base);
    await Promise.all([mkdir(data), mkdir(root)]);
    await protectPrivateDirectory(data);
    await createPrivateFile(stateFile, JSON.stringify({ version: 1, epoch: 1, allowedSubjects: [], refreshes: [], families: {} }));
    await grantBuiltinUsersRead(stateFile);
    await assert.rejects(createFileOAuthStateStore(data).load(), /Private storage ACL/i, "existing OAuth state is checked before its contents are read");
    await createPrivateFile(envFile, [
      `BASE_URL=${baseUrl}`, "REMOTE_AUTH_MODE=google", `TOKEN_SECRET=${sentinel}`,
      "GOOGLE_CLIENT_ID=fixture-client", `GOOGLE_CLIENT_SECRET=${sentinel}`, `GOOGLE_REDIRECT_URI=${baseUrl}/google/callback`,
      `FILE_ROOTS_JSON=${JSON.stringify([{ id: "workspace", path: root }])}`, `DATA_DIR=${data}`,
    ].join("\n"));
    await grantBuiltinUsersRead(envFile);
    const cli = await runCli(base, ["authorize-google"], 3_000);
    assert.equal(cli.timedOut, false, "CLI rejects an unsafe existing .env before opening the callback listener");
    assert.notEqual(cli.code, 0);
    assert.equal(`${cli.stdout}${cli.stderr}`.includes(sentinel), false);
    const startup = await runBootstrap(base, 3_000);
    assert.equal(startup.timedOut, false, "startup rejects an unsafe existing .env before service initialization");
    assert.notEqual(startup.code, 0);
  } finally { await rm(base, { recursive: true, force: true, maxRetries: 3 }); }
});

test("REMOTE-NR-002: configure creates a strict .env from a safe ordinary checkout parent", { skip: process.platform !== "win32" }, async () => {
  const base = await mkdtemp(path.join(path.resolve(process.cwd(), "reference", "validation"), "rdmcp-safe-parent-"));
  const root = path.join(base, "workspace");
  const data = path.join(base, "data");
  const clientFile = path.join(base, "google-client.json");
  try {
    await protectPrivateDirectory(base);
    await grantBuiltinUsersRead(base);
    await Promise.all([mkdir(root), writeFile(clientFile, JSON.stringify({ web: { client_id: "fixture-client", client_secret: "fixture-client-secret" } }))]);
    const configured = await runCli(base, ["configure", clientFile, "--base-url", baseUrl, "--root", root, "--data-dir", data]);
    assert.equal(configured.code, 0);
    await assertPrivateFile(path.join(base, ".env"));
  } finally { await rm(base, { recursive: true, force: true, maxRetries: 3 }); }
});

test("RA-09: configure writes only a new isolated .env and never prints the Google secret", async () => {
  const base = await mkdtemp(path.join(path.resolve(process.cwd(), "reference", "validation"), "rdmcp-cli-"));
  const root = path.join(base, "workspace");
  const data = path.join(base, "data");
  const clientFile = path.join(base, "google-client.json");
  const clientSecret = "cli-fixture-secret-must-not-print";
  await protectPrivateDirectory(base);
  await Promise.all([mkdir(root), mkdir(data), writeFile(clientFile, JSON.stringify({ web: { client_id: "fixture-client", client_secret: clientSecret } }))]);
  await protectPrivateDirectory(data);
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
