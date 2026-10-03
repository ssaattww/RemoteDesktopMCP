import { createSessionTimeFormatter } from "./session-time.js";

const formatSessionTime = createSessionTimeFormatter();

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

export function slideLogWindow(current: ConsoleLogItem[], incoming: ConsoleLogItem[], direction: "older" | "newer", limit = 1000) {
  const byId = new Map(current.map((item) => [item.id, item]));
  const unique = incoming.filter((item) => { if (byId.has(item.id)) return false; byId.set(item.id, item); return true; });
  const combined = direction === "older" ? [...unique, ...current] : [...current, ...unique];
  return {
    items: direction === "older" ? combined.slice(0, limit) : combined.slice(-limit),
    droppedOlder: direction === "newer" && combined.length > limit,
    droppedNewer: direction === "older" && combined.length > limit,
  };
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
  const eventSourceFactory = (url: string) => new EventSource(url);
  let appliedCursor = root.dataset.newestCursor ?? "";
  let oldestCursor = root.dataset.oldestCursor ?? "";
  let displayNewestCursor = appliedCursor;
  let hasMoreOlder = root.dataset.hasMoreOlder === "true";
  let items: LogItem[] = [];
  try {
    const initialItems = JSON.parse(root.dataset.initialItems ?? "[]") as LogItem[];
    items = [...initialItems].reverse().slice(-1000);
    if (items.length) {
      oldestCursor = items[0]!.cursor;
      displayNewestCursor = items.at(-1)!.cursor;
    }
  } catch { /* The server-rendered view remains available if bootstrap data is malformed. */ }
  let seen = new Set(items.map((item) => item.id));
  let baselineCaptured = false;
  let baselineCleared = false;
  const baselineOperations = new Map<string, Record<string, unknown>>();
  const baselineProcesses = new Map<string, { session: string; process: string; start?: Record<string, unknown>; events: Array<Record<string, unknown>> }>();
  const liveProcesses = new Map<string, { purpose: string; command: string; status: string }>();
  let connection: EventSource | undefined;
  let generation = 0;
  let storeGeneration = 0;
  let connectionState: ConnectionState = "connecting";
  let logState: LogState = "current";
  let pendingCount = 0;
  let pendingOverflow = false;
  let gapCount = 0;
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
    newButton.hidden = false;
    const count = Math.min(1000, pendingCount + gapCount);
    const countText = pendingOverflow || count >= 1000 ? "1000件以上" : count + "件";
    newButton.textContent = "↻ 更新（新着 " + countText + "）";
  };
  const updateLogState = (next: LogState) => { logState = next; setStatus(); };
  const ensureInitialSnapshot = () => {
    if (baselineCaptured) return;
    baselineCaptured = true;
    operationRows?.querySelectorAll<HTMLTableRowElement>("tr[data-event-json]").forEach((row) => {
      try {
        const event = JSON.parse(row.dataset.eventJson ?? "") as Record<string, unknown>;
        const key = String(row.dataset.operationId ?? event.operationId ?? "");
        if (key) baselineOperations.set(key, event);
      } catch { /* Ignore a malformed row; API items still populate the live view. */ }
    });
    processDetails?.querySelectorAll<HTMLElement>(".process-block[data-events-json]").forEach((block) => {
      try {
        const session = block.dataset.sessionId ?? "";
        const process = block.dataset.processId ?? "";
        const events = JSON.parse(block.dataset.eventsJson ?? "[]") as Array<Record<string, unknown>>;
        const start = events.find((event) => event.event === "process.start");
        if (process && start) baselineProcesses.set(processKey(session, process), {
          session, process, events,
          start: { event: "process.start", at: start.at, processId: start.processId ?? process, command: start.command, comment: start.comment },
        });
      } catch { /* A malformed snapshot is discarded. */ }
    });
  };
  const captureOpenStates = () => {
    const state = new Map<string, boolean>();
    processDetails?.querySelectorAll<HTMLDetailsElement>(".process-block").forEach((block) => {
      const key = processKey(block.dataset.sessionId ?? "", block.dataset.processId ?? "");
      const output = block.querySelector("details");
      if (output) state.set(key, output.open);
    });
    return state;
  };
  const captureOperationDetailStates = () => {
    const state = new Map<string, boolean>();
    operationRows?.querySelectorAll<HTMLTableRowElement>("tr[data-event-json]").forEach((row) => {
      const operationId = row.dataset.operationId ?? "";
      const detail = row.querySelector("details");
      if (operationId && detail) state.set(operationId, detail.open);
    });
    return state;
  };
  const addOperationDetailCell = (row: HTMLTableRowElement, event: Record<string, unknown>, open: boolean | undefined) => {
    const cell = row.insertCell();
    if (!event.detail || typeof event.detail !== "object" || Array.isArray(event.detail)) { cell.textContent = "—"; return; }
    const detail = event.detail as { summary?: unknown; entries?: unknown };
    if (!Array.isArray(detail.entries)) { cell.textContent = "—"; return; }
    const entries = detail.entries.flatMap((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const item = raw as { label?: unknown; value?: unknown; format?: unknown; truncated?: unknown };
      return typeof item.label === "string" && typeof item.value === "string" ? [{ label: item.label, value: item.value, format: item.format, truncated: item.truncated }] : [];
    });
    if (!entries.length) { cell.textContent = "—"; return; }
    const details = document.createElement("details");
    details.open = open ?? false;
    const summary = document.createElement("summary"); summary.textContent = "詳細"; details.append(summary);
    if (typeof detail.summary === "string") {
      const description = document.createElement("p"); const strong = document.createElement("strong");
      strong.textContent = detail.summary; description.append(strong); details.append(description);
    }
    for (const item of entries) {
      const block = document.createElement("div"); block.className = "operation-detail-entry";
      const label = document.createElement("strong"); label.textContent = item.label + (item.truncated === true ? "（省略あり）" : "");
      const pre = document.createElement("pre"); pre.textContent = item.value;
      if (item.format === "diff") pre.className = "operation-detail-diff";
      block.append(label); block.append(pre); details.append(block);
    }
    cell.append(details);
  };
  const timeText = (value: unknown) => {
    if (typeof value !== "string" || value === "—") return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "medium", hourCycle: "h23" }).format(date) + " JST";
  };
  const appendSessionTimeCell = (row: HTMLTableRowElement, value: unknown, sessionId: string, kind: "created" | "last-access", open: boolean) => {
    const cell = row.insertCell();
    cell.className = "session-time-cell";
    const display = formatSessionTime(value);
    if (!display) { cell.textContent = "—"; return undefined; }
    const details = document.createElement("details");
    details.className = "session-time";
    details.dataset.sessionId = sessionId;
    details.dataset.sessionTime = kind;
    details.open = open;
    const summary = document.createElement("summary");
    const relative = document.createElement("time");
    relative.dateTime = display.iso;
    relative.dataset.sessionRelative = "true";
    relative.textContent = display.relative;
    summary.append(relative);
    const exact = document.createElement("time");
    exact.dateTime = display.iso;
    exact.textContent = display.exact;
    details.append(summary);
    details.append(exact);
    cell.append(details);
    return details;
  };
  const addCell = (row: HTMLTableRowElement, value: unknown) => {
    const cell = row.insertCell();
    cell.textContent = String(value ?? "—");
    return cell;
  };
  const operationStatus = (event: Record<string, unknown>) => typeof event.status === "string" ? event.status : typeof event.event === "string" && event.event.startsWith("operation.") && !["operation.received", "operation.started"].includes(event.event) ? event.event.slice("operation.".length) : "running";
  const renderOperations = () => {
    if (!operationRows) return;
    ensureInitialSnapshot();
    const openedDetails = captureOperationDetailStates();
    const byKey = new Map<string, Record<string, unknown>>();
    if (!baselineCleared) {
      const visibleOperationIds = new Set(items.map((item) => String(item.event.operationId ?? "")).filter(Boolean));
      for (const [key, event] of baselineOperations) if (visibleOperationIds.has(key)) byKey.set(key, event);
    }
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
      addOperationDetailCell(row, event, openedDetails.get(String(event.operationId ?? key)));
    }
  };
  const processKey = (session: string, process: string) => JSON.stringify([session, process]);
  const renderProcesses = () => {
    if (!processDetails) return;
    ensureInitialSnapshot();
    const opened = captureOpenStates();
    const groups = new Map<string, { session: string; process: string; events: Array<Record<string, unknown>> }>();
    const ids = new Map<string, Set<string>>();
    for (const item of items) {
      const event = item.event;
      if (!["process.start", "process.output", "process.exit"].includes(String(event.event)) || typeof event.processId !== "string") continue;
      const session = String(event.sessionId ?? "");
      const key = processKey(session, event.processId);
      const group = groups.get(key) ?? { session, process: event.processId, events: [] };
      const known = ids.get(key) ?? new Set<string>();
      if (!known.has(item.id)) { group.events.push({ ...event, id: item.id }); known.add(item.id); }
      ids.set(key, known);
      groups.set(key, group);
    }
    const retained = [...groups.values()].flatMap((group) => group.events.map((event, order) => ({ group, event, order })))
      .sort((left, right) => Date.parse(String(left.event.at ?? "")) - Date.parse(String(right.event.at ?? "")) || left.order - right.order)
      .slice(-1000);
    groups.clear();
    for (const entry of retained) {
      const key = processKey(entry.group.session, entry.group.process);
      const group = groups.get(key) ?? { session: entry.group.session, process: entry.group.process, events: [] };
      group.events.push(entry.event);
      groups.set(key, group);
    }
    for (const key of liveProcesses.keys()) if (!groups.has(key)) {
      const baseline = baselineCleared ? undefined : baselineProcesses.get(key);
      const identity = baseline ? [baseline.session, baseline.process] : JSON.parse(key) as [string, string];
      groups.set(key, { session: identity[0], process: identity[1], events: [...(baseline?.events ?? [])] });
    }
    const all = [...groups.values()].sort((a, b) => {
      const aLive = liveProcesses.has(processKey(a.session, a.process));
      const bLive = liveProcesses.has(processKey(b.session, b.process));
      return Number(bLive) - Number(aLive) || Date.parse(String(b.events.at(-1)?.at ?? "")) - Date.parse(String(a.events.at(-1)?.at ?? ""));
    });
    const heading = processDetails.querySelector("h2");
    const toolbar = document.getElementById("log-console");
    processDetails.replaceChildren();
    if (heading) processDetails.append(heading);
    if (toolbar) processDetails.append(toolbar);
    for (const group of all.slice(0, 100)) {
      const events = group.events;
      const start = events.find((event) => event.event === "process.start") ?? (baselineCleared ? undefined : baselineProcesses.get(processKey(group.session, group.process))?.start);
      const latest = events.at(-1) ?? {};
      const exit = events.filter((event) => event.event === "process.exit").at(-1);
      const live = liveProcesses.get(processKey(group.session, group.process));
      const command = start?.command ?? events.filter((event) => event.command !== undefined).at(-1)?.command ?? live?.command;
      const comment = start?.comment ?? events.filter((event) => event.comment !== undefined).at(-1)?.comment ?? live?.purpose;
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
      const heading = document.createElement("h3"); heading.tabIndex = -1; heading.id = "process-" + encodeURIComponent(group.session) + "-" + encodeURIComponent(group.process);
      heading.textContent = timeText(start?.at ?? events[0]?.at) + " · " + group.session + " · " + String(latest.processId ?? group.process);
      article.append(heading);
      const addPre = (label: string, value: unknown) => {
        const title = document.createElement("h3"); title.textContent = label; article.append(title);
        const pre = document.createElement("pre"); pre.textContent = String(value ?? ""); article.append(pre);
      };
      addPre("実行目的", typeof comment === "string" && comment ? comment : "未記録");
      addPre("コマンド", typeof command === "string" && command ? command : "未記録");
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
    // Keep the section (and its update toolbar) present even when there are no
    // process events yet. The process articles themselves are the empty state.
    processDetails.hidden = false;
  };
  const renderEvents = () => {
    let focused: { session: string; process: string; tag: string } | undefined;
    let active = document.activeElement as HTMLElement | null;
    while (active && active !== processDetails) {
      if (active.className === "process-block") {
        let target = document.activeElement as HTMLElement | null;
        while (target && target !== active) {
          const targetTag = target.tagName.toUpperCase();
          if (targetTag === "SUMMARY" || targetTag === "H3") {
            focused = { session: active.dataset.sessionId ?? "", process: active.dataset.processId ?? "", tag: targetTag };
            break;
          }
          target = target.parentElement ?? (target as unknown as { parent?: HTMLElement }).parent ?? null;
        }
        break;
      }
      active = active.parentElement ?? (active as unknown as { parent?: HTMLElement }).parent ?? null;
    }
    const visible = processDetails ? [...processDetails.querySelectorAll<HTMLElement>(".process-block")].find((block) => {
      const rect = block.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight;
    }) : undefined;
    const anchor = visible ? { session: visible.dataset.sessionId ?? "", process: visible.dataset.processId ?? "", top: visible.getBoundingClientRect().top } : undefined;
    const scrollY = window.scrollY;
    renderOperations();
    renderProcesses();
    const replacement = anchor ? [...(processDetails?.querySelectorAll<HTMLElement>(".process-block") ?? [])].find((block) => block.dataset.sessionId === anchor.session && block.dataset.processId === anchor.process) : undefined;
    const shift = replacement ? replacement.getBoundingClientRect().top - anchor!.top : 0;
    window.scrollTo(window.scrollX, scrollY + shift);
    if (focused) {
      const targetBlock = [...(processDetails?.querySelectorAll<HTMLElement>(".process-block") ?? [])].find((block) => block.dataset.sessionId === focused!.session && block.dataset.processId === focused!.process);
      const target = targetBlock?.querySelector<HTMLElement>(focused.tag === "SUMMARY" ? "summary" : "h3");
      if (target && target.tagName.toUpperCase() === focused.tag) target.focus({ preventScroll: true });
    }
  };
  const commitItems = (incoming: LogItem[], direction: "newer" | "older" | "replace") => {
    if (direction === "replace") {
      storeGeneration += 1;
      items = incoming.slice(-1000);
      seen = new Set(items.map((item) => item.id));
      baselineCleared = true;
      baselineOperations.clear();
      baselineProcesses.clear();
      gapCount = 0;
    } else {
      const known = new Set(seen);
      const unique = incoming.filter((item) => { if (known.has(item.id)) return false; known.add(item.id); return true; });
      const combined = direction === "older" ? [...unique, ...items] : [...items, ...unique];
      if (direction === "older" && combined.length > 1000) {
        gapCount = Math.min(1000, gapCount + combined.length - 1000);
      }
      if (direction === "newer" && combined.length > 1000) hasMoreOlder = true;
      items = direction === "older" ? combined.slice(0, 1000) : combined.slice(-1000);
      seen = new Set(items.map((item) => item.id));
    }
    if (items.length) {
      oldestCursor = items[0]!.cursor;
      displayNewestCursor = items.at(-1)!.cursor;
      root.dataset.oldestCursor = oldestCursor;
      root.dataset.windowNewestCursor = displayNewestCursor;
    }
    root.dataset.hasMoreOlder = String(hasMoreOlder);
    if (olderButton) olderButton.hidden = !hasMoreOlder;
    renderEvents();
    showPending();
  };
  const fetchPage = async (params: URLSearchParams): Promise<{ response: Response; page?: LogPage }> => {
    if (sessionId) params.set("session_id", sessionId);
    const response = await fetch("/api/logs?" + params.toString(), { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!response.ok) return { response };
    return { response, page: await response.json() as LogPage };
  };
  const applyNewLogs = async () => {
    if (logState === "refreshing") return;
    const startCursor = displayNewestCursor || appliedCursor;
    updateLogState("refreshing");
    const fetched: LogItem[] = [];
    let cursor = startCursor;
    let newest = startCursor;
    const operationGeneration = storeGeneration;
    try {
      while (true) {
        const params = new URLSearchParams({ limit: String(pageLimit) });
        if (cursor) params.set("after", cursor);
        const result = await fetchPage(params);
        if (operationGeneration !== storeGeneration) return;
        if (result.response.status === 409) { await resync(); return; }
        if (!result.response.ok || !result.page) throw new Error("logs request failed");
        const page = result.page;
        if (!Array.isArray(page.items)) throw new Error("invalid logs response");
        fetched.push(...[...page.items].reverse());
        if (fetched.length > 1000) fetched.splice(0, fetched.length - 1000);
        newest = page.newestCursor || newest;
        if (!page.hasMoreNewer || !page.items.length || page.newestCursor === cursor) break;
        cursor = page.newestCursor;
      }
      commitItems(fetched, "newer");
      appliedCursor = newest;
      root.dataset.newestCursor = newest;
      pendingCount = 0; pendingOverflow = false; gapCount = 0; showPending();
      restartEvents();
      void refreshState();
      updateLogState("current");
    } catch {
      updateLogState("pending");
      void refreshState();
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
      pendingCount = 0; pendingOverflow = false; gapCount = 0; showPending();
      restartEvents();
      void refreshState();
      updateLogState("current");
    } catch { updateLogState("pending"); void refreshState(); }
  }
  const chronological = (pageItems: LogItem[]) => [...pageItems].reverse();
  const loadOlder = async () => {
    if (!hasMoreOlder || !oldestCursor || olderButton?.disabled) return;
    if (olderButton) { olderButton.disabled = true; olderButton.textContent = "取得中…"; }
    const before = oldestCursor;
    const operationGeneration = storeGeneration;
    try {
      const params = new URLSearchParams({ limit: String(pageLimit), before });
      const result = await fetchPage(params);
      if (operationGeneration !== storeGeneration) return;
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
    try {
      const response = await fetch(apiPath("/api/console-state"), { credentials: "same-origin", headers: { Accept: "application/json" } });
      if (!response.ok) return;
      const state = await response.json() as {
        stopped: boolean; activeSessions: number; runningProcesses: number; updatedAt: string;
        sessions?: Array<{ session_id: string; working_directory?: string; purpose?: string; created_at: string; last_used_at?: string; state: string; active: boolean }>;
        running?: Array<{ operation_id: string; connection_id: string; label: string; status: string; purpose?: string; command?: string }>;
      };
      if (state.running) {
        liveProcesses.clear();
        for (const operation of state.running) if (operation.label === "process") liveProcesses.set(processKey(operation.connection_id, operation.operation_id), { purpose: operation.purpose ?? "", command: operation.command ?? "", status: operation.status });
        if (processDetails) renderEvents();
      }
      const stopped = document.getElementById("execution-state");
      const active = document.getElementById("active-session-count");
      const running = document.getElementById("running-count");
      const updated = document.getElementById("state-updated-at");
      if (stopped) { stopped.textContent = state.stopped ? "STOPPED" : "READY"; stopped.classList.toggle("stopped", state.stopped); }
      if (active) active.textContent = String(state.activeSessions);
      if (running) running.textContent = String(state.runningProcesses);
      if (updated) updated.textContent = timeText(state.updatedAt);
      const sessionRows = document.getElementById("session-rows") as HTMLTableSectionElement | null;
      if (sessionRows && state.sessions) {
        const visibleSessions = root.dataset.filter === "active" ? state.sessions.filter((session) => session.active) : state.sessions;
        const savedOpenByKey = new Map<string, boolean>();
        let focusedTimeKey: string | undefined;
        for (const details of sessionRows.querySelectorAll<HTMLDetailsElement>("details[data-session-time]")) {
          const key = JSON.stringify([details.dataset.sessionId ?? "", details.dataset.sessionTime ?? ""]);
          savedOpenByKey.set(key, details.open);
          const summary = details.querySelector("summary");
          if (summary && document.activeElement === summary) focusedTimeKey = key;
        }
        const restoredSummaries = new Map<string, HTMLElement>();
        sessionRows.replaceChildren();
        if (!visibleSessions.length) {
          const row = sessionRows.insertRow(); const cell = row.insertCell(); cell.colSpan = 7;
          cell.textContent = root.dataset.filter === "active" ? "有効なセッションはありません。" : "表示できるセッションはありません。";
        } else for (const session of visibleSessions) {
          const row = sessionRows.insertRow();
          const linkCell = row.insertCell(); const link = document.createElement("a");
          link.className = "session-link"; link.href = "/user/sessions/" + encodeURIComponent(session.session_id); link.textContent = "詳細を見る"; linkCell.append(link);
          const createdKey = JSON.stringify([session.session_id, "created"]);
          const createdDetails = appendSessionTimeCell(row, session.created_at, session.session_id, "created", savedOpenByKey.get(createdKey) ?? false);
          const createdSummary = createdDetails?.querySelector("summary") as HTMLElement | null;
          if (createdSummary) restoredSummaries.set(createdKey, createdSummary);
          const lastAccessKey = JSON.stringify([session.session_id, "last-access"]);
          const lastAccessDetails = appendSessionTimeCell(row, session.last_used_at ?? session.created_at, session.session_id, "last-access", savedOpenByKey.get(lastAccessKey) ?? false);
          const lastAccessSummary = lastAccessDetails?.querySelector("summary") as HTMLElement | null;
          if (lastAccessSummary) restoredSummaries.set(lastAccessKey, lastAccessSummary);
          addCell(row, session.active ? "有効" : session.state === "closed" ? "終了" : "履歴");
          addCell(row, session.purpose ?? "—");
          addCell(row, session.session_id);
          addCell(row, session.working_directory ?? "—");
        }
        if (focusedTimeKey) restoredSummaries.get(focusedTimeKey)?.focus({ preventScroll: true });
        syncSessionTimeUpdates();
      }
      const runningRows = document.getElementById("running-rows") as HTMLTableSectionElement | null;
      if (runningRows && state.running) {
        runningRows.replaceChildren();
        for (const operation of state.running) {
          const row = runningRows.insertRow();
          addCell(row, operation.operation_id);
          addCell(row, operation.connection_id);
          const stateCell = addCell(row, operation.label + " · " + operation.status);
          stateCell.className = "running";
          if (operation.label === "process") {
            addCell(row, operation.purpose || "未記録");
            addCell(row, operation.command || "未記録");
            const action = row.insertCell(); const link = document.createElement("a");
            link.href = "#process-" + encodeURIComponent(operation.connection_id) + "-" + encodeURIComponent(operation.operation_id);
            link.dataset.sessionId = operation.connection_id; link.dataset.processId = operation.operation_id;
            link.textContent = "詳細へ"; action.append(link);
          } else { addCell(row, "—"); addCell(row, "—"); addCell(row, "—"); }
        }
        const table = document.getElementById("running-table");
        const empty = document.getElementById("running-empty");
        if (table) table.hidden = state.running.length === 0;
        if (empty) empty.hidden = state.running.length !== 0;
      }
    } catch { /* Keep the last successful state visible. */ }
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
    source.onopen = () => {
      if (generation !== currentGeneration) return;
      // EventSource can reconnect the same object. Each transport connection
      // starts a fresh server-side notification count from appliedCursor, so
      // its first notice replaces the old count instead of adding to it.
      firstNotice = true;
      connectionState = "connected";
      setStatus();
    };
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
  if (processDetails) {
    const hint = document.getElementById("log-pull-hint");
    let pull: { startX: number; startY: number; distance: number; cancelled: boolean } | undefined;
    const resetPull = () => { pull = undefined; if (hint) hint.textContent = "下へ引いて更新"; };
    processDetails.addEventListener("touchstart", (event: TouchEvent) => {
      if (event.touches.length !== 1 || logState === "refreshing") { resetPull(); return; }
      const target = event.target instanceof Element ? event.target : undefined;
      if (!target || target.closest("button,a,input,select,textarea,summary,[role=button]")) { resetPull(); return; }
      const block = target.closest<HTMLElement>(".process-block");
      const newest = processDetails.querySelector<HTMLElement>(".process-block");
      if (!block || block !== newest) { resetPull(); return; }
      const rect = block.getBoundingClientRect();
      if (rect.top < 0 || rect.top >= window.innerHeight || rect.bottom <= 0 || window.getSelection()?.toString()) { resetPull(); return; }
      const touch = event.touches[0]!;
      pull = { startX: touch.clientX, startY: touch.clientY, distance: 0, cancelled: false };
    }, { passive: true });
    processDetails.addEventListener("touchmove", (event: TouchEvent) => {
      if (!pull || event.touches.length !== 1) { resetPull(); return; }
      const touch = event.touches[0]!;
      const dx = touch.clientX - pull.startX;
      const dy = touch.clientY - pull.startY;
      if (Math.abs(dx) > Math.abs(dy) + 8 || dy < 0) { pull.cancelled = true; resetPull(); return; }
      pull.distance = dy;
      if (dy >= 72) {
        event.preventDefault();
        if (hint) hint.textContent = "離すと更新";
      } else if (dy > 10 && hint) hint.textContent = "あと " + Math.ceil(72 - dy) + "px";
    }, { passive: false });
    processDetails.addEventListener("touchend", () => {
      const shouldRefresh = Boolean(pull && !pull.cancelled && pull.distance >= 72 && !window.getSelection()?.toString() && logState !== "refreshing");
      resetPull();
      if (shouldRefresh) void applyNewLogs();
    });
    processDetails.addEventListener("touchcancel", resetPull);
  }
  window.addEventListener("scroll", () => {
    if (!hasMoreOlder || !oldestCursor || (olderButton && olderButton.disabled)) return;
    if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 120) void loadOlder();
  }, { passive: true });
  const sessionRows = document.getElementById("session-rows") as HTMLTableSectionElement | null;
  let relativeUpdateInterval: number | undefined;
  let secondsUpdateInterval: number | undefined;
  let futureBoundaryTimeout: number | undefined;
  const isSecondDisplay = (value: string | null) => /^\d+秒(?:前|後)$/.test(value ?? "");
  const sessionRelativeElements = () => sessionRows?.querySelectorAll<HTMLTimeElement>("time[data-session-relative]") ?? [];
  const updateSessionRelativeTimes = () => {
    for (const relative of sessionRelativeElements()) {
      const next = formatSessionTime(relative.dateTime)?.relative ?? "—";
      if (relative.textContent !== next) relative.textContent = next;
    }
    syncSessionSecondUpdates();
    syncSessionFutureBoundary();
  };
  const updateSessionSecondTimes = () => {
    let hasSecondDisplay = false;
    for (const relative of sessionRelativeElements()) {
      if (!isSecondDisplay(relative.textContent)) continue;
      const next = formatSessionTime(relative.dateTime)?.relative ?? "—";
      if (relative.textContent !== next) relative.textContent = next;
      if (isSecondDisplay(next)) hasSecondDisplay = true;
    }
    if (!hasSecondDisplay && secondsUpdateInterval !== undefined) {
      window.clearInterval(secondsUpdateInterval);
      secondsUpdateInterval = undefined;
    }
  };
  const syncSessionSecondUpdates = () => {
    const hasSecondDisplay = Array.from(sessionRelativeElements()).some((relative) => isSecondDisplay(relative.textContent));
    if (hasSecondDisplay && secondsUpdateInterval === undefined) {
      secondsUpdateInterval = window.setInterval(updateSessionSecondTimes, 1_000);
    } else if (!hasSecondDisplay && secondsUpdateInterval !== undefined) {
      window.clearInterval(secondsUpdateInterval);
      secondsUpdateInterval = undefined;
    }
  };
  const syncSessionFutureBoundary = () => {
    if (futureBoundaryTimeout !== undefined) {
      window.clearTimeout(futureBoundaryTimeout);
      futureBoundaryTimeout = undefined;
    }
    const now = Date.now();
    let nearestDelay: number | undefined;
    for (const relative of sessionRelativeElements()) {
      const timestamp = Date.parse(relative.dateTime);
      const remaining = timestamp - now;
      if (!Number.isFinite(timestamp) || remaining < 60_000) continue;
      const delay = Math.min(remaining - 59_999, 2_147_483_647);
      if (nearestDelay === undefined || delay < nearestDelay) nearestDelay = delay;
    }
    if (nearestDelay !== undefined) {
      futureBoundaryTimeout = window.setTimeout(() => {
        futureBoundaryTimeout = undefined;
        updateSessionRelativeTimes();
      }, nearestDelay);
    }
  };
  const syncSessionTimeUpdates = () => {
    syncSessionSecondUpdates();
    syncSessionFutureBoundary();
  };
  const stopSessionRelativeUpdates = () => {
    if (relativeUpdateInterval !== undefined) window.clearInterval(relativeUpdateInterval);
    if (secondsUpdateInterval !== undefined) window.clearInterval(secondsUpdateInterval);
    if (futureBoundaryTimeout !== undefined) window.clearTimeout(futureBoundaryTimeout);
    relativeUpdateInterval = undefined;
    secondsUpdateInterval = undefined;
    futureBoundaryTimeout = undefined;
  };
  const startSessionRelativeUpdates = () => {
    if (!sessionRows || relativeUpdateInterval !== undefined) return;
    updateSessionRelativeTimes();
    relativeUpdateInterval = window.setInterval(updateSessionRelativeTimes, 60_000);
  };
  if (sessionRows) {
    window.addEventListener("pagehide", stopSessionRelativeUpdates);
    window.addEventListener("pageshow", startSessionRelativeUpdates);
    startSessionRelativeUpdates();
  }
  setStatus(); showPending();
  void refreshState();
  restartEvents();
}

// tsx/esbuild decorates function expressions with __name during tests. Define
// the harmless helper in the emitted browser program as well as in tsc output.
export const userConsoleClientScript = `const __name=(value)=>value;const formatSessionTime=(${createSessionTimeFormatter.toString()})();(${clientBootstrap.toString()})();`;
