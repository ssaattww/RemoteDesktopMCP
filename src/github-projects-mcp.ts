import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GitHubProjectsApi, GitHubProjectsApiError, type GitHubProjectFieldDefinition, type GitHubProjectFieldValue, type GitHubProjectViewInput } from "./github-projects-api.js";

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
      description: "List the authenticated GitHub user's personal Projects.",
      _meta: { securitySchemes, "openai/securitySchemes": securitySchemes },
    }, async () => {
      await input.audit("github_projects.started", { principal: input.principal, tool: "projects_list" });
      try {
        const projects = await input.api.listProjects();
        await input.audit("github_projects.completed", { principal: input.principal, tool: "projects_list", count: projects.length });
        return { content: [{ type: "text", text: JSON.stringify(projects) }] };
      } catch (error) {
        await auditFailure(input.audit, input.principal, "projects_list", error);
        return operationError("GitHub Projects could not be listed.", error, false);
      }
    });

    server.registerTool("project_fields_list", {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description: "List supported custom fields and single-select options for a personal Project.",
      inputSchema: { project_id: z.string().trim().min(1).max(200) },
      _meta: { securitySchemes, "openai/securitySchemes": securitySchemes },
    }, async ({ project_id }) => {
      await input.audit("github_projects.started", { principal: input.principal, tool: "project_fields_list", projectId: project_id });
      try {
        const fields = await input.api.listProjectFields(project_id);
        await input.audit("github_projects.completed", { principal: input.principal, tool: "project_fields_list", projectId: project_id, count: fields.length });
        return { content: [{ type: "text", text: JSON.stringify(fields) }] };
      } catch (error) {
        await auditFailure(input.audit, input.principal, "project_fields_list", error, project_id);
        return operationError("Project fields could not be listed.", error, false);
      }
    });

    server.registerTool("project_views_list", {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description: "List views of a personal Project, including layout, filter, and visible fields.",
      inputSchema: { project_id: z.string().trim().min(1).max(200) },
      _meta: { securitySchemes, "openai/securitySchemes": securitySchemes },
    }, async ({ project_id }) => {
      await input.audit("github_projects.started", { principal: input.principal, tool: "project_views_list", projectId: project_id });
      try {
        const views = await input.api.listProjectViews(project_id);
        await input.audit("github_projects.completed", { principal: input.principal, tool: "project_views_list", projectId: project_id, count: views.length });
        return { content: [{ type: "text", text: JSON.stringify(views) }] };
      } catch (error) {
        await auditFailure(input.audit, input.principal, "project_views_list", error, project_id);
        return operationError("Project views could not be listed.", error, false);
      }
    });

    server.registerTool("project_items_list", {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description: "List Issue and pull request links and field values for a personal Project. Issue or pull request bodies and labels are not returned.",
      inputSchema: { project_id: z.string().trim().min(1).max(200) },
      _meta: { securitySchemes, "openai/securitySchemes": securitySchemes },
    }, async ({ project_id }) => {
      await input.audit("github_projects.started", { principal: input.principal, tool: "project_items_list", projectId: project_id });
      try {
        const items = await input.api.listProjectItems(project_id);
        await input.audit("github_projects.completed", { principal: input.principal, tool: "project_items_list", projectId: project_id, count: items.length });
        return { content: [{ type: "text", text: JSON.stringify(items) }] };
      } catch (error) {
        await auditFailure(input.audit, input.principal, "project_items_list", error, project_id);
        return operationError("Project items could not be listed.", error, false);
      }
    });
  }

  if (canWrite) {
    server.registerTool("project_create", {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description: "Create a personal Project owned by the authenticated GitHub user.",
      inputSchema: { title: z.string().trim().min(1).max(256) },
      _meta: { securitySchemes, "openai/securitySchemes": securitySchemes },
    }, async ({ title }) => {
      await input.audit("github_projects.started", { principal: input.principal, tool: "project_create" });
      try {
        const result = await input.api.createProject(title);
        await input.audit("github_projects.completed", { principal: input.principal, tool: "project_create", projectId: result.project.id, applied: true });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        await auditFailure(input.audit, input.principal, "project_create", error);
        return operationError("The GitHub Project could not be created; check its current state before deciding whether to try again.", error, true);
      }
    });

    server.registerTool("project_update", {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description: "Update the title and/or short description of a personal Project owned by the authenticated GitHub user.",
      inputSchema: {
        project_id: z.string().trim().min(1).max(200),
        title: z.string().trim().min(1).max(256).optional(),
        short_description: z.string().trim().max(2000).optional(),
      },
      _meta: { securitySchemes, "openai/securitySchemes": securitySchemes },
    }, async ({ project_id, title, short_description }) => {
      await input.audit("github_projects.started", { principal: input.principal, tool: "project_update", projectId: project_id });
      try {
        const result = await input.api.updateProject(project_id, { title, shortDescription: short_description });
        await input.audit("github_projects.completed", { principal: input.principal, tool: "project_update", projectId: result.project.id, applied: true });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        await auditFailure(input.audit, input.principal, "project_update", error, project_id);
        return operationError("The GitHub Project could not be updated; check its current state before deciding whether to try again.", error, true);
      }
    });

    server.registerTool("project_item_add", {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description: "Add an existing Issue or pull request to a personal Project by its GitHub node ID. This changes only the Project link, not the Issue or pull request itself.",
      inputSchema: { project_id: z.string().trim().min(1).max(200), content_id: z.string().trim().min(1).max(200) },
      _meta: { securitySchemes, "openai/securitySchemes": securitySchemes },
    }, async ({ project_id, content_id }) => {
      await input.audit("github_projects.started", { principal: input.principal, tool: "project_item_add", projectId: project_id });
      try {
        const result = await input.api.addIssueOrPullRequest(project_id, content_id);
        await input.audit("github_projects.completed", { principal: input.principal, tool: "project_item_add", projectId: project_id, itemId: result.itemId, applied: true });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        await auditFailure(input.audit, input.principal, "project_item_add", error, project_id);
        return operationError("The Issue or pull request could not be added; check its current state before deciding whether to try again.", error, true);
      }
    });

    server.registerTool("project_item_set_field_value", {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description: "Set a Project item's supported custom text, number, date, single-select, multi-select, or iteration field. Issue or pull request fields such as labels, assignees, milestone, state, title, and body are excluded.",
      inputSchema: {
        project_id: z.string().trim().min(1).max(200),
        item_id: z.string().trim().min(1).max(200),
        field_id: z.string().trim().min(1).max(200),
        value: z.discriminatedUnion("type", [
          z.object({ type: z.literal("TEXT"), text: z.string().max(10_000) }),
          z.object({ type: z.literal("NUMBER"), number: z.number().finite() }),
          z.object({ type: z.literal("DATE"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
          z.object({ type: z.literal("SINGLE_SELECT"), option_id: z.string().trim().min(1).max(200) }),
          z.object({ type: z.literal("MULTI_SELECT"), option_ids: z.array(z.string().trim().min(1).max(200)).min(1).max(100) }),
          z.object({ type: z.literal("ITERATION"), iteration_id: z.string().trim().min(1).max(200) }),
        ]),
      },
      _meta: { securitySchemes, "openai/securitySchemes": securitySchemes },
    }, async ({ project_id, item_id, field_id, value }) => {
      await input.audit("github_projects.started", { principal: input.principal, tool: "project_item_set_field_value", projectId: project_id, itemId: item_id, fieldId: field_id });
      const apiValue: GitHubProjectFieldValue = value.type === "TEXT" ? value : value.type === "NUMBER" ? value : value.type === "DATE" ? value : value.type === "SINGLE_SELECT" ? { type: "SINGLE_SELECT", optionId: value.option_id } : value.type === "MULTI_SELECT" ? { type: "MULTI_SELECT", optionIds: value.option_ids } : { type: "ITERATION", iterationId: value.iteration_id };
      try {
        const outcome = await input.api.setProjectItemField(project_id, item_id, field_id, apiValue);
        await input.audit("github_projects.completed", { principal: input.principal, tool: "project_item_set_field_value", projectId: project_id, itemId: item_id, fieldId: field_id, applied: outcome.applied });
        return { content: [{ type: "text", text: JSON.stringify(outcome) }] };
      } catch (error) {
        await auditFailure(input.audit, input.principal, "project_item_set_field_value", error, project_id);
        return operationError("The Project field value could not be set; check its current state before deciding whether to try again.", error, true);
      }
    });

    server.registerTool("project_item_clear_field_value", {
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      description: "Clear a Project item's custom field value. Issue-derived fields such as labels, assignees, and milestone are excluded.",
      inputSchema: {
        project_id: z.string().trim().min(1).max(200),
        item_id: z.string().trim().min(1).max(200),
        field_id: z.string().trim().min(1).max(200),
      },
      _meta: { securitySchemes, "openai/securitySchemes": securitySchemes },
    }, async ({ project_id, item_id, field_id }) => {
      await input.audit("github_projects.started", { principal: input.principal, tool: "project_item_clear_field_value", projectId: project_id, itemId: item_id, fieldId: field_id });
      try {
        const outcome = await input.api.clearProjectItemField(project_id, item_id, field_id);
        await input.audit("github_projects.completed", { principal: input.principal, tool: "project_item_clear_field_value", projectId: project_id, itemId: item_id, fieldId: field_id, applied: outcome.applied });
        return { content: [{ type: "text", text: JSON.stringify(outcome) }] };
      } catch (error) {
        await auditFailure(input.audit, input.principal, "project_item_clear_field_value", error, project_id);
        return operationError("The Project field value could not be cleared; check its current state before deciding whether to try again.", error, true);
      }
    });

    const iterationConfigurationSchema = z.object({
      duration: z.number().int().min(1).max(365),
      start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      iterations: z.array(z.object({ id: z.string().trim().min(1).max(200).optional(), title: z.string().trim().min(1).max(256), start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), duration: z.number().int().min(1).max(365) })).max(100),
    });
    const fieldDefinitionSchema = z.discriminatedUnion("type", [
      z.object({ type: z.enum(["TEXT", "NUMBER", "DATE"]), name: z.string().trim().min(1).max(256) }),
      z.object({ type: z.literal("SINGLE_SELECT"), name: z.string().trim().min(1).max(256), options: z.array(z.object({ id: z.string().trim().min(1).max(200).optional(), name: z.string().trim().min(1).max(256), color: z.enum(["BLUE", "GRAY", "GREEN", "ORANGE", "PINK", "PURPLE", "RED", "YELLOW"]).optional(), description: z.string().max(1000).optional() })).min(1).max(100) }),
      z.object({ type: z.literal("MULTI_SELECT"), name: z.string().trim().min(1).max(256), options: z.array(z.object({ id: z.string().trim().min(1).max(200).optional(), name: z.string().trim().min(1).max(256), color: z.enum(["BLUE", "GRAY", "GREEN", "ORANGE", "PINK", "PURPLE", "RED", "YELLOW"]).optional(), description: z.string().max(1000).optional() })).min(1).max(100) }),
      z.object({ type: z.literal("ITERATION"), name: z.string().trim().min(1).max(256), iteration_configuration: iterationConfigurationSchema }),
    ]);
    const toFieldDefinition = (definition: z.infer<typeof fieldDefinitionSchema>): GitHubProjectFieldDefinition => {
      if (definition.type !== "ITERATION") return definition;
      const config = definition.iteration_configuration;
      return { type: definition.type, name: definition.name, ...(config ? { iterationConfiguration: { duration: config.duration, startDate: config.start_date, iterations: config.iterations.map((iteration) => ({ ...(iteration.id ? { id: iteration.id } : {}), title: iteration.title, startDate: iteration.start_date, duration: iteration.duration })) } } : {}) };
    };

    server.registerTool("project_field_create", {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description: "Create a supported custom text, number, date, single-select, or iteration field for a personal Project.",
      inputSchema: { project_id: z.string().trim().min(1).max(200), definition: fieldDefinitionSchema },
      _meta: { securitySchemes, "openai/securitySchemes": securitySchemes },
    }, async ({ project_id, definition }) => {
      await input.audit("github_projects.started", { principal: input.principal, tool: "project_field_create", projectId: project_id });
      try {
        const result = await input.api.createProjectField(project_id, toFieldDefinition(definition));
        await input.audit("github_projects.completed", { principal: input.principal, tool: "project_field_create", projectId: project_id, fieldId: result.field.id, applied: result.outcome.applied });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        await auditFailure(input.audit, input.principal, "project_field_create", error, project_id);
        return operationError("The Project field could not be created; check its current state before deciding whether to try again.", error, true);
      }
    });

    server.registerTool("project_field_update", {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description: "Update a supported custom Project field. Existing option or iteration IDs can be supplied to preserve their identities.",
      inputSchema: {
        project_id: z.string().trim().min(1).max(200), field_id: z.string().trim().min(1).max(200),
        definition: z.object({ name: z.string().trim().min(1).max(256).optional(), options: z.array(z.object({ id: z.string().trim().min(1).max(200).optional(), name: z.string().trim().min(1).max(256), color: z.enum(["BLUE", "GRAY", "GREEN", "ORANGE", "PINK", "PURPLE", "RED", "YELLOW"]).optional(), description: z.string().max(1000).optional() })).max(100).optional(), iteration_configuration: iterationConfigurationSchema.optional() }),
      },
      _meta: { securitySchemes, "openai/securitySchemes": securitySchemes },
    }, async ({ project_id, field_id, definition }) => {
      await input.audit("github_projects.started", { principal: input.principal, tool: "project_field_update", projectId: project_id, fieldId: field_id });
      try {
        const result = await input.api.updateProjectField(project_id, field_id, {
          ...(definition.name ? { name: definition.name } : {}), ...(definition.options ? { options: definition.options } : {}),
          ...(definition.iteration_configuration ? { iterationConfiguration: { duration: definition.iteration_configuration.duration, startDate: definition.iteration_configuration.start_date, iterations: definition.iteration_configuration.iterations.map((iteration) => ({ ...(iteration.id ? { id: iteration.id } : {}), title: iteration.title, startDate: iteration.start_date, duration: iteration.duration })) } } : {}),
        });
        await input.audit("github_projects.completed", { principal: input.principal, tool: "project_field_update", projectId: project_id, fieldId: field_id, applied: result.outcome.applied });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        await auditFailure(input.audit, input.principal, "project_field_update", error, project_id);
        return operationError("The Project field could not be updated; check its current state before deciding whether to try again.", error, true);
      }
    });

    server.registerTool("project_field_delete", {
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      description: "Delete a supported custom Project field. Existing values for this field may be removed.",
      inputSchema: { project_id: z.string().trim().min(1).max(200), field_id: z.string().trim().min(1).max(200) },
      _meta: { securitySchemes, "openai/securitySchemes": securitySchemes },
    }, async ({ project_id, field_id }) => {
      await input.audit("github_projects.started", { principal: input.principal, tool: "project_field_delete", projectId: project_id, fieldId: field_id });
      try {
        const result = await input.api.deleteProjectField(project_id, field_id);
        await input.audit("github_projects.completed", { principal: input.principal, tool: "project_field_delete", projectId: project_id, fieldId: field_id, applied: result.applied });
        return { content: [{ type: "text", text: JSON.stringify({ ...result, warning: "Existing values for the deleted field may have been removed." }) }] };
      } catch (error) {
        await auditFailure(input.audit, input.principal, "project_field_delete", error, project_id);
        return operationError("The Project field could not be deleted; check its current state before deciding whether to try again.", error, true);
      }
    });

    const viewInputSchema = z.object({ name: z.string().trim().min(1).max(256).optional(), layout: z.enum(["TABLE_LAYOUT", "BOARD_LAYOUT", "ROADMAP_LAYOUT"]).optional(), filter: z.string().max(10_000).optional(), visible_field_ids: z.array(z.string().trim().min(1).max(200)).max(100).optional() });
    const toViewInput = (value: z.infer<typeof viewInputSchema>): GitHubProjectViewInput => ({ ...(value.name ? { name: value.name } : {}), ...(value.layout ? { layout: value.layout } : {}), ...(value.filter !== undefined ? { filter: value.filter } : {}), ...(value.visible_field_ids ? { visibleFieldIds: value.visible_field_ids } : {}) });
    server.registerTool("project_view_create", {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description: "Create a Project view with a supported layout, filter, and visible-field selection.",
      inputSchema: { project_id: z.string().trim().min(1).max(200), name: z.string().trim().min(1).max(256), layout: z.enum(["TABLE_LAYOUT", "BOARD_LAYOUT", "ROADMAP_LAYOUT"]), filter: z.string().max(10_000).optional(), visible_field_ids: z.array(z.string().trim().min(1).max(200)).max(100).optional() },
      _meta: { securitySchemes, "openai/securitySchemes": securitySchemes },
    }, async ({ project_id, name, layout, filter, visible_field_ids }) => {
      await input.audit("github_projects.started", { principal: input.principal, tool: "project_view_create", projectId: project_id });
      try {
        const result = await input.api.createProjectView(project_id, { name, layout, ...(filter !== undefined ? { filter } : {}), ...(visible_field_ids ? { visibleFieldIds: visible_field_ids } : {}) });
        await input.audit("github_projects.completed", { principal: input.principal, tool: "project_view_create", projectId: project_id, viewId: result.view.id, applied: result.outcome.applied });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        await auditFailure(input.audit, input.principal, "project_view_create", error, project_id);
        return operationError("The Project view could not be created; check its current state before deciding whether to try again.", error, true);
      }
    });

    server.registerTool("project_view_update", {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description: "Update a Project view's name, layout, filter, or visible fields. Sorting and grouping changes are not exposed.",
      inputSchema: { project_id: z.string().trim().min(1).max(200), view_id: z.string().trim().min(1).max(200), changes: viewInputSchema },
      _meta: { securitySchemes, "openai/securitySchemes": securitySchemes },
    }, async ({ project_id, view_id, changes }) => {
      await input.audit("github_projects.started", { principal: input.principal, tool: "project_view_update", projectId: project_id, viewId: view_id });
      try {
        const result = await input.api.updateProjectView(project_id, view_id, toViewInput(changes));
        await input.audit("github_projects.completed", { principal: input.principal, tool: "project_view_update", projectId: project_id, viewId: view_id, applied: result.outcome.applied });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        await auditFailure(input.audit, input.principal, "project_view_update", error, project_id);
        return operationError("The Project view could not be updated; check its current state before deciding whether to try again.", error, true);
      }
    });

    server.registerTool("project_view_delete", {
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      description: "Delete a Project view without deleting or changing the Project itself.",
      inputSchema: { project_id: z.string().trim().min(1).max(200), view_id: z.string().trim().min(1).max(200) },
      _meta: { securitySchemes, "openai/securitySchemes": securitySchemes },
    }, async ({ project_id, view_id }) => {
      await input.audit("github_projects.started", { principal: input.principal, tool: "project_view_delete", projectId: project_id, viewId: view_id });
      try {
        const result = await input.api.deleteProjectView(project_id, view_id);
        await input.audit("github_projects.completed", { principal: input.principal, tool: "project_view_delete", projectId: project_id, viewId: view_id, applied: result.applied });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        await auditFailure(input.audit, input.principal, "project_view_delete", error, project_id);
        return operationError("The Project view could not be deleted; check its current state before deciding whether to try again.", error, true);
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

function operationError(message: string, error: unknown, mutation: boolean) {
  const apiError = error instanceof GitHubProjectsApiError ? error : undefined;
  const errorCode = apiError?.code ?? "operation_failed";
  const applied = apiError?.applied ?? (mutation ? "unknown" : false);
  const recoveryNotice = apiError?.recoveryNotice ?? false;
  const recovery = recoveryNotice ? " RDMCP has stopped reusing this credential. Check its status before deciding whether to replace it." : "";
  return {
    isError: true,
    structuredContent: { errorCode, applied, recoveryNotice },
    content: [{ type: "text" as const, text: `${message} Outcome: ${applied}. Reference: ${errorCode}.${recovery}` }],
  };
}
