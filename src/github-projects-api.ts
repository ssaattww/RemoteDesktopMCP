/** Fixed, typed GitHub Projects API operations. This module deliberately does
 * not expose a generic GraphQL/REST entry point or accept credentials from a
 * tool caller. */

const GRAPHQL_URL = "https://api.github.com/graphql";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

export type GitHubProjectsCredentialProvider = {
  getToken(principal: string): Promise<string | undefined>;
};

export type GitHubProjectSummary = {
  id: string;
  title: string;
  number: number;
  url: string;
  closed: boolean;
  public: boolean;
};

export type GitHubProjectField = { id: string; name: string; type: "TEXT" | "NUMBER" | "DATE" | "SINGLE_SELECT" | "ITERATION" | "UNKNOWN"; isIssueField: boolean; options?: Array<{ id: string; name: string }> };
export type GitHubProjectItem = { id: string; type: string; isArchived: boolean; content: { id: string; type: "Issue" | "PullRequest"; title: string; number: number; url: string } | null; fields: Array<{ id: string; name: string; type: string; value: string | number | null; optionId?: string }> };
export type GitHubProjectFieldValue = { type: "TEXT"; text: string } | { type: "NUMBER"; number: number } | { type: "DATE"; date: string } | { type: "SINGLE_SELECT"; optionId: string };

export type GitHubMutationOutcome = { applied: true } | { applied: "unknown" };

export class GitHubProjectsApiError extends Error {
  constructor(
    readonly code: "credential_unavailable" | "credential_rejected" | "forbidden" | "rate_limited" | "api_error" | "invalid_response" | "identity_mismatch" | "request_failed",
    readonly applied: false | "unknown" = false,
    readonly recoveryNotice = false,
  ) {
    super("The GitHub Projects operation could not be completed.");
    this.name = "GitHubProjectsApiError";
  }
}

type Viewer = { login: string };
type GraphQLErrorShape = { message?: unknown; type?: unknown; path?: unknown; extensions?: { code?: unknown } };
type GraphQLResponse<T> = { data?: T; errors?: GraphQLErrorShape[] };

const LIST_PROJECTS = `query RdmcpListProjects($after: String) {
  viewer { login projectsV2(first: 100, after: $after, orderBy: { field: NUMBER, direction: DESC }) {
    nodes { id title number url closed public }
    pageInfo { hasNextPage endCursor }
  } }
}`;
const CREATE_PROJECT = `mutation RdmcpCreateProject($ownerId: ID!, $title: String!) {
  createProjectV2(input: { ownerId: $ownerId, title: $title }) {
    projectV2 { id title number url closed public }
  }
}`;
const UPDATE_PROJECT = `mutation RdmcpUpdateProject($projectId: ID!, $title: String, $shortDescription: String) {
  updateProjectV2(input: { projectId: $projectId, title: $title, shortDescription: $shortDescription }) {
    projectV2 { id title number url closed public }
  }
}`;
const VIEWER_ID = `query RdmcpViewerId { viewer { id login } }`;
const PROJECT_OWNER = `query RdmcpProjectOwner($projectId: ID!) {
  viewer { login }
  node(id: $projectId) { ... on ProjectV2 { id owner { ... on User { login } } } }
}`;
const PROJECT_STATE = `query RdmcpProjectState($projectId: ID!) {
  viewer { login }
  node(id: $projectId) { ... on ProjectV2 { id title shortDescription number url closed public owner { ... on User { login } } } }
}`;
const PROJECT_FIELDS = `query RdmcpProjectFields($projectId: ID!) {
  viewer { login }
  node(id: $projectId) { ... on ProjectV2 {
    id owner { ... on User { login } }
    fields(first: 100) { nodes { __typename ... on ProjectV2FieldCommon { id name dataType isIssueField } ... on ProjectV2SingleSelectField { options { id name } } } pageInfo { hasNextPage } }
  } }
}`;
const PROJECT_ITEMS = `query RdmcpProjectItems($projectId: ID!, $after: String) {
  viewer { login }
  node(id: $projectId) { ... on ProjectV2 {
    id owner { ... on User { login } }
    items(first: 100, after: $after, archivedStates: [NOT_ARCHIVED, ARCHIVED]) { nodes {
      id type isArchived
      content { __typename ... on Issue { id title number url } ... on PullRequest { id title number url } }
      fieldValues(first: 100) { nodes {
        __typename
        ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { id name } } }
        ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2Field { id name } } }
        ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2Field { id name } } }
        ... on ProjectV2ItemFieldSingleSelectValue { name optionId field { ... on ProjectV2SingleSelectField { id name } } }
        ... on ProjectV2ItemFieldIterationValue { title iterationId field { ... on ProjectV2IterationField { id name } } }
      } pageInfo { hasNextPage } }
    } pageInfo { hasNextPage endCursor } }
  } }
}`;
const PROJECT_ITEM_OWNER = `query RdmcpProjectItemOwner($itemId: ID!) {
  viewer { login }
  node(id: $itemId) { ... on ProjectV2Item { id project { id } isArchived } }
}`;
const PROJECT_ITEM_STATE = `query RdmcpProjectItemState($itemId: ID!) {
  viewer { login }
  node(id: $itemId) { ... on ProjectV2Item {
    id type project { id } isArchived
    content { __typename ... on Issue { id title number url } ... on PullRequest { id title number url } }
    fieldValues(first: 100) { nodes {
      __typename
      ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { id name } } }
      ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2Field { id name } } }
      ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2Field { id name } } }
      ... on ProjectV2ItemFieldSingleSelectValue { name optionId field { ... on ProjectV2SingleSelectField { id name } } }
    } pageInfo { hasNextPage } }
  } }
}`;
const ISSUE_OR_PULL_REQUEST = `query RdmcpIssueOrPullRequest($contentId: ID!) {
  viewer { login }
  node(id: $contentId) { __typename ... on Issue { id } ... on PullRequest { id } }
}`;
const ADD_PROJECT_ITEM = `mutation RdmcpAddProjectItem($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id type } }
}`;
const SET_PROJECT_ITEM_FIELD = `mutation RdmcpSetProjectItemField($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
  updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value }) { projectV2Item { id } }
}`;

/** Performs only the initial project-management slice: list, create, and edit
 * a project's title/short description. Administrative operations are absent. */
export class GitHubProjectsApi {
  private readonly request: typeof fetch;
  private readonly isCredentialRejected?: (principal: string, token: string) => boolean;
  private readonly onCredentialRejected?: (principal: string, token: string) => boolean;

  constructor(
    private readonly principal: string,
    private readonly expectedLogin: string,
    private readonly credentials: GitHubProjectsCredentialProvider,
    options: { request?: typeof fetch; isCredentialRejected?: (principal: string, token: string) => boolean; onCredentialRejected?: (principal: string, token: string) => boolean } = {},
  ) {
    if (!principal || !expectedLogin || expectedLogin.trim() !== expectedLogin) throw new Error("A configured principal and GitHub login are required.");
    this.request = options.request ?? fetch;
    this.isCredentialRejected = options.isCredentialRejected;
    this.onCredentialRejected = options.onCredentialRejected;
  }

  async listProjects(): Promise<GitHubProjectSummary[]> {
    const all: GitHubProjectSummary[] = [];
    let after: string | null = null;
    for (let page = 0; page < 100; page += 1) {
      type ListProjectsResult = { viewer?: { login?: string; projectsV2?: { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } } };
      const result: ListProjectsResult = await this.#graphql<ListProjectsResult>("RdmcpListProjects", LIST_PROJECTS, { after });
      const projects: NonNullable<NonNullable<ListProjectsResult["viewer"]>["projectsV2"]> | undefined = result.viewer?.projectsV2;
      if (!Array.isArray(projects?.nodes) || typeof projects.pageInfo?.hasNextPage !== "boolean") throw new GitHubProjectsApiError("invalid_response");
      all.push(...projects.nodes.map(parseProject));
      if (!projects.pageInfo.hasNextPage) return all;
      if (typeof projects.pageInfo.endCursor !== "string" || !projects.pageInfo.endCursor || projects.pageInfo.endCursor === after) throw new GitHubProjectsApiError("invalid_response");
      after = projects.pageInfo.endCursor;
    }
    throw new GitHubProjectsApiError("invalid_response");
  }

  async createProject(title: string): Promise<{ project: GitHubProjectSummary; outcome: GitHubMutationOutcome }> {
    const cleanTitle = requireText(title, "title", 256);
    const token = await this.#getToken();
    const viewer = await this.#graphql<{ viewer?: { id?: string } }>("RdmcpViewerId", VIEWER_ID, {}, { token });
    const ownerId = viewer.viewer?.id;
    if (!ownerId) throw new GitHubProjectsApiError("invalid_response");
    const created = await this.#graphql<{ createProjectV2?: { projectV2?: unknown } }>("RdmcpCreateProject", CREATE_PROJECT, { ownerId, title: cleanTitle }, { token, mutation: true });
    if (!created.createProjectV2?.projectV2) throw new GitHubProjectsApiError("invalid_response", "unknown");
    const projectValue = created.createProjectV2.projectV2;
    const projectId = typeof projectValue === "object" && projectValue !== null && typeof (projectValue as { id?: unknown }).id === "string" ? (projectValue as { id: string }).id : undefined;
    if (!projectId) throw new GitHubProjectsApiError("invalid_response", "unknown");
    const project = await this.#verifyProject(projectId, { title: cleanTitle }, token);
    return { project, outcome: { applied: true } };
  }

  async updateProject(projectId: string, input: { title?: string; shortDescription?: string }): Promise<{ project: GitHubProjectSummary; outcome: GitHubMutationOutcome }> {
    const id = requireText(projectId, "projectId", 200);
    const title = input.title === undefined ? null : requireText(input.title, "title", 256);
    const shortDescription = input.shortDescription === undefined ? null : requireText(input.shortDescription, "shortDescription", 2000);
    if (title === null && shortDescription === null) throw new Error("At least one project property must be provided.");
    const token = await this.#getToken();
    const owner = await this.#graphql<{ node?: { owner?: { login?: string } } | null }>("RdmcpProjectOwner", PROJECT_OWNER, { projectId: id }, { token });
    if (owner.node?.owner?.login?.toLowerCase() !== this.expectedLogin.toLowerCase()) throw new GitHubProjectsApiError("forbidden");
    const response = await this.#graphql<{ updateProjectV2?: { projectV2?: unknown } }>("RdmcpUpdateProject", UPDATE_PROJECT, { projectId: id, title, shortDescription }, { token, mutation: true });
    if (!response.updateProjectV2?.projectV2) throw new GitHubProjectsApiError("invalid_response", "unknown");
    const project = await this.#verifyProject(id, { ...(title !== null ? { title } : {}), ...(shortDescription !== null ? { shortDescription } : {}) }, token);
    return { project, outcome: { applied: true } };
  }

  async listProjectFields(projectId: string): Promise<GitHubProjectField[]> {
    const id = requireText(projectId, "projectId", 200);
    const result = await this.#graphql<{ node?: { id?: string; owner?: { login?: string }; fields?: { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean } } } | null }>("RdmcpProjectFields", PROJECT_FIELDS, { projectId: id });
    if (result.node?.id !== id || result.node.owner?.login?.toLowerCase() !== this.expectedLogin.toLowerCase() || !Array.isArray(result.node.fields?.nodes) || typeof result.node.fields.pageInfo?.hasNextPage !== "boolean" || result.node.fields.pageInfo.hasNextPage) throw new GitHubProjectsApiError("forbidden");
    return result.node.fields.nodes.map(parseField).filter((field) => !field.isIssueField && field.type !== "UNKNOWN");
  }

  async listProjectItems(projectId: string): Promise<GitHubProjectItem[]> {
    const id = requireText(projectId, "projectId", 200);
    const all: GitHubProjectItem[] = [];
    let after: string | null = null;
    for (let page = 0; page < 100; page += 1) {
      const result: { node?: { id?: string; owner?: { login?: string }; items?: { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } } | null } = await this.#graphql("RdmcpProjectItems", PROJECT_ITEMS, { projectId: id, after });
      const items: { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } | undefined = result.node?.items;
      if (result.node?.id !== id || result.node.owner?.login?.toLowerCase() !== this.expectedLogin.toLowerCase()) throw new GitHubProjectsApiError("forbidden");
      if (!Array.isArray(items?.nodes) || typeof items.pageInfo?.hasNextPage !== "boolean") throw new GitHubProjectsApiError("invalid_response");
      all.push(...items.nodes.map(parseProjectItem));
      if (!items.pageInfo.hasNextPage) return all;
      if (typeof items.pageInfo.endCursor !== "string" || !items.pageInfo.endCursor || items.pageInfo.endCursor === after) throw new GitHubProjectsApiError("invalid_response");
      after = items.pageInfo.endCursor;
    }
    throw new GitHubProjectsApiError("invalid_response");
  }

  async addIssueOrPullRequest(projectId: string, contentId: string): Promise<{ itemId: string; outcome: GitHubMutationOutcome }> {
    const project = requireText(projectId, "projectId", 200);
    const content = requireText(contentId, "contentId", 200);
    const token = await this.#getToken();
    await this.#assertProjectOwner(project, token);
    const resolved = await this.#graphql<{ node?: { __typename?: string; id?: string } | null }>("RdmcpIssueOrPullRequest", ISSUE_OR_PULL_REQUEST, { contentId: content }, { token });
    if (!resolved.node || !["Issue", "PullRequest"].includes(resolved.node.__typename ?? "") || resolved.node.id !== content) throw new GitHubProjectsApiError("invalid_response");
    const result = await this.#graphql<{ addProjectV2ItemById?: { item?: { id?: string } } }>("RdmcpAddProjectItem", ADD_PROJECT_ITEM, { projectId: project, contentId: content }, { token, mutation: true });
    const itemId = result.addProjectV2ItemById?.item?.id;
    if (!itemId) throw new GitHubProjectsApiError("invalid_response", "unknown");
    const item = await this.#verifyProjectItem(itemId, project, token);
    if (item.content?.id !== content) throw new GitHubProjectsApiError("invalid_response", "unknown");
    return { itemId, outcome: { applied: true } };
  }

  async setProjectItemField(projectId: string, itemId: string, fieldId: string, value: GitHubProjectFieldValue): Promise<GitHubMutationOutcome> {
    const project = requireText(projectId, "projectId", 200);
    const item = requireText(itemId, "itemId", 200);
    const field = requireText(fieldId, "fieldId", 200);
    const normalized = normalizeFieldValue(value);
    const token = await this.#getToken();
    await this.#assertProjectOwner(project, token);
    const [itemResult, fieldResult] = await Promise.all([
      this.#graphql<{ node?: { id?: string; project?: { id?: string }; isArchived?: boolean } | null }>("RdmcpProjectItemOwner", PROJECT_ITEM_OWNER, { itemId: item }, { token }),
      this.#graphql<{ node?: { id?: string; owner?: { login?: string }; fields?: { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean } } } | null }>("RdmcpProjectFields", PROJECT_FIELDS, { projectId: project }, { token }),
    ]);
    if (itemResult.node?.id !== item || itemResult.node.project?.id !== project || itemResult.node.isArchived !== false) throw new GitHubProjectsApiError("forbidden");
    const fields = fieldResult.node?.fields;
    if (fieldResult.node?.id !== project || fieldResult.node.owner?.login?.toLowerCase() !== this.expectedLogin.toLowerCase() || !Array.isArray(fields?.nodes) || fields.pageInfo?.hasNextPage !== false) throw new GitHubProjectsApiError("forbidden");
    const definition = fields.nodes.map(parseField).find((candidate) => candidate.id === field);
    if (!definition || definition.isIssueField || definition.type !== normalized.type) throw new GitHubProjectsApiError("forbidden");
    if (normalized.type === "SINGLE_SELECT" && !definition.options?.some((option) => option.id === normalized.value.singleSelectOptionId)) throw new GitHubProjectsApiError("invalid_response");
    const result = await this.#graphql<{ updateProjectV2ItemFieldValue?: { projectV2Item?: { id?: string } } }>("RdmcpSetProjectItemField", SET_PROJECT_ITEM_FIELD, { projectId: project, itemId: item, fieldId: field, value: normalized.value }, { token, mutation: true });
    if (result.updateProjectV2ItemFieldValue?.projectV2Item?.id !== item) throw new GitHubProjectsApiError("invalid_response", "unknown");
    const verified = await this.#verifyProjectItem(item, project, token);
    if (!verified.fields.some((entry) => entry.id === field && fieldValueMatches(entry, normalized.value))) throw new GitHubProjectsApiError("invalid_response", "unknown");
    return { applied: true };
  }

  async #verifyProject(projectId: string, expected: { title?: string; shortDescription?: string }, token: string): Promise<GitHubProjectSummary> {
    let result: { node?: unknown | null };
    try { result = await this.#graphql("RdmcpProjectState", PROJECT_STATE, { projectId }, { token }); }
    catch (error) { throw unknownAfterMutation(error); }
    if (!result.node || typeof result.node !== "object") throw new GitHubProjectsApiError("invalid_response", "unknown");
    const projectData = result.node as Record<string, unknown>;
    if (typeof (projectData.owner as { login?: unknown } | undefined)?.login !== "string" || (projectData.owner as { login: string }).login.toLowerCase() !== this.expectedLogin.toLowerCase()) throw new GitHubProjectsApiError("forbidden", "unknown");
    let project: GitHubProjectSummary;
    try { project = parseProject(projectData); }
    catch (error) { throw unknownAfterMutation(error); }
    if ((expected.title !== undefined && projectData.title !== expected.title) || (expected.shortDescription !== undefined && projectData.shortDescription !== expected.shortDescription)) throw new GitHubProjectsApiError("invalid_response", "unknown");
    return project;
  }

  async #verifyProjectItem(itemId: string, projectId: string, token: string): Promise<GitHubProjectItem> {
    let result: { node?: unknown | null };
    try { result = await this.#graphql("RdmcpProjectItemState", PROJECT_ITEM_STATE, { itemId }, { token }); }
    catch (error) { throw unknownAfterMutation(error); }
    if (!result.node || typeof result.node !== "object") throw new GitHubProjectsApiError("invalid_response", "unknown");
    const raw = result.node as Record<string, unknown>;
    if ((raw.project as { id?: unknown } | undefined)?.id !== projectId) throw new GitHubProjectsApiError("forbidden", "unknown");
    try { return parseProjectItem(raw); }
    catch (error) { throw unknownAfterMutation(error); }
  }

  async #getToken(): Promise<string> {
    const token = await this.credentials.getToken(this.principal);
    if (!token || token.length > 16_384 || /[\r\n]/.test(token)) throw new GitHubProjectsApiError("credential_unavailable");
    if (this.isCredentialRejected?.(this.principal, token)) throw new GitHubProjectsApiError("credential_rejected");
    return token;
  }

  async #assertProjectOwner(projectId: string, token: string): Promise<void> {
    const owner = await this.#graphql<{ node?: { id?: string; owner?: { login?: string } } | null }>("RdmcpProjectOwner", PROJECT_OWNER, { projectId }, { token });
    if (owner.node?.id !== projectId || owner.node.owner?.login?.toLowerCase() !== this.expectedLogin.toLowerCase()) throw new GitHubProjectsApiError("forbidden");
  }

  async #graphql<T>(operation: string, query: string, variables: Record<string, unknown>, options: { token?: string; mutation?: boolean } = {}): Promise<T> {
    const token = options.token ?? await this.#getToken();
    const mutation = options.mutation ?? false;
    let response: Response;
    try {
      response = await this.request(GRAPHQL_URL, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${token}`, "user-agent": "RemoteDesktopMCP-GitHub-Projects" },
        body: JSON.stringify({ operationName: operation, query, variables }),
      });
    } catch {
      throw new GitHubProjectsApiError("request_failed", mutation ? "unknown" : false);
    }
    if (response.status === 401) { const recoveryNotice = this.onCredentialRejected?.(this.principal, token) ?? true; throw new GitHubProjectsApiError("credential_rejected", mutation ? "unknown" : false, recoveryNotice); }
    if (response.status === 403) throw new GitHubProjectsApiError(isRateLimitedResponse(response) ? "rate_limited" : "forbidden", mutation ? "unknown" : false);
    if (response.status === 429) throw new GitHubProjectsApiError("rate_limited", mutation ? "unknown" : false);
    if (!response.ok) throw new GitHubProjectsApiError("api_error", mutation ? "unknown" : false);
    let payload: GraphQLResponse<T>;
    try { payload = await readBoundedJson<GraphQLResponse<T>>(response); }
    catch { throw new GitHubProjectsApiError("invalid_response", mutation ? "unknown" : false); }
    if (Array.isArray(payload.errors) && payload.errors.length > 0) throw new GitHubProjectsApiError(payload.errors.some(isRateLimitGraphQLError) ? "rate_limited" : "api_error", mutation ? "unknown" : false);
    if (!payload.data) throw new GitHubProjectsApiError("invalid_response", mutation ? "unknown" : false);
    if (!mutation) {
      const viewer = (payload.data as { viewer?: Viewer }).viewer;
      if (!viewer || typeof viewer.login !== "string" || viewer.login.toLowerCase() !== this.expectedLogin.toLowerCase()) throw new GitHubProjectsApiError("identity_mismatch");
    }
    return payload.data;
  }
}

function isRateLimitedResponse(response: Response): boolean {
  return response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after");
}

function isRateLimitGraphQLError(error: GraphQLErrorShape): boolean {
  const type = typeof error.type === "string" ? error.type.toUpperCase() : "";
  const code = typeof error.extensions?.code === "string" ? error.extensions.code.toUpperCase() : "";
  return [type, code].some((value) => value === "RATE_LIMITED" || value === "ABUSE_DETECTION");
}

function unknownAfterMutation(error: unknown): GitHubProjectsApiError {
  return error instanceof GitHubProjectsApiError ? new GitHubProjectsApiError(error.code, "unknown") : new GitHubProjectsApiError("request_failed", "unknown");
}

function fieldValueMatches(field: GitHubProjectItem["fields"][number], value: Record<string, string | number>): boolean {
  if (field.type === "TEXT") return field.value === value.text;
  if (field.type === "NUMBER") return field.value === value.number;
  if (field.type === "DATE") return field.value === value.date;
  if (field.type === "SINGLE_SELECT") return field.optionId === value.singleSelectOptionId;
  return false;
}

function requireText(value: string, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${field} is invalid.`);
  return value.trim();
}

function parseProject(value: unknown): GitHubProjectSummary {
  if (typeof value !== "object" || value === null) throw new GitHubProjectsApiError("invalid_response");
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || typeof item.title !== "string" || typeof item.number !== "number" || typeof item.url !== "string" || typeof item.closed !== "boolean" || typeof item.public !== "boolean") throw new GitHubProjectsApiError("invalid_response");
  return { id: item.id, title: item.title, number: item.number, url: item.url, closed: item.closed, public: item.public };
}

function parseField(value: unknown): GitHubProjectField {
  if (typeof value !== "object" || value === null) throw new GitHubProjectsApiError("invalid_response");
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || typeof item.name !== "string" || typeof item.__typename !== "string" || typeof item.isIssueField !== "boolean") throw new GitHubProjectsApiError("invalid_response");
  const type = item.__typename === "ProjectV2SingleSelectField" ? "SINGLE_SELECT"
    : item.__typename === "ProjectV2IterationField" ? "ITERATION"
    : item.__typename === "ProjectV2Field" && item.dataType === "TEXT" ? "TEXT"
    : item.__typename === "ProjectV2Field" && item.dataType === "NUMBER" ? "NUMBER"
    : item.__typename === "ProjectV2Field" && item.dataType === "DATE" ? "DATE"
    : "UNKNOWN";
  const options = item.options === undefined ? undefined : Array.isArray(item.options) ? item.options.map((option) => {
    if (typeof option !== "object" || option === null || typeof (option as Record<string, unknown>).id !== "string" || typeof (option as Record<string, unknown>).name !== "string") throw new GitHubProjectsApiError("invalid_response");
    return { id: (option as { id: string }).id, name: (option as { name: string }).name };
  }) : (() => { throw new GitHubProjectsApiError("invalid_response"); })();
  return { id: item.id, name: item.name, type, isIssueField: item.isIssueField, ...(options ? { options } : {}) };
}

function parseProjectItem(value: unknown): GitHubProjectItem {
  if (typeof value !== "object" || value === null) throw new GitHubProjectsApiError("invalid_response");
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || typeof item.type !== "string" || typeof item.isArchived !== "boolean") throw new GitHubProjectsApiError("invalid_response");
  let content: GitHubProjectItem["content"] = null;
  if (item.content !== null && item.content !== undefined) {
    if (typeof item.content !== "object") throw new GitHubProjectsApiError("invalid_response");
    const record = item.content as Record<string, unknown>;
    if (record.__typename === "Issue" || record.__typename === "PullRequest") {
      if (typeof record.id !== "string" || typeof record.title !== "string" || typeof record.number !== "number" || typeof record.url !== "string") throw new GitHubProjectsApiError("invalid_response");
      content = { id: record.id, type: record.__typename, title: record.title, number: record.number, url: record.url };
    }
  }
  const fieldValues = item.fieldValues;
  if (typeof fieldValues !== "object" || fieldValues === null) throw new GitHubProjectsApiError("invalid_response");
  const connection = fieldValues as { nodes?: unknown[]; pageInfo?: { hasNextPage?: unknown } };
  if (!Array.isArray(connection.nodes) || connection.pageInfo?.hasNextPage !== false) throw new GitHubProjectsApiError("invalid_response");
  const fields = connection.nodes.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) throw new GitHubProjectsApiError("invalid_response");
    const fieldValue = entry as Record<string, unknown>;
    const field = fieldValue.field;
    if (typeof field !== "object" || field === null) return [];
    const fieldRecord = field as Record<string, unknown>;
    if (typeof fieldRecord.id !== "string" || typeof fieldRecord.name !== "string" || typeof fieldValue.__typename !== "string") return [];
    let type = fieldValue.__typename;
    let value: string | number | null = null;
    if (type === "ProjectV2ItemFieldTextValue" && typeof fieldValue.text === "string") { type = "TEXT"; value = fieldValue.text; }
    else if (type === "ProjectV2ItemFieldNumberValue" && typeof fieldValue.number === "number") { type = "NUMBER"; value = fieldValue.number; }
    else if (type === "ProjectV2ItemFieldDateValue" && typeof fieldValue.date === "string") { type = "DATE"; value = fieldValue.date; }
    else if (type === "ProjectV2ItemFieldSingleSelectValue" && typeof fieldValue.name === "string") { type = "SINGLE_SELECT"; value = fieldValue.name; }
    else if (type === "ProjectV2ItemFieldIterationValue" && typeof fieldValue.title === "string") { type = "ITERATION"; value = fieldValue.title; }

    return [{ id: fieldRecord.id, name: fieldRecord.name, type, value, ...(typeof fieldValue.optionId === "string" ? { optionId: fieldValue.optionId } : {}) }];
  });
  return { id: item.id, type: item.type, isArchived: item.isArchived, content, fields };
}

function normalizeFieldValue(value: GitHubProjectFieldValue): { type: GitHubProjectField["type"]; value: Record<string, string | number> } {
  if (typeof value !== "object" || value === null) throw new Error("The Project field value is invalid.");
  if (value.type === "TEXT" && typeof value.text === "string" && value.text.length <= 10_000) return { type: "TEXT", value: { text: value.text } };
  if (value.type === "NUMBER" && typeof value.number === "number" && Number.isFinite(value.number)) return { type: "NUMBER", value: { number: value.number } };
  if (value.type === "DATE" && typeof value.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.date) && new Date(`${value.date}T00:00:00Z`).toISOString().slice(0, 10) === value.date) return { type: "DATE", value: { date: value.date } };
  if (value.type === "SINGLE_SELECT" && typeof value.optionId === "string" && value.optionId.trim() && value.optionId.length <= 200) return { type: "SINGLE_SELECT", value: { singleSelectOptionId: value.optionId.trim() } };
  throw new Error("The Project field value is invalid.");
}

async function readBoundedJson<T>(response: Response): Promise<T> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_RESPONSE_BYTES || !response.body) throw new Error("Invalid response size.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("Invalid response size."); }
    chunks.push(chunk.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}
