import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { configFromEnv } from "../src/index.js";
import { GitHubProjectsCredentialStore } from "../src/github-projects-credentials.js";
import { protectPrivateDirectory } from "../src/private-storage.js";

function memorySecretStore() {
  const entries = new Map<string, string>();
  return {
    entries,
    async get(key: string) { return entries.get(key); },
    async set(key: string, value: string) { entries.set(key, value); },
    async remove(key: string) { entries.delete(key); },
  };
}

const principal = "google:https://accounts.google.com:approved-user";

test("Projects runtime wiring is opt-in and never reads a PAT from environment configuration", async () => {
  const base = { BASE_URL: "https://rdmcp.example.test", TOKEN_SECRET: "runtime-test-secret-that-is-long-enough", REMOTE_AUTH_MODE: "google", GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "synthetic-client-secret", FILE_ROOTS_JSON: '[{"id":"files","path":"C:/workspace"}]' };
  assert.equal(configFromEnv(base).githubProjects, undefined);
  const enabled = configFromEnv({ ...base, GITHUB_PROJECTS_LOGIN: "example" });
  assert.equal(enabled.githubProjects?.login, "example");
  assert.ok(enabled.githubProjects?.credentials);
  assert.throws(() => configFromEnv({ ...base, BASE_URL: "http://127.0.0.1:3000", REMOTE_AUTH_MODE: "password", AUTHORIZED_USERS_JSON: '[{"email":"local@example.test","passwordHash":"scrypt$fixture"}]', GITHUB_PROJECTS_LOGIN: "example" }), /requires Google authentication/u);
  assert.throws(() => configFromEnv({ ...base, GITHUB_PROJECTS_LOGIN: "not a login" }), /valid GitHub login/u);
});

test("credential persistence is bound to one RemoteDesktopMCP subject and GitHub account", async () => {
  const secretStore = memorySecretStore();
  const store = new GitHubProjectsCredentialStore("unused", { platform: "linux", secretStore });
  const calls: string[] = [];
  const request: typeof fetch = async (url, init) => {
    calls.push(String(url));
    assert.equal(String(url), "https://api.github.com/user");
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer dummy-test-token");
    return new Response(JSON.stringify({ id: 7123456, login: "example" }), { headers: { "content-type": "application/json" } });
  };

  const metadata = await store.register(principal, "example", "dummy-test-token", request);
  assert.equal(metadata.githubUserId, 7123456);
  assert.equal(metadata.login, "example");
  assert.equal(await store.getToken(principal), "dummy-test-token");
  assert.equal(await store.getToken("google:https://accounts.google.com:another-user"), undefined);
  assert.equal(calls.length, 1);

  await assert.rejects(
    store.register(principal, "example", "replacement-token", async () => new Response(JSON.stringify({ id: 9876543, login: "example" }))),
    /change the linked GitHub account/u,
  );
  assert.equal(await store.getToken(principal), "dummy-test-token", "a different GitHub account cannot replace the existing link");
  assert.equal(secretStore.entries.size, 1);
  await store.remove(principal);
  assert.equal(await store.getToken(principal), undefined);
});

test("credential registration verifies the token without logging or accepting another login", async () => {
  const secretStore = memorySecretStore();
  const store = new GitHubProjectsCredentialStore("unused", { platform: "linux", secretStore });
  await assert.rejects(
    store.register(principal, "expected", "dummy-test-token", async () => new Response(JSON.stringify({ id: 42, login: "other-account" }))),
    /different account/u,
  );
  assert.equal(secretStore.entries.size, 0);
  await assert.rejects(store.register(principal, "expected", "token\nleak", async () => { throw new Error("must not call GitHub"); }), /valid GitHub credential/u);
  assert.equal(secretStore.entries.size, 0);
});

test("Windows storage survives a provider restart using current-user DPAPI", { skip: process.platform !== "win32" }, async () => {
  const validationDirectory = path.join(process.cwd(), "reference", "validation");
  await mkdir(validationDirectory, { recursive: true });
  const directory = await mkdtemp(path.join(validationDirectory, "github-projects-secret-test-"));
  await protectPrivateDirectory(directory);
  try {
    const store = new GitHubProjectsCredentialStore(directory);
    const request: typeof fetch = async () => new Response(JSON.stringify({ id: 7123456, login: "example" }));
    const metadata = await store.register(principal, "example", "synthetic-dpapi-fixture", request);
    assert.equal(metadata.login, "example");
    assert.equal(await new GitHubProjectsCredentialStore(directory).getToken(principal), "synthetic-dpapi-fixture");
    assert.equal(await new GitHubProjectsCredentialStore(directory).getToken("google:https://accounts.google.com:another-user"), undefined);
    await store.remove(principal);
    assert.equal(await store.getToken(principal), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
