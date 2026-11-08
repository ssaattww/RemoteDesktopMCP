import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GitHubProjectsApi } from "../src/github-projects-api.js";
import { createGitHubProjectsServer, type GitHubProjectsScope } from "../src/github-projects-mcp.js";

const project = { id: "PVT_4", title: "Roadmap", number: 4, url: "https://github.com/users/example/projects/4", closed: false, public: false };

async function connectedServer(scopes: GitHubProjectsScope[]) {
  const audit: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const api = new GitHubProjectsApi("google:issuer:subject", "example", { async getToken() { return "opaque-test-token"; } }, {
    request: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer opaque-test-token");
      const body = JSON.parse(String(init?.body)) as { operationName: string };
      if (body.operationName === "RdmcpListProjects") return new Response(JSON.stringify({ data: { viewer: { login: "example", projectsV2: { nodes: [project], pageInfo: { hasNextPage: false, endCursor: null } } } } }));
      if (body.operationName === "RdmcpViewerId") return new Response(JSON.stringify({ data: { viewer: { id: "U_1", login: "example" } } }));
      return new Response(JSON.stringify({ data: { createProjectV2: { projectV2: { ...project, title: "New roadmap" } } } }));
    },
  });
  const server = createGitHubProjectsServer({ api, principal: "google:issuer:subject", scopes, audit: async (event, detail) => { audit.push({ event, detail }); } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "github-projects-test", version: "1" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server, audit };
}

test("read scope exposes only read tools and calls the fixed API client", async () => {
  const connected = await connectedServer(["github-projects:read"]);
  try {
    const tools = await connected.client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), ["projects_list"]);
    assert.deepEqual(tools.tools[0]?._meta?.securitySchemes, [{ type: "oauth2", scopes: ["github-projects:read"] }]);
    assert.doesNotMatch(JSON.stringify(tools.tools), /process_start|project_delete|visibility|collaborator|command|graphql/);
    const result = await connected.client.callTool({ name: "projects_list", arguments: { comment: "Read the project list" } });
    assert.equal(result.isError, undefined);
    assert.match(result.content.find((item) => item.type === "text")?.text ?? "", /Roadmap/);
    assert.ok(connected.audit.some((entry) => entry.event === "github_projects.completed" && entry.detail.tool === "projects_list"));
  } finally { await connected.client.close(); await connected.server.close(); }
});

test("write scope adds only typed project metadata operations", async () => {
  const connected = await connectedServer(["github-projects:write"]);
  try {
    const tools = await connected.client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), ["projects_list", "project_create", "project_update"]);
    assert.deepEqual(tools.tools[0]?._meta?.securitySchemes, [{ type: "oauth2", scopes: ["github-projects:write"] }]);
    const result = await connected.client.callTool({ name: "project_create", arguments: { title: "New roadmap", comment: "Create a personal project" } });
    assert.equal(result.isError, undefined);
    assert.match(result.content.find((item) => item.type === "text")?.text ?? "", /PVT_4/);
    assert.ok(connected.audit.some((entry) => entry.event === "github_projects.completed" && entry.detail.projectId === "PVT_4"));
  } finally { await connected.client.close(); await connected.server.close(); }
});
