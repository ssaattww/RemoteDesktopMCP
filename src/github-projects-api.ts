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

export type GitHubProjectField = { id: string; name: string; type: "TEXT" | "NUMBER" | "DATE" | "SINGLE_SELECT" | "MULTI_SELECT" | "ITERATION" | "UNKNOWN"; isIssueField: boolean; options?: Array<{ id: string; name: string; color: string; description: string }>; iterationConfiguration?: { duration: number; startDate: string | null; startDay: number; iterations: Array<{ id: string; title: string; startDate: string; duration: number }> } };
export type GitHubProjectView = { id: string; name: string; layout: "TABLE_LAYOUT" | "BOARD_LAYOUT" | "ROADMAP_LAYOUT"; filter: string; visibleFieldIds: string[] };
export type GitHubProjectFieldDefinition =
  | { type: "TEXT" | "NUMBER" | "DATE"; name: string }
  | { type: "SINGLE_SELECT"; name: string; options?: Array<{ id?: string; name: string; color?: string; description?: string }> }
  | { type: "MULTI_SELECT"; name: string; options?: Array<{ id?: string; name: string; color?: string; description?: string }> }
  | { type: "ITERATION"; name: string; iterationConfiguration?: { duration: number; startDate: string; iterations: Array<{ id?: string; title: string; startDate: string; duration: number }> } };
export type GitHubProjectFieldUpdate = { name?: string; options?: Array<{ id?: string; name: string; color?: string; description?: string }>; iterationConfiguration?: { duration: number; startDate: string; iterations: Array<{ id?: string; title: string; startDate: string; duration: number }> } };
export type GitHubProjectViewInput = { name?: string; layout?: GitHubProjectView["layout"]; filter?: string; visibleFieldIds?: string[] };
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
    fields(first: 100) { nodes { __typename ... on ProjectV2FieldCommon { id name dataType isIssueField } ... on ProjectV2SingleSelectField { options { id name color description } } ... on ProjectV2MultiSelectField { multiSelectOptions { id name color description } } ... on ProjectV2IterationField { configuration { duration startDay iterations { id title startDate duration } } } } pageInfo { hasNextPage } }
  } }
}`;
const CREATE_PROJECT_FIELD = `mutation RdmcpCreateProjectField($projectId: ID!, $name: String!, $dataType: ProjectV2CustomFieldType!, $singleSelectOptions: [ProjectV2SingleSelectFieldOptionInput!], $multiSelectOptions: [ProjectV2MultiSelectFieldOptionInput!], $iterationConfiguration: ProjectV2IterationFieldConfigurationInput) {
  createProjectV2Field(input: { projectId: $projectId, name: $name, dataType: $dataType, singleSelectOptions: $singleSelectOptions, multiSelectOptions: $multiSelectOptions, iterationConfiguration: $iterationConfiguration }) { projectV2Field { ... on ProjectV2FieldCommon { id name dataType isIssueField } ... on ProjectV2SingleSelectField { options { id name } } ... on ProjectV2MultiSelectField { multiSelectOptions { id name } } } }
}`;
const UPDATE_PROJECT_FIELD = `mutation RdmcpUpdateProjectField($fieldId: ID!, $name: String, $singleSelectOptions: [ProjectV2SingleSelectFieldOptionInput!], $multiSelectOptions: [ProjectV2MultiSelectFieldOptionInput!], $iterationConfiguration: ProjectV2IterationFieldConfigurationInput) {
  updateProjectV2Field(input: { fieldId: $fieldId, name: $name, singleSelectOptions: $singleSelectOptions, multiSelectOptions: $multiSelectOptions, iterationConfiguration: $iterationConfiguration }) { projectV2Field { ... on ProjectV2FieldCommon { id name dataType isIssueField } ... on ProjectV2SingleSelectField { options { id name } } ... on ProjectV2MultiSelectField { multiSelectOptions { id name } } } }
}`;
const DELETE_PROJECT_FIELD = `mutation RdmcpDeleteProjectField($fieldId: ID!) { deleteProjectV2Field(input: { fieldId: $fieldId }) { projectV2Field { ... on ProjectV2FieldCommon { id } } } }`;
const PROJECT_VIEWS = `query RdmcpProjectViews($projectId: ID!, $after: String) {
  viewer { login }
  node(id: $projectId) { ... on ProjectV2 { id owner { ... on User { login } } views(first: 100, after: $after) { nodes { id name layout filter configuration { visibleFields(first: 100) { nodes { id } pageInfo { hasNextPage } } } } pageInfo { hasNextPage endCursor } } } }
}`;
const CREATE_PROJECT_VIEW = `mutation RdmcpCreateProjectView($projectId: ID!, $name: String!, $layout: ProjectV2ViewLayout!, $filter: String, $configuration: ProjectV2ViewConfigurationInput) {
  createProjectV2View(input: { projectId: $projectId, name: $name, layout: $layout, filter: $filter, configuration: $configuration }) { projectV2View { id name layout filter configuration { visibleFields(first: 100) { nodes { id } pageInfo { hasNextPage } } } } }
}`;
const UPDATE_PROJECT_VIEW = `mutation RdmcpUpdateProjectView($viewId: ID!, $name: String, $layout: ProjectV2ViewLayout, $filter: String, $configuration: ProjectV2ViewConfigurationInput) {
  updateProjectV2View(input: { viewId: $viewId, name: $name, layout: $layout, filter: $filter, configuration: $configuration }) { projectV2View { id name layout filter configuration { visibleFields(first: 100) { nodes { id } pageInfo { hasNextPage } } } } }
}`;
const DELETE_PROJECT_VIEW = `mutation RdmcpDeleteProjectView($viewId: ID!) { deleteProjectV2View(input: { viewId: $viewId }) { projectV2View { id } } }`;
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

  async createProjectField(projectId: string, definition: GitHubProjectFieldDefinition): Promise<{ field: GitHubProjectField; outcome: GitHubMutationOutcome }> {
    const project = requireText(projectId, "projectId", 200);
    const clean = normalizeFieldDefinition(definition);
    const token = await this.#getToken();
    await this.#assertProjectOwner(project, token);
    const result = await this.#graphql<{ createProjectV2Field?: { projectV2Field?: { id?: string } } }>("RdmcpCreateProjectField", CREATE_PROJECT_FIELD, {
      projectId: project, name: clean.name, dataType: clean.dataType, singleSelectOptions: clean.singleSelectOptions, multiSelectOptions: clean.multiSelectOptions, iterationConfiguration: clean.iterationConfiguration,
    }, { token, mutation: true });
    const fieldId = result.createProjectV2Field?.projectV2Field?.id;
    if (!fieldId) throw new GitHubProjectsApiError("invalid_response", "unknown");
    const field = await this.#verifyProjectField(project, fieldId, clean);
    return { field, outcome: { applied: true } };
  }

  async updateProjectField(projectId: string, fieldId: string, input: GitHubProjectFieldUpdate): Promise<{ field: GitHubProjectField; outcome: GitHubMutationOutcome }> {
    const project = requireText(projectId, "projectId", 200);
    const id = requireText(fieldId, "fieldId", 200);
    if (input.name === undefined && input.options === undefined && input.iterationConfiguration === undefined) throw new Error("At least one Project field property must be provided.");
    const token = await this.#getToken();
    await this.#assertProjectOwner(project, token);
    const currentFields = await this.#readProjectFields(project, token);
    const current = currentFields.find((field) => field.id === id);
    if (!current || current.isIssueField || current.type === "UNKNOWN") throw new GitHubProjectsApiError("forbidden");
    const cleanName = input.name === undefined ? undefined : requireText(input.name, "name", 256);
    const variables: Record<string, unknown> = { fieldId: id, ...(cleanName !== undefined ? { name: cleanName } : {}) };
    let expected: NormalizedFieldDefinition = { dataType: fieldTypeToDataType(current.type), name: cleanName ?? current.name };
    if (current.type === "SINGLE_SELECT" || current.type === "MULTI_SELECT") {
      const requested = "options" in input ? input.options : undefined;
      const options = requested === undefined ? current.options ?? [] : preserveOptionIds(current.options ?? [], requested);
      if (requested !== undefined || input.name !== undefined) variables[current.type === "SINGLE_SELECT" ? "singleSelectOptions" : "multiSelectOptions"] = options;
      expected = { dataType: current.type, name: cleanName ?? current.name, ...(current.type === "SINGLE_SELECT" ? { singleSelectOptions: options } : { multiSelectOptions: options }) };
    } else if (current.type === "ITERATION") {
      const requested = "iterationConfiguration" in input ? input.iterationConfiguration : undefined;
      const configuration = requested === undefined ? undefined : preserveIterationIds(current.iterationConfiguration, requested);
      if (requested !== undefined) variables.iterationConfiguration = configuration;
      expected = { dataType: "ITERATION", name: cleanName ?? current.name, ...(configuration ? { iterationConfiguration: configuration } : {}) };
    } else if (input.name === undefined) {
      throw new Error("A field update must include a supported property.");
    }
    const result = await this.#graphql<{ updateProjectV2Field?: { projectV2Field?: { id?: string } } }>("RdmcpUpdateProjectField", UPDATE_PROJECT_FIELD, variables, { token, mutation: true });
    if (result.updateProjectV2Field?.projectV2Field?.id !== id) throw new GitHubProjectsApiError("invalid_response", "unknown");
    const field = await this.#verifyProjectField(project, id, expected);
    return { field, outcome: { applied: true } };
  }

  async deleteProjectField(projectId: string, fieldId: string): Promise<GitHubMutationOutcome> {
    const project = requireText(projectId, "projectId", 200);
    const id = requireText(fieldId, "fieldId", 200);
    const token = await this.#getToken();
    await this.#assertProjectOwner(project, token);
    const fields = await this.#readProjectFields(project, token);
    const current = fields.find((field) => field.id === id);
    if (!current || current.isIssueField || current.type === "UNKNOWN") throw new GitHubProjectsApiError("forbidden");
    const result = await this.#graphql<{ deleteProjectV2Field?: { projectV2Field?: { id?: string } | null } }>("RdmcpDeleteProjectField", DELETE_PROJECT_FIELD, { fieldId: id }, { token, mutation: true });
    if (result.deleteProjectV2Field?.projectV2Field?.id !== id) throw new GitHubProjectsApiError("invalid_response", "unknown");
    try {
      if ((await this.#readProjectFields(project, token)).some((field) => field.id === id)) throw new GitHubProjectsApiError("invalid_response", "unknown");
    } catch (error) { throw unknownAfterMutation(error); }
    return { applied: true };
  }

  async listProjectViews(projectId: string): Promise<GitHubProjectView[]> {
    const project = requireText(projectId, "projectId", 200);
    return this.#readProjectViews(project, await this.#getToken());
  }

  async createProjectView(projectId: string, input: Required<Pick<GitHubProjectViewInput, "name" | "layout">> & GitHubProjectViewInput): Promise<{ view: GitHubProjectView; outcome: GitHubMutationOutcome }> {
    const project = requireText(projectId, "projectId", 200);
    const clean = normalizeViewInput(input, true);
    const token = await this.#getToken();
    await this.#assertProjectOwner(project, token);
    await this.#assertViewFields(project, clean.visibleFieldIds ?? [], token);
    const result = await this.#graphql<{ createProjectV2View?: { projectV2View?: unknown } }>("RdmcpCreateProjectView", CREATE_PROJECT_VIEW, { projectId: project, name: clean.name, layout: clean.layout, filter: clean.filter ?? null, configuration: { visibleFieldIds: clean.visibleFieldIds ?? [] } }, { token, mutation: true });
    const raw = result.createProjectV2View?.projectV2View;
    if (typeof raw !== "object" || raw === null || typeof (raw as { id?: unknown }).id !== "string") throw new GitHubProjectsApiError("invalid_response", "unknown");
    const viewId = (raw as { id: string }).id;
    const view = await this.#verifyProjectView(project, viewId, clean);
    return { view, outcome: { applied: true } };
  }

  async updateProjectView(projectId: string, viewId: string, input: GitHubProjectViewInput): Promise<{ view: GitHubProjectView; outcome: GitHubMutationOutcome }> {
    const project = requireText(projectId, "projectId", 200);
    const id = requireText(viewId, "viewId", 200);
    if (!Object.keys(input).length) throw new Error("At least one view property must be provided.");
    const token = await this.#getToken();
    await this.#assertProjectOwner(project, token);
    const current = await this.#getProjectView(project, id, token);
    if (!current) throw new GitHubProjectsApiError("forbidden");
    const clean = normalizeViewInput({ ...current, ...input }, false);
    await this.#assertViewFields(project, clean.visibleFieldIds ?? current.visibleFieldIds, token);
    const variables = { viewId: id, name: clean.name, layout: clean.layout, filter: clean.filter ?? null, configuration: { visibleFieldIds: clean.visibleFieldIds ?? [] } };
    const result = await this.#graphql<{ updateProjectV2View?: { projectV2View?: { id?: string } } }>("RdmcpUpdateProjectView", UPDATE_PROJECT_VIEW, variables, { token, mutation: true });
    if (result.updateProjectV2View?.projectV2View?.id !== id) throw new GitHubProjectsApiError("invalid_response", "unknown");
    const view = await this.#verifyProjectView(project, id, clean);
    return { view, outcome: { applied: true } };
  }

  async deleteProjectView(projectId: string, viewId: string): Promise<GitHubMutationOutcome> {
    const project = requireText(projectId, "projectId", 200);
    const id = requireText(viewId, "viewId", 200);
    const token = await this.#getToken();
    await this.#assertProjectOwner(project, token);
    await this.#getProjectView(project, id, token);
    const result = await this.#graphql<{ deleteProjectV2View?: { projectV2View?: { id?: string } | null } }>("RdmcpDeleteProjectView", DELETE_PROJECT_VIEW, { viewId: id }, { token, mutation: true });
    if (result.deleteProjectV2View?.projectV2View?.id !== id) throw new GitHubProjectsApiError("invalid_response", "unknown");
    try {
      if ((await this.#getProjectView(project, id, token, true)) !== null) throw new GitHubProjectsApiError("invalid_response", "unknown");
    } catch (error) { throw unknownAfterMutation(error); }
    return { applied: true };
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

  async #readProjectFields(projectId: string, token: string): Promise<GitHubProjectField[]> {
    const result = await this.#graphql<{ node?: { id?: string; owner?: { login?: string }; fields?: { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean } } } | null }>("RdmcpProjectFields", PROJECT_FIELDS, { projectId }, { token });
    const fields = result.node?.fields;
    if (result.node?.id !== projectId || result.node.owner?.login?.toLowerCase() !== this.expectedLogin.toLowerCase() || !Array.isArray(fields?.nodes) || fields.pageInfo?.hasNextPage !== false) throw new GitHubProjectsApiError("forbidden");
    return fields.nodes.map(parseField);
  }

  async #assertViewFields(projectId: string, fieldIds: readonly string[], token: string): Promise<void> {
    if (new Set(fieldIds).size !== fieldIds.length || fieldIds.some((id) => typeof id !== "string" || !id.trim())) throw new Error("Visible Project fields are invalid.");
    const fields = await this.#readProjectFields(projectId, token);
    const available = new Set(fields.map((field) => field.id));
    if (fieldIds.some((id) => !available.has(id))) throw new GitHubProjectsApiError("forbidden");
  }

  async #getProjectView(projectId: string, viewId: string, token: string, allowMissing = false): Promise<GitHubProjectView | null> {
    const views = await this.#readProjectViews(projectId, token);
    const found = views.find((entry) => entry.id === viewId);
    if (!found) {
      if (allowMissing) return null;
      throw new GitHubProjectsApiError("forbidden");
    }
    return found;
  }

  async #readProjectViews(projectId: string, token: string): Promise<GitHubProjectView[]> {
    const all: GitHubProjectView[] = [];
    let after: string | null = null;
    for (let page = 0; page < 100; page += 1) {
      const result: { node?: { id?: string; owner?: { login?: string }; views?: { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } } | null } = await this.#graphql("RdmcpProjectViews", PROJECT_VIEWS, { projectId, after }, { token });
      const views = result.node?.views;
      if (result.node?.id !== projectId || result.node.owner?.login?.toLowerCase() !== this.expectedLogin.toLowerCase() || !Array.isArray(views?.nodes) || typeof views.pageInfo?.hasNextPage !== "boolean") throw new GitHubProjectsApiError("forbidden");
      all.push(...views.nodes.map(parseProjectView));
      if (!views.pageInfo.hasNextPage) return all;
      if (typeof views.pageInfo.endCursor !== "string" || !views.pageInfo.endCursor || views.pageInfo.endCursor === after) throw new GitHubProjectsApiError("invalid_response");
      after = views.pageInfo.endCursor;
    }
    throw new GitHubProjectsApiError("invalid_response");
  }

  async #verifyProjectField(projectId: string, fieldId: string, expected: NormalizedFieldDefinition): Promise<GitHubProjectField> {
    let fields: GitHubProjectField[];
    try { fields = await this.#readProjectFields(projectId, await this.#getToken()); }
    catch (error) { throw unknownAfterMutation(error); }
    const field = fields.find((entry) => entry.id === fieldId);
    if (!field || field.isIssueField || field.name !== expected.name || field.type !== dataTypeToFieldType(expected.dataType)) throw new GitHubProjectsApiError("invalid_response", "unknown");
    if (expected.singleSelectOptions && !sameOptions(field.options ?? [], expected.singleSelectOptions)) throw new GitHubProjectsApiError("invalid_response", "unknown");
    if (expected.multiSelectOptions && !sameOptions(field.options ?? [], expected.multiSelectOptions)) throw new GitHubProjectsApiError("invalid_response", "unknown");
    if (expected.iterationConfiguration && !sameIterationConfiguration(field.iterationConfiguration, expected.iterationConfiguration)) throw new GitHubProjectsApiError("invalid_response", "unknown");
    return field;
  }

  async #verifyProjectView(projectId: string, viewId: string, expected: Partial<GitHubProjectViewInput>): Promise<GitHubProjectView> {
    let view: GitHubProjectView | null;
    try { view = await this.#getProjectView(projectId, viewId, await this.#getToken()); }
    catch (error) { throw unknownAfterMutation(error); }
    if (!view || (expected.name !== undefined && view.name !== expected.name) || (expected.layout !== undefined && view.layout !== expected.layout) || (expected.filter !== undefined && view.filter !== expected.filter) || (expected.visibleFieldIds !== undefined && !sameStringArray(view.visibleFieldIds, expected.visibleFieldIds))) throw new GitHubProjectsApiError("invalid_response", "unknown");
    return view;
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
  return error instanceof GitHubProjectsApiError ? new GitHubProjectsApiError(error.code, "unknown", error.recoveryNotice) : new GitHubProjectsApiError("request_failed", "unknown");
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
    : item.__typename === "ProjectV2MultiSelectField" ? "MULTI_SELECT"
    : item.__typename === "ProjectV2IterationField" ? "ITERATION"
    : item.__typename === "ProjectV2Field" && item.dataType === "TEXT" ? "TEXT"
    : item.__typename === "ProjectV2Field" && item.dataType === "NUMBER" ? "NUMBER"
    : item.__typename === "ProjectV2Field" && item.dataType === "DATE" ? "DATE"
    : "UNKNOWN";
  const rawOptions = item.__typename === "ProjectV2MultiSelectField" ? item.multiSelectOptions : item.options;
  const options = rawOptions === undefined ? undefined : Array.isArray(rawOptions) ? rawOptions.map((option) => {
    if (typeof option !== "object" || option === null || typeof (option as Record<string, unknown>).id !== "string" || typeof (option as Record<string, unknown>).name !== "string") throw new GitHubProjectsApiError("invalid_response");
    const record = option as { id: string; name: string; color?: unknown; description?: unknown };
    if (typeof record.color !== "string" || typeof record.description !== "string") throw new GitHubProjectsApiError("invalid_response");
    return { id: record.id, name: record.name, color: record.color, description: record.description };
  }) : (() => { throw new GitHubProjectsApiError("invalid_response"); })();
  let iterationConfiguration: GitHubProjectField["iterationConfiguration"];
  if (item.configuration !== undefined && item.configuration !== null) {
    if (typeof item.configuration !== "object") throw new GitHubProjectsApiError("invalid_response");
    const config = item.configuration as Record<string, unknown>;
    if (typeof config.duration !== "number" || typeof config.startDay !== "number" || !Array.isArray(config.iterations)) throw new GitHubProjectsApiError("invalid_response");
    const iterations = config.iterations.map((value) => {
      if (typeof value !== "object" || value === null) throw new GitHubProjectsApiError("invalid_response");
      const iteration = value as Record<string, unknown>;
      if (typeof iteration.id !== "string" || typeof iteration.title !== "string" || typeof iteration.startDate !== "string" || typeof iteration.duration !== "number") throw new GitHubProjectsApiError("invalid_response");
      return { id: iteration.id, title: iteration.title, startDate: iteration.startDate, duration: iteration.duration };
    });
    iterationConfiguration = { duration: config.duration, startDate: iterations[0]?.startDate ?? null, startDay: config.startDay, iterations };
  }
  return { id: item.id, name: item.name, type, isIssueField: item.isIssueField, ...(options ? { options } : {}), ...(iterationConfiguration ? { iterationConfiguration } : {}) };
}

type NormalizedFieldDefinition = {
  dataType: "TEXT" | "NUMBER" | "DATE" | "SINGLE_SELECT" | "MULTI_SELECT" | "ITERATION";
  name: string;
  singleSelectOptions?: Array<{ id?: string; name: string; color: string; description: string }>;
  multiSelectOptions?: Array<{ id?: string; name: string; color: string; description: string }>;
  iterationConfiguration?: { duration: number; startDate: string; iterations: Array<{ id?: string; title: string; startDate: string; duration?: number }> };
};

function normalizeFieldDefinition(input: GitHubProjectFieldDefinition): NormalizedFieldDefinition {
  if (typeof input !== "object" || input === null) throw new Error("The Project field definition is invalid.");
  const name = requireText(input.name, "name", 256);
  if (input.type === "TEXT" || input.type === "NUMBER" || input.type === "DATE") return { dataType: input.type, name };
  if (input.type === "SINGLE_SELECT" || input.type === "MULTI_SELECT") {
    const options = normalizeOptions(input.options ?? []);
    if (!options.length) throw new Error("A single-select field needs at least one option.");
    return { dataType: input.type, name, ...(input.type === "SINGLE_SELECT" ? { singleSelectOptions: options } : { multiSelectOptions: options }) };
  }
  if (input.type === "ITERATION") {
    if (!input.iterationConfiguration) throw new Error("An iteration field needs an iteration configuration.");
    return { dataType: input.type, name, iterationConfiguration: normalizeIterationConfiguration(input.iterationConfiguration) };
  }
  throw new Error("The Project field type is unsupported.");
}

function preserveOptionIds(current: Array<{ id: string; name: string; color: string; description: string }>, requested: Array<{ id?: string; name: string; color?: string; description?: string }>): Array<{ id?: string; name: string; color: string; description: string }> {
  const options = normalizeOptions(requested);
  const byId = new Map(current.map((option) => [option.id, option]));
  const byName = new Map(current.map((option) => [option.name.toLocaleLowerCase(), option]));
  return options.map((option, index) => {
    const requestedOption = requested[index]!;
    const prior = option.id ? byId.get(option.id) : byName.get(option.name.toLocaleLowerCase());
    if (option.id && !prior) throw new Error("A single-select option ID does not belong to this Project field.");
    return { ...(prior ? { id: prior.id } : option.id ? { id: option.id } : {}), name: option.name, color: requestedOption.color ?? prior?.color ?? "GRAY", description: requestedOption.description ?? prior?.description ?? "" };
  });
}

function normalizeOptions(options: Array<{ id?: string; name: string; color?: string; description?: string }>): Array<{ id?: string; name: string; color: string; description: string }> {
  if (!Array.isArray(options) || options.length > 100) throw new Error("Project field options are invalid.");
  const colors = ["BLUE", "GRAY", "GREEN", "ORANGE", "PINK", "PURPLE", "RED", "YELLOW"];
  const result = options.map((option) => {
    const color = option.color ?? "GRAY";
    if (!colors.includes(color) || (option.description !== undefined && (typeof option.description !== "string" || option.description.length > 1000))) throw new Error("Project field option metadata is invalid.");
    return { ...(option.id !== undefined ? { id: requireText(option.id, "optionId", 200) } : {}), name: requireText(option.name, "optionName", 256), color, description: option.description ?? "" };
  });
  if (new Set(result.map((option) => option.id).filter(Boolean)).size !== result.filter((option) => option.id).length || new Set(result.map((option) => option.name.toLocaleLowerCase())).size !== result.length) throw new Error("Project field options must be unique.");
  return result;
}

function normalizeIterationConfiguration(input: NonNullable<Extract<GitHubProjectFieldDefinition, { type: "ITERATION" }>["iterationConfiguration"]>): NonNullable<NormalizedFieldDefinition["iterationConfiguration"]> {
  if (!Number.isInteger(input.duration) || input.duration < 1 || input.duration > 365 || !validDate(input.startDate) || !Array.isArray(input.iterations) || input.iterations.length > 100) throw new Error("The iteration configuration is invalid.");
  const iterations = input.iterations.map((iteration) => ({ ...(iteration.id !== undefined ? { id: requireText(iteration.id, "iterationId", 200) } : {}), title: requireText(iteration.title, "iterationTitle", 256), startDate: requireText(iteration.startDate, "iterationStartDate", 10), ...(iteration.duration !== undefined ? { duration: iteration.duration } : {}) }));
  if (iterations.some((iteration) => !validDate(iteration.startDate) || (iteration.duration !== undefined && (!Number.isInteger(iteration.duration) || iteration.duration < 1 || iteration.duration > 365)))) throw new Error("The iteration configuration is invalid.");
  return { duration: input.duration, startDate: input.startDate, iterations };
}

function preserveIterationIds(current: GitHubProjectField["iterationConfiguration"], requested: NonNullable<Extract<GitHubProjectFieldDefinition, { type: "ITERATION" }>["iterationConfiguration"]>) {
  const normalized = normalizeIterationConfiguration(requested);
  const byId = new Map((current?.iterations ?? []).map((iteration) => [iteration.id, iteration]));
  const byTitle = new Map((current?.iterations ?? []).map((iteration) => [iteration.title.toLocaleLowerCase(), iteration]));
  normalized.iterations = normalized.iterations.map((iteration) => {
    const prior = iteration.id ? byId.get(iteration.id) : byTitle.get(iteration.title.toLocaleLowerCase());
    if (iteration.id && !prior) throw new Error("An iteration ID does not belong to this Project field.");
    return prior ? { ...iteration, id: prior.id } : iteration;
  });
  return normalized;
}

function fieldTypeToDataType(type: GitHubProjectField["type"]): NormalizedFieldDefinition["dataType"] {
  if (type === "TEXT" || type === "NUMBER" || type === "DATE" || type === "SINGLE_SELECT" || type === "MULTI_SELECT" || type === "ITERATION") return type;
  throw new Error("The Project field type is unsupported.");
}

function dataTypeToFieldType(type: NormalizedFieldDefinition["dataType"]): GitHubProjectField["type"] { return type; }

function sameOptions(actual: Array<{ id: string; name: string; color: string; description: string }>, expected: Array<{ id?: string; name: string; color: string; description: string }>): boolean {
  return actual.length === expected.length && expected.every((option, index) => actual[index]?.name === option.name && actual[index]?.color === option.color && actual[index]?.description === option.description && (!option.id || actual[index]?.id === option.id));
}

function sameIterationConfiguration(actual: GitHubProjectField["iterationConfiguration"], expected: NonNullable<NormalizedFieldDefinition["iterationConfiguration"]>): boolean {
  return Boolean(actual && actual.duration === expected.duration && actual.startDate === expected.startDate && actual.iterations.length === expected.iterations.length && expected.iterations.every((iteration, index) => actual.iterations[index]?.title === iteration.title && actual.iterations[index]?.startDate === iteration.startDate && (!iteration.id || actual.iterations[index]?.id === iteration.id) && actual.iterations[index]?.duration === iteration.duration));
}

function sameStringArray(actual: string[], expected: string[]): boolean { return actual.length === expected.length && actual.every((value, index) => value === expected[index]); }

function validDate(value: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value; }

function parseProjectView(value: unknown): GitHubProjectView {
  if (typeof value !== "object" || value === null) throw new GitHubProjectsApiError("invalid_response");
  const item = value as Record<string, unknown>;
  const visibleFields = (item.configuration as { visibleFields?: { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean } } } | undefined)?.visibleFields;
  if (typeof item.id !== "string" || typeof item.name !== "string" || !["TABLE_LAYOUT", "BOARD_LAYOUT", "ROADMAP_LAYOUT"].includes(String(item.layout)) || (item.filter !== null && item.filter !== undefined && typeof item.filter !== "string") || !Array.isArray(visibleFields?.nodes) || visibleFields.pageInfo?.hasNextPage !== false || visibleFields.nodes.some((field) => typeof field !== "object" || field === null || typeof (field as { id?: unknown }).id !== "string")) throw new GitHubProjectsApiError("invalid_response");
  return { id: item.id, name: item.name, layout: item.layout as GitHubProjectView["layout"], filter: typeof item.filter === "string" ? item.filter : "", visibleFieldIds: visibleFields.nodes.map((field) => (field as { id: string }).id) };
}

function normalizeViewInput(input: GitHubProjectViewInput, creating: boolean): GitHubProjectViewInput {
  const result: GitHubProjectViewInput = {};
  if (input.name !== undefined) result.name = requireText(input.name, "name", 256);
  else if (creating) throw new Error("A view name is required.");
  if (input.layout !== undefined) {
    if (!["TABLE_LAYOUT", "BOARD_LAYOUT", "ROADMAP_LAYOUT"].includes(input.layout)) throw new Error("The Project view layout is invalid.");
    result.layout = input.layout;
  } else if (creating) throw new Error("A view layout is required.");
  if (input.filter !== undefined) {
    if (typeof input.filter !== "string" || input.filter.length > 10_000) throw new Error("The Project view filter is invalid.");
    result.filter = input.filter;
  }
  if (input.visibleFieldIds !== undefined) {
    if (!Array.isArray(input.visibleFieldIds) || input.visibleFieldIds.length > 100 || input.visibleFieldIds.some((id) => typeof id !== "string" || !id.trim())) throw new Error("Visible Project fields are invalid.");
    result.visibleFieldIds = [...input.visibleFieldIds];
  }
  return result;
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
