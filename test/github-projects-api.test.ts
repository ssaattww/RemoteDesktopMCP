import assert from "node:assert/strict";
import test from "node:test";
import { GitHubProjectsApi, GitHubProjectsApiError, type GitHubProjectsCredentialProvider } from "../src/github-projects-api.js";

const token = "github-token-that-must-not-be-logged";
const project = { id: "PVT_1", title: "Roadmap", number: 4, url: "https://github.com/users/example/projects/4", closed: false, public: false };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function credentialProvider(calls: string[] = []): GitHubProjectsCredentialProvider {
  return { async getToken(principal) { calls.push(principal); return token; } };
}

test("GitHub Projects client exposes only fixed self-owned project operations", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
  const credentialCalls: string[] = [];
  const api = new GitHubProjectsApi("google:issuer:subject", "example", credentialProvider(credentialCalls), {
    request: async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown>, authorization: new Headers(init?.headers).get("authorization") });
      if (calls.length === 1) return response({ data: { viewer: { login: "example", projectsV2: { nodes: [project], pageInfo: { hasNextPage: false, endCursor: null } } } } });
      if (calls.length === 2) return response({ data: { viewer: { id: "U_1", login: "example" } } });
      return response({ data: { viewer: { login: "example" }, createProjectV2: { projectV2: { ...project, title: "New" } } } });
    },
  });

  assert.deepEqual(await api.listProjects(), [project]);
  const created = await api.createProject("New");
  assert.equal(created.project.title, "New");
  assert.deepEqual(created.outcome, { applied: true });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.url === "https://api.github.com/graphql"));
  assert.ok(calls.every((call) => call.authorization === `Bearer ${token}`));
  assert.match(String(calls[0]?.body.query), /projectsV2/);
  assert.match(String(calls[1]?.body.query), /viewer \{ id login \}/);
  assert.doesNotMatch(String(calls[2]?.body.query), /deleteProjectV2|updateProjectV2Field|clearProjectV2ItemFieldValue/);
  assert.doesNotMatch(String(calls[2]?.body.query), /viewer/);
  assert.equal(calls[2]?.body.variables && (calls[2]?.body.variables as Record<string, unknown>).ownerId, "U_1");
  assert.deepEqual(credentialCalls, ["google:issuer:subject", "google:issuer:subject"], "the create flow pins the checked credential for its mutation");
  assert.equal("graphql" in api, false, "no public generic GraphQL method is exposed");
});

test("mutation transport loss is reported as unknown and is not retried", async () => {
  let requestCount = 0;
  const api = new GitHubProjectsApi("principal", "example", credentialProvider(), {
    request: async (_input, init) => {
      requestCount += 1;
      const body = JSON.parse(String(init?.body)) as { operationName: string };
      if (body.operationName === "RdmcpViewerId") return response({ data: { viewer: { id: "U_1", login: "example" } } });
      throw new Error("simulated response loss");
    },
  });
  await assert.rejects(api.createProject("New"), (error: unknown) => error instanceof GitHubProjectsApiError && error.code === "request_failed" && error.applied === "unknown");
  assert.equal(requestCount, 2);
});

test("API identity mismatch and GraphQL errors fail closed without exposing response details", async () => {
  const mismatch = new GitHubProjectsApi("principal", "expected", credentialProvider(), { request: async () => response({ data: { viewer: { login: "different", projectsV2: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }) });
  await assert.rejects(mismatch.listProjects(), (error: unknown) => error instanceof GitHubProjectsApiError && error.code === "identity_mismatch");

  const graphQlFailure = new GitHubProjectsApi("principal", "expected", credentialProvider(), { request: async () => response({ data: { viewer: { login: "expected" } }, errors: [{ message: token }] }) });
  await assert.rejects(graphQlFailure.listProjects(), (error: unknown) => error instanceof GitHubProjectsApiError && !error.message.includes(token));
});

test("permission and rate-limit responses are classified without retry", async () => {
  for (const [status, code] of [[403, "forbidden"], [429, "rate_limited"]] as const) {
    let count = 0;
    const api = new GitHubProjectsApi("principal", "expected", credentialProvider(), { request: async () => { count += 1; return new Response("{}", { status }); } });
    await assert.rejects(api.listProjects(), (error: unknown) => error instanceof GitHubProjectsApiError && error.code === code);
    assert.equal(count, 1);
  }
});

test("project updates check owner before the fixed title/description mutation", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const api = new GitHubProjectsApi("principal", "example", credentialProvider(), {
    request: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(body);
      if (body.operationName === "RdmcpProjectOwner") return response({ data: { viewer: { login: "example" }, node: { owner: { login: "someone-else" } } } });
      assert.doesNotMatch(String(body.query), /viewer/);
      return response({ data: { viewer: { login: "example" }, updateProjectV2: { projectV2: project } } });
    },
  });
  await assert.rejects(api.updateProject("PVT_1", { title: "New title" }), (error: unknown) => error instanceof GitHubProjectsApiError && error.code === "forbidden");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.operationName, "RdmcpProjectOwner");
});
