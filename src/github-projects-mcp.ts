import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GitHubProjectsApi, GitHubProjectsApiError, type GitHubProjectFieldValue } from "./github-projects-api.js";

export type GitHubProjectsScope = "github-projects:read" | "github-projects:write" | "github-projects:read github-projects:write";
export type GitHubProjectsAudit = (event: string, detail: Record<string, unknown>) => Promise<void>;

export function createGitHubProjectsServer(input: {
  api: GitHubProjectsApi;
  principal: string;
  scopes: readonly GitHubProjectsScope[];
  audit: GitHubProjectsAudit;
}): McpServer {
  const canRead = input.scopes.includes("github-projects:read") || input.scopes.includes("github-projects:write");
  const canWrite = input.scopes.includes("github-projects:write");
  const securitySchemes = [{ type: "oauth2" as const, scopes: [...new Set(input.scopes.flatMap((scope) => scope.split(" ")))] }];
  if (!canRead && !canWrite) throw new Error("A GitHub Projects scope is required.");

  const server = new McpServer({ name: "github-projects-mcp", version: "0.1.0" }, {
    instructions: "This connection exposes typed GitHub Projects operations only. It does not control the PC or expose arbitrary commands, URLs, or API requests. Project deletion, visibility, and access changes are not available.",
  });
  if (canRead) {
    server.registerTool("projects_list", {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description: "List the authenticated GitHub user's personal Projects. A short comment is required for the audit record.",
      inputSchema: { comment: z.string().trim().min(1).max(500) },
      _meta: { securitySchemes, "openai/securitySchemes": securitySchemes },
    }, async ({ comment }) => {
      await input.audit("github_projects.started", { principal: input.principal, tool: "projects_list", comment });
      try {
        const projects = await input.api.listProjects();
        await input.audit("github_projects.completed", { principal: input.principal, tool: "projects_list", count: projects.length });
        return { content: [{ type: "text", text: JSON.stringify(projects) }] };
      } catch (error) {
        await auditFailure(input.audit, input.principal, "projects_list", error);
        return { isError: true, content: [{ type: "text", text: "GitHub Projects could not be listed." }] };
      }
    });

    server.registerTool("project_fields_list", {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description: "List supported custom fields and single-select options for a personal Project. A short comment is required for the audit record.",
      inputSchema: { project_id: z.string().trim().min(1).max(200), comment: z.string().trim().min(1).max(500) },
      _meta: { securitySchemes, "openai/securitySchemes": securitySchemes },
    }, async ({ project_id, comment }) => {
      await input.audit("github_projects.started", { principal: input.principal, tool: "project_fields_list", projectId: project_id, comment });
      try {
        const fields = await input.api.listProjectFields(project_id);
        await input.audit("github_projects.completed", { principal: input.principal, tool: "project_fields_list", projectId: project_id, count: fields.length });
        return { content: [{ type: "text", text: JSON.stringify(fields) }] };
      } catch (error) {
        await auditFailure(input.audit, input.principal, "project_fields_list", error, project_id);
        return { isError: true, content: [{ type: "text", text: "Project fields could not be listed." }] };
      }
    });

    server.registerTool("project_items_list", {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description: "List Issue and pull request links and field values for a personal Project. Issue or pull request bodies and labels are not returned. A short comment is required for the audit record.",
      inputSchema: { project_id: z.string().trim().min(1).max(200), comment: z.string().trim().min(1).max(500) },
      _meta: { securitySchemes, "openai/securitySchemes": securitySchemes },
    }, async ({ project_id, comment }) => {
      await input.audit("github_projects.started", { principal: input.principal, tool: "project_items_list", projectId: project_id, comment });
      try {
        const items = await input.api.listProjectItems(project_id);
        await input.audit("github_projects.completed", { principal: input.principal, tool: "project_items_list", projectId: project_id, count: items.length });
        return { content: [{ type: "text", text: JSON.stringify(items) }] };
      } catch (error) {
        await auditFailure(input.audit, input.principal, "project_items_list", error, project_id);
        return { isError: true, content: [{ type: "text", text: "Project items could not be listed." }] };
      }
    });
  }

  if (canWrite) {
    server.registerTool("project_create", {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description: "Create a personal Project owned by the authenticated GitHub user. A short comment is required for the audit record.",
      inputSchema: { title: z.string().trim().min(1).max(256), comment: z.string().trim().min(1).max(500) },
      _meta: { securitySchemes, "openai/securitySchemes": securitySchemes },
    }, async ({ title, comment }) => {
      await input.audit("github_projects.started", { principal: input.principal, tool: "project_create", title, comment });
      try {
        const result = await input.api.createProject(title);
        await input.audit("github_projects.completed", { principal: input.principal, tool: "project_create", projectId: result.project.id, applied: true });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        await auditFailure(input.audit, input.principal, "project_create", error);
        return { isError: true, content: [{ type: "text", text: "The GitHub Project could not be created; check the operation result before deciding whether to try again." }] };
      }
    });

    server.registerTool("project_update", {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description: "Update the title and/or short description of a personal Project owned by the authenticated GitHub user. A short comment is required for the audit record.",
      inputSchema: {
        project_id: z.string().trim().min(1).max(200),
        title: z.string().trim().min(1).max(256).optional(),
        short_description: z.string().trim().max(2000).optional(),
        comment: z.string().trim().min(1).max(500),
      },
      _meta: { securitySchemes, "openai/securitySchemes": securitySchemes },
    }, async ({ project_id, title, short_description, comment }) => {
      await input.audit("github_projects.started", { principal: input.principal, tool: "project_update", projectId: project_id, comment });
      try {
        const result = await input.api.updateProject(project_id, { title, shortDescription: short_description });
        await input.audit("github_projects.completed", { principal: input.principal, tool: "project_update", projectId: result.project.id, applied: true });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        await auditFailure(input.audit, input.principal, "project_update", error, project_id);
        return { isError: true, content: [{ type: "text", text: "The GitHub Project could not be updated; check the operation result before deciding whether to try again." }] };
      }
    });

    server.registerTool("project_item_add", {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description: "Add an existing Issue or pull request to a personal Project by its GitHub node ID. This changes only the Project link, not the Issue or pull request itself. A short comment is required for the audit record.",
      inputSchema: { project_id: z.string().trim().min(1).max(200), content_id: z.string().trim().min(1).max(200), comment: z.string().trim().min(1).max(500) },
      _meta: { securitySchemes, "openai/securitySchemes": securitySchemes },
    }, async ({ project_id, content_id, comment }) => {
      await input.audit("github_projects.started", { principal: input.principal, tool: "project_item_add", projectId: project_id, contentId: content_id, comment });
      try {
        const result = await input.api.addIssueOrPullRequest(project_id, content_id);
        await input.audit("github_projects.completed", { principal: input.principal, tool: "project_item_add", projectId: project_id, itemId: result.itemId, applied: true });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        await auditFailure(input.audit, input.principal, "project_item_add", error, project_id);
        return { isError: true, content: [{ type: "text", text: "The Issue or pull request could not be added; check the result before deciding whether to try again." }] };
      }
    });

    server.registerTool("project_item_set_field_value", {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description: "Set a Project item's supported custom text, number, date, or single-select field. Issue or pull request fields such as labels, assignees, milestone, state, title, and body are excluded. A short comment is required for the audit record.",
      inputSchema: {
        project_id: z.string().trim().min(1).max(200),
        item_id: z.string().trim().min(1).max(200),
        field_id: z.string().trim().min(1).max(200),
        value: z.discriminatedUnion("type", [
          z.object({ type: z.literal("TEXT"), text: z.string().max(10_000) }),
          z.object({ type: z.literal("NUMBER"), number: z.number().finite() }),
          z.object({ type: z.literal("DATE"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
          z.object({ type: z.literal("SINGLE_SELECT"), option_id: z.string().trim().min(1).max(200) }),
        ]),
        comment: z.string().trim().min(1).max(500),
      },
      _meta: { securitySchemes, "openai/securitySchemes": securitySchemes },
    }, async ({ project_id, item_id, field_id, value, comment }) => {
      await input.audit("github_projects.started", { principal: input.principal, tool: "project_item_set_field_value", projectId: project_id, itemId: item_id, fieldId: field_id, comment });
      const apiValue: GitHubProjectFieldValue = value.type === "TEXT" ? value : value.type === "NUMBER" ? value : value.type === "DATE" ? value : { type: "SINGLE_SELECT", optionId: value.option_id };
      try {
        const outcome = await input.api.setProjectItemField(project_id, item_id, field_id, apiValue);
        await input.audit("github_projects.completed", { principal: input.principal, tool: "project_item_set_field_value", projectId: project_id, itemId: item_id, fieldId: field_id, applied: outcome.applied });
        return { content: [{ type: "text", text: JSON.stringify(outcome) }] };
      } catch (error) {
        await auditFailure(input.audit, input.principal, "project_item_set_field_value", error, project_id);
        return { isError: true, content: [{ type: "text", text: "The Project field value could not be set; check the result before deciding whether to try again." }] };
      }
    });
  }

  return server;
}

async function auditFailure(audit: GitHubProjectsAudit, principal: string, tool: string, error: unknown, projectId?: string): Promise<void> {
  const apiError = error instanceof GitHubProjectsApiError ? error : undefined;
  await audit("github_projects.failed", {
    principal,
    tool,
    ...(projectId ? { projectId } : {}),
    ...(apiError ? { errorCode: apiError.code, applied: apiError.applied } : { errorCode: "operation_failed" }),
  });
}
