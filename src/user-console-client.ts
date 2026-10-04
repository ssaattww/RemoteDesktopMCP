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
  type SessionState = { session_id: string; working_directory?: string; purpose?: string; external_url?: string | null; external_title?: string | null; external_title_source?: string | null; external_title_status?: string; version?: number; created_at: string; last_used_at?: string; state: string; active: boolean };
  const renderExternalLink = (cell: HTMLElement, session: { external_url?: string | null; external_title?: string | null; external_title_source?: string | null; external_title_status?: string }) => {
    cell.replaceChildren();
    if (!session.external_url) {
      if (session.external_title) { const title = document.createElement("span"); title.className = "session-external-title"; title.textContent = session.external_title; cell.append(title); }
      else cell.textContent = "—";
    } else try {
      const url = new URL(session.external_url);
      if (!(url.protocol === "http:" || url.protocol === "https:") || url.username || url.password) cell.textContent = "—";
      else { const anchor = document.createElement("a"); anchor.className = "session-external-link"; anchor.href = url.href; anchor.target = "_blank"; anchor.rel = "noopener noreferrer"; anchor.referrerPolicy = "no-referrer"; anchor.textContent = session.external_title ?? url.href; cell.append(anchor); }
    } catch { cell.textContent = "—"; }
    const source = session.external_title_source === "manual" ? "手入力" : session.external_title_source === "fetched" ? "自動取得" : session.external_title_status === "pending" ? "題名を取得中" : session.external_title_status === "failed" ? "題名を取得できません" : "";
    if (source) { const label = document.createElement("small"); label.className = "session-external-source"; label.textContent = source; cell.append(label); }
  };
  let stateRequestGeneration = 0;
  const latestSavedVersionBySession = new Map<string, number>();
  const latestSessionStateById = new Map<string, SessionState>();
  const initializeSessionEditor = (form: HTMLFormElement) => {
    const conflict = form.querySelector<HTMLElement>("[data-session-conflict]");
    const conflictSummary = form.querySelector<HTMLElement>("[data-session-conflict-summary]");
    const directory = form.elements.namedItem("workingDirectory") as HTMLInputElement | null;
    const purpose = form.elements.namedItem("purpose") as HTMLInputElement | null;
    const externalUrl = form.elements.namedItem("externalUrl") as HTMLInputElement | null;
    const externalTitle = form.elements.namedItem("externalTitle") as HTMLInputElement | null;
    if (externalUrl) form.dataset.initialExternalUrl = externalUrl.value;
    if (externalTitle) form.dataset.initialExternalTitle = externalTitle.value;
    const applyLatest = (keepDraft: boolean) => {
      const version = Number(form.dataset.latestVersion);
      if (!Number.isSafeInteger(version) || !directory || !purpose) return;
      if (!keepDraft) {
        directory.value = form.dataset.latestDirectory ?? directory.value;
        purpose.value = form.dataset.latestPurpose ?? purpose.value;
        if (externalUrl) { externalUrl.value = form.dataset.latestExternalUrl ?? ""; form.dataset.initialExternalUrl = externalUrl.value; }
        if (externalTitle) { externalTitle.value = form.dataset.latestExternalTitle ?? ""; form.dataset.initialExternalTitle = externalTitle.value; }
        const row = form.closest("tr");
        const directoryCell = row?.querySelector<HTMLElement>("[data-session-directory]");
        const purposeCell = row?.querySelector<HTMLElement>("[data-session-purpose]");
        if (directoryCell) directoryCell.textContent = directory.value;
        if (purposeCell) purposeCell.textContent = purpose.value;
      }
      form.dataset.version = String(version);
      if (conflict) conflict.hidden = true;
      const output = form.querySelector<HTMLElement>("output");
      if (output) output.textContent = keepDraft ? "自分の入力を残しました。内容を確認して保存してください。" : "最新値を取り込みました。内容を確認して保存してください。";
    };
    form.querySelector<HTMLButtonElement>('[data-session-conflict-action="keep-draft"]')?.addEventListener("click", () => applyLatest(true));
    form.querySelector<HTMLButtonElement>('[data-session-conflict-action="use-latest"]')?.addEventListener("click", () => applyLatest(false));
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const sessionId = form.dataset.sessionEdit;
      const csrf = (form.elements.namedItem("csrf") as HTMLInputElement | null)?.value ?? "";
      const status = form.querySelector("output");
      const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
      const expectedVersion = Number(form.dataset.version);
      if (!sessionId || !directory || !purpose || !Number.isSafeInteger(expectedVersion)) return;
      if (button) button.disabled = true;
      if (status) status.textContent = "保存中…";
      const submittedDirectory = directory.value;
      const submittedPurpose = purpose.value;
      const submittedExternalUrl = externalUrl?.value;
      const submittedExternalTitle = externalTitle?.value;
      const payload: Record<string, unknown> = { expectedVersion, workingDirectory: directory.value, purpose: purpose.value };
      if (externalUrl && externalUrl.value !== (form.dataset.initialExternalUrl ?? "")) payload.externalUrl = externalUrl.value || null;
      if (externalTitle && externalTitle.value !== (form.dataset.initialExternalTitle ?? "")) payload.externalTitle = externalTitle.value || null;
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
          method: "PATCH",
          credentials: "same-origin",
          headers: { "content-type": "application/json", "x-csrf-token": csrf },
          body: JSON.stringify(payload),
        });
        const result = await response.json() as { error?: string; version?: number; working_directory?: string; purpose?: string; external_url?: string | null; external_title?: string | null; external_title_source?: string | null; external_title_status?: string };
        if (!response.ok || result.version === undefined || result.working_directory === undefined || result.purpose === undefined) {
          if (response.status === 409) {
            try {
              const latestResponse = await fetch("/api/console-state", { credentials: "same-origin", headers: { Accept: "application/json" } });
              const latestState = await latestResponse.json() as { sessions?: Array<{ session_id: string; active: boolean; version?: number; working_directory?: string; purpose?: string; external_url?: string | null; external_title?: string | null }> };
              const latest = latestState.sessions?.find((session) => session.session_id === sessionId && session.active && Number.isSafeInteger(session.version));
              if (latest) {
                form.dataset.latestVersion = String(latest.version);
                form.dataset.latestDirectory = latest.working_directory ?? "";
                form.dataset.latestPurpose = latest.purpose ?? "";
                form.dataset.latestExternalUrl = latest.external_url ?? "";
                form.dataset.latestExternalTitle = latest.external_title ?? "";
                if (conflictSummary) conflictSummary.textContent = `サーバーの最新値（版 ${latest.version}）: 作業ディレクトリ ${latest.working_directory ?? "—"} · 用途 ${latest.purpose ?? "—"}`;
                if (conflict) conflict.hidden = false;
                if (status) status.textContent = "版が競合しました。自分の入力を再編集するか、最新値を取り込んでください。";
              } else if (status) status.textContent = "競合後の最新状態を取得できませんでした。入力は保持しています。";
            } catch { if (status) status.textContent = "競合後の最新状態を取得できませんでした。入力は保持しています。"; }
          } else if (status) status.textContent = response.status === 404 ? "編集できるセッションではありません。" : result.error === "unsupported_field" ? "URL・題名の編集はまだ利用できません。" : "保存できませんでした。入力内容を確認してください。";
          return;
        }
        form.dataset.version = String(result.version);
        latestSavedVersionBySession.set(sessionId, Math.max(latestSavedVersionBySession.get(sessionId) ?? 0, result.version));
        const priorSession = latestSessionStateById.get(sessionId);
        if (priorSession) latestSessionStateById.set(sessionId, { ...priorSession, version: result.version, working_directory: result.working_directory, purpose: result.purpose, external_url: result.external_url ?? null, external_title: result.external_title ?? null, external_title_source: result.external_title_source ?? null, external_title_status: result.external_title_status });
        // Any state request started before this committed write must not restore its older snapshot.
        stateRequestGeneration++;
        const addedDirectoryInput = directory.value !== submittedDirectory;
        const addedPurposeInput = purpose.value !== submittedPurpose;
        const addedExternalUrl = externalUrl?.value !== submittedExternalUrl;
        const addedExternalTitle = externalTitle?.value !== submittedExternalTitle;
        if (!addedDirectoryInput) directory.value = result.working_directory;
        if (!addedPurposeInput) purpose.value = result.purpose;
        if (externalUrl) { form.dataset.initialExternalUrl = result.external_url ?? ""; if (!addedExternalUrl) externalUrl.value = result.external_url ?? ""; }
        if (externalTitle) { form.dataset.initialExternalTitle = result.external_title ?? ""; if (!addedExternalTitle) externalTitle.value = result.external_title ?? ""; }
        const row = form.closest("tr");
        const directoryCell = row?.querySelector<HTMLElement>("[data-session-directory]");
        const purposeCell = row?.querySelector<HTMLElement>("[data-session-purpose]");
        if (directoryCell) directoryCell.textContent = result.working_directory;
        if (purposeCell) purposeCell.textContent = result.purpose;
        const linkCell = row?.querySelector<HTMLElement>("[data-session-external-link]");
        if (linkCell) renderExternalLink(linkCell, result);
        if (status) status.textContent = addedDirectoryInput || addedPurposeInput || addedExternalUrl || addedExternalTitle ? "保存しました。追加の入力は未保存です。" : "保存しました。";
      } catch {
        if (status) status.textContent = "通信できませんでした。入力内容は保持しています。";
      } finally {
        if (button) button.disabled = false;
      }
    });
  };
  document.querySelectorAll<HTMLFormElement>("[data-session-edit]").forEach(initializeSessionEditor);
  const consoleRoot = document.getElementById("log-console");
  if (!consoleRoot) return;
  const root = consoleRoot;

  type LogItem = { id: string; cursor: string; event: Record<string, unknown> };
  type LogPage = { items: LogItem[]; newestCursor: string; oldestCursor: string; hasMoreOlder: boolean; hasMoreNewer: boolean };
  type ConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";
  type LogState = "current" | "pending" | "refreshing" | "resync-required";
  type ConsoleState = {
    stopped: boolean; activeSessions: number; runningProcesses: number; updatedAt: string;
    sessions?: SessionState[];
    running?: Array<{ operation_id: string; connection_id: string; label: string; status: string; purpose?: string; command?: string }>;
  };
  const sessionId = root.dataset.sessionId ?? "";
  const sessionCsrf = root.dataset.csrf ?? "";
  const todoPanel = document.getElementById("session-todo") as HTMLElement | null;
  type TodoItem = { id: string; text: string; status: string; order?: number };
  type TodoSnapshot = { session_id?: string; version: number; items: TodoItem[]; total?: number; completed?: number; last_updated_at?: string | null; enforcement_enabled?: boolean; audit_warning?: boolean; applied?: boolean; conflict?: boolean };
  type TodoRowState = { baseVersion: number; baseText: string; baseStatus: string; textGeneration: number; savedTextGeneration: number; statusGeneration: number; savedStatusGeneration: number; conflict?: TodoSnapshot; deletedDraft: boolean };
  type TodoAddState = { generation: number; savedGeneration: number; baseVersion: number; conflict?: TodoSnapshot; conflictGeneration?: number };
  let todoVersion = Number(todoPanel?.dataset.version ?? 0);
  let todoFetchGeneration = 0;
  let todoRefreshPending = false;
  let todoRefreshRunning = false;
  let todoMutationRunning = false;
  let todoUnavailable = false;
  let todoFetchController: AbortController | undefined;
  const rowStates = new WeakMap<HTMLElement, TodoRowState>();
  const boundRows = new WeakSet<HTMLElement>();
  const addState: TodoAddState = { generation: 0, savedGeneration: 0, baseVersion: todoVersion };
  const todoRows = (): HTMLElement[] => todoPanel ? Array.from(todoPanel.querySelectorAll<HTMLElement>("li[data-todo-id]")) : [];
  const statusLabel = (value: string) => value === "completed" ? "完了" : value === "in_progress" ? "進行中" : "未着手";
  const stateFor = (row: HTMLElement): TodoRowState => {
    const existing = rowStates.get(row); if (existing) return existing;
    const value = { baseVersion: Number(row.dataset.baseVersion ?? todoVersion), baseText: row.dataset.baseText ?? "", baseStatus: row.dataset.baseStatus ?? "not_started", textGeneration: 0, savedTextGeneration: 0, statusGeneration: 0, savedStatusGeneration: 0, deletedDraft: row.dataset.deletedDraft === "true" };
    rowStates.set(row, value); return value;
  };
  const textField = (row: HTMLElement) => row.querySelector<HTMLTextAreaElement>("[data-todo-text]");
  const statusField = (row: HTMLElement) => row.querySelector<HTMLSelectElement>("[data-todo-status]");
  const isTextDirty = (row: HTMLElement, state = stateFor(row)) => { const field = textField(row); return Boolean(field && (state.textGeneration !== state.savedTextGeneration || field.value !== state.baseText)); };
  const isStatusDirty = (row: HTMLElement, state = stateFor(row)) => { const field = statusField(row); return Boolean(field && (state.statusGeneration !== state.savedStatusGeneration || field.value !== state.baseStatus)); };
  const allTodoButtons = () => todoPanel ? Array.from(todoPanel.querySelectorAll<HTMLButtonElement>("button[data-todo-op]")) : [];
  const refreshTodoControls = () => {
    if (!todoPanel) return;
    const unavailable = todoUnavailable || authenticationEnded;
    for (const field of Array.from(todoPanel.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("textarea,select"))) field.disabled = unavailable || pageLeft;
    for (const button of allTodoButtons()) {
      const op = button.dataset.todoOp ?? "";
      const row = button.closest<HTMLElement>("li[data-todo-id]");
      const state = row ? stateFor(row) : undefined;
      const conflicted = Boolean(state?.conflict);
      const blockedRow = Boolean(state?.deletedDraft || row?.dataset.readonly === "true");
      const addConflicted = Boolean(addState.conflict);
      const resolution = op === "use-latest" || op === "keep-draft";
      const deletedChoice = op === "discard-deleted" || op === "readd-deleted" || op === "replace-add-draft" || op === "keep-add-draft";
      const blocked = unavailable || pageLeft || todoMutationRunning || (op === "add" && addConflicted) || (row && !resolution && !deletedChoice && (conflicted || blockedRow)) || (resolution && !conflicted) || (deletedChoice && !state?.deletedDraft);
      button.disabled = Boolean(blocked);
    }
  };
  const resizeTodoText = (field: HTMLTextAreaElement) => {
    field.style.height = "auto";
    const lineHeight = Number.parseFloat(field.style.lineHeight || "20") || 20;
    const cap = lineHeight * 8 + 20;
    const minHeight = lineHeight * 2 + 20;
    field.style.height = Math.max(minHeight, Math.min(Number(field.scrollHeight) || minHeight, cap)) + "px";
  };
  const updateRowBase = (row: HTMLElement, state: TodoRowState, item: TodoItem, version: number, takeText: boolean, takeStatus: boolean) => {
    state.baseText = item.text; state.baseStatus = item.status; state.baseVersion = version;
    row.dataset.baseText = item.text; row.dataset.baseStatus = item.status; row.dataset.baseVersion = String(version);
    if (takeText) { const field = textField(row); if (field) { field.value = item.text; resizeTodoText(field); } state.savedTextGeneration = state.textGeneration; }
    if (takeStatus) { const field = statusField(row); if (field) field.value = item.status; state.savedStatusGeneration = state.statusGeneration; }
  };
  const syncTodoMetadata = (snapshot: TodoSnapshot) => {
    if (!todoPanel) return;
    const summary = todoPanel.querySelector<HTMLElement>("[data-todo-summary-count]");
    if (summary && snapshot.total !== undefined && snapshot.completed !== undefined) summary.textContent = `進捗: ${snapshot.completed} / ${snapshot.total}`;
    const updated = todoPanel.querySelector<HTMLElement>("[data-todo-updated]");
    if (updated) updated.textContent = snapshot.last_updated_at ? timeText(snapshot.last_updated_at) : "未更新";
    if (typeof snapshot.enforcement_enabled === "boolean") {
      const state = todoPanel.querySelector<HTMLElement>("[data-todo-enforcement-state]"); if (state) state.textContent = snapshot.enforcement_enabled ? "有効" : "無効";
      const button = todoPanel.querySelector<HTMLButtonElement>("[data-todo-enforcement]"); if (button) { button.value = String(!snapshot.enforcement_enabled); button.textContent = snapshot.enforcement_enabled ? "強制を無効にする" : "強制を有効にする"; }
    }
  };
  const showRowConflict = (row: HTMLElement, snapshot: TodoSnapshot) => {
    const state = stateFor(row); if (snapshot.version < todoVersion || snapshot.version < (state.conflict?.version ?? 0)) return; state.conflict = snapshot;
    const box = row.querySelector<HTMLElement>("[data-todo-conflict]"); if (box) box.hidden = false;
    const latest = snapshot.items.find((item) => item.id === row.dataset.todoId);
    const latestText = row.querySelector<HTMLElement>("[data-todo-latest-text]"); if (latestText) latestText.textContent = latest?.text ?? "この項目は共有一覧から削除されています。";
    const latestStatus = row.querySelector<HTMLElement>("[data-todo-latest-status]"); if (latestStatus) latestStatus.textContent = latest ? `状態: ${statusLabel(latest.status)}` : "";
  };
  const focusAfterRowRemoval = (row: HTMLElement, previousOrder: HTMLElement[]) => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || !row.contains(active)) return;
    const index = previousOrder.indexOf(row);
    const destination = previousOrder.slice(index + 1).find((item) => Boolean(item.parentElement)) ?? previousOrder.slice(0, index).reverse().find((item) => Boolean(item.parentElement));
    const target = destination?.querySelector<HTMLElement>("[data-todo-text]") ?? todoPanel?.querySelector<HTMLElement>("h2");
    const scrollY = window.scrollY;
    if (target) target.focus({ preventScroll: true });
    window.scrollTo(window.scrollX, scrollY);
    const status = todoPanel?.querySelector<HTMLElement>("[data-todo-status-message]"); if (status) status.textContent = "削除された項目から次の利用可能な項目へ移動しました。";
  };
  const removeTodoRow = (row: HTMLElement, priorRows = todoRows()) => { focusAfterRowRemoval(row, priorRows); row.remove(); };
  const markDeletedDraft = (row: HTMLElement) => {
    const state = stateFor(row); if (state.deletedDraft) return;
    state.deletedDraft = true; row.dataset.deletedDraft = "true";
    const save = row.querySelector<HTMLButtonElement>('[data-todo-op="save"]'); const remove = row.querySelector<HTMLButtonElement>('[data-todo-op="delete"]');
    if (save) save.disabled = true; if (remove) remove.disabled = true;
    const notice = row.querySelector<HTMLElement>("[data-todo-deleted-notice]"); if (notice) { notice.hidden = false; notice.textContent = "サーバー側で削除済みです。入力を捨てるか、新しい項目として追加できます。"; }
    const choices = row.querySelector<HTMLElement>("[data-todo-deleted-actions]"); if (choices) choices.hidden = false;
    refreshTodoControls();
  };
  const applyTodoSnapshot = (snapshot: TodoSnapshot, mutation?: { row?: HTMLElement; operation: "add" | "edit" | "delete"; textGeneration: number; statusGeneration: number; addGeneration: number }) => {
    if (!todoPanel || !Number.isSafeInteger(snapshot.version) || snapshot.version < todoVersion || (snapshot.session_id && snapshot.session_id !== sessionId)) return;
    const list = todoPanel.querySelector<HTMLElement>("[data-todo-items]");
    const oldRows = todoRows();
    const oldOrder = [...oldRows];
    const activeElement = document.activeElement as HTMLElement | null;
    const focusedRow = activeElement ? oldRows.find((row) => row.contains(activeElement)) : undefined;
    const activeControl = activeElement as (HTMLInputElement | HTMLTextAreaElement) | null;
    const selection = activeControl && "selectionStart" in activeControl && "selectionEnd" in activeControl
      ? { start: activeControl.selectionStart, end: activeControl.selectionEnd, direction: activeControl.selectionDirection }
      : undefined;
    const scrollX = window.scrollX; const scrollY = window.scrollY;
    const itemIds = new Set(snapshot.items.map((item) => item.id));
    const orderedRows: HTMLElement[] = [];
    for (const item of snapshot.items) {
      let row = oldRows.find((candidate) => candidate.dataset.todoId === item.id);
      if (!row) { row = makeTodoRow(item); bindTodoRow(row); }
      const state = stateFor(row);
      if (mutation?.row === row && mutation.operation === "edit") {
        const unchangedText = state.textGeneration === mutation.textGeneration;
        const unchangedStatus = state.statusGeneration === mutation.statusGeneration;
        updateRowBase(row, state, item, snapshot.version, unchangedText, unchangedStatus);
        state.conflict = undefined;
        const box = row.querySelector<HTMLElement>("[data-todo-conflict]"); if (box) box.hidden = true;
      } else {
        const dirty = isTextDirty(row, state) || isStatusDirty(row, state);
        if (dirty && snapshot.version > state.baseVersion) showRowConflict(row, snapshot);
        else if (!dirty) { updateRowBase(row, state, item, snapshot.version, true, true); state.conflict = undefined; const box = row.querySelector<HTMLElement>("[data-todo-conflict]"); if (box) box.hidden = true; }
      }
      orderedRows.push(row);
    }
    for (const row of oldRows) {
      if (itemIds.has(row.dataset.todoId ?? "")) continue;
      const state = stateFor(row);
      const isSubmittedDelete = mutation?.row === row && mutation.operation === "delete";
      const editedAfterSubmit = isSubmittedDelete && (state.textGeneration !== mutation.textGeneration || state.statusGeneration !== mutation.statusGeneration);
      if (isSubmittedDelete && !editedAfterSubmit) removeTodoRow(row, oldOrder);
      else if (isTextDirty(row, state) || isStatusDirty(row, state) || editedAfterSubmit) markDeletedDraft(row);
      else removeTodoRow(row, oldOrder);
    }
    const deletedRows = todoRows().filter((row) => stateFor(row).deletedDraft && !itemIds.has(row.dataset.todoId ?? ""));
    const desiredRows = [...orderedRows, ...deletedRows];
    const currentRows = todoRows();
    const needsReorder = desiredRows.some((row, index) => currentRows[index] !== row);
    let movedFocusedRow = false;
    if (list && needsReorder) {
      for (let index = 0; index < desiredRows.length; index += 1) {
        const row = desiredRows[index]!; const current = todoRows();
        if (current[index] !== row) { if (row === focusedRow) movedFocusedRow = true; list.insertBefore(row, current[index] ?? null); }
      }
      if (focusedRow && movedFocusedRow && desiredRows.includes(focusedRow) && activeElement) {
        if (document.activeElement !== activeElement) activeElement.focus({ preventScroll: true });
        if (selection && typeof activeControl?.setSelectionRange === "function") {
          try { activeControl.setSelectionRange(selection.start ?? 0, selection.end ?? 0, selection.direction ?? "none"); } catch { /* Some input types do not support text selection. */ }
        }
        window.scrollTo(scrollX, scrollY);
      }
    }
    todoVersion = snapshot.version; todoPanel.dataset.version = String(todoVersion);
    for (const stateRow of todoRows()) if (!stateFor(stateRow).deletedDraft && !stateFor(stateRow).conflict) stateFor(stateRow).baseVersion = snapshot.version;
    syncTodoMetadata(snapshot);
    const addText = todoPanel.querySelector<HTMLTextAreaElement>("[data-todo-add-text]");
    if (addText) {
      const addDirty = addState.generation !== addState.savedGeneration || Boolean(addText.value);
      if (addDirty && snapshot.version > addState.baseVersion) {
        addState.conflict = snapshot; addState.conflictGeneration = addState.generation;
        const box = todoPanel.querySelector<HTMLElement>("[data-todo-add-conflict]"); if (box) box.hidden = false;
        const latest = todoPanel.querySelector<HTMLElement>("[data-todo-add-latest]"); if (latest) latest.textContent = `最新の共有版は ${snapshot.version}、項目数 ${snapshot.total ?? snapshot.items.length} 件です。`;
      } else if (!addDirty) addState.baseVersion = snapshot.version;
    }
    if (mutation?.operation === "add" && addText && addState.generation === mutation.addGeneration) { addText.value = ""; addState.generation += 1; addState.savedGeneration = addState.generation; }
    if (mutation?.operation === "add") { addState.baseVersion = snapshot.version; addState.conflict = undefined; const box = todoPanel.querySelector<HTMLElement>("[data-todo-add-conflict]"); if (box) box.hidden = true; }
    refreshTodoControls();
  };
  const showSessionUnavailable = () => {
    if (!todoPanel) return;
    todoUnavailable = true; todoRefreshPending = false; todoFetchGeneration += 1; todoFetchController?.abort();
    const message = todoPanel.querySelector<HTMLElement>("[data-todo-status-message]"); if (message) message.textContent = "このセッションでは作業一覧を利用できません。表示中の内容は保持されています。";
    refreshTodoControls();
  };
  const refreshTodo = () => {
    if (!todoPanel || !sessionId || authenticationEnded || pageLeft || todoUnavailable) return;
    todoRefreshPending = true;
    if (todoRefreshRunning) return;
    todoRefreshRunning = true;
    const fetchGeneration = ++todoFetchGeneration;
    void (async () => {
      while (todoRefreshPending && !authenticationEnded && !pageLeft && !todoUnavailable) {
        todoRefreshPending = false;
        const controller = new AbortController(); todoFetchController = controller;
        const screenGeneration = pageGeneration;
        try {
          const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/todo`, { credentials: "same-origin", signal: controller.signal, headers: { Accept: "application/json" } });
          if (fetchGeneration !== todoFetchGeneration || screenGeneration !== pageGeneration || pageLeft || authenticationEnded) return;
          if (isAuthenticationFailure(response)) return;
          if (response.status === 404) { showSessionUnavailable(); todoRefreshRunning = false; return; }
          if (!response.ok) throw new Error("Todo refresh failed");
          const snapshot = await response.json() as TodoSnapshot;
          if (fetchGeneration !== todoFetchGeneration || screenGeneration !== pageGeneration || pageLeft || authenticationEnded) return;
          applyTodoSnapshot(snapshot);
        } catch {
          if (!controller.signal.aborted && fetchGeneration === todoFetchGeneration && screenGeneration === pageGeneration && !authenticationEnded && !pageLeft) {
            const message = todoPanel.querySelector<HTMLElement>("[data-todo-status-message]"); if (message) message.textContent = "最新の作業一覧を取得できませんでした。表示中の内容は保持しています。";
          }
        }
      }
      todoRefreshRunning = false;
    })();
  };
  const resolveRowConflict = (row: HTMLElement, keepDraft: boolean) => {
    const state = stateFor(row); const snapshot = state.conflict; if (!snapshot) return;
    if (snapshot.version < todoVersion) return;
    const latest = snapshot.items.find((item) => item.id === row.dataset.todoId);
    if (!latest) { state.conflict = undefined; markDeletedDraft(row); }
    else {
      const localTextDirty = isTextDirty(row, state); const localStatusDirty = isStatusDirty(row, state);
      updateRowBase(row, state, latest, snapshot.version, !keepDraft || !localTextDirty, !keepDraft || !localStatusDirty);
      state.conflict = undefined; const box = row.querySelector<HTMLElement>("[data-todo-conflict]"); if (box) box.hidden = true;
    }
    todoVersion = Math.max(todoVersion, snapshot.version); if (todoPanel) todoPanel.dataset.version = String(todoVersion);
    syncTodoMetadata(snapshot); refreshTodoControls();
    const message = todoPanel?.querySelector<HTMLElement>("[data-todo-status-message]"); if (message) message.textContent = keepDraft ? "入力を残しました。内容を確認して更新してください。" : "最新の内容を取り込みました。";
  };
  const resolveAddConflict = (keepDraft: boolean) => {
    const snapshot = addState.conflict; if (!snapshot) return;
    if (snapshot.version < todoVersion) return;
    const field = todoPanel?.querySelector<HTMLTextAreaElement>("[data-todo-add-text]");
    if (!keepDraft && field && addState.generation === addState.conflictGeneration) { field.value = ""; addState.generation += 1; addState.savedGeneration = addState.generation; }
    addState.baseVersion = snapshot.version; addState.conflict = undefined; addState.conflictGeneration = undefined;
    todoVersion = Math.max(todoVersion, snapshot.version); if (todoPanel) todoPanel.dataset.version = String(todoVersion);
    applyTodoSnapshot(snapshot); const box = todoPanel?.querySelector<HTMLElement>("[data-todo-add-conflict]"); if (box) box.hidden = true;
    const message = todoPanel?.querySelector<HTMLElement>("[data-todo-status-message]"); if (message) message.textContent = keepDraft ? "追加入力を残しました。確認後、追加操作を押してください。" : "共有内容を確認しました。追加操作は再送していません。";
  };
  const bindTodoRow = (row: HTMLElement) => {
    if (boundRows.has(row)) return; boundRows.add(row);
    const text = textField(row); if (text) { stateFor(row); resizeTodoText(text); text.addEventListener("input", () => { const state = stateFor(row); state.textGeneration += 1; resizeTodoText(text); refreshTodoControls(); }); }
    const stateField = statusField(row); if (stateField) { stateFor(row); stateField.addEventListener("change", () => { const state = stateFor(row); state.statusGeneration += 1; refreshTodoControls(); }); }
    row.querySelector<HTMLButtonElement>('[data-todo-op="save"]')?.addEventListener("click", () => { void submitTodo(row, "edit"); });
    row.querySelector<HTMLButtonElement>('[data-todo-op="delete"]')?.addEventListener("click", () => { void submitTodo(row, "delete"); });
    row.querySelector<HTMLButtonElement>('[data-todo-op="use-latest"]')?.addEventListener("click", () => resolveRowConflict(row, false));
    row.querySelector<HTMLButtonElement>('[data-todo-op="keep-draft"]')?.addEventListener("click", () => resolveRowConflict(row, true));
    row.querySelector<HTMLButtonElement>('[data-todo-op="discard-deleted"]')?.addEventListener("click", () => removeTodoRow(row));
    row.querySelector<HTMLButtonElement>('[data-todo-op="readd-deleted"]')?.addEventListener("click", () => {
      const addField = todoPanel?.querySelector<HTMLTextAreaElement>("[data-todo-add-text]"); const source = textField(row); const confirmBox = row.querySelector<HTMLElement>("[data-todo-readd-confirm]");
      if (!addField || !source) return;
      if (addField.value && addField.value !== source.value) { if (confirmBox) confirmBox.hidden = false; return; }
      addField.value = source.value; addState.generation += 1; addField.focus(); removeTodoRow(row);
    });
    row.querySelector<HTMLButtonElement>('[data-todo-op="replace-add-draft"]')?.addEventListener("click", () => { const addField = todoPanel?.querySelector<HTMLTextAreaElement>("[data-todo-add-text]"); const source = textField(row); if (!addField || !source) return; addField.value = source.value; addState.generation += 1; const box = row.querySelector<HTMLElement>("[data-todo-readd-confirm]"); if (box) box.hidden = true; addField.focus(); removeTodoRow(row); });
    row.querySelector<HTMLButtonElement>('[data-todo-op="keep-add-draft"]')?.addEventListener("click", () => { const box = row.querySelector<HTMLElement>("[data-todo-readd-confirm]"); if (box) box.hidden = true; });
  };
  const submitTodo = async (row: HTMLElement | null, operation: "add" | "edit" | "delete") => {
    if (!todoPanel || todoMutationRunning || authenticationEnded || pageLeft || todoUnavailable) return;
    const rowState = row ? stateFor(row) : undefined;
    if (rowState?.conflict || rowState?.deletedDraft || (operation === "add" && addState.conflict)) return;
    const text = row ? textField(row) : null; const state = row ? statusField(row) : null;
    const addText = todoPanel.querySelector<HTMLTextAreaElement>("[data-todo-add-text]");
    const textAtSubmit = text?.value ?? addText?.value ?? ""; const statusAtSubmit = state?.value ?? "not_started";
    const context = { row: row ?? undefined, operation, textGeneration: rowState?.textGeneration ?? 0, statusGeneration: rowState?.statusGeneration ?? 0, addGeneration: addState.generation } as const;
    const textRevision = rowState?.textGeneration ?? addState.generation;
    const versionAtSubmit = todoVersion; const screenGeneration = pageGeneration;
    const changes = operation === "add" ? [{ op: "add", text: textAtSubmit }] : operation === "delete" ? [{ op: "delete", id: row?.dataset.todoId }] : [{ op: "edit", id: row?.dataset.todoId, text: textAtSubmit }, { op: "status", id: row?.dataset.todoId, status: statusAtSubmit }];
    todoMutationRunning = true; refreshTodoControls();
    const isCurrent = () => !pageLeft && !authenticationEnded && !todoUnavailable && screenGeneration === pageGeneration;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/todo`, { method: "PUT", credentials: "same-origin", headers: { Accept: "application/json", "Content-Type": "application/json", "x-csrf-token": todoPanel.dataset.csrf ?? sessionCsrf }, body: JSON.stringify({ expected_version: versionAtSubmit, changes }) });
      if (!isCurrent()) return;
      if (isAuthenticationFailure(response)) return;
      if (response.status === 404) { showSessionUnavailable(); return; }
      const snapshot = await response.json() as TodoSnapshot;
      if (!isCurrent()) return;
      if (response.status === 409) {
        if (snapshot.version >= todoVersion) {
          if (operation === "add" && snapshot.version >= (addState.conflict?.version ?? 0)) { addState.conflict = snapshot; addState.conflictGeneration = textRevision; }
          applyTodoSnapshot(snapshot);
          if (row) showRowConflict(row, snapshot);
        }
        const message = todoPanel.querySelector<HTMLElement>("[data-todo-status-message]"); if (message) message.textContent = "競合しました。入力を保持しています。内容を選択してから再操作してください。";
      } else if (!response.ok) throw new Error("Todo update failed");
      else {
        applyTodoSnapshot(snapshot, context);
        const message = todoPanel.querySelector<HTMLElement>("[data-todo-status-message]");
        if (message) message.textContent = snapshot.audit_warning && snapshot.applied ? "更新は適用済みです。監査記録に警告があります。内容を確認してください。" : "作業一覧を更新しました。";
      }
    } catch {
      if (isCurrent()) { const message = todoPanel.querySelector<HTMLElement>("[data-todo-status-message]"); if (message) message.textContent = "更新結果を確認できませんでした。表示中の入力を保持しています。"; }
    } finally {
      if (screenGeneration === pageGeneration && !pageLeft && !authenticationEnded) { todoMutationRunning = false; refreshTodoControls(); }
    }
  };
  const makeTodoRow = (item: TodoItem) => {
    const row = document.createElement("li"); row.dataset.todoId = item.id; row.dataset.baseText = item.text; row.dataset.baseStatus = item.status; row.dataset.baseVersion = String(todoVersion);
    const textLabel = document.createElement("label"); textLabel.className = "todo-text-label"; const title = document.createElement("span"); title.textContent = "作業項目";
    const text = document.createElement("textarea") as HTMLTextAreaElement; text.dataset.todoText = "true"; text.rows = 2; text.maxLength = 1000; text.setAttribute("aria-label", "作業項目"); text.value = item.text; textLabel.append(title, text);
    const statusLabel = document.createElement("label"); statusLabel.textContent = "状態"; const select = document.createElement("select") as HTMLSelectElement; select.dataset.todoStatus = "true"; select.setAttribute("aria-label", "状態");
    for (const [value, label] of [["not_started", "未着手"], ["in_progress", "進行中"], ["completed", "完了"]]) { const option = document.createElement("option"); option.value = value; option.textContent = label; select.append(option); } select.value = item.status; statusLabel.append(select);
    const controls = document.createElement("div"); controls.className = "todo-controls";
    const actions = document.createElement("div"); actions.className = "todo-actions";
    const button = (op: string, label: string) => { const element = document.createElement("button") as HTMLButtonElement; element.type = "button"; element.dataset.todoOp = op; element.textContent = label; return element; };
    actions.append(button("save", "更新"), button("delete", "削除")); controls.append(statusLabel, actions);
    const conflict = document.createElement("div"); conflict.dataset.todoConflict = "true"; conflict.hidden = true;
    const conflictTitle = document.createElement("p"); conflictTitle.textContent = "最新の共有内容"; const latestText = document.createElement("p"); latestText.dataset.todoLatestText = "true"; const latestStatus = document.createElement("p"); latestStatus.dataset.todoLatestStatus = "true";
    conflict.append(conflictTitle, latestText, latestStatus, button("use-latest", "最新を使う"), button("keep-draft", "入力を残して再編集"));
    const deletedNotice = document.createElement("div"); deletedNotice.dataset.todoDeletedNotice = "true"; deletedNotice.hidden = true;
    const readdConfirm = document.createElement("div"); readdConfirm.dataset.todoReaddConfirm = "true"; readdConfirm.hidden = true;
    const confirmText = document.createElement("p"); confirmText.textContent = "追加欄の入力を置き換えますか？"; readdConfirm.append(confirmText, button("replace-add-draft", "追加欄を置き換える"), button("keep-add-draft", "追加欄を保つ"));
    const deletedActions = document.createElement("div"); deletedActions.dataset.todoDeletedActions = "true"; deletedActions.hidden = true; deletedActions.append(button("discard-deleted", "入力を捨てる"), button("readd-deleted", "新しい項目として編集"));
    row.append(textLabel, controls, conflict, deletedNotice, deletedActions, readdConfirm);
    rowStates.set(row, { baseVersion: todoVersion, baseText: item.text, baseStatus: item.status, textGeneration: 0, savedTextGeneration: 0, statusGeneration: 0, savedStatusGeneration: 0, deletedDraft: false });
    return row;
  };
  if (todoPanel) {
    for (const row of todoRows()) bindTodoRow(row);
    const addField = todoPanel.querySelector<HTMLTextAreaElement>("[data-todo-add-text]"); if (addField) { resizeTodoText(addField); addField.addEventListener("input", () => { addState.generation += 1; resizeTodoText(addField); refreshTodoControls(); }); }
    todoPanel.querySelector<HTMLButtonElement>('[data-todo-op="add"]')?.addEventListener("click", () => { void submitTodo(null, "add"); });
    todoPanel.querySelector<HTMLButtonElement>('[data-todo-op="use-latest-add"]')?.addEventListener("click", () => resolveAddConflict(false));
    todoPanel.querySelector<HTMLButtonElement>('[data-todo-op="keep-draft-add"]')?.addEventListener("click", () => resolveAddConflict(true));
  }
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
    todoPanel?.querySelectorAll<HTMLButtonElement>("button[data-todo-op]").forEach((button) => { button.disabled = true; });
    todoPanel?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("textarea,select").forEach((field) => { field.disabled = true; });
    todoFetchGeneration += 1;
    todoRefreshPending = false;
    todoRefreshRunning = false;
    todoFetchController?.abort();
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
    refreshTodoControls();
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
  const addCell = (row: HTMLTableRowElement, value: unknown) => {
    const cell = row.insertCell();
    cell.textContent = String(value ?? "—");
    return cell;
  };
  const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  const appendSessionEditorCell = (row: HTMLTableRowElement, session: { session_id: string; working_directory?: string; purpose?: string; external_url?: string | null; external_title?: string | null; version?: number }, stopped: boolean) => {
    const cell = row.insertCell();
    if (stopped || !Number.isSafeInteger(session.version)) { cell.textContent = "—"; return cell; }
    const sessionKey = escapeHtml(session.session_id);
    cell.innerHTML = `<details><summary>編集</summary><form class="session-editor" data-session-edit="${sessionKey}" data-version="${session.version}"><input type="hidden" name="csrf" value="${escapeHtml(sessionCsrf)}"><label>作業ディレクトリ <input name="workingDirectory" required maxlength="4096" value="${escapeHtml(session.working_directory)}"></label><label>用途 <input name="purpose" required maxlength="200" value="${escapeHtml(session.purpose)}"></label><label>URL <input name="externalUrl" type="url" maxlength="2048" value="${escapeHtml(session.external_url)}"></label><label>題名 <input name="externalTitle" maxlength="200" value="${escapeHtml(session.external_title)}"></label><button type="submit">保存</button><output aria-live="polite"></output><div data-session-conflict hidden><p data-session-conflict-summary></p><button type="button" data-session-conflict-action="keep-draft">自分の入力で再編集</button><button type="button" data-session-conflict-action="use-latest">最新値を取り込む</button></div></form><small>変更は保存後に開始するプロセスから適用されます。</small></details>`;
    const form = cell.querySelector<HTMLFormElement>("form[data-session-edit]");
    if (form) initializeSessionEditor(form);
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
        if (result.response.status === 409) { if (await resync()) refreshTodo(); return; }
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
      refreshTodo();
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
  async function resync(): Promise<boolean> {
    if (!readsAllowed()) return false;
    const screenGeneration = pageGeneration;
    updateLogState("resync-required");
    const params = new URLSearchParams({ limit: String(pageLimit) });
    try {
      const result = await fetchPage(params);
      if (!readsAllowed() || screenGeneration !== pageGeneration) return false;
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
      return true;
    } catch {
      if (authenticationEnded) return false;
      updateLogState("pending");
      void refreshState();
      return false;
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
      const sessions = state.sessions?.map((incoming) => {
        const previous = latestSessionStateById.get(incoming.session_id);
        const savedVersion = latestSavedVersionBySession.get(incoming.session_id) ?? 0;
        const knownVersion = Math.max(savedVersion, previous?.version ?? 0);
        if (Number.isSafeInteger(incoming.version) && incoming.version! < knownVersion) return previous;
        latestSessionStateById.set(incoming.session_id, incoming);
        return incoming;
      }).filter((session): session is SessionState => session !== undefined);
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
        const freshSessions = sessions ?? state.sessions;
        const visibleSessions = root.dataset.filter === "active" ? freshSessions.filter((session) => session.active) : freshSessions;
        const savedOpenByKey = new Map<string, boolean>();
        let focusedTimeKey: string | undefined;
        const editorCells = new Map<string, HTMLTableCellElement>();
        let focusedEditor: HTMLElement | undefined;
        let focusedEditorId: string | undefined;
        const activeElement = document.activeElement as HTMLElement | null;
        for (const form of sessionRows.querySelectorAll<HTMLFormElement>("form[data-session-edit]")) {
          const sessionKey = form.dataset.sessionEdit;
          const incoming = sessionKey ? freshSessions.find((session) => session.session_id === sessionKey) : undefined;
          const externalUrlInput = form.elements.namedItem("externalUrl") as HTMLInputElement | null;
          const externalTitleInput = form.elements.namedItem("externalTitle") as HTMLInputElement | null;
          if (incoming && externalUrlInput && externalUrlInput.value === (form.dataset.initialExternalUrl ?? "")) { externalUrlInput.value = incoming.external_url ?? ""; form.dataset.initialExternalUrl = externalUrlInput.value; }
          if (incoming && externalTitleInput && externalTitleInput.value === (form.dataset.initialExternalTitle ?? "")) { externalTitleInput.value = incoming.external_title ?? ""; form.dataset.initialExternalTitle = externalTitleInput.value; }
          const editorCell = form.closest("td") as HTMLTableCellElement | null;
          if (sessionKey && editorCell) {
            editorCells.set(sessionKey, editorCell);
            if (activeElement && editorCell.contains(activeElement)) { focusedEditor = activeElement; focusedEditorId = sessionKey; }
          }
        }
        for (const details of sessionRows.querySelectorAll<HTMLDetailsElement>("details[data-session-time]")) {
          const key = JSON.stringify([details.dataset.sessionId ?? "", details.dataset.sessionTime ?? ""]);
          savedOpenByKey.set(key, details.open);
          const summary = details.querySelector("summary");
          if (summary && activeElement === summary) focusedTimeKey = key;
        }
        const restoredSummaries = new Map<string, HTMLElement>();
        const restoredEditorIds = new Set<string>();
        sessionRows.replaceChildren();
        if (!visibleSessions.length) {
          const row = sessionRows.insertRow(); const cell = row.insertCell(); cell.colSpan = 9;
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
          const stateCell = addCell(row, session.active ? "有効" : session.state === "closed" ? "終了" : "履歴");
          stateCell.dataset.sessionState = "true";
          const purposeCell = addCell(row, session.purpose ?? "—"); purposeCell.dataset.sessionPurpose = "true";
          addCell(row, session.session_id);
          const directoryCell = addCell(row, session.working_directory ?? "—"); directoryCell.dataset.sessionDirectory = "true";
          const externalLinkCell = addCell(row, "—"); externalLinkCell.className = "session-external-link-cell"; externalLinkCell.dataset.sessionExternalLink = "true"; renderExternalLink(externalLinkCell, session);
          if (session.active && !state.stopped) {
            const existingEditor = editorCells.get(session.session_id);
            if (existingEditor) { row.append(existingEditor); restoredEditorIds.add(session.session_id); }
            else appendSessionEditorCell(row, session, state.stopped);
          } else addCell(row, "—");
        }
        if (focusedSessionId) {
          const restoredRow = [...sessionRows.querySelectorAll<HTMLTableRowElement>("tr[data-session-id]")].find((row) => row.dataset.sessionId === focusedSessionId);
          if (!selection || selection.isCollapsed) restoredRow?.querySelector("a")?.focus();
        }
        if (focusedTimeKey) restoredSummaries.get(focusedTimeKey)?.focus({ preventScroll: true });
        else if (focusedEditor && focusedEditorId && restoredEditorIds.has(focusedEditorId)) focusedEditor.focus({ preventScroll: true });
        if (!focusedTimeKey && !(focusedEditor && focusedEditorId && restoredEditorIds.has(focusedEditorId)) && focusedSessionId && (!selection || selection.isCollapsed)) {
          const restoredRow = [...sessionRows.querySelectorAll<HTMLTableRowElement>("tr[data-session-id]")].find((row) => row.dataset.sessionId === focusedSessionId);
          restoredRow?.querySelector("a")?.focus({ preventScroll: true });
        }
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
    source.addEventListener("session-link-updated", () => { if (generation === currentGeneration && autoEnabled()) void refreshState(); });
    source.addEventListener("resync-required", () => { if (generation !== currentGeneration) return; source.close(); connectionState = "disconnected"; setStatus(); if (listPage) { resyncPending = true; autoPending = true; if (autoEnabled()) scheduleAutomatic(); else updateLogState("resync-required"); } else void resync(); });
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
    todoFetchGeneration += 1;
    todoRefreshPending = false;
    todoRefreshRunning = false;
    todoFetchController?.abort();
    todoMutationRunning = false;
    refreshTodoControls();
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
    todoMutationRunning = false;
    refreshTodoControls();
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
