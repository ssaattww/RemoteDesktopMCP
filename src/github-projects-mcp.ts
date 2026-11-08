import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GitHubProjectsApi, GitHubProjectsApiError } from "./github-projects-api.js";

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
