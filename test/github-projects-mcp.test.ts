import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GitHubProjectsApi } from "../src/github-projects-api.js";
import { createGitHubProjectsServer, type GitHubProjectsScope } from "../src/github-projects-mcp.js";

const project = { id: "PVT_4", title: "Roadmap", number: 4, url: "https://github.com/users/example/projects/4", closed: false, public: false };

async function connectedServer(scopes: GitHubProjectsScope[], failCreate = false, largeDraftRecovery = false) {
  const audit: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const operations: string[] = [];
  let draftReadAttempts = 0;
  const recoveryBody = "x".repeat(65_536);
  const draftItems = Array.from({ length: 17 }, (_, index) => ({ id: `ITEM_DRAFT_${index + 1}`, type: "DRAFT_ISSUE", isArchived: false, content: { __typename: "DraftIssue", id: `DRAFT_${index + 1}`, title: index === 9 ? "Recovery target" : `Draft ${index + 1}`, body: recoveryBody }, fieldValues: { nodes: [], pageInfo: { hasNextPage: false } } }));
  let statusCleared = false;
  const api = new GitHubProjectsApi("google:issuer:subject", "example", { async getToken() { return "opaque-test-token"; } }, {
    request: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer opaque-test-token");
      const body = JSON.parse(String(init?.body)) as { operationName: string; variables: Record<string, unknown> };
      operations.push(body.operationName);
      if (body.operationName === "RdmcpListProjects") return new Response(JSON.stringify({ data: { viewer: { login: "example", projectsV2: { nodes: [project], pageInfo: { hasNextPage: false, endCursor: null } } } } }));
      if (body.operationName === "RdmcpViewerId") return new Response(JSON.stringify({ data: { viewer: { id: "U_1", login: "example" } } }));
      if (body.operationName === "RdmcpProjectFields") return new Response(JSON.stringify({ data: { viewer: { login: "example" }, node: { id: project.id, owner: { login: "example" }, fields: { nodes: [{ __typename: "ProjectV2Field", id: "F_TEXT", name: "Notes", dataType: "TEXT", isIssueField: false }, { __typename: "ProjectV2SingleSelectField", id: "F_STATUS", name: "Status", dataType: "SINGLE_SELECT", isIssueField: false, options: [{ id: "O_TODO", name: "Todo", color: "GRAY", description: "" }] }], pageInfo: { hasNextPage: false } } } } }));
      if (body.operationName === "RdmcpProjectViews") return new Response(JSON.stringify({ data: { viewer: { login: "example" }, node: { id: project.id, owner: { login: "example" }, views: { nodes: [{ id: "V_1", name: "Default", layout: "TABLE_LAYOUT", filter: "", configuration: { visibleFields: { nodes: [{ id: "F_TEXT" }], pageInfo: { hasNextPage: false } } } }], pageInfo: { hasNextPage: false } } } } }));
      if (body.operationName === "RdmcpProjectItems") {
        if (largeDraftRecovery) {
          assert.match(body.query, /\.\.\. on DraftIssue \{ id title \}/);
          assert.doesNotMatch(body.query, /\.\.\. on DraftIssue \{ id title body \}/);
          assert.ok(Buffer.byteLength(JSON.stringify(draftItems), "utf8") > 1024 * 1024);
        }
        const nodes = largeDraftRecovery ? draftItems.map((item) => ({ ...item, content: { ...item.content, body: undefined } })) : [{ id: "ITEM_1", type: "ISSUE", isArchived: false, content: { __typename: "Issue", id: "ISSUE_5", title: "Work item", number: 5, url: "https://github.com/example/repo/issues/5" }, fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldTextValue", text: "note", field: { id: "F_TEXT", name: "Notes" } }], pageInfo: { hasNextPage: false } } }];
        return new Response(JSON.stringify({ data: { viewer: { login: "example" }, node: { id: project.id, owner: { login: "example" }, items: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } }));
      }
      if (body.operationName === "RdmcpCreateDraft") return new Response(JSON.stringify({ data: { addProjectV2DraftIssue: { projectItem: { id: "ITEM_DRAFT_10" } } } }));
      if (body.operationName === "RdmcpDraftState") {
        draftReadAttempts += 1;
        if (largeDraftRecovery && draftReadAttempts === 1) return new Response("{}", { status: 503 });
        return new Response(JSON.stringify({ data: { viewer: { login: "example" }, node: { id: "ITEM_DRAFT_10", project: { id: project.id }, content: { __typename: "DraftIssue", id: "DRAFT_10", title: "Recovery target", body: recoveryBody } } } }));
      }
      if (body.operationName === "RdmcpProjectState") return new Response(JSON.stringify({ data: { viewer: { login: "example" }, node: { ...project, title: "New roadmap", shortDescription: "", owner: { login: "example" } } } }));
      if (body.operationName === "RdmcpProjectOwner") return new Response(JSON.stringify({ data: { viewer: { login: "example" }, node: { id: project.id, owner: { login: "example" } } } }));
      if (body.operationName === "RdmcpIssueOrPullRequest") return new Response(JSON.stringify({ data: { viewer: { login: "example" }, node: { __typename: "PullRequest", id: "PR_1" } } }));
      if (body.operationName === "RdmcpAddProjectItem") return new Response(JSON.stringify({ data: { addProjectV2ItemById: { item: { id: "ITEM_2", type: "PULL_REQUEST" } } } }));
      if (body.operationName === "RdmcpProjectItemState") return new Response(JSON.stringify({ data: { viewer: { login: "example" }, node: { id: body.variables.itemId, type: body.variables.itemId === "ITEM_2" ? "PULL_REQUEST" : "ISSUE", project: { id: project.id }, isArchived: false, content: body.variables.itemId === "ITEM_2" ? { __typename: "PullRequest", id: "PR_1", title: "Change", number: 1, url: "https://github.com/example/repo/pull/1" } : { __typename: "Issue", id: "ISSUE_5", title: "Work item", number: 5, url: "https://github.com/example/repo/issues/5" }, fieldValues: { nodes: body.variables.itemId === "ITEM_1" && statusCleared ? [] : [{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Todo", optionId: "O_TODO", field: { id: "F_STATUS", name: "Status" } }], pageInfo: { hasNextPage: false } } } } }));
      if (body.operationName === "RdmcpProjectItemOwner") return new Response(JSON.stringify({ data: { viewer: { login: "example" }, node: { id: "ITEM_1", project: { id: project.id }, isArchived: false } } }));
      if (body.operationName === "RdmcpSetProjectItemField") return new Response(JSON.stringify({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_1" } } } }));
      if (body.operationName === "RdmcpClearProjectItemField") { statusCleared = true; return new Response(JSON.stringify({ data: { clearProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_1" } } } })); }
      if (body.operationName === "RdmcpCreateProject") return new Response(JSON.stringify(failCreate ? { data: { createProjectV2: null }, errors: [{ message: "private token and response details" }] } : { data: { createProjectV2: { projectV2: { ...project, title: "New roadmap" } } } }));
      throw new Error(`Unexpected operation ${body.operationName}`);
    },
  });
  const server = createGitHubProjectsServer({ api, principal: "google:issuer:subject", scopes, audit: async (event, detail) => { audit.push({ event, detail }); } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "github-projects-test", version: "1" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server, audit, operations };
}

test("read scope exposes only read tools and calls the fixed API client", async () => {
  const connected = await connectedServer(["github-projects:read"]);
  try {
    const tools = await connected.client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), ["projects_list", "project_fields_list", "project_views_list", "project_items_list", "project_draft_get", "project_readme_get"]);
    assert.deepEqual(tools.tools[0]?._meta?.securitySchemes, [{ type: "oauth2", scopes: ["github-projects:read"] }]);
    assert.doesNotMatch(JSON.stringify(tools.tools), /process_start|project_delete|visibility|collaborator|command|graphql/);
    const result = await connected.client.callTool({ name: "projects_list", arguments: {} });
    assert.equal(result.isError, undefined);
    assert.match(result.content.find((item) => item.type === "text")?.text ?? "", /Roadmap/);
    assert.ok(connected.audit.some((entry) => entry.event === "github_projects.completed" && entry.detail.tool === "projects_list"));
    const items = await connected.client.callTool({ name: "project_items_list", arguments: { project_id: "PVT_4" } });
    assert.match(items.content.find((item) => item.type === "text")?.text ?? "", /Work item/);
    const fields = await connected.client.callTool({ name: "project_fields_list", arguments: { project_id: "PVT_4" } });
    assert.match(fields.content.find((item) => item.type === "text")?.text ?? "", /F_STATUS/);
    const views = await connected.client.callTool({ name: "project_views_list", arguments: { project_id: "PVT_4" } });
    assert.match(views.content.find((item) => item.type === "text")?.text ?? "", /TABLE_LAYOUT/);
  } finally { await connected.client.close(); await connected.server.close(); }
});

test("write scope adds only typed project metadata operations", async () => {
  const connected = await connectedServer(["github-projects:write"]);
  try {
    const tools = await connected.client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), ["projects_list", "project_fields_list", "project_views_list", "project_items_list", "project_draft_get", "project_readme_get", "project_create", "project_update", "project_readme_update", "project_draft_create", "project_draft_update", "project_draft_convert", "project_item_archive", "project_item_restore", "project_item_remove", "project_item_add", "project_item_set_field_value", "project_item_clear_field_value", "project_field_create", "project_field_update", "project_field_delete", "project_view_create", "project_view_update", "project_view_delete"]);
    assert.equal((tools.tools.find((tool) => tool.name === "project_draft_convert")?.inputSchema as { properties?: Record<string, unknown> })?.properties && "repository_id" in ((tools.tools.find((tool) => tool.name === "project_draft_convert")?.inputSchema as { properties: Record<string, unknown> }).properties), true);
    assert.equal(tools.tools.find((tool) => tool.name === "project_item_restore")?.annotations?.destructiveHint, false);
    assert.equal(tools.tools.find((tool) => tool.name === "project_item_remove")?.annotations?.destructiveHint, true);
    assert.deepEqual(tools.tools[0]?._meta?.securitySchemes, [{ type: "oauth2", scopes: ["github-projects:write"] }]);
    const result = await connected.client.callTool({ name: "project_create", arguments: { title: "New roadmap" } });
    assert.equal(result.isError, undefined);
    assert.match(result.content.find((item) => item.type === "text")?.text ?? "", /PVT_4/);
    assert.ok(connected.audit.some((entry) => entry.event === "github_projects.completed" && entry.detail.projectId === "PVT_4"));
    const started = connected.audit.find((entry) => entry.event === "github_projects.started" && entry.detail.tool === "project_create");
    assert.deepEqual(started?.detail, { principal: "google:issuer:subject", tool: "project_create" });
    const added = await connected.client.callTool({ name: "project_item_add", arguments: { project_id: "PVT_4", content_id: "PR_1" } });
    assert.match(added.content.find((item) => item.type === "text")?.text ?? "", /ITEM_2/);
    const updated = await connected.client.callTool({ name: "project_item_set_field_value", arguments: { project_id: "PVT_4", item_id: "ITEM_1", field_id: "F_STATUS", value: { type: "SINGLE_SELECT", option_id: "O_TODO" } } });
    assert.match(updated.content.find((item) => item.type === "text")?.text ?? "", /applied/);
    const cleared = await connected.client.callTool({ name: "project_item_clear_field_value", arguments: { project_id: "PVT_4", item_id: "ITEM_1", field_id: "F_STATUS" } });
    assert.match(cleared.content.find((item) => item.type === "text")?.text ?? "", /applied/);
    assert.ok(connected.audit.some((entry) => entry.event === "github_projects.completed" && entry.detail.tool === "project_item_clear_field_value"));
  } finally { await connected.client.close(); await connected.server.close(); }
});

test("mutation failures expose a fixed code and outcome without leaking API details", async () => {
  const connected = await connectedServer(["github-projects:write"], true);
  try {
    const result = await connected.client.callTool({ name: "project_create", arguments: { title: "Sensitive title" } });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, { errorCode: "api_error", applied: "unknown", recoveryNotice: false });
    assert.doesNotMatch(JSON.stringify(result), /private token|response details|Sensitive title/);
    const started = connected.audit.find((entry) => entry.event === "github_projects.started" && entry.detail.tool === "project_create");
    assert.deepEqual(started?.detail, { principal: "google:issuer:subject", tool: "project_create" });
  } finally { await connected.client.close(); await connected.server.close(); }
});

test("an empty draft update is rejected before any GitHub request", async () => {
  const connected = await connectedServer(["github-projects:write"]);
  try {
    const before = connected.operations.length;
    const result = await connected.client.callTool({ name: "project_draft_update", arguments: { project_id: "PVT_4", item_id: "ITEM_DRAFT" } });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, { errorCode: "invalid_input", applied: false, recoveryNotice: false });
    assert.equal(connected.operations.length, before);
  } finally { await connected.client.close(); await connected.server.close(); }
});

test("a failed create readback can be recovered with bounded list metadata and an individual draft read", async () => {
  const connected = await connectedServer(["github-projects:write"], false, true);
  try {
    const created = await connected.client.callTool({ name: "project_draft_create", arguments: { project_id: "PVT_4", title: "Recovery target", body: "x".repeat(65_536) } });
    assert.equal(created.isError, true);
    assert.deepEqual(created.structuredContent, { errorCode: "api_error", applied: "unknown", recoveryNotice: false, itemId: "ITEM_DRAFT_10" });

    const listed = await connected.client.callTool({ name: "project_items_list", arguments: { project_id: "PVT_4" } });
    assert.equal(listed.isError, undefined);
    const listedItems = JSON.parse(listed.content.find((entry) => entry.type === "text")?.text ?? "[]") as Array<{ id: string; content: { id: string; type: string; title: string; body?: string } | null }>;
    assert.equal(listedItems.length, 17);
    assert.deepEqual(listedItems[9]?.content, { id: "DRAFT_10", type: "DraftIssue", title: "Recovery target" });
    assert.ok(!listedItems.some((entry) => entry.content && "body" in entry.content));
    assert.ok(Buffer.byteLength(JSON.stringify(listedItems), "utf8") < 1024 * 1024);

    const read = await connected.client.callTool({ name: "project_draft_get", arguments: { project_id: "PVT_4", item_id: "ITEM_DRAFT_10" } });
    assert.equal(read.isError, undefined);
    const draft = JSON.parse(read.content.find((entry) => entry.type === "text")?.text ?? "{}") as { id: string; title: string; body: string };
    assert.equal(draft.id, "ITEM_DRAFT_10");
    assert.equal(draft.title, "Recovery target");
    assert.equal(draft.body, "x".repeat(65_536));
  } finally { await connected.client.close(); await connected.server.close(); }
});
