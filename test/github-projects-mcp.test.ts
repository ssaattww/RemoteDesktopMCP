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
      if (body.operationName === "RdmcpProjectFields") return new Response(JSON.stringify({ data: { viewer: { login: "example" }, node: { id: project.id, owner: { login: "example" }, fields: { nodes: [{ __typename: "ProjectV2Field", id: "F_TEXT", name: "Notes", dataType: "TEXT", isIssueField: false }, { __typename: "ProjectV2SingleSelectField", id: "F_STATUS", name: "Status", dataType: "SINGLE_SELECT", isIssueField: false, options: [{ id: "O_TODO", name: "Todo" }] }], pageInfo: { hasNextPage: false } } } } }));
      if (body.operationName === "RdmcpProjectItems") return new Response(JSON.stringify({ data: { viewer: { login: "example" }, node: { id: project.id, owner: { login: "example" }, items: { nodes: [{ id: "ITEM_1", type: "ISSUE", isArchived: false, content: { __typename: "Issue", title: "Work item", number: 5, url: "https://github.com/example/repo/issues/5" }, fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldTextValue", text: "note", field: { id: "F_TEXT", name: "Notes" } }], pageInfo: { hasNextPage: false } } }], pageInfo: { hasNextPage: false, endCursor: null } } } } }));
      if (body.operationName === "RdmcpProjectOwner") return new Response(JSON.stringify({ data: { viewer: { login: "example" }, node: { id: project.id, owner: { login: "example" } } } }));
      if (body.operationName === "RdmcpIssueOrPullRequest") return new Response(JSON.stringify({ data: { viewer: { login: "example" }, node: { __typename: "PullRequest", id: "PR_1" } } }));
      if (body.operationName === "RdmcpAddProjectItem") return new Response(JSON.stringify({ data: { addProjectV2ItemById: { item: { id: "ITEM_2", type: "PULL_REQUEST" } } } }));
      if (body.operationName === "RdmcpProjectItemOwner") return new Response(JSON.stringify({ data: { viewer: { login: "example" }, node: { id: "ITEM_1", project: { id: project.id }, isArchived: false } } }));
      if (body.operationName === "RdmcpSetProjectItemField") return new Response(JSON.stringify({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_1" } } } }));
      if (body.operationName === "RdmcpCreateProject") return new Response(JSON.stringify({ data: { createProjectV2: { projectV2: { ...project, title: "New roadmap" } } } }));
      throw new Error(`Unexpected operation ${body.operationName}`);
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
    assert.deepEqual(tools.tools.map((tool) => tool.name), ["projects_list", "project_fields_list", "project_items_list"]);
    assert.deepEqual(tools.tools[0]?._meta?.securitySchemes, [{ type: "oauth2", scopes: ["github-projects:read"] }]);
    assert.doesNotMatch(JSON.stringify(tools.tools), /process_start|project_delete|visibility|collaborator|command|graphql/);
    const result = await connected.client.callTool({ name: "projects_list", arguments: { comment: "Read the project list" } });
    assert.equal(result.isError, undefined);
    assert.match(result.content.find((item) => item.type === "text")?.text ?? "", /Roadmap/);
    assert.ok(connected.audit.some((entry) => entry.event === "github_projects.completed" && entry.detail.tool === "projects_list"));
    const items = await connected.client.callTool({ name: "project_items_list", arguments: { project_id: "PVT_4", comment: "Read linked Issue and its Project fields" } });
    assert.match(items.content.find((item) => item.type === "text")?.text ?? "", /Work item/);
    const fields = await connected.client.callTool({ name: "project_fields_list", arguments: { project_id: "PVT_4", comment: "Read Project field definitions" } });
    assert.match(fields.content.find((item) => item.type === "text")?.text ?? "", /F_STATUS/);
  } finally { await connected.client.close(); await connected.server.close(); }
});

test("write scope adds only typed project metadata operations", async () => {
  const connected = await connectedServer(["github-projects:write"]);
  try {
    const tools = await connected.client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), ["projects_list", "project_fields_list", "project_items_list", "project_create", "project_update", "project_item_add", "project_item_set_field_value"]);
    assert.deepEqual(tools.tools[0]?._meta?.securitySchemes, [{ type: "oauth2", scopes: ["github-projects:write"] }]);
    const result = await connected.client.callTool({ name: "project_create", arguments: { title: "New roadmap", comment: "Create a personal project" } });
    assert.equal(result.isError, undefined);
    assert.match(result.content.find((item) => item.type === "text")?.text ?? "", /PVT_4/);
    assert.ok(connected.audit.some((entry) => entry.event === "github_projects.completed" && entry.detail.projectId === "PVT_4"));
    const added = await connected.client.callTool({ name: "project_item_add", arguments: { project_id: "PVT_4", content_id: "PR_1", comment: "Link a pull request" } });
    assert.match(added.content.find((item) => item.type === "text")?.text ?? "", /ITEM_2/);
    const updated = await connected.client.callTool({ name: "project_item_set_field_value", arguments: { project_id: "PVT_4", item_id: "ITEM_1", field_id: "F_STATUS", value: { type: "SINGLE_SELECT", option_id: "O_TODO" }, comment: "Set the Project status" } });
    assert.match(updated.content.find((item) => item.type === "text")?.text ?? "", /applied/);
  } finally { await connected.client.close(); await connected.server.close(); }
});
