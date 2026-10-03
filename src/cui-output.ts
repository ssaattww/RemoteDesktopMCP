export type CuiModel = {
  sessions: Array<{ sessionId: string; purpose: string | null; workingDirectory: string | null; createdAt: string; lastAccessAt: string; state: "active" | "closed" | "expired" | "unavailable" }>;
  operations: Array<{ operationId: string; connectionId: string; status: "running" | "terminating"; startedAt: null; endedAt: null }>;
  logs: Array<{ logId: string; timestamp: string; type: string }>;
};

/** Pure, shared allowlist converter used by the authenticated browser panel and terminal CUI. */
export function mapCuiResponse(rawState: unknown, rawLogs: unknown, selectedSession = ""): { model: CuiModel; truncated: boolean } {
  const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
  const isDate = (value: unknown): value is string => isText(value) && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
  if (!isRecord(rawState) || !Array.isArray(rawState.sessions) || !Array.isArray(rawState.running) || !isRecord(rawLogs) || !Array.isArray(rawLogs.items)) throw new Error("invalid response");
  const scopedSessions = selectedSession ? rawState.sessions.filter((raw) => isRecord(raw) && raw.session_id === selectedSession) : rawState.sessions;
  const sessions = scopedSessions.slice(0, 201).map((raw): CuiModel["sessions"][number] => {
    if (!isRecord(raw) || !isText(raw.session_id) || !(raw.purpose == null || typeof raw.purpose === "string") || !(raw.working_directory == null || typeof raw.working_directory === "string") || !isDate(raw.created_at) || !isDate(raw.last_used_at) || typeof raw.active !== "boolean" || typeof raw.state !== "string" || !["active", "closed", "expired", "unavailable"].includes(raw.state) || (raw.active ? raw.state !== "active" : raw.state === "active")) throw new Error("invalid session");
    return { sessionId: raw.session_id, purpose: raw.purpose ?? null, workingDirectory: raw.working_directory as string | null ?? null, createdAt: raw.created_at, lastAccessAt: raw.last_used_at, state: raw.state as CuiModel["sessions"][number]["state"] };
  }).filter((session) => !selectedSession || session.sessionId === selectedSession);
  const operations = rawState.running.slice(0, 201).map((raw): CuiModel["operations"][number] => {
    if (!isRecord(raw) || !isText(raw.operation_id) || !isText(raw.connection_id) || (raw.status !== "running" && raw.status !== "terminating")) throw new Error("invalid operation");
    return { operationId: raw.operation_id, connectionId: raw.connection_id, status: raw.status, startedAt: null, endedAt: null };
  });
  const logs = rawLogs.items.slice(0, 201).map((raw): CuiModel["logs"][number] => {
    if (!isRecord(raw) || !isText(raw.id) || !isRecord(raw.event) || !isDate(raw.event.at) || !isText(raw.event.event)) throw new Error("invalid log");
    return { logId: raw.id, timestamp: raw.event.at, type: raw.event.event };
  });
  const truncated = scopedSessions.length > 200 || rawState.running.length > 200 || rawLogs.items.length > 200;
  return { model: { sessions: sessions.slice(0, 200), operations: operations.slice(0, 200), logs: logs.slice(0, 200) }, truncated };
}

// Kept as a narrow compatibility helper for callers that already hold the approved model.
export function createCuiOutput(model: CuiModel): CuiModel { return model; }
