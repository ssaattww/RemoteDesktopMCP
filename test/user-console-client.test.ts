import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { chronologicalPage, mergeBoundedItems, slideLogWindow, userConsoleClientScript, type ConsoleLogItem } from "../src/user-console-client.js";

const item = (id: string): ConsoleLogItem => ({ id, cursor: "cursor-" + id, event: { id } });

test("client paging helpers preserve cursor order, deduplicate, and cap retained events", () => {
  assert.deepEqual(chronologicalPage([item("3"), item("2"), item("1")]).map((entry) => entry.id), ["1", "2", "3"]);
  assert.deepEqual(mergeBoundedItems([item("1"), item("2")], [item("2"), item("3")], 2).map((entry) => entry.id), ["2", "3"]);
  const older = slideLogWindow(Array.from({ length: 4 }, (_, index) => item(String(index))), [item("-2"), item("-1")], "older", 4);
  assert.deepEqual(older.items.map((entry) => entry.id), ["-2", "-1", "0", "1"]);
  assert.equal(older.droppedNewer, true);
  const newer = slideLogWindow(older.items, [item("2"), item("3")], "newer", 4);
  assert.deepEqual(newer.items.map((entry) => entry.id), ["0", "1", "2", "3"]);
});

class FakeElement {
  dataset: Record<string, string> = {};
  hidden = false;
  disabled = false;
  open = false;
  textContent = "";
  className = "";
  tagName: string;
  href = "";
  colSpan = 1;
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  listeners = new Map<string, (event?: unknown) => void>();
  queries = new Map<string, FakeElement>();
  closestNodes = new Map<string, FakeElement>();
  rect = { top: 0, bottom: 100, left: 0, right: 100 };
  classList = { toggle: (name: string, force?: boolean) => Boolean(name && force !== false) };
  constructor(tagName = "div") { this.tagName = tagName.toLowerCase(); }
  checked = false;
  addEventListener(name: string, listener: (event?: unknown) => void) { this.listeners.set(name, listener); }
  click(name = "click") { this.listeners.get(name)?.({ target: this }); }
  replaceChildren(...children: FakeElement[]) { this.children = children; for (const child of children) child.parentElement = this; }
  append(child: FakeElement) { this.children.push(child); child.parentElement = this; }
  insertRow() { const row = new FakeElement("tr"); this.append(row); return row; }
  insertCell() { const cell = new FakeElement("td"); this.append(cell); return cell; }
  querySelectorAll<T extends FakeElement>(selector: string) {
    const override = this.queries.get(selector);
    if (override) return [override] as T[];
    if (selector.startsWith(".process-block")) return this.children.filter((child) => child.className === "process-block" && (!selector.includes("data-events-json") || child.dataset.eventsJson !== undefined)) as T[];
    if (selector.startsWith("tr[data-event-json]")) return this.children.filter((child) => child.tagName === "tr" && child.dataset.eventJson !== undefined) as T[];
    if (selector === "tr[data-session-id]") return this.children.filter((child) => child.tagName === "tr" && child.dataset.sessionId !== undefined) as T[];
    return [] as T[];
  }
  querySelector<T extends FakeElement>(selector: string) {
    const override = this.queries.get(selector);
    if (override) return override as T;
    if (selector === "h2") return (this.children.find((child) => child.tagName === "h2") ?? null) as T | null;
    if (selector === ".process-block") return (this.children.find((child) => child.className === "process-block") ?? null) as T | null;
    if (selector === "details") return (this.children.find((child) => child.tagName === "details") ?? this.children.map((child) => child.querySelector<FakeElement>(selector)).find(Boolean) ?? null) as T | null;
    return null;
  }
  closest<T extends FakeElement>(selector: string) { let current: FakeElement | null = this; while (current) { if (selector === "tr[data-session-id]" && current.tagName === "tr" && current.dataset.sessionId !== undefined) return current as T; if (selector === "td" && current.tagName === "td") return current as T; if (current.closestNodes.has(selector)) return current.closestNodes.get(selector) as T; current = current.parentElement; } return null; }
  contains(node: FakeElement | null) { let current = node; while (current) { if (current === this) return true; current = current.parentElement; } return false; }
  getBoundingClientRect() { return this.rect; }
  get cells() { return this.children.filter((child) => child.tagName === "td"); }
}

class FakeEventSource {
  static OPEN = 1;
  static instances: FakeEventSource[] = [];
  readyState = 1;
  closed = false;
  listeners = new Map<string, (event: { data: string }) => void>();
  onopen?: () => void;
  onerror?: () => void;
  constructor(readonly url: string) { FakeEventSource.instances.push(this); }
  addEventListener(name: string, listener: (event: { data: string }) => void) { this.listeners.set(name, listener); }
  dispatch(name: string, data = "") { this.listeners.get(name)?.({ data }); }
  open() { this.onopen?.(); }
  error() { this.onerror?.(); }
  close() { this.closed = true; this.readyState = 2; }
}

class FakeClock {
  now = 10_000;
  nextId = 0;
  timers = new Map<number, { due: number; callback: () => void }>();
  setTimeout = (callback: () => void, delay = 0) => {
    const id = ++this.nextId;
    this.timers.set(id, { due: this.now + Math.max(0, delay), callback });
    return id;
  };
  clearTimeout = (id: number | undefined) => { if (id !== undefined) this.timers.delete(id); };
  async advance(milliseconds: number) {
    const target = this.now + milliseconds;
    while (true) {
      const next = [...this.timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
      if (!next || next[1].due > target) break;
      this.now = next[1].due;
      this.timers.delete(next[0]);
      next[1].callback();
      await settle();
    }
    this.now = target;
  }
}

function response(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

async function settle() { await new Promise((resolve) => setTimeout(resolve, 0)); }

function boot(fetchImpl: (url: string, init?: RequestInit) => Promise<ReturnType<typeof response>>, initialItems: ConsoleLogItem[] = [], extras: Record<string, FakeElement> = {}, sessionId = "", options: { clock?: FakeClock; hidden?: boolean; selection?: { anchorNode: FakeElement; focusNode: FakeElement; anchorOffset: number; focusOffset: number; isCollapsed: boolean; toString: () => string; setBaseAndExtent?: (...args: unknown[]) => void; collapse?: (node: FakeElement, offset: number) => void; extend?: (node: FakeElement, offset: number) => void; removeAllRanges: () => void; addRange: (...args: unknown[]) => void } } = {}) {
  FakeEventSource.instances = [];
  const root = new FakeElement(); root.dataset = { sessionId, newestCursor: initialItems[0]?.cursor ?? "c0", oldestCursor: initialItems.at(-1)?.cursor ?? "c-older", hasMoreOlder: String(initialItems.length > 0), initialItems: JSON.stringify(initialItems) };
  const status = new FakeElement();
  const newest = new FakeElement(); newest.hidden = true;
  const older = new FakeElement(); older.hidden = true;
  const elements = new Map<string, FakeElement>([["log-console", root], ["log-status", status], ["log-new-button", newest], ["log-older-button", older], ...Object.entries(extras)]);
  const scrollY = 0; let scrollCalls = 0;
  const windowListeners = new Map<string, (event?: unknown) => void>();
  const windowStub = { scrollY, scrollX: 0, innerHeight: 600, addEventListener: (name: string, listener: (event?: unknown) => void) => windowListeners.set(name, listener), scrollTo: () => { scrollCalls += 1; }, scrollBy: () => { scrollCalls += 1; }, getSelection: () => options.selection ?? ({ toString: () => "", isCollapsed: true }) };
  const documentListeners = new Map<string, (event?: unknown) => void>();
  const createTreeWalker = (rootNode: FakeElement) => { const nodes: FakeElement[] = []; const visit = (element: FakeElement) => { if (element.textContent && element.children.length === 0) { const textNode = new FakeElement("#text"); textNode.textContent = element.textContent; textNode.parentElement = element; nodes.push(textNode); } for (const child of element.children) visit(child); }; visit(rootNode); let index = 0; return { nextNode: () => nodes[index++] ?? null }; };
  const createRange = () => { let startNode: FakeElement | null = null; let startOffset = 0; let endNode: FakeElement | null = null; let endOffset = 0; const compare = (left: FakeElement | null, leftOffset: number, right: FakeElement | null, rightOffset: number) => { if (!left || !right) return 0; const leftRow = left.closest<FakeElement>("tr[data-session-id]"); const rightRow = right.closest<FakeElement>("tr[data-session-id]"); const rowOrder = (leftRow?.dataset.sessionId ?? "").localeCompare(rightRow?.dataset.sessionId ?? ""); if (rowOrder) return rowOrder; const leftCell = left.closest<FakeElement>("td"); const rightCell = right.closest<FakeElement>("td"); const cellOrder = (leftRow?.cells.indexOf(leftCell!) ?? 0) - (rightRow?.cells.indexOf(rightCell!) ?? 0); return cellOrder || leftOffset - rightOffset; }; const range = { selectNodeContents: () => undefined, setEnd: (node: FakeElement, at: number) => { endNode = node; endOffset = at; }, setStart: (node: FakeElement, at: number) => { startNode = node; startOffset = at; }, collapse: () => { endNode = startNode; endOffset = startOffset; }, compareBoundaryPoints: (_how: number, other: typeof range) => compare(startNode, startOffset, other.startContainer, other.startOffset), get startContainer() { return startNode; }, get startOffset() { return startOffset; }, get endContainer() { return endNode; }, get endOffset() { return endOffset; }, toString: () => "x".repeat(endOffset) }; return range as unknown as Range; };
  const documentStub = { hidden: options.hidden ?? false, getElementById: (id: string) => elements.get(id) ?? null, createElement: (tagName: string) => new FakeElement(tagName), createRange, createTreeWalker, addEventListener: (name: string, listener: (event?: unknown) => void) => documentListeners.set(name, listener), documentElement: { scrollHeight: 1200 } };
  const clock = options.clock;
  const ClockDate = clock ? class extends Date { constructor(value?: string | number) { super(value ?? clock.now); } static now() { return clock.now; } } : Date;
  runInNewContext(userConsoleClientScript, { document: documentStub, window: windowStub, fetch: fetchImpl, EventSource: FakeEventSource, URLSearchParams, encodeURIComponent, Element: FakeElement, Date: ClockDate, AbortController, setTimeout: clock ? clock.setTimeout : setTimeout, clearTimeout: clock ? clock.clearTimeout : clearTimeout });
  return { root, status, newest, older, windowStub, documentStub, documentListeners, windowListeners, get scrollCalls() { return scrollCalls; }, sources: FakeEventSource.instances };
}

test("browser bootstrap treats SSE as a notice, pages logs, and restarts from the applied cursor", async () => {
  const calls: URL[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(new URL(url, "http://local.test"));
    const request = calls.at(-1)!;
    if (request.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-09-28T00:00:00Z" });
    if (request.searchParams.get("after") === "c0") return response(200, { items: [item("2"), item("1")], newestCursor: "c2", oldestCursor: "c1", hasMoreOlder: false, hasMoreNewer: true });
    if (request.searchParams.get("after") === "c2") return response(200, { items: [item("3")], newestCursor: "c3", oldestCursor: "c3", hasMoreOlder: false, hasMoreNewer: false });
    throw new Error("unexpected request " + request.href);
  };
  const ui = boot(fetchImpl);
  await settle();
  const initialSource = ui.sources[0]!;
  initialSource.dispatch("logs-available", JSON.stringify({ addedCount: 3, latestCursor: "c3", overflow: false }));
  assert.equal(ui.newest.hidden, false);
  assert.equal(ui.newest.textContent, "↻ 更新（新着 3件）");
  assert.equal(calls.filter((url) => url.pathname === "/api/logs").length, 0, "SSE notification does not fetch log bodies");
  assert.equal(ui.scrollCalls, 0, "SSE notification does not move the page");

  ui.newest.click();
  await settle();
  await settle();
  assert.equal(ui.root.dataset.newestCursor, "c3");
  assert.equal(initialSource.closed, true, "the old stream closes after applying logs");
  assert.match(ui.sources[1]!.url, /after=c3/);
  assert.deepEqual(calls.filter((url) => url.pathname === "/api/logs").map((url) => url.searchParams.get("after")), ["c0", "c2"]);
  assert.equal(ui.newest.hidden, false);
  assert.equal(ui.newest.textContent, "↻ 更新（新着 0件）");

  const restartedSource = ui.sources[1]!;
  restartedSource.open();
  restartedSource.dispatch("logs-available", JSON.stringify({ addedCount: 1, latestCursor: "c4", overflow: false }));
  assert.equal(ui.newest.textContent, "↻ 更新（新着 1件）");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    restartedSource.error();
    restartedSource.open();
    restartedSource.dispatch("logs-available", JSON.stringify({ addedCount: 1, latestCursor: "c4", overflow: false }));
  }
  assert.equal(ui.newest.textContent, "↻ 更新（新着 1件）", "each reconnect's first count replaces the previous connection's count");
});

test("operation detail keeps its open state when unrelated new logs redraw the table", async () => {
  const sessionId = "session-operation-detail";
  const at = "2026-10-01T00:00:00.000Z";
  const detailEvent: ConsoleLogItem = {
    id: "detail-terminal",
    cursor: "c1",
    event: { event: "operation.succeeded", at, receivedAt: at, sessionId, connectionId: sessionId, operationId: "operation-detail", tool: "file_read", target: "detail.txt", status: "succeeded", detail: { version: 1, summary: "ファイル読取", entries: [{ label: "本文", value: "visible detail", format: "text" }] } },
  };
  const operationRows = new FakeElement("tbody");
  const seedRow = new FakeElement("tr");
  seedRow.dataset.operationId = "operation-detail";
  seedRow.dataset.eventJson = JSON.stringify(detailEvent.event);
  const seedCell = new FakeElement("td");
  const seedDetails = new FakeElement("details"); seedDetails.open = true;
  seedCell.append(seedDetails); seedRow.append(seedCell); operationRows.append(seedRow);
  const unrelated: ConsoleLogItem = {
    id: "other-terminal",
    cursor: "c2",
    event: { event: "operation.succeeded", at: "2026-10-01T00:00:01.000Z", receivedAt: "2026-10-01T00:00:01.000Z", sessionId, connectionId: sessionId, operationId: "operation-other", tool: "session_list", status: "succeeded" },
  };
  const ui = boot(async (url) => {
    const request = new URL(url, "http://local.test");
    if (request.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: at });
    if (request.searchParams.get("after") === "c1") return response(200, { items: [unrelated], newestCursor: "c2", oldestCursor: "c2", hasMoreOlder: false, hasMoreNewer: false });
    throw new Error("unexpected request " + request.href);
  }, [detailEvent], { "operation-rows": operationRows }, sessionId);
  await settle();
  ui.sources[0]!.dispatch("logs-available", JSON.stringify({ addedCount: 1, latestCursor: "c2", overflow: false }));
  ui.newest.click();
  await settle();
  await settle();
  const detailRow = operationRows.children.find((row) => row.dataset.operationId === "operation-detail");
  assert.ok(detailRow);
  const details = detailRow.querySelector<FakeElement>("details");
  assert.ok(details, "structured operation detail remains rendered after redraw");
  assert.equal(details.open, true, "the user's expanded state survives differential redraw");
});

test("failed log fetch retains the cursor and pending button for retry", async () => {
  const calls: URL[] = [];
  const ui = boot(async (url) => {
    calls.push(new URL(url, "http://local.test"));
    return calls.at(-1)!.pathname === "/api/console-state"
      ? response(200, { stopped: true, activeSessions: 0, runningProcesses: 0, updatedAt: "2026-09-28T00:00:00Z" })
      : response(503, { error: "unavailable" });
  });
  await settle();
  const source = ui.sources[0]!;
  source.dispatch("logs-available", JSON.stringify({ addedCount: 1, latestCursor: "c1", overflow: false }));
  ui.newest.click();
  await settle();
  assert.equal(ui.root.dataset.newestCursor, "c0");
  assert.equal(ui.sources.length, 1);
  assert.equal(ui.newest.hidden, false);
  assert.match(ui.status.textContent, /新着あり/);
});

test("expired cursor resynchronizes the latest page without reloading the document", async () => {
  const calls: URL[] = [];
  const ui = boot(async (url) => {
    const request = new URL(url, "http://local.test"); calls.push(request);
    if (request.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 0, runningProcesses: 0, updatedAt: "2026-09-28T00:00:00Z" });
    if (request.searchParams.has("after")) return response(409, { error: "cursor_expired" });
    return response(200, { items: [item("newest")], newestCursor: "latest", oldestCursor: "latest", hasMoreOlder: false, hasMoreNewer: false });
  });
  await settle();
  ui.sources[0]!.dispatch("logs-available", JSON.stringify({ addedCount: 1, latestCursor: "expired", overflow: false }));
  ui.newest.click();
  await settle();
  await settle();
  assert.equal(ui.root.dataset.newestCursor, "latest");
  assert.equal(calls.some((url) => url.pathname === "/api/logs" && !url.searchParams.has("after")), true);
  assert.match(ui.sources[1]!.url, /after=latest/);
});

test("older paging slides a full window toward history and refresh re-fetches the pruned newer range", async () => {
  const sessionId = "session-window";
  const makeItem = (sequence: number): ConsoleLogItem => {
    const at = new Date(sequence * 1000).toISOString();
    const event = sequence % 2 === 0
      ? { event: "process.output", at, sessionId, processId: "process-window", output: "out-" + sequence }
      : { event: "operation.received", at, receivedAt: at, sessionId, connectionId: sessionId, operationId: "op-" + sequence, tool: "file_read", status: "running" };
    return { id: "event-" + sequence, cursor: "c" + sequence, event };
  };
  const initial = Array.from({ length: 1000 }, (_, index) => {
    const sequence = 999 - index;
    return makeItem(sequence);
  });
  const processDetails = new FakeElement("section");
  const heading = new FakeElement("h2"); heading.textContent = "コマンドと出力の詳細"; processDetails.append(heading);
  const processStart = { event: "process.start", at: "1970-01-01T00:00:00.000Z", sessionId, processId: "process-window", command: "echo window", comment: "window test" };
  const seedBlock = new FakeElement("article"); seedBlock.className = "process-block"; seedBlock.dataset.sessionId = sessionId; seedBlock.dataset.processId = "process-window"; seedBlock.dataset.eventsJson = JSON.stringify([processStart]);
  processDetails.append(seedBlock);
  const operationRows = new FakeElement("tbody");
  const calls: URL[] = [];
  const fetchImpl = async (url: string) => {
    const request = new URL(url, "http://local.test"); calls.push(request);
    if (request.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 0, runningProcesses: 0, updatedAt: "2026-09-28T00:00:00Z", sessions: [], running: [] });
    if (request.searchParams.get("before") === "c0") {
      const older = Array.from({ length: 200 }, (_, index) => makeItem(-1 - index));
      return response(200, { items: older, newestCursor: "c-1", oldestCursor: "c-200", hasMoreOlder: true, hasMoreNewer: false });
    }
    if (request.searchParams.get("after") === "c799") {
      const newer = Array.from({ length: 200 }, (_, index) => makeItem(999 - index));
      return response(200, { items: newer, newestCursor: "c999", oldestCursor: "c800", hasMoreOlder: true, hasMoreNewer: false });
    }
    throw new Error("unexpected request " + request.href);
  };
  const ui = boot(fetchImpl, initial, { "process-details": processDetails, "operation-rows": operationRows }, sessionId);
  await settle();
  ui.older.click();
  await settle();
  assert.equal(ui.root.dataset.oldestCursor, "c-200");
  assert.equal(ui.root.dataset.windowNewestCursor, "c799");
  assert.equal(ui.newest.textContent, "↻ 更新（新着 200件）");
  let processBlock = processDetails.children.find((child) => child.className === "process-block");
  assert.ok(processBlock);
  let processWindow = JSON.parse(processBlock.dataset.eventsJson ?? "[]") as Array<Record<string, unknown>>;
  assert.equal(processWindow.some((event) => event.output === "out-998"), false, "the pruned newest process output is not retained as SSR baseline");
  assert.equal(processWindow.some((event) => event.output === "out-798"), true);
  let renderedOperationIds = operationRows.children.map((row) => row.dataset.operationId);
  assert.equal(renderedOperationIds.includes("op-999"), false, "pruned operation summaries do not leak from SSR rows");

  ui.newest.click();
  await settle();
  await settle();
  assert.equal(calls.some((url) => url.pathname === "/api/logs" && url.searchParams.get("after") === "c799"), true);
  assert.equal(ui.root.dataset.oldestCursor, "c0");
  assert.equal(ui.root.dataset.windowNewestCursor, "c999");
  assert.equal(ui.newest.textContent, "↻ 更新（新着 0件）");
  processBlock = processDetails.children.find((child) => child.className === "process-block");
  assert.ok(processBlock);
  processWindow = JSON.parse(processBlock.dataset.eventsJson ?? "[]") as Array<Record<string, unknown>>;
  assert.equal(processWindow.some((event) => event.output === "out-998"), true, "the newer page restores pruned process history");
  renderedOperationIds = operationRows.children.map((row) => row.dataset.operationId);
  assert.equal(renderedOperationIds.includes("op-999"), true, "the newer page restores pruned operation history");
});

test("state refresh updates only session and running rows with the selected filter", async () => {
  const sessionRows = new FakeElement();
  const runningRows = new FakeElement();
  const runningTable = new FakeElement();
  const runningEmpty = new FakeElement();
  const executionState = new FakeElement();
  const activeCount = new FakeElement();
  const runningCount = new FakeElement();
  const updatedAt = new FakeElement();
  const ui = boot(async () => response(200, {
    stopped: true,
    activeSessions: 1,
    runningProcesses: 1,
    updatedAt: "2026-09-28T00:00:00Z",
    sessions: [
      { session_id: "active/one", working_directory: "C:/work", purpose: "Build", created_at: "2026-09-27T00:00:00Z", last_used_at: "2026-09-28T00:00:00Z", state: "active", active: true },
      { session_id: "closed-two", working_directory: "C:/old", purpose: "Archive", created_at: "2026-09-20T00:00:00Z", state: "closed", active: false },
    ],
    running: [{ operation_id: "proc-1", connection_id: "active/one", label: "process", status: "running" }],
  }), [], { "session-rows": sessionRows, "running-rows": runningRows, "running-table": runningTable, "running-empty": runningEmpty, "execution-state": executionState, "active-session-count": activeCount, "running-count": runningCount, "state-updated-at": updatedAt });
  ui.root.dataset.filter = "active";
  await settle();
  assert.equal(activeCount.textContent, "1");
  assert.equal(runningCount.textContent, "1");
  assert.equal(executionState.textContent, "STOPPED");
  assert.equal(sessionRows.children.length, 1);
  assert.equal(sessionRows.children[0]?.children[0]?.children[0]?.href, "/user/sessions/active%2Fone");
  assert.equal(sessionRows.children[0]?.children[4]?.textContent, "Build");
  assert.equal(runningRows.children.length, 1);
  assert.equal(runningRows.children[0]?.children[2]?.textContent, "process · running");
  assert.equal(runningTable.hidden, false);
  assert.equal(runningEmpty.hidden, true);
  assert.notEqual(updatedAt.textContent, "");
});

test("pull-down refresh only starts on the visible newest log block and ignores horizontal or canceled gestures", async () => {
  const processDetails = new FakeElement();
  const newestBlock = new FakeElement(); newestBlock.rect = { top: 10, bottom: 150, left: 0, right: 100 };
  const target = new FakeElement(); target.closestNodes.set(".process-block", newestBlock);
  processDetails.queries.set(".process-block", newestBlock);
  const calls: URL[] = [];
  const ui = boot(async (url) => {
    const request = new URL(url, "http://local.test"); calls.push(request);
    if (request.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 0, runningProcesses: 0, updatedAt: "2026-09-28T00:00:00Z" });
    return response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false });
  }, [], { "process-details": processDetails });
  await settle();
  const dispatch = (name: string, event?: unknown) => (processDetails.listeners.get(name) as unknown as ((value?: unknown) => void) | undefined)?.(event);
  dispatch("touchstart", { target, touches: [{ clientX: 5, clientY: 20 }] });
  dispatch("touchmove", { touches: [{ clientX: 90, clientY: 25 }], preventDefault: () => undefined });
  dispatch("touchend");
  await settle();
  assert.equal(calls.filter((url) => url.pathname === "/api/logs").length, 0, "horizontal movement stays ordinary content interaction");

  dispatch("touchstart", { target, touches: [{ clientX: 5, clientY: 20 }] });
  let prevented = false;
  dispatch("touchmove", { touches: [{ clientX: 5, clientY: 100 }], preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  dispatch("touchcancel");
  dispatch("touchend");
  await settle();
  assert.equal(calls.filter((url) => url.pathname === "/api/logs").length, 0, "canceled pull does not refresh");

  dispatch("touchstart", { target, touches: [{ clientX: 5, clientY: 20 }] });
  dispatch("touchmove", { touches: [{ clientX: 5, clientY: 100 }], preventDefault: () => undefined });
  dispatch("touchend");
  await settle();
  assert.equal(calls.filter((url) => url.pathname === "/api/logs").length, 1, "pulling and releasing the newest visible log uses the update path");
  assert.equal(calls.filter((url) => url.pathname === "/api/console-state").length, 2, "the update path refreshes state even when there are no new logs");
  newestBlock.rect = { top: -10, bottom: 100, left: 0, right: 100 };
  dispatch("touchstart", { target, touches: [{ clientX: 5, clientY: 20 }] });
  dispatch("touchmove", { touches: [{ clientX: 5, clientY: 100 }], preventDefault: () => undefined });
  dispatch("touchend");
  await settle();
  assert.equal(calls.filter((url) => url.pathname === "/api/logs").length, 1, "a newest block whose beginning is above the viewport does not pull-refresh");
});

test("process grouping preserves distinct same-time output IDs and cursor resync clears old groups", async () => {
  const sessionId = "session-a";
  const processId = "process-a";
  const at = "2026-09-28T00:00:00.000Z";
  const start = { id: "start", cursor: "c0", event: { event: "process.start", at, sessionId, processId, comment: "purpose", command: "echo safe" } };
  const output1 = { id: "output-one", cursor: "c1", event: { event: "process.output", at, sessionId, processId, output: "same output" } };
  const output2 = { id: "output-two", cursor: "c2", event: { event: "process.output", at, sessionId, processId, output: "same output" } };
  const processDetails = new FakeElement("section");
  const heading = new FakeElement("h2"); heading.textContent = "コマンドと出力の詳細"; processDetails.append(heading);
  const initialArticle = new FakeElement("article"); initialArticle.className = "process-block";
  initialArticle.dataset.sessionId = sessionId; initialArticle.dataset.processId = processId;
  initialArticle.dataset.eventsJson = JSON.stringify([start.event, output1.event, output2.event]); processDetails.append(initialArticle);
  const calls: URL[] = [];
  const ui = boot(async (url) => {
    const request = new URL(url, "http://local.test"); calls.push(request);
    if (request.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 0, runningProcesses: 0, updatedAt: at });
    if (request.searchParams.get("after") === "c2") return response(200, { items: [{ id: "output-three", cursor: "c3", event: { event: "process.output", at, sessionId, processId, output: "tail" } }], newestCursor: "c3", oldestCursor: "c3", hasMoreOlder: false, hasMoreNewer: false });
    return response(200, { items: [{ id: "resynced", cursor: "c4", event: { event: "process.output", at, sessionId, processId, output: "resynced only" } }], newestCursor: "c4", oldestCursor: "c4", hasMoreOlder: false, hasMoreNewer: false });
  }, [output2, output1, start], { "process-details": processDetails });
  ui.root.dataset.sessionId = sessionId;
  await settle();
  ui.newest.click();
  await settle();
  await settle();
  const blockAfterAppend = processDetails.children.find((child) => child.className === "process-block");
  assert.ok(blockAfterAppend);
  const afterAppend = JSON.parse(blockAfterAppend.dataset.eventsJson ?? "[]") as Array<Record<string, unknown>>;
  assert.equal(afterAppend.filter((event) => event.event === "process.output" && event.output === "same output").length, 2, "equal timestamp and body still retain distinct API ids");
  assert.match(blockAfterAppend.children.map((child) => child.textContent).join(" "), /purpose.*echo safe/);

  ui.sources.at(-1)!.dispatch("resync-required");
  await settle();
  await settle();
  const blockAfterResync = processDetails.children.find((child) => child.className === "process-block");
  assert.ok(blockAfterResync);
  const afterResync = JSON.parse(blockAfterResync.dataset.eventsJson ?? "[]") as Array<Record<string, unknown>>;
  assert.equal(afterResync.length, 1);
  assert.equal(afterResync[0]?.output, "resynced only");
  assert.equal(blockAfterResync.children.some((child) => child.textContent === "purpose"), false, "a resync does not reuse stale SSR command metadata");
  assert.ok(calls.some((url) => url.pathname === "/api/logs" && !url.searchParams.has("after")));
});

test("the 1000-event older window retains every API process event and keeps start metadata separate", async () => {
  const sessionId = "session-output-window";
  const processId = "long-process";
  const makeOutput = (sequence: number): ConsoleLogItem => {
    const at = new Date(sequence * 1000).toISOString();
    return { id: "output-" + sequence, cursor: "c" + sequence, event: { event: "process.output", at, sessionId, processId, output: "out-" + sequence } };
  };
  const initial = Array.from({ length: 1000 }, (_, index) => makeOutput(999 - index));
  const processDetails = new FakeElement("section");
  const heading = new FakeElement("h2"); heading.textContent = "コマンドと出力の詳細"; processDetails.append(heading);
  processDetails.append(new FakeElement("div"));
  const baselineStart = { event: "process.start", at: "1969-12-31T23:59:59.000Z", sessionId, processId, command: "long command", comment: "long purpose" };
  const seed = new FakeElement("article"); seed.className = "process-block"; seed.dataset.sessionId = sessionId; seed.dataset.processId = processId; seed.dataset.eventsJson = JSON.stringify([baselineStart]); processDetails.append(seed);
  const ui = boot(async (url) => {
    const request = new URL(url, "http://local.test");
    if (request.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 0, runningProcesses: 0, updatedAt: new Date().toISOString() });
    if (request.searchParams.get("before") === "c0") {
      const older = Array.from({ length: 200 }, (_, index) => makeOutput(-1 - index));
      return response(200, { items: older, newestCursor: "c-1", oldestCursor: "c-200", hasMoreOlder: false, hasMoreNewer: false });
    }
    throw new Error("unexpected request " + request.href);
  }, initial, { "process-details": processDetails }, sessionId);
  await settle();
  ui.older.click();
  await settle();
  const article = processDetails.children.find((child) => child.className === "process-block");
  assert.ok(article);
  const renderedEvents = JSON.parse(article.dataset.eventsJson ?? "[]") as Array<Record<string, unknown>>;
  assert.equal(renderedEvents.length, 1000, "the SSR start summary does not evict an API event from the bounded window");
  assert.equal(renderedEvents[0]?.output, "out--200");
  assert.equal(article.children.some((child) => child.tagName === "pre" && child.textContent === "long command"), true);
  assert.equal(article.children.some((child) => child.tagName === "pre" && child.textContent === "long purpose"), true);
  assert.ok(processDetails.children.includes(ui.root), "the refresh toolbar remains above the latest displayed process");
});

test("an empty process detail keeps its update button after a zero-count refresh", async () => {
  const processDetails = new FakeElement("section");
  const heading = new FakeElement("h2"); heading.textContent = "コマンドと出力の詳細"; processDetails.append(heading);
  const ui = boot(async (url) => {
    const request = new URL(url, "http://local.test");
    if (request.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 0, runningProcesses: 0, updatedAt: "2026-09-28T00:00:00Z" });
    return response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false });
  }, [], { "process-details": processDetails });
  await settle();
  assert.equal(processDetails.hidden, false);
  ui.newest.click();
  await settle();
  await settle();
  assert.equal(ui.newest.hidden, false);
  assert.equal(ui.newest.textContent, "↻ 更新（新着 0件）");
  assert.equal(processDetails.hidden, false);
  assert.ok(processDetails.children.includes(ui.root), "the update control remains in the otherwise empty process section");
  assert.ok(processDetails.children.includes(heading));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const emptyState = { stopped: false, activeSessions: 0, runningProcesses: 0, updatedAt: "2026-09-28T00:00:00Z", sessions: [], running: [] };

test("list auto update consumes SSE notices while detail pages remain manual", async () => {
  const calls: URL[] = [];
  const toggle = new FakeElement("input"); toggle.checked = true;
  const ui = boot(async (url) => {
    const request = new URL(url, "http://local.test"); calls.push(request);
    if (request.pathname === "/api/console-state") return response(200, emptyState);
    if (request.pathname === "/api/logs") return response(200, { items: [item("auto-1")], newestCursor: "c1", oldestCursor: "c1", hasMoreOlder: false, hasMoreNewer: false });
    throw new Error("unexpected request " + request.href);
  }, [], { "auto-refresh": toggle }, "", { clock: new FakeClock() });
  await settle();
  ui.sources[0]!.dispatch("logs-available", JSON.stringify({ addedCount: 1, latestCursor: "c1" }));
  await settle(); await settle();
  assert.equal(calls.filter((url) => url.pathname === "/api/logs").length, 1);
  assert.equal(calls.filter((url) => url.pathname === "/api/console-state").length, 2);
  assert.equal(ui.root.dataset.newestCursor, "c1");

  const detailToggle = new FakeElement("input"); detailToggle.checked = true;
  const detailCalls: URL[] = [];
  const detail = boot(async (url) => {
    const request = new URL(url, "http://local.test"); detailCalls.push(request);
    return request.pathname === "/api/console-state" ? response(200, emptyState) : response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false });
  }, [], { "auto-refresh": detailToggle }, "individual-session-id");
  await settle();
  detail.sources[0]!.dispatch("logs-available", JSON.stringify({ addedCount: 1, latestCursor: "c1" }));
  await settle();
  assert.equal(detailCalls.filter((url) => url.pathname === "/api/logs").length, 0, "individual details do not add auto fetching");
});

test("turning automatic refresh off ignores a late response without moving the cursor", async () => {
  const gate = deferred<ReturnType<typeof response>>();
  const calls: URL[] = [];
  const toggle = new FakeElement("input"); toggle.checked = true;
  const clock = new FakeClock();
  const ui = boot(async (url) => {
    const request = new URL(url, "http://local.test"); calls.push(request);
    if (request.pathname === "/api/console-state") return response(200, emptyState);
    return gate.promise;
  }, [], { "auto-refresh": toggle }, "", { clock });
  await settle();
  ui.sources[0]!.dispatch("logs-available", JSON.stringify({ addedCount: 1, latestCursor: "c1" }));
  assert.equal(calls.filter((url) => url.pathname === "/api/logs").length, 1);
  toggle.checked = false; toggle.click("change");
  gate.resolve(response(200, { items: [item("stale")], newestCursor: "c1", oldestCursor: "c1", hasMoreOlder: false, hasMoreNewer: false }));
  await settle(); await settle();
  assert.equal(ui.root.dataset.newestCursor, "c0");
  assert.equal(calls.filter((url) => url.pathname === "/api/console-state").length, 1);
  assert.equal(ui.newest.hidden, false, "the unapplied notice remains visible");
  assert.equal(clock.timers.size, 0, "disabled auto refresh leaves no retry timer");
});

test("failure on log request two keeps request one's cursor and resumes from it", async () => {
  const clock = new FakeClock();
  const toggle = new FakeElement("input"); toggle.checked = true;
  const calls: URL[] = [];
  let failSecond = true;
  const ui = boot(async (url) => {
    const request = new URL(url, "http://local.test"); calls.push(request);
    if (request.pathname === "/api/console-state") return response(200, emptyState);
    const after = request.searchParams.get("after");
    if (after === "c0") return response(200, { items: [item("first")], newestCursor: "c1", oldestCursor: "c1", hasMoreOlder: false, hasMoreNewer: true });
    if (after === "c1" && failSecond) { failSecond = false; return response(503, {}); }
    if (after === "c1") return response(200, { items: [item("second")], newestCursor: "c2", oldestCursor: "c2", hasMoreOlder: false, hasMoreNewer: false });
    throw new Error("unexpected cursor " + after);
  }, [], { "auto-refresh": toggle }, "", { clock });
  await settle();
  ui.sources[0]!.dispatch("logs-available", JSON.stringify({ addedCount: 2, latestCursor: "c2" }));
  await settle(); await settle();
  assert.equal(ui.root.dataset.newestCursor, "c1", "only the reflected first page advances the cursor");
  assert.equal(ui.newest.hidden, false, "unread work remains pending after the second request fails");
  await clock.advance(2_000);
  await settle(); await settle();
  assert.equal(ui.root.dataset.newestCursor, "c2");
  assert.deepEqual(calls.filter((url) => url.pathname === "/api/logs").map((url) => url.searchParams.get("after")), ["c0", "c1", "c1"]);
});

test("state-only failure retries state without waiting for another SSE notice", async () => {
  const clock = new FakeClock();
  const toggle = new FakeElement("input"); toggle.checked = true;
  const calls: URL[] = [];
  let failRefreshState = true;
  const ui = boot(async (url) => {
    const request = new URL(url, "http://local.test"); calls.push(request);
    if (request.pathname === "/api/logs") return response(200, { items: [item("state-retry")], newestCursor: "c1", oldestCursor: "c1", hasMoreOlder: false, hasMoreNewer: false });
    if (failRefreshState && calls.filter((call) => call.pathname === "/api/console-state").length === 2) { failRefreshState = false; return response(503, {}); }
    return response(200, emptyState);
  }, [], { "auto-refresh": toggle }, "", { clock });
  await settle();
  ui.sources[0]!.dispatch("logs-available", JSON.stringify({ addedCount: 1, latestCursor: "c1" }));
  await settle(); await settle();
  assert.equal(ui.root.dataset.newestCursor, "c1", "the successful log cursor remains committed");
  assert.equal(calls.filter((url) => url.pathname === "/api/console-state").length, 2);
  await clock.advance(2_000);
  await settle(); await settle();
  assert.equal(calls.filter((url) => url.pathname === "/api/console-state").length, 3, "state retry runs with no further SSE notice");
  assert.equal(calls.filter((url) => url.pathname === "/api/logs").length, 1, "state retry does not reread committed log pages");
});

test("one automatic cycle stops after five pages and queues a bounded catch-up", async () => {
  const clock = new FakeClock();
  const toggle = new FakeElement("input"); toggle.checked = true;
  const calls: URL[] = [];
  let sequence = 0;
  const ui = boot(async (url) => {
    const request = new URL(url, "http://local.test"); calls.push(request);
    if (request.pathname === "/api/console-state") return response(200, emptyState);
    const start = sequence;
    sequence += 1;
    return response(200, { items: [item(String(start))], newestCursor: "c" + (start + 1), oldestCursor: "c" + (start + 1), hasMoreOlder: false, hasMoreNewer: start < 5 });
  }, [], { "auto-refresh": toggle }, "", { clock });
  await settle();
  ui.sources[0]!.dispatch("logs-available", JSON.stringify({ addedCount: 10_000, latestCursor: "c10000" }));
  await settle(); await settle();
  assert.equal(calls.filter((url) => url.pathname === "/api/logs").length, 5);
  assert.equal(ui.root.dataset.newestCursor, "c5");
  assert.equal(ui.newest.hidden, false, "the capped cycle keeps pending work visible");
  await clock.advance(1_999);
  assert.equal(calls.filter((url) => url.pathname === "/api/logs").length, 5, "no catch-up starts before two seconds");
  await clock.advance(1);
  await settle(); await settle();
  assert.equal(calls.filter((url) => url.pathname === "/api/logs").length, 6);
  assert.equal(calls.filter((url) => url.pathname === "/api/logs")[5]?.searchParams.get("after"), "c5");
});

test("resync-required while disabled waits for manual refresh", async () => {
  const calls: URL[] = [];
  const toggle = new FakeElement("input"); toggle.checked = false;
  const ui = boot(async (url) => {
    const request = new URL(url, "http://local.test"); calls.push(request);
    if (request.pathname === "/api/console-state") return response(200, emptyState);
    return response(200, { items: [item("resynced")], newestCursor: "c9", oldestCursor: "c9", hasMoreOlder: false, hasMoreNewer: false });
  }, [], { "auto-refresh": toggle }, "", { clock: new FakeClock() });
  await settle();
  ui.sources[0]!.dispatch("resync-required");
  await settle();
  assert.equal(calls.filter((url) => url.pathname === "/api/logs").length, 0);
  assert.equal(ui.root.dataset.newestCursor, "c0");
  ui.newest.click();
  await settle(); await settle();
  assert.equal(calls.filter((url) => url.pathname === "/api/logs").length, 1, "manual action performs the deferred resync");
  assert.equal(ui.root.dataset.newestCursor, "c9");
});

test("hidden pages and pagehide invalidate delayed automatic responses", async () => {
  const hiddenGate = deferred<ReturnType<typeof response>>();
  const departureGate = deferred<ReturnType<typeof response>>();
  const clock = new FakeClock();
  const toggle = new FakeElement("input"); toggle.checked = true;
  const calls: URL[] = [];
  const ui = boot(async (url) => {
    const request = new URL(url, "http://local.test"); calls.push(request);
    if (request.pathname === "/api/console-state") return response(200, emptyState);
    return calls.filter((call) => call.pathname === "/api/logs").length === 1 ? hiddenGate.promise : departureGate.promise;
  }, [], { "auto-refresh": toggle }, "", { clock });
  await settle();
  ui.sources[0]!.dispatch("logs-available", JSON.stringify({ addedCount: 1, latestCursor: "c1" }));
  ui.documentStub.hidden = true;
  ui.documentListeners.get("visibilitychange")?.();
  hiddenGate.resolve(response(200, { items: [item("hidden")], newestCursor: "c1", oldestCursor: "c1", hasMoreOlder: false, hasMoreNewer: false }));
  await settle(); await settle();
  assert.equal(ui.root.dataset.newestCursor, "c0");
  assert.equal(clock.timers.size, 0);

  ui.documentStub.hidden = false;
  ui.documentListeners.get("visibilitychange")?.();
  await clock.advance(2_000);
  await settle();
  assert.equal(calls.filter((url) => url.pathname === "/api/logs").length, 2);
  ui.windowListeners.get("pagehide")?.();
  departureGate.resolve(response(200, { items: [item("departed")], newestCursor: "c2", oldestCursor: "c2", hasMoreOlder: false, hasMoreNewer: false }));
  await settle(); await settle();
  assert.equal(ui.root.dataset.newestCursor, "c0", "a response arriving after navigation cannot mutate the page");
  assert.equal(ui.sources[0]!.closed, true);
  assert.equal(clock.timers.size, 0, "pagehide must not queue another automatic request");
  await clock.advance(10_000);
  assert.equal(calls.filter((url) => url.pathname === "/api/logs").length, 2, "a departed page cannot keep fetching");
  ui.windowListeners.get("pageshow")?.({ persisted: true });
  await settle(); await settle();
  assert.equal(ui.sources.length, 2, "BFCache restoration creates a fresh EventSource");
  assert.equal(ui.root.dataset.newestCursor, "c2", "restoration catches up from the retained cursor");
});

test("interrupted automatic state refresh remains pending and retries without an SSE notice", async () => {
  const gate = deferred<ReturnType<typeof response>>();
  const clock = new FakeClock();
  const toggle = new FakeElement("input"); toggle.checked = true;
  const activeCount = new FakeElement();
  let stateRequests = 0;
  const ui = boot(async (url) => {
    const request = new URL(url, "http://local.test");
    if (request.pathname === "/api/logs") return response(200, { items: [item("state-interrupt")], newestCursor: "c1", oldestCursor: "c1", hasMoreOlder: false, hasMoreNewer: false });
    stateRequests += 1;
    if (stateRequests === 1) return response(200, { ...emptyState, activeSessions: 1 });
    if (stateRequests === 2) return gate.promise;
    return response(200, { ...emptyState, activeSessions: 5 });
  }, [], { "auto-refresh": toggle, "active-session-count": activeCount }, "", { clock });
  await settle();
  ui.sources[0]!.dispatch("logs-available", JSON.stringify({ addedCount: 1, latestCursor: "c1" }));
  await settle(); await settle();
  assert.equal(stateRequests, 2);
  toggle.checked = false; toggle.click("change");
  gate.resolve(response(200, { ...emptyState, activeSessions: 9 }));
  await settle(); await settle();
  assert.equal(activeCount.textContent, "1", "the interrupted snapshot must not be rendered late");
  toggle.checked = true; toggle.click("change");
  await clock.advance(2_000);
  await settle(); await settle();
  assert.equal(stateRequests, 3, "state work is retried even without another SSE notice");
  assert.equal(activeCount.textContent, "5");
});

test("authentication failures stop automatic log, state, and resync retries", async () => {
  for (const mode of ["logs", "state", "resync", "normal-resync"] as const) {
    const clock = new FakeClock();
    const toggle = new FakeElement("input"); toggle.checked = true;
    const calls: URL[] = [];
    let stateRequests = 0;
    const ui = boot(async (url) => {
      const request = new URL(url, "http://local.test"); calls.push(request);
      if (request.pathname === "/api/logs") {
        if (mode !== "state") return response(mode === "logs" ? 401 : 403, {});
        return response(200, { items: [item("auth-state")], newestCursor: "c1", oldestCursor: "c1", hasMoreOlder: false, hasMoreNewer: false });
      }
      stateRequests += 1;
      return stateRequests === 1 ? response(200, emptyState) : response(403, {});
    }, [], { "auto-refresh": toggle }, mode === "normal-resync" ? "individual-session" : "", { clock });
    await settle();
    if (mode === "resync" || mode === "normal-resync") ui.sources[0]!.dispatch("resync-required");
    else ui.sources[0]!.dispatch("logs-available", JSON.stringify({ addedCount: 1, latestCursor: "c1" }));
    await settle(); await settle();
    const requestsAtFailure = calls.length;
    await clock.advance(10_000);
    await settle();
    assert.equal(calls.length, requestsAtFailure, `${mode} auth failure must not be retried`);
    assert.equal(toggle.disabled, true, `${mode} auth failure disables further automatic work`);
    assert.equal(clock.timers.size, 0);
  }
});

test("SSE auth-expired stops an in-flight automatic request and its retry timer", async () => {
  const gate = deferred<ReturnType<typeof response>>();
  const clock = new FakeClock();
  const toggle = new FakeElement("input"); toggle.checked = true;
  let logRequests = 0;
  const ui = boot(async (url) => {
    const request = new URL(url, "http://local.test");
    if (request.pathname === "/api/console-state") return response(200, emptyState);
    logRequests += 1;
    return gate.promise;
  }, [], { "auto-refresh": toggle }, "", { clock });
  await settle();
  const source = ui.sources[0]!;
  source.dispatch("logs-available", JSON.stringify({ addedCount: 1, latestCursor: "c1" }));
  await settle();
  source.dispatch("auth-expired");
  gate.resolve(response(200, { items: [item("late-auth")], newestCursor: "c1", oldestCursor: "c1", hasMoreOlder: false, hasMoreNewer: false }));
  await settle(); await settle();
  assert.equal(source.closed, true);
  assert.equal(ui.root.dataset.newestCursor, "c0");
  assert.equal(toggle.disabled, true);
  ui.windowListeners.get("pageshow")?.({ persisted: true });
  assert.equal(ui.sources.length, 1, "BFCache restoration after auth expiry must not reopen SSE");
  await clock.advance(10_000);
  assert.equal(logRequests, 1);
  assert.equal(clock.timers.size, 0);
});

test("manual refresh completes across automatic toggle and visibility changes", async () => {
  for (const change of ["toggle", "visibility"] as const) {
    const gate = deferred<ReturnType<typeof response>>();
    const toggle = new FakeElement("input"); toggle.checked = false;
    const ui = boot(async (url) => {
      const request = new URL(url, "http://local.test");
      if (request.pathname === "/api/console-state") return response(200, emptyState);
      return gate.promise;
    }, [], { "auto-refresh": toggle });
    await settle();
    ui.newest.click();
    if (change === "toggle") {
      toggle.checked = true; toggle.click("change");
      toggle.checked = false; toggle.click("change");
    } else {
      ui.documentStub.hidden = true;
      ui.documentListeners.get("visibilitychange")?.();
    }
    gate.resolve(response(200, { items: [item("manual-survives")], newestCursor: "c1", oldestCursor: "c1", hasMoreOlder: false, hasMoreNewer: false }));
    await settle(); await settle();
    assert.equal(ui.root.dataset.newestCursor, "c1", `automatic ${change} cancellation must not invalidate a manual request`);
  }
});

test("authentication end invalidates delayed state and older-page reads and blocks new reads", async () => {
  const stateGate = deferred<unknown>();
  const olderGate = deferred<unknown>();
  const toggle = new FakeElement("input"); toggle.checked = true;
  const activeCount = new FakeElement();
  const calls: URL[] = [];
  const ui = boot(async (url) => {
    const request = new URL(url, "http://local.test"); calls.push(request);
    if (request.pathname === "/api/console-state") return { status: 200, ok: true, json: () => stateGate.promise };
    if (request.searchParams.has("before")) return { status: 200, ok: true, json: () => olderGate.promise };
    return response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: true, hasMoreNewer: false });
  }, [item("base")], { "auto-refresh": toggle, "active-session-count": activeCount });
  await settle();
  ui.older.click();
  await settle();
  assert.equal(calls.filter((url) => url.pathname === "/api/console-state").length, 1);
  assert.equal(calls.filter((url) => url.pathname === "/api/logs").length, 1);
  ui.sources[0]!.dispatch("auth-expired");
  stateGate.resolve({ ...emptyState, activeSessions: 9 });
  olderGate.resolve({ items: [item("late-older")], newestCursor: "c0", oldestCursor: "c-1", hasMoreOlder: false, hasMoreNewer: false });
  await settle(); await settle();
  assert.equal(activeCount.textContent, "", "a state response received after authentication ends must not render");
  assert.equal(ui.root.dataset.oldestCursor, "cursor-base", "an older-page response received after authentication ends must not commit");
  ui.older.click();
  await settle();
  assert.equal(calls.filter((url) => url.pathname === "/api/logs").length, 1, "expired authentication must block new older-page reads");
});

test("manual refresh queued during automatic work runs once even after switching off", async () => {
  const automaticGate = deferred<ReturnType<typeof response>>();
  const toggle = new FakeElement("input"); toggle.checked = true;
  const calls: URL[] = [];
  let activeLogRequests = 0;
  let maximumActiveLogRequests = 0;
  const ui = boot(async (url) => {
    const request = new URL(url, "http://local.test"); calls.push(request);
    if (request.pathname === "/api/console-state") return response(200, emptyState);
    activeLogRequests += 1;
    maximumActiveLogRequests = Math.max(maximumActiveLogRequests, activeLogRequests);
    if (calls.filter((call) => call.pathname === "/api/logs").length === 1) {
      const result = await automaticGate.promise;
      activeLogRequests -= 1;
      return result;
    }
    activeLogRequests -= 1;
    return response(200, { items: [item("manual-queued")], newestCursor: "c2", oldestCursor: "c2", hasMoreOlder: false, hasMoreNewer: false });
  }, [], { "auto-refresh": toggle });
  await settle();
  ui.sources[0]!.dispatch("logs-available", JSON.stringify({ addedCount: 1, latestCursor: "c1" }));
  await settle();
  assert.equal(calls.filter((url) => url.pathname === "/api/logs").length, 1);
  ui.newest.click();
  ui.newest.click();
  toggle.checked = false; toggle.click("change");
  automaticGate.resolve(response(200, { items: [item("automatic-late")], newestCursor: "c1", oldestCursor: "c1", hasMoreOlder: false, hasMoreNewer: false }));
  await settle(); await settle(); await settle();
  assert.equal(calls.filter((url) => url.pathname === "/api/logs").length, 2, "duplicate queued clicks collapse to one manual log request");
  assert.equal(maximumActiveLogRequests, 1, "the queued manual request starts after the automatic request ends");
  assert.equal(ui.root.dataset.newestCursor, "c2", "the queued manual request runs after automatic refresh is switched off");
});

test("queued manual refresh is discarded after page departure or authentication end", async () => {
  for (const ending of ["pagehide", "auth-expired"] as const) {
    const automaticGate = deferred<ReturnType<typeof response>>();
    const toggle = new FakeElement("input"); toggle.checked = true;
    const calls: URL[] = [];
    const ui = boot(async (url) => {
      const request = new URL(url, "http://local.test"); calls.push(request);
      if (request.pathname === "/api/console-state") return response(200, emptyState);
      return automaticGate.promise;
    }, [], { "auto-refresh": toggle });
    await settle();
    ui.sources[0]!.dispatch("logs-available", JSON.stringify({ addedCount: 1, latestCursor: "c1" }));
    await settle();
    ui.newest.click();
    if (ending === "pagehide") ui.windowListeners.get("pagehide")?.();
    else ui.sources[0]!.dispatch("auth-expired");
    automaticGate.resolve(response(200, { items: [item("late-auto")], newestCursor: "c1", oldestCursor: "c1", hasMoreOlder: false, hasMoreNewer: false }));
    await settle(); await settle(); await settle();
    assert.equal(calls.filter((url) => url.pathname === "/api/logs").length, 1, `${ending} discards queued manual work`);
    assert.equal(ui.root.dataset.newestCursor, "c0");
  }
});

test("a late initial state response cannot overwrite newer state from an SSE refresh", async () => {
  const initialState = deferred<unknown>();
  const toggle = new FakeElement("input"); toggle.checked = true;
  const activeCount = new FakeElement();
  let stateCalls = 0;
  const ui = boot(async (url) => {
    const request = new URL(url, "http://local.test");
    if (request.pathname === "/api/console-state") {
      stateCalls += 1;
      if (stateCalls === 1) return { status: 200, ok: true, json: () => initialState.promise };
      return response(200, { ...emptyState, activeSessions: 5 });
    }
    return response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false });
  }, [], { "auto-refresh": toggle, "active-session-count": activeCount }, "", { clock: new FakeClock() });
  await settle();
  ui.sources[0]!.dispatch("logs-available", JSON.stringify({ addedCount: 1, latestCursor: "c1" }));
  await settle(); await settle();
  assert.equal(activeCount.textContent, "5", "the newer automatic snapshot should render first");
  initialState.resolve({ ...emptyState, activeSessions: 1 });
  await settle(); await settle();
  assert.equal(activeCount.textContent, "5", "the older initial response must not roll the page back");
});

test("session row redraw restores its text selection and visible scroll anchor", async () => {
  const rows = new FakeElement("tbody");
  const oldRow = new FakeElement("tr"); oldRow.dataset.sessionId = "session-1"; oldRow.rect = { top: 20, bottom: 40, left: 0, right: 100 };
  const values = ["詳細を見る", "2026-10-01", "2026-10-01", "有効", "test", "session-1", "C:/work"];
  for (const value of values) { const cell = new FakeElement("td"); cell.textContent = value; const text = new FakeElement("#text"); text.textContent = value; cell.append(text); oldRow.append(cell); }
  rows.append(oldRow);
  const oldText = oldRow.cells[4]!.children[0]!;
  let restored: unknown[] | undefined;
  const selection = { anchorNode: oldText, focusNode: oldText, anchorOffset: 1, focusOffset: 3, isCollapsed: false, toString: () => "es", setBaseAndExtent: (...args: unknown[]) => { restored = args; }, removeAllRanges: () => undefined, addRange: () => undefined };
  const ui = boot(async (url) => new URL(url, "http://local.test").pathname === "/api/console-state"
    ? response(200, { ...emptyState, sessions: [{ session_id: "session-1", created_at: "2026-10-01T00:00:00Z", state: "active", active: true, purpose: "test", working_directory: "C:/work" }] })
    : response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false }), [], { "session-rows": rows }, "", { selection });
  await settle(); await settle();
  assert.ok(restored, "the selected text endpoints should be rebound to the recreated row");
  assert.equal((restored![0] as FakeElement).tagName, "#text");
  assert.equal((restored![0] as FakeElement).parentElement, (restored![2] as FakeElement).parentElement, "same-cell endpoints stay attached to their original cell");
  assert.equal(restored![1], 1);
  assert.equal(restored![3], 3);
  assert.equal(ui.scrollCalls, 1, "the same visible session row keeps its viewport position");
});

test("session row redraw preserves forward and reverse selections spanning two rows", async () => {
  for (const direction of ["forward", "reverse"] as const) {
    const rows = new FakeElement("tbody");
    const rowNodes = ["session-a", "session-b"].map((id) => { const row = new FakeElement("tr"); row.dataset.sessionId = id; for (const value of ["詳細を見る", "2026-10-01", "2026-10-03", "有効", "test", id, "C:/work"]) { const cell = new FakeElement("td"); cell.textContent = value; const text = new FakeElement("#text"); text.textContent = value; cell.append(text); row.append(cell); } rows.append(row); return row; });
    const start = { node: rowNodes[0]!.cells[5]!.children[0]!, offset: 1 };
    const end = { node: rowNodes[1]!.cells[5]!.children[0]!, offset: 4 };
    let restored: unknown[] | undefined;
    const selection = { anchorNode: direction === "forward" ? start.node : end.node, focusNode: direction === "forward" ? end.node : start.node, anchorOffset: direction === "forward" ? start.offset : end.offset, focusOffset: direction === "forward" ? end.offset : start.offset, isCollapsed: false, toString: () => "a-b", setBaseAndExtent: (...args: unknown[]) => { restored = args; }, removeAllRanges: () => undefined, addRange: () => undefined };
    const ui = boot(async (url) => new URL(url, "http://local.test").pathname === "/api/console-state"
      ? response(200, { ...emptyState, sessions: ["session-a", "session-b"].map((session_id) => ({ session_id, created_at: "2026-10-01T00:00:00Z", state: "active", active: true, purpose: "test", working_directory: "C:/work" })) })
      : response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false }), [], { "session-rows": rows }, "", { selection });
    await settle(); await settle();
    assert.ok(restored, `${direction} selection endpoints spanning separate session rows should be restored`);
    assert.equal((restored![0] as FakeElement).closest("tr[data-session-id]")?.dataset.sessionId, direction === "forward" ? "session-a" : "session-b");
    assert.equal((restored![2] as FakeElement).closest("tr[data-session-id]")?.dataset.sessionId, direction === "forward" ? "session-b" : "session-a");
    assert.equal(ui.scrollCalls, 0);
  }
});

test("reverse selection fallback preserves endpoints when setBaseAndExtent is unavailable", async () => {
  for (const fallback of ["collapse-extend", "range"] as const) {
    const rows = new FakeElement("tbody");
    for (const id of ["session-a", "session-b"]) { const row = new FakeElement("tr"); row.dataset.sessionId = id; for (const value of ["詳細を見る", "date", "access", "有効", "test", id, "C:/work"]) { const cell = new FakeElement("td"); cell.textContent = value; const text = new FakeElement("#text"); text.textContent = value; cell.append(text); row.append(cell); } rows.append(row); }
    const anchor = rows.children[1]!.cells[5]!.children[0]!; const focus = rows.children[0]!.cells[5]!.children[0]!;
    let collapsed: [FakeElement, number] | undefined; let extended: [FakeElement, number] | undefined; let addedRange: Range | undefined;
    const selectionBase = { anchorNode: anchor, focusNode: focus, anchorOffset: 4, focusOffset: 1, isCollapsed: false, toString: () => "a-b", removeAllRanges: () => undefined, addRange: (range: Range) => { addedRange = range; } };
    const selection = fallback === "collapse-extend" ? { ...selectionBase, collapse: (node: FakeElement, offset: number) => { collapsed = [node, offset]; }, extend: (node: FakeElement, offset: number) => { extended = [node, offset]; } } : selectionBase;
    const ui = boot(async (url) => new URL(url, "http://local.test").pathname === "/api/console-state"
      ? response(200, { ...emptyState, sessions: ["session-a", "session-b"].map((session_id) => ({ session_id, created_at: "2026-10-01T00:00:00Z", state: "active", active: true, purpose: "test", working_directory: "C:/work" })) })
      : response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false }), [], { "session-rows": rows }, "", { selection });
    await settle(); await settle();
    if (fallback === "collapse-extend") {
      assert.equal(collapsed?.[0].closest("tr[data-session-id]")?.dataset.sessionId, "session-b", "the original reverse anchor remains the anchor");
      assert.equal(collapsed?.[1], 4);
      assert.equal(extended?.[0].closest("tr[data-session-id]")?.dataset.sessionId, "session-a", "the original reverse focus remains the focus");
      assert.equal(extended?.[1], 1);
    } else {
      assert.equal((addedRange?.startContainer as FakeElement | null)?.closest("tr[data-session-id]")?.dataset.sessionId, "session-a", "Range start is normalized to the earlier DOM endpoint");
      assert.equal(addedRange?.startOffset, 1);
      assert.equal((addedRange?.endContainer as FakeElement | null)?.closest("tr[data-session-id]")?.dataset.sessionId, "session-b", "Range end is normalized to the later DOM endpoint");
      assert.equal(addedRange?.endOffset, 4);
    }
    assert.equal(ui.scrollCalls, 0);
  }
});

test("session selection stays attached to its cell when text in preceding cells changes", async () => {
  const rows = new FakeElement("tbody"); const row = new FakeElement("tr"); row.dataset.sessionId = "session-cell";
  const values = ["link", "old date", "old access", "active", "purpose", "session-cell", "old directory"];
  for (const value of values) { const cell = new FakeElement("td"); cell.textContent = value; const text = new FakeElement("#text"); text.textContent = value; cell.append(text); row.append(cell); }
  rows.append(row);
  const idText = row.cells[5]!.children[0]!; let restored: unknown[] | undefined; let clearCount = 0;
  const selection = { anchorNode: idText, focusNode: idText, anchorOffset: 3, focusOffset: 7, isCollapsed: false, toString: () => "sion", setBaseAndExtent: (...args: unknown[]) => { restored = args; }, removeAllRanges: () => { clearCount += 1; }, addRange: () => undefined };
  const ui = boot(async (url) => new URL(url, "http://local.test").pathname === "/api/console-state"
    ? response(200, { ...emptyState, sessions: [{ session_id: "session-cell", created_at: "2026-10-02T00:00:00Z", last_used_at: "2026-10-03T00:00:00Z", state: "active", active: true, purpose: "a much longer changed purpose", working_directory: "C:/new-directory" }] })
    : response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false }), [], { "session-rows": rows }, "", { selection });
  await settle(); await settle();
  assert.ok(restored, `the exact endpoint cell should be restored (clear=${clearCount})`);
  const restoredCell = (restored![0] as FakeElement).closest("td");
  assert.equal((restoredCell?.parentElement as FakeElement | null)?.cells.indexOf(restoredCell!), 5, "a longer purpose in an earlier cell must not redirect selection into that cell");
  assert.equal(restored![1], 3);
  assert.equal(restored![3], 7);
  assert.equal(ui.scrollCalls, 0);
});

test("changed or removed selection targets are cleared instead of moved to different text", async () => {
  for (const changed of [true, false]) {
    const rows = new FakeElement("tbody"); const row = new FakeElement("tr"); row.dataset.sessionId = "session-target";
    for (const value of ["link", "date", "access", "active", "original purpose", "session-target", "directory"]) { const cell = new FakeElement("td"); cell.textContent = value; const text = new FakeElement("#text"); text.textContent = value; cell.append(text); row.append(cell); }
    rows.append(row);
    const target = row.cells[4]!.children[0]!; let clearCount = 0; let restoreCount = 0;
    const selection = { anchorNode: target, focusNode: target, anchorOffset: 2, focusOffset: 7, isCollapsed: false, toString: () => "iginal", setBaseAndExtent: () => { restoreCount += 1; }, removeAllRanges: () => { clearCount += 1; }, addRange: () => undefined };
    const sessions = changed ? [{ session_id: "session-target", created_at: "2026-10-01T00:00:00Z", state: "active", active: true, purpose: "replacement purpose", working_directory: "directory" }] : [];
    const ui = boot(async (url) => new URL(url, "http://local.test").pathname === "/api/console-state"
      ? response(200, { ...emptyState, sessions })
      : response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false }), [], { "session-rows": rows }, "", { selection });
    await settle(); await settle();
    assert.equal(restoreCount, 0, "a changed or missing target must not be rebound to unrelated characters");
    assert.equal(clearCount, 1, "an unrestorable range is explicitly cleared");
    assert.equal(ui.scrollCalls, 0);
  }
});
