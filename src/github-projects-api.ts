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

export type GitHubMutationOutcome = { applied: true } | { applied: "unknown" };

export class GitHubProjectsApiError extends Error {
  constructor(
    readonly code: "credential_unavailable" | "credential_rejected" | "forbidden" | "rate_limited" | "api_error" | "invalid_response" | "identity_mismatch" | "request_failed",
    readonly applied: false | "unknown" = false,
  ) {
    super("The GitHub Projects operation could not be completed.");
    this.name = "GitHubProjectsApiError";
  }
}

type Viewer = { login: string };
type GraphQLErrorShape = { message?: unknown; type?: unknown; path?: unknown };
type GraphQLResponse<T> = { data?: T; errors?: GraphQLErrorShape[] };

const LIST_PROJECTS = `query RdmcpListProjects($after: String) {
  viewer { login projectsV2(first: 100, after: $after, orderBy: { field: NUMBER, direction: DESC }) {
    nodes { id title number url closed public }
    pageInfo { hasNextPage endCursor }
  } }
}`;
const CREATE_PROJECT = `mutation RdmcpCreateProject($ownerId: ID!, $title: String!) {
  viewer { login }
  createProjectV2(input: { ownerId: $ownerId, title: $title }) {
    projectV2 { id title number url closed public }
  }
}`;
const UPDATE_PROJECT = `mutation RdmcpUpdateProject($projectId: ID!, $title: String, $shortDescription: String) {
  viewer { login }
  updateProjectV2(input: { projectId: $projectId, title: $title, shortDescription: $shortDescription }) {
    projectV2 { id title number url closed public }
  }
}`;
const VIEWER_ID = `query RdmcpViewerId { viewer { id login } }`;
const PROJECT_OWNER = `query RdmcpProjectOwner($projectId: ID!) {
  viewer { login }
  node(id: $projectId) { ... on ProjectV2 { id owner { ... on User { login } } } }
}`;

/** Performs only the initial project-management slice: list, create, and edit
 * a project's title/short description. Administrative operations are absent. */
export class GitHubProjectsApi {
  private readonly request: typeof fetch;

  constructor(
    private readonly principal: string,
    private readonly expectedLogin: string,
    private readonly credentials: GitHubProjectsCredentialProvider,
    options: { request?: typeof fetch } = {},
  ) {
    if (!principal || !expectedLogin || expectedLogin.trim() !== expectedLogin) throw new Error("A configured principal and GitHub login are required.");
    this.request = options.request ?? fetch;
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
    const viewer = await this.#graphql<{ viewer?: { id?: string } }>("RdmcpViewerId", VIEWER_ID, {});
    const ownerId = viewer.viewer?.id;
    if (!ownerId) throw new GitHubProjectsApiError("invalid_response");
    const created = await this.#graphql<{ viewer?: { login?: string }; createProjectV2?: { projectV2?: unknown } }>("RdmcpCreateProject", CREATE_PROJECT, { ownerId, title: cleanTitle }, true);
    if (!created.createProjectV2?.projectV2) throw new GitHubProjectsApiError("invalid_response", "unknown");
    return { project: parseProject(created.createProjectV2.projectV2), outcome: { applied: true } };
  }

  async updateProject(projectId: string, input: { title?: string; shortDescription?: string }): Promise<{ project: GitHubProjectSummary; outcome: GitHubMutationOutcome }> {
    const id = requireText(projectId, "projectId", 200);
    const title = input.title === undefined ? null : requireText(input.title, "title", 256);
    const shortDescription = input.shortDescription === undefined ? null : requireText(input.shortDescription, "shortDescription", 2000);
    if (title === null && shortDescription === null) throw new Error("At least one project property must be provided.");
    const owner = await this.#graphql<{ node?: { owner?: { login?: string } } | null }>("RdmcpProjectOwner", PROJECT_OWNER, { projectId: id });
    if (owner.node?.owner?.login !== this.expectedLogin) throw new GitHubProjectsApiError("forbidden");
    const response = await this.#graphql<{ viewer?: { login?: string }; updateProjectV2?: { projectV2?: unknown } }>("RdmcpUpdateProject", UPDATE_PROJECT, { projectId: id, title, shortDescription }, true);
    if (!response.updateProjectV2?.projectV2) throw new GitHubProjectsApiError("invalid_response", "unknown");
    return { project: parseProject(response.updateProjectV2.projectV2), outcome: { applied: true } };
  }

  async #graphql<T>(operation: string, query: string, variables: Record<string, unknown>, mutation = false): Promise<T> {
    const token = await this.credentials.getToken(this.principal);
    if (!token || token.length > 16_384 || /[\r\n]/.test(token)) throw new GitHubProjectsApiError("credential_unavailable");
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
    if (response.status === 401) throw new GitHubProjectsApiError("credential_rejected", mutation ? "unknown" : false);
    if (response.status === 403) throw new GitHubProjectsApiError("forbidden", mutation ? "unknown" : false);
    if (response.status === 429) throw new GitHubProjectsApiError("rate_limited", mutation ? "unknown" : false);
    if (!response.ok) throw new GitHubProjectsApiError("api_error", mutation ? "unknown" : false);
    let payload: GraphQLResponse<T>;
    try { payload = await readBoundedJson<GraphQLResponse<T>>(response); }
    catch { throw new GitHubProjectsApiError("invalid_response", mutation ? "unknown" : false); }
    if (Array.isArray(payload.errors) && payload.errors.length > 0) throw new GitHubProjectsApiError("api_error", mutation ? "unknown" : false);
    if (!payload.data) throw new GitHubProjectsApiError("invalid_response", mutation ? "unknown" : false);
    const viewer = (payload.data as { viewer?: Viewer }).viewer;
    if (!viewer || viewer.login !== this.expectedLogin) throw new GitHubProjectsApiError("identity_mismatch", mutation ? "unknown" : false);
    return payload.data;
  }
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
