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
  type ConsoleState = {
    stopped: boolean; activeSessions: number; runningProcesses: number; updatedAt: string;
    sessions?: Array<{ session_id: string; working_directory?: string; purpose?: string; created_at: string; last_used_at?: string; state: string; active: boolean; external_url?: string; external_title?: string }>;
    running?: Array<{ operation_id: string; connection_id: string; label: string; status: string; purpose?: string; command?: string }>;
  };
  const sessionId = root.dataset.sessionId ?? "";
  const operationRows = document.getElementById("operation-rows") as HTMLTableSectionElement | null;
  const processDetails = document.getElementById("process-details");
  const status = document.getElementById("log-status");
  const newButton = document.getElementById("log-new-button") as HTMLButtonElement | null;
  const olderButton = document.getElementById("log-older-button") as HTMLButtonElement | null;
  const autoRefresh = document.getElementById("auto-refresh") as HTMLInputElement | null;
  const listPage = !sessionId && Boolean(autoRefresh);
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
  let pageLeft = false;
  let pageGeneration = 0;
  let authenticationEnded = false;
  let manualGeneration = 0;
  let manualController: AbortController | undefined;
  let generation = 0;
  let storeGeneration = 0;
  let connectionState: ConnectionState = "connecting";
  let logState: LogState = "current";
  let pendingCount = 0;
  let pendingOverflow = false;
  let gapCount = 0;
  const pageLimit = 200;
  let autoGeneration = 0;
  let autoTimer: ReturnType<typeof setTimeout> | undefined;
  let autoBusy = false;
  let autoPending = false;
  let manualPending = false;
  let noticeGeneration = 0;
  let stateRequestGeneration = 0;
  let statePending = false;
  let deferredConsoleState: ConsoleState | undefined;
  let resyncPending = false;
  let pageHidden = document.hidden;
  let autoController: AbortController | undefined;
  let lastAutomaticCycleAt = Number.NEGATIVE_INFINITY;
  const autoEnabled = () => Boolean(listPage && autoRefresh?.checked && !pageHidden && !pageLeft && !authenticationEnded);
  const readsAllowed = () => !authenticationEnded && !pageLeft;
  const cancelAutomatic = () => { autoGeneration += 1; if (autoTimer !== undefined) clearTimeout(autoTimer); autoTimer = undefined; autoController?.abort(); };
  function stopAuthentication() {
    if (authenticationEnded) return;
    authenticationEnded = true;
    deferredConsoleState = undefined;
    cancelAutomatic();
    manualPending = false;
    manualGeneration += 1;
    manualController?.abort();
    generation += 1;
    pageGeneration += 1;
    if (connection) connection.close();
    connectionState = "disconnected";
    if (autoRefresh) autoRefresh.disabled = true;
    if (newButton) newButton.disabled = true;
    if (olderButton) olderButton.disabled = true;
    if (status) status.textContent = "認証またはアクセス権を確認してください。再読み込み後に再認証できます。";
  }
  const isAuthenticationFailure = (response: Response) => {
    if (response.status !== 401 && response.status !== 403) return false;
    stopAuthentication();
    return true;
  };
  const scheduleAutomatic = () => {
    if (!autoEnabled() || autoBusy || autoTimer !== undefined || !(autoPending || statePending || resyncPending)) return;
    const generationAtSchedule = autoGeneration;
    const wait = Math.max(0, 2000 - (Date.now() - lastAutomaticCycleAt));
    if (wait === 0) { void automaticCycle(); return; }
    autoTimer = setTimeout(() => { autoTimer = undefined; if (generationAtSchedule === autoGeneration) void automaticCycle(); }, wait);
  };

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
  const addCell = (row: HTMLTableRowElement, value: unknown) => {
    const cell = row.insertCell();
    cell.textContent = String(value ?? "—");
    return cell;
  };
  const appendSessionTimeCell = (row: HTMLTableRowElement, value: unknown, id: string, kind: "created" | "last-access", open: boolean) => {
    const cell = row.insertCell();
    cell.className = "session-time-cell";
    const display = formatSessionTime(value);
    if (!display) { cell.textContent = "—"; return undefined; }
    const details = document.createElement("details");
    details.className = "session-time";
    details.dataset.sessionId = id;
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
    if (!readsAllowed()) throw new Error("read stopped");
    if (sessionId) params.set("session_id", sessionId);
    const response = await fetch("/api/logs?" + params.toString(), { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!readsAllowed()) throw new Error("read stopped");
    if (isAuthenticationFailure(response)) return { response };
    if (!response.ok) return { response };
    const page = await response.json() as LogPage;
    if (!readsAllowed()) throw new Error("read stopped");
    return { response, page };
  };
  const applyNewLogs = async () => {
    if (!readsAllowed() || logState === "refreshing") return;
    const startCursor = displayNewestCursor || appliedCursor;
    updateLogState("refreshing");
    const fetched: LogItem[] = [];
    let cursor = startCursor;
    let newest = startCursor;
    const operationGeneration = storeGeneration;
    const screenGeneration = pageGeneration;
    try {
      while (true) {
        const params = new URLSearchParams({ limit: String(pageLimit) });
        if (cursor) params.set("after", cursor);
        const result = await fetchPage(params);
        if (!readsAllowed() || operationGeneration !== storeGeneration || screenGeneration !== pageGeneration) return;
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
      if (!readsAllowed() || screenGeneration !== pageGeneration) return;
      commitItems(fetched, "newer");
      appliedCursor = newest;
      root.dataset.newestCursor = newest;
      pendingCount = 0; pendingOverflow = false; gapCount = 0; showPending();
      restartEvents();
      void refreshState();
      updateLogState("current");
    } catch {
      if (authenticationEnded) return;
      updateLogState("pending");
      void refreshState();
    }
  };
  async function automaticCycle(manual = false) {
    if (authenticationEnded || (!manual && !autoEnabled()) || autoBusy) return;
    const expected = manual ? manualGeneration : autoGeneration;
    lastAutomaticCycleAt = Date.now();
    const noticesAtStart = noticeGeneration;
    const controller = new AbortController();
    if (manual) manualController = controller; else autoController = controller;
    autoBusy = true;
    const current = () => expected === (manual ? manualGeneration : autoGeneration) && !pageLeft && !authenticationEnded && (manual || autoEnabled()) && !controller.signal.aborted;
    let needsState = statePending;
    try {
      if (resyncPending) {
        const response = await fetch("/api/logs?limit=" + pageLimit, { credentials: "same-origin", signal: controller.signal, headers: { Accept: "application/json" } });
        if (!current()) return;
        if (isAuthenticationFailure(response)) return;
        if (!response.ok) throw new Error("resync failed");
        const page = await response.json() as LogPage;
        if (!current()) return;
        commitItems(chronological(page.items), "replace");
        if (!current()) return;
        appliedCursor = page.newestCursor; oldestCursor = page.oldestCursor; hasMoreOlder = page.hasMoreOlder;
        root.dataset.newestCursor = appliedCursor; root.dataset.oldestCursor = oldestCursor; root.dataset.hasMoreOlder = String(hasMoreOlder);
        pendingCount = 0; pendingOverflow = false; resyncPending = false;
        autoPending = noticeGeneration !== noticesAtStart;
        if (!autoPending) showPending();
        needsState = true; statePending = true;
        restartEvents();
      } else if (autoPending) {
        let cursor = appliedCursor;
        let completed = false;
        for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
          const params = new URLSearchParams({ limit: String(pageLimit), after: cursor });
          const response = await fetch("/api/logs?" + params, { credentials: "same-origin", signal: controller.signal, headers: { Accept: "application/json" } });
          if (!current()) return;
          if (isAuthenticationFailure(response)) return;
          if (response.status === 409) { resyncPending = true; break; }
          if (!response.ok) throw new Error("logs request failed");
          const page = await response.json() as LogPage;
          if (!current()) return;
          if (!Array.isArray(page.items)) throw new Error("invalid logs response");
          commitItems(chronological(page.items), "newer");
          if (!current()) return;
          cursor = page.newestCursor || cursor;
          appliedCursor = cursor; root.dataset.newestCursor = cursor;
          needsState = true; statePending = true;
          if (!page.hasMoreNewer || !page.items.length || cursor === params.get("after")) { completed = true; break; }
        }
        if (completed && noticeGeneration === noticesAtStart) { autoPending = false; pendingCount = 0; pendingOverflow = false; showPending(); }
        else if (completed) autoPending = true;
      }
      if (needsState) {
        const stateRequest = ++stateRequestGeneration;
        const response = await fetch(apiPath("/api/console-state"), { credentials: "same-origin", signal: controller.signal, headers: { Accept: "application/json" } });
        if (!current() || stateRequest !== stateRequestGeneration) return;
        if (isAuthenticationFailure(response)) return;
        if (!response.ok) throw new Error("state request failed");
        const state = await response.json();
        if (!current() || stateRequest !== stateRequestGeneration) return;
        statePending = false;
        await refreshStateFrom(state);
        if (!current()) return;
      }
      updateLogState(autoPending || resyncPending || statePending ? "pending" : "current");
    } catch {
      if (current()) { autoPending = autoPending || pendingCount > 0 || pendingOverflow; statePending = needsState || statePending; updateLogState("pending"); }
    } finally {
      if (autoController === controller) autoController = undefined;
      if (manualController === controller) manualController = undefined;
      autoBusy = false;
      if (!readsAllowed()) manualPending = false;
      else if (manualPending) {
        manualPending = false;
        autoPending = true;
        statePending = true;
        void automaticCycle(true);
      } else scheduleAutomatic();
    }
  }
  async function resync() {
    if (!readsAllowed()) return;
    const screenGeneration = pageGeneration;
    updateLogState("resync-required");
    const params = new URLSearchParams({ limit: String(pageLimit) });
    try {
      const result = await fetchPage(params);
      if (!readsAllowed() || screenGeneration !== pageGeneration) return;
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
    } catch {
      if (authenticationEnded) return;
      updateLogState("pending");
      void refreshState();
    }
  }
  const chronological = (pageItems: LogItem[]) => [...pageItems].reverse();
  const loadOlder = async () => {
    if (!readsAllowed() || !hasMoreOlder || !oldestCursor || olderButton?.disabled) return;
    if (olderButton) { olderButton.disabled = true; olderButton.textContent = "取得中…"; }
    const before = oldestCursor;
    const operationGeneration = storeGeneration;
    try {
      const params = new URLSearchParams({ limit: String(pageLimit), before });
      const result = await fetchPage(params);
      if (!readsAllowed() || operationGeneration !== storeGeneration) return;
      if (result.response.status === 409) { await resync(); return; }
      if (!result.response.ok || !result.page) throw new Error("older logs request failed");
      commitItems(chronological(result.page.items), "older");
      oldestCursor = result.page.oldestCursor || oldestCursor;
      hasMoreOlder = result.page.hasMoreOlder;
      root.dataset.oldestCursor = oldestCursor;
      root.dataset.hasMoreOlder = String(hasMoreOlder);
      if (olderButton) olderButton.hidden = !hasMoreOlder;
    } catch { if (!authenticationEnded && status) status.textContent = "過去のログを取得できませんでした。再試行してください。"; }
    finally { if (olderButton) { olderButton.disabled = authenticationEnded; olderButton.textContent = "過去のログを読み込む"; } }
  };
  const sessionRows = document.getElementById("session-rows") as HTMLTableSectionElement | null;
  let relativeUpdateInterval: number | undefined;
  let secondsUpdateInterval: number | undefined;
  let futureBoundaryTimeout: number | undefined;
  const isSecondDisplay = (value: string | null) => /^\d+秒(?:前|後)$/.test(value ?? "");
  const sessionRelativeElements = () => sessionRows?.querySelectorAll<HTMLTimeElement>("time[data-session-relative]") ?? [];
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
  const selectionIntersectsSessionRows = () => {
    if (!sessionRows) return false;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return false;
    const anchorInside = Boolean(selection.anchorNode && sessionRows.contains(selection.anchorNode as Node));
    const focusInside = Boolean(selection.focusNode && sessionRows.contains(selection.focusNode as Node));
    // Selections wholly owned by the list can use the existing endpoint rebinding.
    if (anchorInside && focusInside) return false;
    try {
      const range = typeof selection.getRangeAt === "function" && (selection.rangeCount === undefined || selection.rangeCount > 0)
        ? selection.getRangeAt(0) : undefined;
      if (range?.intersectsNode) return range.intersectsNode(sessionRows);
    } catch { /* Use endpoint containment when an implementation cannot inspect this range. */ }
    return anchorInside !== focusInside;
  };
  const refreshStateFrom = async (state: ConsoleState) => {
      if (state.sessions && selectionIntersectsSessionRows()) {
        deferredConsoleState = state;
        return;
      }
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
      if (sessionRows && state.sessions) {
        const focusedElement = document.activeElement as HTMLElement | null;
        const focusedRow = focusedElement?.closest("tr[data-session-id]") as HTMLTableRowElement | null;
        const focusedSessionId = focusedRow?.dataset.sessionId;
        const selection = window.getSelection();
        const selectionPoint = (node: Node | null, offset: number) => {
          const cell = (node?.parentElement?.closest("td") ?? null) as HTMLTableCellElement | null;
          const row = (cell?.closest("tr[data-session-id]") ?? null) as HTMLTableRowElement | null;
          if (!node || !cell || !row || !sessionRows.contains(node)) return undefined;
          const cellIndex = Array.prototype.indexOf.call(row.cells, cell) as number;
          if (cellIndex < 0) return undefined;
          const range = document.createRange(); range.selectNodeContents(cell); range.setEnd(node, offset);
          return { sessionId: row.dataset.sessionId ?? "", cellIndex, cellText: cell.textContent ?? "", offset: range.toString().length };
        };
        const savedSelection = (() => {
          if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return undefined;
          const anchor = selectionPoint(selection.anchorNode, selection.anchorOffset);
          const focus = selectionPoint(selection.focusNode, selection.focusOffset);
          // Only selections wholly owned by session rows are managed during this redraw.
          if (!anchor || !focus) return undefined;
          return { text: selection.toString(), anchor, focus };
        })();
        const visibleRows = [...sessionRows.querySelectorAll<HTMLTableRowElement>("tr[data-session-id]")];
        const anchorRow = visibleRows.find((row) => { const rect = row.getBoundingClientRect(); return rect.bottom > 0 && rect.top < window.innerHeight; });
        const scrollAnchor = anchorRow ? { sessionId: anchorRow.dataset.sessionId ?? "", top: anchorRow.getBoundingClientRect().top } : undefined;
        const priorScrollY = window.scrollY;
        const visibleSessions = root.dataset.filter === "active" ? state.sessions.filter((session) => session.active) : state.sessions;
        const savedOpenByKey = new Map<string, boolean>();
        let focusedTimeKey: string | undefined;
        for (const details of sessionRows.querySelectorAll<HTMLDetailsElement>("details[data-session-time]")) {
          const key = JSON.stringify([details.dataset.sessionId ?? "", details.dataset.sessionTime ?? ""]);
          savedOpenByKey.set(key, details.open);
          if (details.querySelector("summary") === document.activeElement) focusedTimeKey = key;
        }
        const restoredSummaries = new Map<string, HTMLElement>();
        sessionRows.replaceChildren();
        if (!visibleSessions.length) {
          const row = sessionRows.insertRow(); const cell = row.insertCell(); cell.colSpan = 8;
          cell.textContent = root.dataset.filter === "active" ? "有効なセッションはありません。" : "表示できるセッションはありません。";
        } else for (const session of visibleSessions) {
          const row = sessionRows.insertRow();
          row.dataset.sessionId = session.session_id;
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
          const externalCell = row.insertCell(); externalCell.className = "session-external-link-cell";
          if (externalCell.style) { externalCell.style.textAlign = "right"; externalCell.style.fontSize = ".9em"; externalCell.style.color = "#777"; }
          if (session.external_url) {
            try {
              const destination = new URL(session.external_url);
              if (["http:", "https:"].includes(destination.protocol) && !destination.username && !destination.password) {
                const external = document.createElement("a"); external.className = "session-external-link"; external.href = destination.href; external.target = "_blank"; external.rel = "noopener noreferrer"; external.referrerPolicy = "no-referrer"; external.textContent = session.external_title ?? session.external_url; externalCell.append(external);
              }
            } catch { /* Malformed API data cannot create a navigation link. */ }
          } else if (session.external_title) {
            const title = document.createElement("span"); title.className = "session-external-title"; title.textContent = session.external_title; externalCell.append(title);
          }
        }
        if (focusedSessionId) {
          const restoredRow = [...sessionRows.querySelectorAll<HTMLTableRowElement>("tr[data-session-id]")].find((row) => row.dataset.sessionId === focusedSessionId);
          if (!selection || selection.isCollapsed) restoredRow?.querySelector("a")?.focus();
        }
        if (focusedTimeKey) restoredSummaries.get(focusedTimeKey)?.focus({ preventScroll: true });
        if (savedSelection && selection) {
          const locate = (point: NonNullable<typeof savedSelection.anchor>) => {
            if (!point) return undefined;
            const row = [...sessionRows.querySelectorAll<HTMLTableRowElement>("tr[data-session-id]")].find((candidate) => candidate.dataset.sessionId === point.sessionId);
            const cell = row?.cells[point.cellIndex];
            // Restore only if the exact endpoint cell survives unchanged; otherwise clear rather than select different text.
            if (!cell || cell.textContent !== point.cellText) return undefined;
            const walker = document.createTreeWalker(cell, 4);
            let remaining = point.offset;
            let text = walker.nextNode();
            let last: Node | null = null;
            while (text) {
              last = text;
              const length = text.textContent?.length ?? 0;
              if (remaining <= length) return { node: text, offset: remaining };
              remaining -= length; text = walker.nextNode();
            }
            return last ? { node: last, offset: last.textContent?.length ?? 0 } : undefined;
          };
          const anchor = savedSelection.anchor && locate(savedSelection.anchor);
          const focus = savedSelection.focus && locate(savedSelection.focus);
          let restored = false;
          if (anchor && focus) {
            if (selection.setBaseAndExtent) {
              selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
              restored = selection.toString() === savedSelection.text;
            } else if (selection.collapse && selection.extend) {
              selection.collapse(anchor.node, anchor.offset);
              selection.extend(focus.node, focus.offset);
              restored = selection.toString() === savedSelection.text;
            } else {
              const anchorRange = document.createRange(); anchorRange.setStart(anchor.node, anchor.offset); anchorRange.collapse(true);
              const focusRange = document.createRange(); focusRange.setStart(focus.node, focus.offset); focusRange.collapse(true);
              const backwards = anchorRange.compareBoundaryPoints(0, focusRange) > 0;
              const range = document.createRange();
              range.setStart(backwards ? focus.node : anchor.node, backwards ? focus.offset : anchor.offset);
              range.setEnd(backwards ? anchor.node : focus.node, backwards ? anchor.offset : focus.offset);
              selection.removeAllRanges(); selection.addRange(range);
              restored = selection.toString() === savedSelection.text;
            }
          }
          if (!restored) selection.removeAllRanges();
        }
        const restoredAnchor = scrollAnchor && [...sessionRows.querySelectorAll<HTMLTableRowElement>("tr[data-session-id]")].find((row) => row.dataset.sessionId === scrollAnchor.sessionId);
        if (restoredAnchor) {
          const delta = restoredAnchor.getBoundingClientRect().top - scrollAnchor.top;
          if (delta) window.scrollBy(0, delta);
        } else if (window.scrollY !== priorScrollY) {
          window.scrollTo(window.scrollX, priorScrollY);
        }
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
  };
  document.addEventListener("selectionchange", () => {
    if (!deferredConsoleState || !readsAllowed() || selectionIntersectsSessionRows()) return;
    const latest = deferredConsoleState;
    deferredConsoleState = undefined;
    void refreshStateFrom(latest);
  });
  const refreshState = async () => {
    if (!readsAllowed()) return;
    const screenGeneration = pageGeneration;
    const stateRequest = ++stateRequestGeneration;
    try {
      const response = await fetch(apiPath("/api/console-state"), { credentials: "same-origin", headers: { Accept: "application/json" } });
      if (isAuthenticationFailure(response)) return;
      if (!response.ok || !readsAllowed() || screenGeneration !== pageGeneration || stateRequest !== stateRequestGeneration) return;
      const state = await response.json();
      if (!readsAllowed() || screenGeneration !== pageGeneration || stateRequest !== stateRequestGeneration) return;
      await refreshStateFrom(state);
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
      if (pendingCount || pendingOverflow) { noticeGeneration += 1; updateLogState("pending"); showPending(); if (autoEnabled()) { autoPending = true; scheduleAutomatic(); } }
      else if (logState !== "refreshing") { updateLogState("current"); showPending(); }
    });
    source.addEventListener("resync-required", () => { if (generation !== currentGeneration) return; source.close(); connectionState = "disconnected"; setStatus(); if (listPage) { resyncPending = true; autoPending = true; if (autoEnabled()) scheduleAutomatic(); else updateLogState("resync-required"); } else void resync(); });
    source.addEventListener("session-link-updated", () => { if (generation === currentGeneration) void refreshState(); });
    source.addEventListener("auth-expired", () => { if (generation !== currentGeneration) return; source.close(); connectionState = "disconnected"; stopAuthentication(); });
    source.addEventListener("heartbeat", () => { if (generation === currentGeneration && source.readyState === EventSource.OPEN) { connectionState = "connected"; setStatus(); } });
  }

  newButton?.addEventListener("click", () => {
    if (authenticationEnded || pageLeft) return;
    if (!listPage) { void applyNewLogs(); return; }
    if (autoBusy) {
      if (manualController) return;
      manualPending = true;
      autoPending = true;
      statePending = true;
      return;
    }
    autoPending = true; statePending = true;
    void automaticCycle(true);
  });
  autoRefresh?.addEventListener("change", () => {
    if (!autoRefresh.checked) { cancelAutomatic(); return; }
    if (pendingCount || pendingOverflow || resyncPending) autoPending = true;
    scheduleAutomatic();
  });
  document.addEventListener("visibilitychange", () => {
    pageHidden = document.hidden;
    if (pageHidden) cancelAutomatic();
    else { if (pendingCount || pendingOverflow || resyncPending) autoPending = true; scheduleAutomatic(); }
  });
  window.addEventListener("pagehide", () => {
    pageLeft = true;
    deferredConsoleState = undefined;
    pageGeneration += 1;
    cancelAutomatic();
    manualPending = false;
    manualGeneration += 1;
    manualController?.abort();
    generation += 1;
    if (connection) connection.close();
  });
  window.addEventListener("pageshow", (raw: Event) => {
    if (!(raw as PageTransitionEvent).persisted || authenticationEnded) return;
    pageLeft = false;
    pageGeneration += 1;
    pageHidden = document.hidden;
    generation += 1;
    if (listPage) { autoPending = true; statePending = true; }
    restartEvents();
    scheduleAutomatic();
  });
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
  setStatus(); showPending();
  void refreshState();
  restartEvents();
}

// tsx/esbuild decorates function expressions with __name during tests. Define
// the harmless helper in the emitted browser program as well as in tsc output.
export const userConsoleClientScript = `const __name=(value)=>value;const formatSessionTime=(${createSessionTimeFormatter.toString()})();(${clientBootstrap.toString()})();`;
