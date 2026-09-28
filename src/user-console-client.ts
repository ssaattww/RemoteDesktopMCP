export type ConsoleLogItem = { id: string; cursor: string; event: Record<string, unknown> };

export function chronologicalPage(items: ConsoleLogItem[]): ConsoleLogItem[] {
  // /api/logs returns pages newest first. `after` pages are deliberately
  // fetched from the oldest unseen position forward, so reversing each page
  // preserves the store order when pages are appended.
  return [...items].reverse();
}

export function mergeBoundedItems(current: ConsoleLogItem[], incoming: ConsoleLogItem[], limit = 1000): ConsoleLogItem[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) if (!byId.has(item.id)) byId.set(item.id, item);
  return [...byId.values()].slice(-limit);
}

function clientBootstrap(): void {
  const consoleRoot = document.getElementById("log-console");
  if (!consoleRoot) return;
  const root = consoleRoot;

  type LogItem = { id: string; cursor: string; event: Record<string, unknown> };
  type LogPage = { items: LogItem[]; newestCursor: string; oldestCursor: string; hasMoreOlder: boolean; hasMoreNewer: boolean };
  type ConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";
  type LogState = "current" | "pending" | "refreshing" | "resync-required";
  const sessionId = root.dataset.sessionId ?? "";
  const operationRows = document.getElementById("operation-rows") as HTMLTableSectionElement | null;
  const processDetails = document.getElementById("process-details");
  const status = document.getElementById("log-status");
  const newButton = document.getElementById("log-new-button") as HTMLButtonElement | null;
  const olderButton = document.getElementById("log-older-button") as HTMLButtonElement | null;
  const stateButton = document.getElementById("state-refresh") as HTMLButtonElement | null;
  const eventSourceFactory = (url: string) => new EventSource(url);
  let appliedCursor = root.dataset.newestCursor ?? "";
  let oldestCursor = root.dataset.oldestCursor ?? "";
  let hasMoreOlder = root.dataset.hasMoreOlder === "true";
  let items: LogItem[] = [];
  let seen = new Set<string>();
  let connection: EventSource | undefined;
  let generation = 0;
  let connectionState: ConnectionState = "connecting";
  let logState: LogState = "current";
  let pendingCount = 0;
  let pendingOverflow = false;
  const pageLimit = 200;

  const query = (name: string, value: string) => name + "=" + encodeURIComponent(value);
  const apiPath = (path: string) => path + (sessionId ? "?" + query("session_id", sessionId) : "");
  const setStatus = () => {
    if (!status) return;
    const connectionLabel: Record<ConnectionState, string> = { connecting: "接続中", connected: "接続済み", reconnecting: "再接続中", disconnected: "切断" };
    const logLabel: Record<LogState, string> = { current: "最新", pending: "新着あり", refreshing: "取得中", "resync-required": "再同期が必要" };
    status.textContent = connectionLabel[connectionState] + " · " + logLabel[logState];
  };
  const showPending = () => {
    if (!newButton) return;
    if (!pendingCount && !pendingOverflow) { newButton.hidden = true; return; }
    newButton.hidden = false;
    newButton.textContent = pendingOverflow || pendingCount >= 1000 ? "新しいログ 1000件以上" : "新しいログ " + pendingCount + "件";
  };
  const updateLogState = (next: LogState) => { logState = next; setStatus(); };
  const captureOpenStates = () => {
    const state = new Map<string, boolean>();
    processDetails?.querySelectorAll<HTMLDetailsElement>(".process-block").forEach((block) => {
      const key = (block.dataset.sessionId ?? "") + ":" + (block.dataset.processId ?? "");
      const output = block.querySelector("details");
      if (output) state.set(key, output.open);
    });
    return state;
  };
  const timeText = (value: unknown) => {
    if (typeof value !== "string" || value === "—") return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "medium", hourCycle: "h23" }).format(date) + " JST";
  };
  const addCell = (row: HTMLTableRowElement, value: unknown) => {
    const cell = row.insertCell();
    cell.textContent = String(value ?? "—");
    return cell;
  };
  const operationStatus = (event: Record<string, unknown>) => typeof event.status === "string" ? event.status : typeof event.event === "string" && event.event.startsWith("operation.") && !["operation.received", "operation.started"].includes(event.event) ? event.event.slice("operation.".length) : "running";
  const renderOperations = () => {
    if (!operationRows) return;
    const byKey = new Map<string, Record<string, unknown>>();
    operationRows.querySelectorAll<HTMLTableRowElement>("tr[data-event-json]").forEach((row) => {
      try {
        const event = JSON.parse(row.dataset.eventJson ?? "") as Record<string, unknown>;
        const operationId = String(row.dataset.operationId ?? event.operationId ?? "");
        byKey.set(operationId, event);
      } catch { /* Leave malformed server-rendered rows alone until the next render. */ }
    });
    for (const item of items) {
      const event = item.event;
      if (typeof event.event !== "string" || !event.event.startsWith("operation.")) continue;
      const operationId = String(event.operationId ?? "");
      if (!operationId) continue;
      const connectionId = String(event.connectionId ?? event.sessionId ?? (operationId.startsWith("request:") ? operationId.slice("request:".length) : ""));
      const key = operationId;
      const prior = byKey.get(key);
      byKey.set(key, { ...(prior ?? {}), ...event, receivedAt: prior?.receivedAt ?? event.receivedAt ?? event.at, startAt: event.startAt ?? prior?.startAt, endedAt: event.endedAt ?? prior?.endedAt, durationMs: event.durationMs ?? prior?.durationMs, connectionId: event.connectionId ?? prior?.connectionId ?? connectionId });
    }
    const values = [...byKey.entries()].sort((a, b) => Date.parse(String(b[1].receivedAt ?? b[1].at ?? "")) - Date.parse(String(a[1].receivedAt ?? a[1].at ?? "")));
    operationRows.replaceChildren();
    for (const [key, event] of values.slice(0, 200)) {
      const row = operationRows.insertRow();
      row.dataset.operationId = String(event.operationId ?? key.slice(key.indexOf(":") + 1));
      row.dataset.connectionId = String(event.connectionId ?? "");
      row.dataset.eventJson = JSON.stringify(event);
      addCell(row, timeText(event.receivedAt ?? event.at));
      addCell(row, event.connectionId ?? "—");
      addCell(row, event.operationId ?? "—");
      addCell(row, event.tool ?? "—");
      const state = addCell(row, operationStatus(event));
      if (operationStatus(event) === "running") state.className = "running";
      addCell(row, event.target ?? "—");
      addCell(row, timeText(event.startAt));
      addCell(row, timeText(event.endedAt));
      addCell(row, event.durationMs === undefined ? "—" : String(event.durationMs) + " ms");
    }
  };
  const processKey = (session: string, process: string) => session + ":" + process;
  const renderProcesses = () => {
    if (!processDetails) return;
    const opened = captureOpenStates();
    const groups = new Map<string, { session: string; process: string; events: Array<Record<string, unknown>> }>();
    processDetails.querySelectorAll<HTMLElement>(".process-block[data-events-json]").forEach((block) => {
      try {
        const session = block.dataset.sessionId ?? "";
        const process = block.dataset.processId ?? "";
        const events = JSON.parse(block.dataset.eventsJson ?? "[]") as Array<Record<string, unknown>>;
        if (process) groups.set(processKey(session, process), { session, process, events });
      } catch { /* A later valid update can still be rendered. */ }
    });
    for (const item of items) {
      const event = item.event;
      if (!["process.start", "process.output", "process.exit"].includes(String(event.event)) || typeof event.processId !== "string") continue;
      const session = String(event.sessionId ?? "");
      const key = processKey(session, event.processId);
      const group = groups.get(key) ?? { session, process: event.processId, events: [] };
      if (!group.events.some((existing) => existing.id === item.id)) group.events.push({ ...event, id: item.id });
      groups.set(key, group);
    }
    const all = [...groups.values()].sort((a, b) => Date.parse(String(b.events.at(-1)?.at ?? "")) - Date.parse(String(a.events.at(-1)?.at ?? "")));
    const heading = processDetails.querySelector("h2");
    processDetails.replaceChildren();
    if (heading) processDetails.append(heading);
    for (const group of all.slice(0, 100)) {
      const events = group.events;
      const start = events.find((event) => event.event === "process.start");
      const latest = events.at(-1) ?? {};
      const exit = events.filter((event) => event.event === "process.exit").at(-1);
      const command = start?.command ?? events.filter((event) => event.command !== undefined).at(-1)?.command;
      const comment = start?.comment ?? events.filter((event) => event.comment !== undefined).at(-1)?.comment;
      const outputs = events.filter((event) => event.output !== undefined && event.event !== "process.exit");
      const earlierOutput = outputs.map((event) => String(event.output)).join("\n");
      if (exit?.output !== undefined && !earlierOutput.includes(String(exit.output))) {
        const snapshot = String(exit.output);
        const remainder = snapshot.startsWith(earlierOutput) ? snapshot.slice(earlierOutput.length).replace(/^\n/, "") : snapshot;
        if (remainder) outputs.push({ ...exit, output: remainder });
      }
      const article = document.createElement("article");
      article.className = "process-block";
      article.dataset.sessionId = group.session;
      article.dataset.processId = group.process;
      article.dataset.eventsJson = JSON.stringify(events);
      const heading = document.createElement("p");
      heading.textContent = timeText(start?.at ?? events[0]?.at) + " · " + group.session + " · " + String(latest.processId ?? "—");
      article.append(heading);
      const addPre = (label: string, value: unknown) => {
        const title = document.createElement("h3"); title.textContent = label; article.append(title);
        const pre = document.createElement("pre"); pre.textContent = String(value ?? ""); article.append(pre);
      };
      if (comment !== undefined) addPre("実行目的", comment);
      if (command !== undefined) addPre("コマンド", command);
      if (outputs.length) {
        const details = document.createElement("details");
        const summary = document.createElement("summary"); summary.textContent = "出力"; details.append(summary);
        for (const event of outputs) {
          const part = document.createElement("div"); part.className = "output-part";
          const small = document.createElement("small"); small.textContent = (event.event === "process.exit" ? "終了時の出力 · " : "") + timeText(event.at); part.append(small);
          const pre = document.createElement("pre"); pre.textContent = String(event.output); part.append(pre); details.append(part);
        }
        details.open = opened.get(processKey(group.session, group.process)) ?? false;
        article.append(details);
      }
      if (exit) { const foot = document.createElement("p"); foot.textContent = "終了コード: " + String(exit.exitCode ?? "—") + (exit.result ? " · " + String(exit.result) : ""); article.append(foot); }
      processDetails.append(article);
    }
    processDetails.hidden = all.length === 0;
  };
  const renderEvents = () => {
    const scrollY = window.scrollY;
    renderOperations();
    renderProcesses();
    window.scrollTo(window.scrollX, scrollY);
  };
  const commitItems = (incoming: LogItem[], direction: "newer" | "older" | "replace") => {
    if (direction === "replace") {
      items = incoming.slice(-1000);
      seen = new Set(items.map((item) => item.id));
    } else {
      const unique = incoming.filter((item) => !seen.has(item.id));
      for (const item of unique) seen.add(item.id);
      items = direction === "older" ? [...unique, ...items].slice(-1000) : [...items, ...unique].slice(-1000);
      seen = new Set(items.map((item) => item.id));
    }
    renderEvents();
  };
  const fetchPage = async (params: URLSearchParams): Promise<{ response: Response; page?: LogPage }> => {
    if (sessionId) params.set("session_id", sessionId);
    const response = await fetch("/api/logs?" + params.toString(), { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!response.ok) return { response };
    return { response, page: await response.json() as LogPage };
  };
  const applyNewLogs = async () => {
    if (logState === "refreshing") return;
    const startCursor = appliedCursor;
    updateLogState("refreshing");
    const fetched: LogItem[][] = [];
    let cursor = startCursor;
    let newest = startCursor;
    try {
      while (true) {
        const params = new URLSearchParams({ limit: String(pageLimit) });
        if (cursor) params.set("after", cursor);
        const result = await fetchPage(params);
        if (result.response.status === 409) { await resync(); return; }
        if (!result.response.ok || !result.page) throw new Error("logs request failed");
        const page = result.page;
        if (!Array.isArray(page.items)) throw new Error("invalid logs response");
        fetched.push(page.items);
        newest = page.newestCursor || newest;
        if (!page.hasMoreNewer || !page.items.length || page.newestCursor === cursor) break;
        cursor = page.newestCursor;
      }
      commitItems(fetched.flatMap((page) => [...page].reverse()), "newer");
      appliedCursor = newest;
      root.dataset.newestCursor = newest;
      pendingCount = 0; pendingOverflow = false; showPending();
      restartEvents();
      void refreshState();
      updateLogState("current");
    } catch {
      updateLogState("pending");
    }
  };
  async function resync() {
    updateLogState("resync-required");
    const params = new URLSearchParams({ limit: String(pageLimit) });
    try {
      const result = await fetchPage(params);
      if (!result.response.ok || !result.page) throw new Error("resync failed");
      commitItems(chronological(result.page.items), "replace");
      appliedCursor = result.page.newestCursor;
      oldestCursor = result.page.oldestCursor;
      hasMoreOlder = result.page.hasMoreOlder;
      root.dataset.newestCursor = appliedCursor;
      root.dataset.oldestCursor = oldestCursor;
      root.dataset.hasMoreOlder = String(hasMoreOlder);
      if (olderButton) olderButton.hidden = !hasMoreOlder;
      pendingCount = 0; pendingOverflow = false; showPending();
      restartEvents();
      void refreshState();
      updateLogState("current");
    } catch { updateLogState("pending"); }
  }
  const chronological = (pageItems: LogItem[]) => [...pageItems].reverse();
  const loadOlder = async () => {
    if (!hasMoreOlder || !oldestCursor || olderButton?.disabled) return;
    if (olderButton) { olderButton.disabled = true; olderButton.textContent = "取得中…"; }
    const before = oldestCursor;
    try {
      const params = new URLSearchParams({ limit: String(pageLimit), before });
      const result = await fetchPage(params);
      if (result.response.status === 409) { await resync(); return; }
      if (!result.response.ok || !result.page) throw new Error("older logs request failed");
      commitItems(chronological(result.page.items), "older");
      oldestCursor = result.page.oldestCursor || oldestCursor;
      hasMoreOlder = result.page.hasMoreOlder;
      root.dataset.oldestCursor = oldestCursor;
      root.dataset.hasMoreOlder = String(hasMoreOlder);
      if (olderButton) olderButton.hidden = !hasMoreOlder;
    } catch { if (status) status.textContent = "過去のログを取得できませんでした。再試行してください。"; }
    finally { if (olderButton) { olderButton.disabled = false; olderButton.textContent = "過去のログを読み込む"; } }
  };
  const refreshState = async () => {
    if (stateButton) stateButton.disabled = true;
    try {
      const response = await fetch(apiPath("/api/console-state"), { credentials: "same-origin", headers: { Accept: "application/json" } });
      if (!response.ok) return;
      const state = await response.json() as { stopped: boolean; activeSessions: number; runningProcesses: number; updatedAt: string };
      const stopped = document.getElementById("execution-state");
      const active = document.getElementById("active-session-count");
      const running = document.getElementById("running-count");
      const updated = document.getElementById("state-updated-at");
      if (stopped) { stopped.textContent = state.stopped ? "STOPPED" : "READY"; stopped.classList.toggle("stopped", state.stopped); }
      if (active) active.textContent = String(state.activeSessions);
      if (running) running.textContent = String(state.runningProcesses);
      if (updated) updated.textContent = timeText(state.updatedAt);
    } catch { /* Keep the last successful state visible. */ }
    finally { if (stateButton) stateButton.disabled = false; }
  };
  function restartEvents() {
    if (connection) connection.close();
    const currentGeneration = ++generation;
    connectionState = "connecting"; setStatus();
    const params = new URLSearchParams();
    params.set("after", appliedCursor);
    if (sessionId) params.set("session_id", sessionId);
    const source = eventSourceFactory("/api/events?" + params.toString());
    connection = source;
    let firstNotice = true;
    source.onopen = () => { if (generation !== currentGeneration) return; connectionState = "connected"; setStatus(); };
    source.onerror = () => { if (generation !== currentGeneration) return; connectionState = "reconnecting"; setStatus(); };
    source.addEventListener("logs-available", (raw: Event) => {
      if (generation !== currentGeneration) return;
      const data = JSON.parse((raw as MessageEvent<string>).data) as { addedCount?: number; latestCursor?: string; overflow?: boolean };
      const amount = Math.max(0, Math.floor(data.addedCount ?? 0));
      pendingCount = firstNotice ? amount : Math.min(1000, pendingCount + amount);
      firstNotice = false;
      pendingOverflow = Boolean(data.overflow) || pendingCount >= 1000;
      if (pendingCount || pendingOverflow) { updateLogState("pending"); showPending(); }
      else if (logState !== "refreshing") { updateLogState("current"); showPending(); }
    });
    source.addEventListener("resync-required", () => { if (generation !== currentGeneration) return; source.close(); connectionState = "disconnected"; setStatus(); void resync(); });
    source.addEventListener("auth-expired", () => { if (generation !== currentGeneration) return; source.close(); connectionState = "disconnected"; setStatus(); });
    source.addEventListener("heartbeat", () => { if (generation === currentGeneration && source.readyState === EventSource.OPEN) { connectionState = "connected"; setStatus(); } });
  }

  newButton?.addEventListener("click", () => { void applyNewLogs(); });
  olderButton?.addEventListener("click", () => { void loadOlder(); });
  stateButton?.addEventListener("click", () => { void refreshState(); });
  window.addEventListener("scroll", () => {
    if (!hasMoreOlder || !oldestCursor || (olderButton && olderButton.disabled)) return;
    if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 120) void loadOlder();
  }, { passive: true });
  setStatus(); showPending();
  void refreshState();
  restartEvents();
}

// tsx/esbuild decorates function expressions with __name during tests. Define
// the harmless helper in the emitted browser program as well as in tsc output.
export const userConsoleClientScript = `const __name=(value)=>value;(${clientBootstrap.toString()})();`;
