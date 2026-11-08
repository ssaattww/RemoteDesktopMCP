import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CHATGPT_CLIENT_ID, CHATGPT_REDIRECT_URI, type GoogleIdentity, type OAuthState, type OAuthStateStore, type OidcVerifier } from "../src/public-auth.js";
import { createApp, RemoteDesktopService, type RuntimeConfig } from "../src/index.js";

const baseUrl = "https://rdmcp-projects.example.test";
const googleIdentity: GoogleIdentity = { iss: "https://accounts.google.com", sub: "projects-http-user" };
const blankState = (): OAuthState => ({ version: 1, epoch: 1, allowedSubjects: [], refreshes: [], families: {} });
const resource = (path: string) => `${baseUrl}${path}`;

function stateStore(): OAuthStateStore {
  let state = blankState();
  return { async load() { return structuredClone(state); }, async save(next) { state = structuredClone(next); } };
}

async function issueToken(service: RemoteDesktopService, scope: "mcp" | "github-projects:read", resourceUrl: string) {
  const auth = service.publicAuth!;
  const verifier = "v".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const begun = await auth.begin({ clientId: CHATGPT_CLIENT_ID, redirectUri: CHATGPT_REDIRECT_URI, resource: resourceUrl, scope, challenge });
  const googleState = new URL(begun.redirect).searchParams.get("state");
  assert.ok(googleState);
  const callback = await auth.googleCallback({ state: googleState, code: "google-code", cookie: begun.cookie });
  assert.ok(callback.transaction);
  const consent = await auth.consent({ transaction: callback.transaction, cookie: begun.cookie, allow: true });
  assert.ok(consent.redirect);
  const code = new URL(consent.redirect).searchParams.get("code");
  assert.ok(code);
  const issued = await auth.token({ grantType: "authorization_code", clientId: CHATGPT_CLIENT_ID, redirectUri: CHATGPT_REDIRECT_URI, resource: resourceUrl, code, verifier });
  assert.ok("access_token" in issued);
  return issued.access_token;
}

test("Projects MCP uses its isolated route, token audience, and tool registry without creating the PC MCP server", async () => {
  const oidc: OidcVerifier = {
    authorizationUrl: ({ state }) => `https://identity.example.test/authorize?state=${encodeURIComponent(state)}`,
    async exchangeCode() { return googleIdentity; },
  };
  let apiCalls = 0;
  const config: RuntimeConfig = {
    baseUrl,
    tokenSecret: "projects-http-test-secret-0123456789",
    users: [],
    roots: [],
    dataDir: "unused",
    port: 0,
    chunkBytes: 1024,
    nodeId: "local",
    nodeLabel: "test",
    dcCommand: process.execPath,
    dcArgs: [],
    allowedRedirectOrigins: new Set(),
    publicAuth: { baseUrl, tokenSecret: "projects-http-test-secret-0123456789", dataDir: "unused", googleClientId: "test-client", googleClientSecret: "not-a-real-secret", googleRedirectUri: `${baseUrl}/google/callback` },
    publicAuthOptions: {
      store: stateStore(),
      verifier: oidc,
      request: async () => new Response(JSON.stringify({ client_id: CHATGPT_CLIENT_ID, redirect_uris: [CHATGPT_REDIRECT_URI], token_endpoint_auth_methods_supported: ["none"] }), { headers: { "content-type": "application/json" } }),
    },
    githubProjects: {
      login: "example",
      credentials: { async getToken(principal) { assert.equal(principal, `google:${googleIdentity.iss}:${googleIdentity.sub}`); return "test-pat-never-logged"; } },
      request: async (_url, init) => {
        apiCalls += 1;
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-pat-never-logged");
        return new Response(JSON.stringify({ data: { viewer: { login: "example", projectsV2: { nodes: [{ id: "PVT_4", title: "Roadmap", number: 4, url: "https://github.com/users/example/projects/4", closed: false, public: false }], pageInfo: { hasNextPage: false, endCursor: null } } } } }), { headers: { "content-type": "application/json" } });
      },
    },
  };
  const service = new RemoteDesktopService(config);
  service.audit = async () => undefined;
  service.server = (() => { throw new Error("The Projects route must not construct the PC MCP server."); }) as RemoteDesktopService["server"];
  await service.publicAuth!.initialize();
  await service.publicAuth!.addAllowedSubject(googleIdentity);
  const pcToken = await issueToken(service, "mcp", resource("/mcp"));

  const app = createApp(service);
  const http = app.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const projectsResource = resource("/github-projects/mcp");
  const verifier = "p".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizeQuery = new URLSearchParams({ client_id: CHATGPT_CLIENT_ID, redirect_uri: CHATGPT_REDIRECT_URI, response_type: "code", code_challenge_method: "S256", code_challenge: challenge, scope: "github-projects:read", resource: projectsResource, state: "project-oauth-test" });
  const protectedResource = await fetch(`${origin}/.well-known/oauth-protected-resource/github-projects/mcp`);
  assert.equal((await protectedResource.json() as { resource: string }).resource, projectsResource);
  const begin = await fetch(`${origin}/authorize?${authorizeQuery}`, { redirect: "manual" });
  assert.equal(begin.status, 303);
  const cookie = begin.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const identityLocation = new URL(begin.headers.get("location")!);
  const googleState = identityLocation.searchParams.get("state");
  assert.ok(googleState);
  const callback = await fetch(`${origin}/google/callback?${new URLSearchParams({ state: googleState, code: "google-code" })}`, { headers: { cookie } });
  assert.equal(callback.status, 200);
  const consentHtml = await callback.text();
  assert.match(consentHtml, /GitHub Projects/);
  assert.match(consentHtml, /does not provide PC tools/);
  assert.doesNotMatch(consentHtml, /arbitrary commands|file roots/);
  const transaction = /name="transaction" value="([^"]+)"/.exec(consentHtml)?.[1];
  assert.ok(transaction);
  const consent = await fetch(`${origin}/authorize/consent`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ transaction, allow: "yes" }), redirect: "manual" });
  assert.equal(consent.status, 303);
  const code = new URL(consent.headers.get("location")!).searchParams.get("code");
  assert.ok(code);
  const tokenResponse = await fetch(`${origin}/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", client_id: CHATGPT_CLIENT_ID, redirect_uri: CHATGPT_REDIRECT_URI, resource: projectsResource, code, code_verifier: verifier }) });
  assert.equal(tokenResponse.status, 200);
  const projectToken = (await tokenResponse.json() as { access_token: string }).access_token;
  const client = new Client({ name: "projects-route-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/github-projects/mcp`), { requestInit: { headers: { authorization: `Bearer ${projectToken}` } } });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), ["projects_list"]);
    const list = await client.callTool({ name: "projects_list", arguments: { comment: "Read a Project" } });
    assert.match(list.content.find((item) => item.type === "text")?.text ?? "", /Roadmap/);
    assert.equal(apiCalls, 1);

    const projectTokenOnPc = await fetch(`${origin}/mcp`, { method: "POST", headers: { authorization: `Bearer ${projectToken}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(projectTokenOnPc.status, 401);
    const pcTokenOnProjects = await fetch(`${origin}/github-projects/mcp`, { method: "POST", headers: { authorization: `Bearer ${pcToken}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
    assert.equal(pcTokenOnProjects.status, 401);
    assert.equal(apiCalls, 1, "cross-audience tokens are rejected before the GitHub API is called");
  } finally {
    await client.close().catch(() => undefined);
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await service.close();
  }
});
