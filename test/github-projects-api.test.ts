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
      if (calls.length === 3) return response({ data: { createProjectV2: { projectV2: { ...project, title: "New" } } } });
      return response({ data: { viewer: { login: "example" }, node: { ...project, title: "New", shortDescription: "", owner: { login: "example" } } } });
    },
  });

  assert.deepEqual(await api.listProjects(), [project]);
  const created = await api.createProject("New");
  assert.equal(created.project.title, "New");
  assert.deepEqual(created.outcome, { applied: true });
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.url === "https://api.github.com/graphql"));
  assert.ok(calls.every((call) => call.authorization === `Bearer ${token}`));
  assert.match(String(calls[0]?.body.query), /projectsV2/);
  assert.match(String(calls[1]?.body.query), /viewer \{ id login \}/);
  assert.doesNotMatch(String(calls[2]?.body.query), /deleteProjectV2|updateProjectV2Field|clearProjectV2ItemFieldValue/);
  assert.match(String(calls[3]?.body.query), /shortDescription/);
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

test("an incomplete project-creation response remains unknown", async () => {
  const api = new GitHubProjectsApi("principal", "example", credentialProvider(), {
    request: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { operationName: string };
      if (body.operationName === "RdmcpViewerId") return response({ data: { viewer: { id: "U_1", login: "example" } } });
      return response({ data: { createProjectV2: { projectV2: { title: "New" } } } });
    },
  });
  await assert.rejects(api.createProject("New"), (error: unknown) => error instanceof GitHubProjectsApiError && error.code === "invalid_response" && error.applied === "unknown");
});

test("a 401 during mutation readback preserves the one-time recovery notice and unknown outcome", async () => {
  let recoveryNotice = false;
  const api = new GitHubProjectsApi("principal", "example", credentialProvider(), {
    onCredentialRejected: () => { const first = !recoveryNotice; recoveryNotice = true; return first; },
    request: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { operationName: string };
      if (body.operationName === "RdmcpViewerId") return response({ data: { viewer: { id: "U_1", login: "example" } } });
      if (body.operationName === "RdmcpCreateProject") return response({ data: { createProjectV2: { projectV2: { id: "PVT_1" } } } });
      return response({}, 401);
    },
  });
  await assert.rejects(api.createProject("New"), (error: unknown) => error instanceof GitHubProjectsApiError && error.code === "credential_rejected" && error.applied === "unknown" && error.recoveryNotice);
});

test("a rejected credential blocks later requests until the credential changes", async () => {
  let rejected = "";
  let requestCount = 0;
  const credentials = credentialProvider();
  const options = {
    isCredentialRejected: (_principal: string, candidate: string) => candidate === rejected,
    onCredentialRejected: (_principal: string, candidate: string) => { const first = candidate !== rejected; rejected = candidate; return first; },
    request: async (_input: string | URL | Request, init?: RequestInit) => {
      requestCount += 1;
      const body = JSON.parse(String(init?.body)) as { operationName: string };
      if (body.operationName === "RdmcpViewerId") return response({ data: { viewer: { id: "U_1", login: "example" } } });
      return response({}, 401);
    },
  };
  const first = new GitHubProjectsApi("principal", "example", credentials, options);
  await assert.rejects(first.createProject("New"), (error: unknown) => error instanceof GitHubProjectsApiError && error.code === "credential_rejected" && error.applied === "unknown" && error.recoveryNotice);
  const laterRequest = new GitHubProjectsApi("principal", "example", credentials, options);
  await assert.rejects(laterRequest.createProject("Another"), (error: unknown) => error instanceof GitHubProjectsApiError && error.code === "credential_rejected" && error.applied === false && !error.recoveryNotice);
  assert.equal(requestCount, 2, "the same rejected PAT is not sent again");
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
  const graphqlLimit = new GitHubProjectsApi("principal", "expected", credentialProvider(), { request: async () => response({ data: { viewer: { login: "expected" } }, errors: [{ type: "RATE_LIMITED", message: "private details" }] }) });
  await assert.rejects(graphqlLimit.listProjects(), (error: unknown) => error instanceof GitHubProjectsApiError && error.code === "rate_limited" && !error.message.includes("private details"));
  const forbiddenWithLimitHeader = new GitHubProjectsApi("principal", "expected", credentialProvider(), { request: async () => new Response("private details", { status: 403, headers: { "x-ratelimit-remaining": "0" } }) });
  await assert.rejects(forbiddenWithLimitHeader.listProjects(), (error: unknown) => error instanceof GitHubProjectsApiError && error.code === "rate_limited");
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

test("Project fields and Issue or pull request links use fixed read and add operations", async () => {
  const operations: string[] = [];
  const api = new GitHubProjectsApi("principal", "example", credentialProvider(), {
    request: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { operationName: string };
      operations.push(body.operationName);
      if (body.operationName === "RdmcpProjectFields") return response({ data: { viewer: { login: "example" }, node: { id: "PVT_1", owner: { login: "example" }, fields: { nodes: [{ __typename: "ProjectV2Field", id: "F_TEXT", name: "Notes", dataType: "TEXT", isIssueField: false }, { __typename: "ProjectV2SingleSelectField", id: "F_STATUS", name: "Status", dataType: "SINGLE_SELECT", isIssueField: false, options: [{ id: "O_TODO", name: "Todo" }] }, { __typename: "ProjectV2Field", id: "F_ISSUE_BODY", name: "Body", dataType: "TEXT", isIssueField: true }], pageInfo: { hasNextPage: false } } } } });
      if (body.operationName === "RdmcpIssueOrPullRequest") return response({ data: { viewer: { login: "example" }, node: { __typename: "PullRequest", id: "PR_1" } } });
      if (body.operationName === "RdmcpProjectOwner") return response({ data: { viewer: { login: "example" }, node: { id: "PVT_1", owner: { login: "example" } } } });
      if (body.operationName === "RdmcpAddProjectItem") return response({ data: { addProjectV2ItemById: { item: { id: "ITEM_1", type: "PULL_REQUEST" } } } });
      if (body.operationName === "RdmcpProjectItemState") return response({ data: { viewer: { login: "example" }, node: { id: "ITEM_1", type: "PULL_REQUEST", project: { id: "PVT_1" }, isArchived: false, content: { __typename: "PullRequest", id: "PR_1", title: "Change", number: 12, url: "https://github.com/example/repo/pull/12" }, fieldValues: { nodes: [], pageInfo: { hasNextPage: false } } } } });
      throw new Error(`Unexpected operation ${body.operationName}`);
    },
  });
  const fields = await api.listProjectFields("PVT_1");
  assert.deepEqual(fields, [{ id: "F_TEXT", name: "Notes", type: "TEXT", isIssueField: false }, { id: "F_STATUS", name: "Status", type: "SINGLE_SELECT", isIssueField: false, options: [{ id: "O_TODO", name: "Todo" }] }]);
  assert.deepEqual(await api.addIssueOrPullRequest("PVT_1", "PR_1"), { itemId: "ITEM_1", outcome: { applied: true } });
  assert.deepEqual(operations, ["RdmcpProjectFields", "RdmcpProjectOwner", "RdmcpIssueOrPullRequest", "RdmcpAddProjectItem", "RdmcpProjectItemState"]);
});

test("Project item reads return issue or pull request links and only Project field values", async () => {
  const api = new GitHubProjectsApi("principal", "example", credentialProvider(), {
    request: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { operationName: string };
      assert.equal(body.operationName, "RdmcpProjectItems");
      return response({ data: { viewer: { login: "example" }, node: { id: "PVT_1", owner: { login: "example" }, items: { nodes: [{ id: "ITEM_1", type: "PULL_REQUEST", isArchived: false, content: { __typename: "PullRequest", id: "PR_1", title: "Change", number: 12, url: "https://github.com/example/repo/pull/12" }, fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldTextValue", text: "review", field: { id: "F_TEXT", name: "Notes" } }, { __typename: "ProjectV2ItemFieldSingleSelectValue", name: "In progress", optionId: "O_PROGRESS", field: { id: "F_STATUS", name: "Status" } }], pageInfo: { hasNextPage: false } } }], pageInfo: { hasNextPage: false, endCursor: null } } } } });
    },
  });
  assert.deepEqual(await api.listProjectItems("PVT_1"), [{ id: "ITEM_1", type: "PULL_REQUEST", isArchived: false, content: { id: "PR_1", type: "PullRequest", title: "Change", number: 12, url: "https://github.com/example/repo/pull/12" }, fields: [{ id: "F_TEXT", name: "Notes", type: "TEXT", value: "review" }, { id: "F_STATUS", name: "Status", type: "SINGLE_SELECT", value: "In progress", optionId: "O_PROGRESS" }] }]);
});

test("Project item field values are changed only for a supported field in the same personal Project", async () => {
  const operations: Array<{ operationName: string; variables: Record<string, unknown> }> = [];
  const api = new GitHubProjectsApi("principal", "example", credentialProvider(), {
    request: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { operationName: string; variables: Record<string, unknown> };
      operations.push(body);
      if (body.operationName === "RdmcpProjectOwner") return response({ data: { viewer: { login: "example" }, node: { id: "PVT_1", owner: { login: "example" } } } });
      if (body.operationName === "RdmcpProjectItemOwner") return response({ data: { viewer: { login: "example" }, node: { id: "ITEM_1", project: { id: "PVT_1" }, isArchived: false } } });
      if (body.operationName === "RdmcpProjectFields") return response({ data: { viewer: { login: "example" }, node: { id: "PVT_1", owner: { login: "example" }, fields: { nodes: [{ __typename: "ProjectV2SingleSelectField", id: "F_STATUS", name: "Status", dataType: "SINGLE_SELECT", isIssueField: false, options: [{ id: "O_TODO", name: "Todo" }] }], pageInfo: { hasNextPage: false } } } } });
      if (body.operationName === "RdmcpSetProjectItemField") return response({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_1" } } } });
      if (body.operationName === "RdmcpProjectItemState") return response({ data: { viewer: { login: "example" }, node: { id: "ITEM_1", type: "ISSUE", project: { id: "PVT_1" }, isArchived: false, content: null, fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Todo", optionId: "O_TODO", field: { id: "F_STATUS", name: "Status" } }], pageInfo: { hasNextPage: false } } } } });
      throw new Error(`Unexpected operation ${body.operationName}`);
    },
  });
  assert.deepEqual(await api.setProjectItemField("PVT_1", "ITEM_1", "F_STATUS", { type: "SINGLE_SELECT", optionId: "O_TODO" }), { applied: true });
  assert.deepEqual(operations.find((operation) => operation.operationName === "RdmcpSetProjectItemField")?.variables.value, { singleSelectOptionId: "O_TODO" });
  assert.equal(operations.at(-1)?.operationName, "RdmcpProjectItemState");

  const rejected = new GitHubProjectsApi("principal", "example", credentialProvider(), {
    request: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { operationName: string };
      if (body.operationName === "RdmcpProjectOwner") return response({ data: { viewer: { login: "example" }, node: { id: "PVT_1", owner: { login: "example" } } } });
      if (body.operationName === "RdmcpProjectItemOwner") return response({ data: { viewer: { login: "example" }, node: { id: "ITEM_1", project: { id: "PVT_1" }, isArchived: false } } });
      if (body.operationName === "RdmcpProjectFields") return response({ data: { viewer: { login: "example" }, node: { id: "PVT_1", owner: { login: "example" }, fields: { nodes: [{ __typename: "ProjectV2Field", id: "F_ISSUE_TEXT", name: "Issue text", dataType: "TEXT", isIssueField: true }], pageInfo: { hasNextPage: false } } } } });
      throw new Error(`Unexpected operation ${body.operationName}`);
    },
  });
  await assert.rejects(rejected.setProjectItemField("PVT_1", "ITEM_1", "F_ISSUE_TEXT", { type: "TEXT", text: "must not edit Issue fields" }), (error: unknown) => error instanceof GitHubProjectsApiError && error.code === "forbidden");
});
