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
  static activeElement: FakeElement | null = null;
  dataset: Record<string, string> = {};
  hidden = false;
  disabled = false;
  open = false;
  textContent = "";
  className = "";
  tagName: string;
  href = "";
  id = "";
  dateTime = "";
  focusOptions?: { preventScroll?: boolean };
  style = { height: "", lineHeight: "" };
  colSpan = 1;
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  listeners = new Map<string, (event?: unknown) => void>();
  onReplaceChildren?: (removed: FakeElement[]) => void;
  queries = new Map<string, FakeElement>();
  closestNodes = new Map<string, FakeElement>();
  rect = { top: 0, bottom: 100, left: 0, right: 100 };
  classList = { toggle: (name: string, force?: boolean) => Boolean(name && force !== false) };
  constructor(tagName = "div") { this.tagName = tagName.toLowerCase(); }
  checked = false;
  value = "";
  name = "";
  type = "";
  required = false;
  setAttribute(_name: string, _value: string) {}
  maxLength = 0;
  rows = 0;
  scrollHeight = 80;
  selectionStart = 0;
  selectionEnd = 0;
  selectionDirection: "forward" | "backward" | "none" = "none";
  innerHTML = "";
  focus(options?: { preventScroll?: boolean }) { FakeElement.activeElement = this; this.focusOptions = options; }
  addEventListener(name: string, listener: (event?: unknown) => void) { this.listeners.set(name, listener); }
  click(name = "click") { if (this.disabled) return; this.listeners.get(name)?.({ target: this }); }
  replaceChildren(...children: FakeElement[]) { this.onReplaceChildren?.(this.children); for (const child of this.children) child.parentElement = null; this.children = []; for (const child of children) this.append(child); }
  append(...children: FakeElement[]) { for (const child of children) { if (child.contains(FakeElement.activeElement)) FakeElement.activeElement = null; child.parentElement?.remove(child); this.children.push(child); child.parentElement = this; } }
  insertBefore(child: FakeElement, reference: FakeElement | null) { if (child === reference) return child; if (child.contains(FakeElement.activeElement)) FakeElement.activeElement = null; child.parentElement?.remove(child); const index = reference ? this.children.indexOf(reference) : -1; if (index < 0) this.children.push(child); else this.children.splice(index, 0, child); child.parentElement = this; return child; }
  setSelectionRange(start: number, end: number, direction: "forward" | "backward" | "none" = "none") { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
  remove(child?: FakeElement) { if (!child) { this.parentElement?.remove(this); return; } this.children = this.children.filter((candidate) => candidate !== child); child.parentElement = null; }
  get parent() { return this.parentElement; }
  insertRow() { const row = new FakeElement("tr"); this.append(row); return row; }
  insertCell() { const cell = new FakeElement("td"); this.append(cell); return cell; }
  allDescendants(): FakeElement[] { return this.children.flatMap((child) => [child, ...child.allDescendants()]); }
  querySelectorAll<T extends FakeElement>(selector: string) {
    const override = this.queries.get(selector);
    if (override) return [override] as T[];
    if (selector.startsWith(".process-block")) return this.children.filter((child) => child.className === "process-block" && (!selector.includes("data-events-json") || child.dataset.eventsJson !== undefined)) as T[];
    if (selector.startsWith("tr[data-event-json]")) return this.children.filter((child) => child.tagName === "tr" && child.dataset.eventJson !== undefined) as T[];
    if (selector === "tr[data-session-id]") return this.children.filter((child) => child.tagName === "tr" && child.dataset.sessionId !== undefined) as T[];
    const descendants = this.allDescendants();
    if (selector === "li[data-todo-id]") return descendants.filter((child) => child.tagName === "li" && child.dataset.todoId !== undefined) as T[];
    if (selector === "button[data-todo-op]") return descendants.filter((child) => child.tagName === "button" && child.dataset.todoOp !== undefined) as T[];
    if (selector === "textarea,select") return descendants.filter((child) => child.tagName === "textarea" || child.tagName === "select") as T[];
    if (selector === "form[data-session-edit]" || selector === "[data-session-edit]") return descendants.filter((child) => child.tagName === "form" && child.dataset.sessionEdit !== undefined) as T[];
    if (selector === "details[data-session-time]") return descendants.filter((child) => child.tagName === "details" && child.dataset.sessionTime !== undefined) as T[];
    if (selector === "time[data-session-relative]") return descendants.filter((child) => child.tagName === "time" && child.dataset.sessionRelative !== undefined) as T[];
    return [] as T[];
  }
  querySelector<T extends FakeElement>(selector: string) {
    const override = this.queries.get(selector);
    if (override) return override as T;
    const attribute = selector.match(/^\[data-([a-z-]+)(?:="([^"]+)")?\]$/);
    if (attribute) { const key = attribute[1]!.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase()); return (this.allDescendants().find((child) => child.dataset[key] === (attribute[2] ?? "true")) ?? null) as T | null; }
    if (selector.startsWith(".")) return (this.allDescendants().find((child) => child.className.split(/\s+/).includes(selector.slice(1))) ?? null) as T | null;
    if (selector === "form[data-session-edit]") return (this.allDescendants().find((child) => child.tagName === "form" && child.dataset.sessionEdit !== undefined) ?? null) as T | null;
    if (selector === "h2") return (this.children.find((child) => child.tagName === "h2") ?? null) as T | null;
    if (selector === "h3") return (this.children.find((child) => child.tagName === "h3") ?? this.children.map((child) => child.querySelector<FakeElement>(selector)).find(Boolean) ?? null) as T | null;
    if (selector === "summary") return (this.children.find((child) => child.tagName === "summary") ?? this.children.map((child) => child.querySelector<FakeElement>(selector)).find(Boolean) ?? null) as T | null;
    if (selector === ".process-block") return (this.children.find((child) => child.className === "process-block") ?? null) as T | null;
    if (selector === "details") return (this.children.find((child) => child.tagName === "details") ?? this.children.map((child) => child.querySelector<FakeElement>(selector)).find(Boolean) ?? null) as T | null;
    return null;
  }
  closest<T extends FakeElement>(selector: string) { let current: FakeElement | null = this; while (current) { if ((selector === "li[data-todo-id]" && current.tagName === "li" && current.dataset.todoId !== undefined) || (selector === "tr" && current.tagName === "tr") || (selector === "tr[data-session-id]" && current.tagName === "tr" && current.dataset.sessionId !== undefined) || (selector === "td" && current.tagName === "td") || (selector === "form[data-session-edit]" && current.tagName === "form" && current.dataset.sessionEdit !== undefined)) return current as T; if (current.closestNodes.has(selector)) return current.closestNodes.get(selector) as T; current = current.parentElement; } return null; }
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
  now: number;
  constructor(now = 10_000) { this.now = now; }
  nextId = 0;
  timers = new Map<number, { due: number; callback: () => void }>();
  intervals = new Map<number, { due: number; delay: number; callback: () => void }>();
  setTimeout = (callback: () => void, delay = 0) => {
    const id = ++this.nextId;
    this.timers.set(id, { due: this.now + Math.max(0, delay), callback });
    return id;
  };
  clearTimeout = (id: number | undefined) => { if (id !== undefined) this.timers.delete(id); };
  setInterval = (callback: () => void, delay = 0) => { const id = ++this.nextId; this.intervals.set(id, { due: this.now + delay, delay, callback }); return id; };
  clearInterval = (id: number | undefined) => { if (id !== undefined) this.intervals.delete(id); };
  async advance(milliseconds: number) {
    const target = this.now + milliseconds;
    while (true) {
      const next = [...this.timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
      const interval = [...this.intervals.entries()].sort((a, b) => a[1].due - b[1].due)[0];
      if ((!next || next[1].due > target) && (!interval || interval[1].due > target)) break;
      if (interval && (!next || interval[1].due <= next[1].due) && interval[1].due <= target) {
        this.now = interval[1].due;
        interval[1].due += interval[1].delay;
        interval[1].callback();
        await settle();
        continue;
      }
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

function todoFixture(sessionId = "todo-session", version = 1, text = "server text") {
  const panel = new FakeElement("section"); panel.dataset = { sessionId, version: String(version), csrf: "csrf-value" };
  const summary = new FakeElement("p");
  const notice = new FakeElement("p");
  const list = new FakeElement("ul");
  const row = new FakeElement("li"); row.dataset = { todoId: "todo-1", baseText: text, baseStatus: "not_started", baseVersion: String(version) };
  const textarea = new FakeElement("textarea"); textarea.value = text;
  const status = new FakeElement("select"); status.value = "not_started";
  const save = new FakeElement("button");
  const remove = new FakeElement("button");
  save.dataset.todoOp = "save"; remove.dataset.todoOp = "delete";
  const conflict = new FakeElement("div"); conflict.hidden = true;
  const latest = new FakeElement("p");
  const latestStatus = new FakeElement("p");
  const useLatest = new FakeElement("button");
  const keepDraft = new FakeElement("button");
  const deletedNotice = new FakeElement("div"); deletedNotice.hidden = true;
  const deletedActions = new FakeElement("div"); deletedActions.hidden = true;
  const discardDeleted = new FakeElement("button"); discardDeleted.dataset.todoOp = "discard-deleted";
  const readdDeleted = new FakeElement("button"); readdDeleted.dataset.todoOp = "readd-deleted";
  const readdConfirm = new FakeElement("div"); readdConfirm.hidden = true;
  const replaceAddDraft = new FakeElement("button"); replaceAddDraft.dataset.todoOp = "replace-add-draft";
  const keepAddDraft = new FakeElement("button"); keepAddDraft.dataset.todoOp = "keep-add-draft";
  row.queries.set("[data-todo-text]", textarea);
  row.queries.set("[data-todo-status]", status);
  row.queries.set('[data-todo-op="save"]', save);
  row.queries.set('[data-todo-op="delete"]', remove);
  row.queries.set("[data-todo-conflict]", conflict);
  row.queries.set("[data-todo-latest]", latest);
  row.queries.set("[data-todo-latest-text]", latest);
  row.queries.set("[data-todo-latest-status]", latestStatus);
  row.queries.set('[data-todo-op="use-latest"]', useLatest);
  row.queries.set('[data-todo-op="keep-draft"]', keepDraft);
  row.queries.set("[data-todo-deleted-notice]", deletedNotice);
  row.queries.set("[data-todo-deleted-actions]", deletedActions);
  row.queries.set("[data-todo-readd-confirm]", readdConfirm);
  deletedActions.append(discardDeleted, readdDeleted); readdConfirm.append(replaceAddDraft, keepAddDraft);
  conflict.append(latest); conflict.append(latestStatus); conflict.append(useLatest); conflict.append(keepDraft);
  row.append(textarea); row.append(status); row.append(save); row.append(remove); row.append(conflict); row.append(deletedNotice); row.append(deletedActions); row.append(readdConfirm);
  list.append(row);
  const addText = new FakeElement("textarea");
  const addButton = new FakeElement("button");
  const addConflict = new FakeElement("div"); addConflict.hidden = true;
  const addLatest = new FakeElement("p");
  const useLatestAdd = new FakeElement("button");
  const keepDraftAdd = new FakeElement("button");
  useLatestAdd.dataset.todoOp = "use-latest-add"; keepDraftAdd.dataset.todoOp = "keep-draft-add";
  addConflict.append(addLatest, useLatestAdd, keepDraftAdd);
  addButton.dataset.todoOp = "add";
  panel.queries.set("[data-todo-summary]", summary);
  panel.queries.set("[data-todo-summary-count]", summary);
  panel.queries.set("[data-todo-status]", notice);
  panel.queries.set("[data-todo-status-message]", notice);
  panel.queries.set("[data-todo-updated]", new FakeElement("time"));
  panel.queries.set("[data-todo-enforcement-state]", new FakeElement("span"));
  panel.queries.set("[data-todo-enforcement]", new FakeElement("button"));
  panel.queries.set("[data-todo-items]", list);
  panel.queries.set("[data-todo-add-text]", addText);
  panel.queries.set("[data-todo-add-conflict]", addConflict);
  panel.queries.set("[data-todo-add-latest]", addLatest);
  panel.queries.set('[data-todo-op="use-latest-add"]', useLatestAdd);
  panel.queries.set('[data-todo-op="keep-draft-add"]', keepDraftAdd);
  panel.queries.set('[data-todo-op="add"]', addButton);
  panel.append(summary); panel.append(notice); panel.append(list); panel.append(addText); panel.append(addButton); panel.append(addConflict);
  return { panel, summary, notice, list, row, textarea, status, save, remove, conflict, latest, useLatest, keepDraft, addText, addButton, addConflict, addLatest, useLatestAdd, keepDraftAdd, discardDeleted, readdDeleted, readdConfirm, replaceAddDraft, keepAddDraft };
}

async function settle() { await new Promise((resolve) => setTimeout(resolve, 0)); }

function boot(fetchImpl: (url: string, init?: RequestInit) => Promise<ReturnType<typeof response>>, initialItems: ConsoleLogItem[] = [], extras: Record<string, FakeElement> = {}, sessionId = "", options: { clock?: FakeClock; hidden?: boolean; selection?: { anchorNode: FakeElement; focusNode: FakeElement; anchorOffset: number; focusOffset: number; isCollapsed: boolean; toString: () => string; getRangeAt?: (index: number) => { intersectsNode?: (node: FakeElement) => boolean }; setBaseAndExtent?: (...args: unknown[]) => void; collapse?: (node: FakeElement, offset: number) => void; extend?: (node: FakeElement, offset: number) => void; removeAllRanges: () => void; addRange: (...args: unknown[]) => void } } = {}) {
  FakeEventSource.instances = [];
  FakeElement.activeElement = null;
  const root = new FakeElement(); root.dataset = { sessionId, newestCursor: initialItems[0]?.cursor ?? "c0", oldestCursor: initialItems.at(-1)?.cursor ?? "c-older", hasMoreOlder: String(initialItems.length > 0), initialItems: JSON.stringify(initialItems) };
  const status = new FakeElement();
  const newest = new FakeElement(); newest.hidden = true;
  const older = new FakeElement(); older.hidden = true;
  const elements = new Map<string, FakeElement>([["log-console", root], ["log-status", status], ["log-new-button", newest], ["log-older-button", older], ...Object.entries(extras)]);
  const scrollY = 0; let scrollCalls = 0; const scrollTargets: number[] = [];
  const windowListeners = new Map<string, (event?: unknown) => void>();
  const clock = options.clock ?? new FakeClock();
  const windowStub = { scrollY, scrollX: 0, innerHeight: 600, addEventListener: (name: string, listener: (event?: unknown) => void) => windowListeners.set(name, listener), setInterval: clock.setInterval, clearInterval: clock.clearInterval, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, scrollTo: (_x: number, y: number) => { scrollCalls += 1; scrollTargets.push(y); }, scrollBy: (_x: number, y: number) => { scrollCalls += 1; scrollTargets.push(y); }, getSelection: () => options.selection ?? ({ toString: () => "", isCollapsed: true }) };
  const documentListeners = new Map<string, (event?: unknown) => void>();
  const createTreeWalker = (rootNode: FakeElement) => { const nodes: FakeElement[] = []; const visit = (element: FakeElement) => { if (element.textContent && element.children.length === 0) { const textNode = new FakeElement("#text"); textNode.textContent = element.textContent; textNode.parentElement = element; nodes.push(textNode); } for (const child of element.children) visit(child); }; visit(rootNode); let index = 0; return { nextNode: () => nodes[index++] ?? null }; };
  const createRange = () => { let startNode: FakeElement | null = null; let startOffset = 0; let endNode: FakeElement | null = null; let endOffset = 0; const compare = (left: FakeElement | null, leftOffset: number, right: FakeElement | null, rightOffset: number) => { if (!left || !right) return 0; const leftRow = left.closest<FakeElement>("tr[data-session-id]"); const rightRow = right.closest<FakeElement>("tr[data-session-id]"); const rowOrder = (leftRow?.dataset.sessionId ?? "").localeCompare(rightRow?.dataset.sessionId ?? ""); if (rowOrder) return rowOrder; const leftCell = left.closest<FakeElement>("td"); const rightCell = right.closest<FakeElement>("td"); const cellOrder = (leftRow?.cells.indexOf(leftCell!) ?? 0) - (rightRow?.cells.indexOf(rightCell!) ?? 0); return cellOrder || leftOffset - rightOffset; }; const range = { selectNodeContents: () => undefined, setEnd: (node: FakeElement, at: number) => { endNode = node; endOffset = at; }, setStart: (node: FakeElement, at: number) => { startNode = node; startOffset = at; }, collapse: () => { endNode = startNode; endOffset = startOffset; }, compareBoundaryPoints: (_how: number, other: typeof range) => compare(startNode, startOffset, other.startContainer, other.startOffset), get startContainer() { return startNode; }, get startOffset() { return startOffset; }, get endContainer() { return endNode; }, get endOffset() { return endOffset; }, toString: () => "x".repeat(endOffset) }; return range as unknown as Range; };
  const documentStub = { hidden: options.hidden ?? false, get activeElement() { return FakeElement.activeElement; }, getElementById: (id: string) => elements.get(id) ?? null, querySelectorAll: (selector: string) => [...elements.values()].flatMap((element) => element.querySelectorAll(selector)), createElement: (tagName: string) => new FakeElement(tagName), createRange, createTreeWalker, addEventListener: (name: string, listener: (event?: unknown) => void) => documentListeners.set(name, listener), documentElement: { scrollHeight: 1200 } };
  const ClockDate = class extends Date { constructor(value?: string | number) { super(value ?? clock.now); } static now() { return clock.now; } };
  runInNewContext(userConsoleClientScript, { document: documentStub, window: windowStub, fetch: fetchImpl, EventSource: FakeEventSource, URL, URLSearchParams, encodeURIComponent, Element: FakeElement, Date: ClockDate, AbortController, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const emptyTimers = new Map<number, { callback: () => void; delay: number }>();
  const emptyTimeouts = new Map<number, { due: number; callback: () => void }>();
  return { root, status, newest, older, windowStub, documentStub, documentListeners, windowListeners, intervals: clock.intervals, timeouts: clock.timers, tickIntervals: () => { for (const timer of [...clock.intervals.values()]) timer.callback(); }, tickInterval: (delay: number) => { for (const timer of [...clock.intervals.values()]) if (timer.delay === delay) timer.callback(); }, advanceTime: async (milliseconds: number) => clock.advance(milliseconds), setNow: (value: number) => { clock.now = value; }, get scrollCalls() { return scrollCalls; }, scrollTargets, sources: FakeEventSource.instances };
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

test("a successful detail refresh fetches Todo when the log page has no new rows", async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  let releaseTodo!: (value: ReturnType<typeof response>) => void;
  const fixture = todoFixture();
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const request = { url: new URL(url, "http://local.test"), init };
    calls.push(request);
    if (request.url.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-01T00:00:00Z" });
    if (request.url.pathname === "/api/logs") return response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false });
    if (request.url.pathname === "/api/sessions/todo-session/todo") return await new Promise<ReturnType<typeof response>>((resolve) => { releaseTodo = resolve; });
    throw new Error("unexpected request " + request.url.href);
  };
  const ui = boot(fetchImpl, [], { "session-todo": fixture.panel }, "todo-session");
  await settle();
  ui.newest.click();
  await settle();
  await settle();
  const todoRead = calls.find((request) => request.url.pathname === "/api/sessions/todo-session/todo");
  assert.ok(todoRead, "manual detail refresh reads the Todo even if the log response is empty");
  assert.equal(todoRead.init?.credentials, "same-origin");
  releaseTodo(response(200, { session_id: "todo-session", version: 2, items: [], total: 0, completed: 0, last_updated_at: "2026-10-01T00:00:01Z", enforcement_enabled: true }));
  await settle();
  assert.equal(fixture.panel.dataset.version, "2");
});

test("typing made while a Todo PUT is pending survives its successful response", async () => {
  const fixture = todoFixture();
  let release!: (value: ReturnType<typeof response>) => void;
  let request: { url: URL; init?: RequestInit } | undefined;
  const ui = boot(async (url, init) => {
    const parsed = new URL(url, "http://local.test");
    if (parsed.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-01T00:00:00Z" });
    if (parsed.pathname === "/api/sessions/todo-session/todo" && init?.method === "PUT") {
      request = { url: parsed, init };
      return await new Promise<ReturnType<typeof response>>((resolve) => { release = resolve; });
    }
    throw new Error("unexpected request " + parsed.href);
  }, [], { "session-todo": fixture.panel }, "todo-session");
  await settle();
  fixture.save.click();
  await settle();
  assert.equal(request?.init?.method, "PUT");
  assert.deepEqual(JSON.parse(String(request?.init?.body)), { expected_version: 1, changes: [{ op: "edit", id: "todo-1", text: "server text" }, { op: "status", id: "todo-1", status: "not_started" }] });
  fixture.textarea.value = "typed after pressing update";
  fixture.textarea.listeners.get("input")?.({ target: fixture.textarea });
  release(response(200, { session_id: "todo-session", version: 2, items: [{ id: "todo-1", text: "server text", status: "not_started", order: 0 }], total: 1, completed: 0, last_updated_at: "2026-10-01T00:00:01Z", enforcement_enabled: true }));
  await settle();
  assert.equal(fixture.textarea.value, "typed after pressing update");
  assert.equal(fixture.panel.dataset.version, "2");
});

test("adding and deleting a Todo use versioned JSON updates and reconcile the visible list", async () => {
  const fixture = todoFixture();
  fixture.addText.value = "new task";
  const requests: Array<{ body: { expected_version: number; changes: Array<{ op: string }> } }> = [];
  let version = 1;
  let items: Array<{ id: string; text: string; status: string }> = [{ id: "todo-1", text: "server text", status: "not_started" }];
  const ui = boot(async (url, init) => {
    const parsed = new URL(url, "http://local.test");
    if (parsed.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-01T00:00:00Z" });
    if (parsed.pathname.endsWith("/todo") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { expected_version: number; changes: Array<{ op: string; id?: string; text?: string }> };
      requests.push({ body });
      if (body.changes[0]?.op === "add") items = [...items, { id: "todo-2", text: body.changes[0].text ?? "", status: "not_started" }];
      else items = items.filter((item) => item.id !== body.changes[0]?.id);
      version += 1;
      return response(200, { session_id: "todo-session", version, items, total: items.length, completed: 0, last_updated_at: "2026-10-01T00:00:01Z", enforcement_enabled: true });
    }
    throw new Error("unexpected request " + parsed.href);
  }, [], { "session-todo": fixture.panel }, "todo-session");
  await settle();
  fixture.addButton.click();
  await settle();
  assert.equal(requests[0]?.body.expected_version, 1);
  assert.equal(requests[0]?.body.changes[0]?.op, "add");
  const added = fixture.list.querySelectorAll<FakeElement>("li[data-todo-id]").find((row) => row.dataset.todoId === "todo-2");
  assert.ok(added);
  added.querySelector<FakeElement>('[data-todo-op="delete"]')?.click();
  await settle();
  assert.equal(requests[1]?.body.expected_version, 2);
  assert.equal(requests[1]?.body.changes[0]?.op, "delete");
  assert.equal(fixture.list.querySelectorAll("li[data-todo-id]").some((row) => row.dataset.todoId === "todo-2"), false);
  void ui;
});

test("Todo version conflicts preserve drafts until the user chooses how to continue", async () => {
  const fixture = todoFixture(); fixture.textarea.value = "my draft";
  let requests = 0;
  const ui = boot(async (url, init) => {
    const parsed = new URL(url, "http://local.test");
    if (parsed.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-01T00:00:00Z" });
    if (parsed.pathname.endsWith("/todo") && init?.method === "PUT") { requests += 1; return response(409, { version: 2, items: [{ id: "todo-1", text: "latest server value", status: "in_progress" }], total: 1, completed: 0, conflict: true }); }
    throw new Error("unexpected request " + parsed.href);
  }, [], { "session-todo": fixture.panel }, "todo-session");
  await settle(); fixture.save.click(); await settle();
  assert.equal(fixture.textarea.value, "my draft");
  assert.equal(fixture.panel.dataset.version, "2", "global server version can advance while the dirty row keeps its old base");
  assert.equal(fixture.conflict.hidden, false);
  fixture.keepDraft.click();
  assert.equal(fixture.panel.dataset.version, "2");
  assert.equal(fixture.textarea.value, "my draft");
  assert.equal(fixture.status.value, "in_progress");
  assert.equal(requests, 1, "conflict recovery does not resubmit automatically");
  void ui;
});

test("a refresh keeps dirty text as a deleted draft instead of restoring a removed item", async () => {
  const fixture = todoFixture(); fixture.textarea.value = "unsaved work";
  const ui = boot(async (url) => {
    const parsed = new URL(url, "http://local.test");
    if (parsed.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-01T00:00:00Z" });
    if (parsed.pathname === "/api/logs") return response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false });
    if (parsed.pathname.endsWith("/todo")) return response(200, { version: 2, items: [], total: 0, completed: 0 });
    throw new Error("unexpected request " + parsed.href);
  }, [], { "session-todo": fixture.panel }, "todo-session");
  await settle(); ui.newest.click(); await settle(); await settle(); await settle();
  assert.equal(fixture.panel.dataset.version, "2", "successful log refresh also requests the Todo snapshot");
  assert.equal(fixture.row.dataset.deletedDraft, "true");
  assert.equal(fixture.textarea.value, "unsaved work");
  assert.equal(fixture.save.disabled, true);
  void ui;
});

test("authentication expiry during a Todo refresh disables further Todo actions", async () => {
  const fixture = todoFixture();
  const ui = boot(async (url) => {
    const parsed = new URL(url, "http://local.test");
    if (parsed.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-01T00:00:00Z" });
    if (parsed.pathname === "/api/logs") return response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false });
    if (parsed.pathname.endsWith("/todo")) return response(401, {});
    throw new Error("unexpected request " + parsed.href);
  }, [], { "session-todo": fixture.panel }, "todo-session");
  ui.newest.click(); await settle(); await settle();
  assert.equal(fixture.save.disabled, true);
  assert.equal(fixture.addButton.disabled, true);
  assert.equal(ui.newest.disabled, true);
});

test("remote Todo refresh keeps the original dirty baseline until explicit conflict resolution", async () => {
  const fixture = todoFixture(); fixture.textarea.value = "local B";
  const requests: Array<{ expected_version: number; changes: Array<{ text?: string }> }> = [];
  const ui = boot(async (url, init) => {
    const parsed = new URL(url, "http://local.test");
    if (parsed.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-01T00:00:00Z" });
    if (parsed.pathname === "/api/logs") return response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false });
    if (parsed.pathname.endsWith("/todo") && init?.method === "PUT") { requests.push(JSON.parse(String(init.body)) as typeof requests[number]); return response(200, { version: 3, items: [{ id: "todo-1", text: "local B", status: "not_started" }], total: 1, completed: 0, last_updated_at: "t3", enforcement_enabled: true }); }
    if (parsed.pathname.endsWith("/todo")) return response(200, { version: 2, items: [{ id: "todo-1", text: "remote C", status: "in_progress" }], total: 1, completed: 0, last_updated_at: "t2", enforcement_enabled: true });
    throw new Error("unexpected request " + parsed.href);
  }, [], { "session-todo": fixture.panel }, "todo-session");
  fixture.textarea.listeners.get("input")?.({ target: fixture.textarea });
  ui.newest.click(); await settle(); await settle();
  assert.equal(fixture.panel.dataset.version, "2");
  assert.equal(fixture.row.dataset.baseText, "server text", "GET must not silently rebase a dirty draft");
  assert.equal(fixture.textarea.value, "local B");
  assert.equal(fixture.save.disabled, true, "stale dirty row cannot submit before a choice");
  fixture.keepDraft.click();
  assert.equal(fixture.row.dataset.baseText, "remote C");
  assert.equal(fixture.textarea.value, "local B");
  assert.equal(fixture.save.disabled, false);
  fixture.save.click(); await settle();
  assert.equal(requests[0]?.expected_version, 2);
  assert.equal(requests[0]?.changes[0]?.text, "local B");
});

test("typing back to the old value while a Todo save is pending survives the response", async () => {
  const fixture = todoFixture();
  let release!: (value: ReturnType<typeof response>) => void;
  const bodies: Array<{ expected_version: number; changes: Array<{ text?: string }> }> = [];
  const ui = boot(async (url, init) => {
    const parsed = new URL(url, "http://local.test");
    if (parsed.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-01T00:00:00Z" });
    if (parsed.pathname.endsWith("/todo") && init?.method === "PUT") { bodies.push(JSON.parse(String(init.body)) as typeof bodies[number]); return await new Promise<ReturnType<typeof response>>((resolve) => { release = resolve; }); }
    throw new Error("unexpected request " + parsed.href);
  }, [], { "session-todo": fixture.panel }, "todo-session");
  fixture.textarea.value = "B"; fixture.textarea.listeners.get("input")?.({ target: fixture.textarea }); fixture.save.click(); await settle();
  fixture.textarea.value = "server text"; fixture.textarea.listeners.get("input")?.({ target: fixture.textarea });
  fixture.status.value = "in_progress"; fixture.status.listeners.get("change")?.({ target: fixture.status }); fixture.status.value = "not_started"; fixture.status.listeners.get("change")?.({ target: fixture.status });
  release(response(200, { version: 2, items: [{ id: "todo-1", text: "B", status: "in_progress" }], total: 1, completed: 0, last_updated_at: "t2", enforcement_enabled: true }));
  await settle();
  assert.equal(fixture.textarea.value, "server text");
  assert.equal(fixture.row.dataset.baseText, "B");
  assert.equal(fixture.status.value, "not_started");
  assert.equal(fixture.row.dataset.baseStatus, "in_progress");
  assert.equal(fixture.save.disabled, false);
  fixture.save.click(); await settle();
  assert.equal(bodies[1]?.expected_version, 2);
  assert.equal(bodies[1]?.changes[0]?.text, "server text");
  void ui;
});

test("a dynamically rendered row has its own latest-value conflict controls", async () => {
  const fixture = todoFixture(); let puts = 0;
  const ui = boot(async (url, init) => {
    const parsed = new URL(url, "http://local.test");
    if (parsed.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-01T00:00:00Z" });
    if (parsed.pathname.endsWith("/todo") && init?.method === "PUT") {
      puts += 1;
      return puts === 1
        ? response(409, { version: 2, items: [{ id: "todo-1", text: "server text", status: "not_started" }, { id: "todo-2", text: "from other client", status: "in_progress" }], total: 2, completed: 0, last_updated_at: "t2", enforcement_enabled: true })
        : response(409, { version: 3, items: [{ id: "todo-1", text: "server text", status: "not_started" }, { id: "todo-2", text: "latest row text", status: "completed" }], total: 2, completed: 1, last_updated_at: "t3", enforcement_enabled: true });
    }
    throw new Error("unexpected request " + parsed.href);
  }, [], { "session-todo": fixture.panel }, "todo-session");
  fixture.save.click(); await settle();
  const newRow = fixture.list.querySelectorAll<FakeElement>("li[data-todo-id]").find((row) => row.dataset.todoId === "todo-2"); assert.ok(newRow);
  assert.equal(newRow.querySelector<FakeElement>("[data-todo-text]")?.rows, 2);
  assert.notEqual(newRow.querySelector<FakeElement>("[data-todo-text]")?.style.height, "");
  assert.equal(newRow.querySelector<FakeElement>("[data-todo-conflict]")?.hidden, true);
  newRow.querySelector<FakeElement>('[data-todo-op="save"]')?.click(); await settle();
  const latestText = newRow.querySelector<FakeElement>("[data-todo-latest-text]");
  assert.equal(newRow.querySelector<FakeElement>("[data-todo-conflict]")?.hidden, false);
  assert.equal(latestText?.textContent, "latest row text");
  newRow.querySelector<FakeElement>('[data-todo-op="keep-draft"]')?.click();
  assert.equal(newRow.dataset.baseText, "latest row text");
  assert.equal(newRow.querySelector<FakeElement>('[data-todo-op="save"]')?.disabled, false);
  void ui;
});

test("an add conflict keeps its independent draft and requires an explicit retry", async () => {
  const fixture = todoFixture(); fixture.addText.value = "new local task";
  const requests: Array<{ expected_version: number; changes: Array<{ text?: string }> }> = [];
  const ui = boot(async (url, init) => {
    const parsed = new URL(url, "http://local.test");
    if (parsed.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-01T00:00:00Z" });
    if (parsed.pathname.endsWith("/todo") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as typeof requests[number]; requests.push(body);
      return requests.length === 1 ? response(409, { version: 2, items: [{ id: "todo-1", text: "remote", status: "completed" }], total: 1, completed: 1, last_updated_at: "t2", enforcement_enabled: true }) : response(200, { version: 3, items: [{ id: "todo-1", text: "remote", status: "completed" }, { id: "todo-2", text: "new local task", status: "not_started" }], total: 2, completed: 1, last_updated_at: "t3", enforcement_enabled: true });
    }
    throw new Error("unexpected request " + parsed.href);
  }, [], { "session-todo": fixture.panel }, "todo-session");
  fixture.addText.listeners.get("input")?.({ target: fixture.addText }); fixture.addButton.click(); await settle();
  assert.equal(fixture.panel.dataset.version, "2");
  assert.equal(fixture.addText.value, "new local task");
  assert.equal(fixture.addConflict.hidden, false);
  assert.equal(fixture.addButton.disabled, true);
  fixture.keepDraftAdd.click();
  assert.equal(fixture.addText.value, "new local task");
  assert.equal(fixture.addButton.disabled, false);
  assert.equal(requests.length, 1, "conflict resolution does not replay the add request");
  fixture.addButton.click(); await settle();
  assert.equal(requests[1]?.expected_version, 2);
  void ui;
});

test("an add conflict blocks only add retries and does not disable other rows", async () => {
  const fixture = todoFixture(); fixture.addText.value = "draft to add";
  let puts = 0; const rowOperations: string[] = [];
  const ui = boot(async (url, init) => {
    const parsed = new URL(url, "http://local.test");
    if (parsed.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-01T00:00:00Z" });
    if (parsed.pathname.endsWith("/todo") && init?.method === "PUT") {
      puts += 1;
      const body = JSON.parse(String(init.body)) as { changes: Array<{ op: string }> };
      if (puts > 1) rowOperations.push(body.changes[0]!.op);
      if (puts === 1) return response(409, { version: 2, items: [{ id: "todo-1", text: "server text", status: "not_started" }], total: 1, completed: 0, conflict: true });
      if (puts === 2) return response(200, { version: 3, items: [{ id: "todo-1", text: "edited existing row", status: "not_started" }], total: 1, completed: 0 });
      return response(200, { version: 4, items: [], total: 0, completed: 0 });
    }
    throw new Error("unexpected request " + parsed.href);
  }, [], { "session-todo": fixture.panel }, "todo-session");
  fixture.addText.listeners.get("input")?.({ target: fixture.addText }); fixture.addButton.click(); await settle();
  assert.equal(fixture.addButton.disabled, true);
  assert.equal(fixture.save.disabled, false, "row controls are independent of an add-field conflict");
  fixture.textarea.value = "edited existing row";
  fixture.textarea.listeners.get("input")?.({ target: fixture.textarea });
  fixture.save.click(); await settle();
  fixture.remove.click(); await settle();
  assert.equal(puts, 3, "non-conflicting existing row can still be saved and deleted");
  assert.deepEqual(rowOperations, ["edit", "delete"]);
  assert.equal(fixture.panel.dataset.version, "4");
  void ui;
});

test("Todo snapshots reorder rows and refresh summary, timestamp, and enforcement state at the same version", async () => {
  const fixture = todoFixture();
  const updated = new FakeElement("time"); const enforcementText = new FakeElement("span"); const enforcementButton = new FakeElement("button");
  fixture.panel.queries.set("[data-todo-updated]", updated); fixture.panel.queries.set("[data-todo-enforcement-state]", enforcementText); fixture.panel.queries.set("[data-todo-enforcement]", enforcementButton);
  const ui = boot(async (url) => {
    const parsed = new URL(url, "http://local.test");
    if (parsed.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-01T00:00:00Z" });
    if (parsed.pathname === "/api/logs") return response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false });
    if (parsed.pathname.endsWith("/todo")) return response(200, { version: 1, items: [{ id: "todo-2", text: "second", status: "completed", order: 0 }, { id: "todo-1", text: "server text", status: "not_started", order: 1 }], total: 2, completed: 1, last_updated_at: "2026-10-01T00:00:00Z", enforcement_enabled: false });
    throw new Error("unexpected request " + parsed.href);
  }, [], { "session-todo": fixture.panel }, "todo-session");
  ui.newest.click(); await settle(); await settle();
  assert.deepEqual(fixture.list.querySelectorAll<FakeElement>("li[data-todo-id]").map((row) => row.dataset.todoId), ["todo-2", "todo-1"]);
  assert.equal(fixture.summary.textContent, "進捗: 1 / 2");
  assert.notEqual(updated.textContent, "");
  assert.equal(enforcementText.textContent, "無効");
  assert.equal(enforcementButton.value, "true");
});

test("Todo snapshot reordering preserves focused textarea selection on a moved row", async () => {
  const fixture = todoFixture();
  const second = new FakeElement("li"); second.dataset = { todoId: "todo-2", baseText: "second", baseStatus: "not_started", baseVersion: "1" };
  const secondText = new FakeElement("textarea"); secondText.value = "second"; secondText.dataset.todoText = "true"; second.queries.set("[data-todo-text]", secondText); second.append(secondText); fixture.list.append(second);
  const third = new FakeElement("li"); third.dataset = { todoId: "todo-3", baseText: "third", baseStatus: "not_started", baseVersion: "1" };
  const thirdText = new FakeElement("textarea"); thirdText.value = "third"; thirdText.dataset.todoText = "true"; third.queries.set("[data-todo-text]", thirdText); third.append(thirdText); fixture.list.append(third);
  secondText.setSelectionRange(2, 5, "backward");
  const ui = boot(async (url) => {
    const parsed = new URL(url, "http://local.test");
    if (parsed.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-01T00:00:00Z" });
    if (parsed.pathname === "/api/logs") return response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false });
    if (parsed.pathname.endsWith("/todo")) return response(200, { version: 2, items: [{ id: "todo-3", text: "third", status: "not_started", order: 0 }, { id: "todo-2", text: "second", status: "not_started", order: 1 }, { id: "todo-1", text: "server text", status: "not_started", order: 2 }], total: 3, completed: 0 });
    throw new Error("unexpected request " + parsed.href);
  }, [], { "session-todo": fixture.panel }, "todo-session");
  secondText.focus();
  ui.newest.click(); await settle(); await settle();
  assert.deepEqual(fixture.list.querySelectorAll<FakeElement>("li[data-todo-id]").map((row) => row.dataset.todoId), ["todo-3", "todo-2", "todo-1"]);
  assert.equal(FakeElement.activeElement, secondText, "a middle row may be moved during reorder even when its final index is unchanged");
  assert.equal(secondText.selectionStart, 2);
  assert.equal(secondText.selectionEnd, 5);
  assert.equal(secondText.selectionDirection, "backward");
  assert.equal(secondText.focusOptions?.preventScroll, true);
  void ui;
});

test("a successful 409 log resync still refreshes Todo exactly once", async () => {
  const fixture = todoFixture(); let todoReads = 0;
  const ui = boot(async (url) => {
    const parsed = new URL(url, "http://local.test");
    if (parsed.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-01T00:00:00Z" });
    if (parsed.pathname === "/api/logs" && parsed.searchParams.has("after")) return response(409, {});
    if (parsed.pathname === "/api/logs") return response(200, { items: [], newestCursor: "c1", oldestCursor: "c1", hasMoreOlder: false, hasMoreNewer: false });
    if (parsed.pathname.endsWith("/todo")) { todoReads += 1; return response(200, { session_id: "todo-session", version: 2, items: [], total: 0, completed: 0, enforcement_enabled: false }); }
    throw new Error("unexpected request " + parsed.href);
  }, [], { "session-todo": fixture.panel }, "todo-session");
  ui.newest.click(); await settle(); await settle(); await settle();
  assert.equal(todoReads, 1);
  assert.equal(fixture.panel.dataset.version, "2");
});

test("a Todo 404 ends session reads while preserving rendered values", async () => {
  const fixture = todoFixture(); let todoReads = 0;
  const ui = boot(async (url) => {
    const parsed = new URL(url, "http://local.test");
    if (parsed.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-01T00:00:00Z" });
    if (parsed.pathname === "/api/logs") return response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false });
    if (parsed.pathname.endsWith("/todo")) { todoReads += 1; return response(404, {}); }
    throw new Error("unexpected request " + parsed.href);
  }, [], { "session-todo": fixture.panel }, "todo-session");
  ui.newest.click(); await settle(); await settle();
  assert.equal(fixture.textarea.value, "server text");
  assert.equal(fixture.save.disabled, true);
  ui.newest.click(); await settle(); await settle();
  assert.equal(todoReads, 1);
});

test("late Todo JSON after page departure and BFCache return cannot update the detail", async () => {
  const fixture = todoFixture(); let finishJson!: (value: unknown) => void;
  const ui = boot(async (url) => {
    const parsed = new URL(url, "http://local.test");
    if (parsed.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-01T00:00:00Z" });
    if (parsed.pathname === "/api/logs") return response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false });
    if (parsed.pathname.endsWith("/todo")) return { status: 200, ok: true, json: async () => await new Promise((resolve) => { finishJson = resolve; }) } as ReturnType<typeof response>;
    throw new Error("unexpected request " + parsed.href);
  }, [], { "session-todo": fixture.panel }, "todo-session");
  ui.newest.click(); await settle(); await settle();
  ui.windowListeners.get("pagehide")?.();
  ui.windowListeners.get("pageshow")?.({ persisted: true });
  finishJson({ version: 2, items: [], total: 0, completed: 0, enforcement_enabled: false });
  await settle(); await settle();
  assert.equal(fixture.panel.dataset.version, "1");
  assert.equal(fixture.textarea.value, "server text");
  assert.equal(ui.newest.disabled, false);
});

test("late Todo mutation JSON after page departure cannot repaint, and BFCache return restores controls", async () => {
  const fixture = todoFixture(); let finishJson!: (value: unknown) => void;
  const ui = boot(async (url, init) => {
    const parsed = new URL(url, "http://local.test");
    if (parsed.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-01T00:00:00Z" });
    if (parsed.pathname.endsWith("/todo") && init?.method === "PUT") return { status: 200, ok: true, json: async () => await new Promise((resolve) => { finishJson = resolve; }) } as ReturnType<typeof response>;
    throw new Error("unexpected request " + parsed.href);
  }, [], { "session-todo": fixture.panel }, "todo-session");
  fixture.save.click(); await settle();
  ui.windowListeners.get("pagehide")?.(); ui.windowListeners.get("pageshow")?.({ persisted: true });
  finishJson({ version: 2, items: [{ id: "todo-1", text: "stale response", status: "completed" }], total: 1, completed: 1 });
  await settle(); await settle();
  assert.equal(fixture.panel.dataset.version, "1");
  assert.equal(fixture.textarea.value, "server text");
  assert.equal(fixture.save.disabled, false);
});

test("a deleted draft stays disabled after a concurrent save settles and preserves add input", async () => {
  const fixture = todoFixture(); fixture.textarea.value = "unsaved row"; fixture.addText.value = "keep this add draft";
  let release!: (value: ReturnType<typeof response>) => void;
  const ui = boot(async (url, init) => {
    const parsed = new URL(url, "http://local.test");
    if (parsed.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-01T00:00:00Z" });
    if (parsed.pathname === "/api/logs") return response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false });
    if (parsed.pathname.endsWith("/todo") && init?.method === "PUT") return await new Promise<ReturnType<typeof response>>((resolve) => { release = resolve; });
    if (parsed.pathname.endsWith("/todo")) return response(200, { version: 2, items: [], total: 0, completed: 0 });
    throw new Error("unexpected request " + parsed.href);
  }, [], { "session-todo": fixture.panel }, "todo-session");
  fixture.textarea.listeners.get("input")?.({ target: fixture.textarea }); fixture.save.click(); await settle();
  ui.newest.click(); await settle(); await settle();
  assert.equal(fixture.row.dataset.deletedDraft, "true");
  release(response(409, { version: 2, items: [], total: 0, completed: 0, conflict: true })); await settle();
  assert.equal(fixture.save.disabled, true);
  fixture.readdDeleted.click();
  assert.equal(fixture.addText.value, "keep this add draft");
  assert.equal(fixture.row.parentElement !== null, true, "collision requires explicit replace-or-keep choice");
  assert.equal(fixture.readdConfirm.hidden, false);
  assert.equal(fixture.replaceAddDraft.disabled, false, "deleted-draft replacement choice is enabled");
  assert.equal(fixture.keepAddDraft.disabled, false, "deleted-draft preservation choice is enabled");
  fixture.keepAddDraft.click();
  assert.equal(fixture.addText.value, "keep this add draft");
  assert.equal(fixture.readdConfirm.hidden, true, "keep choice is dispatched by the button");
});

test("a delayed stale row 409 cannot replace or resolve a newer snapshot", async () => {
  const fixture = todoFixture(); fixture.textarea.value = "local draft";
  let finishJson!: (value: unknown) => void;
  const requests: Array<{ expected_version: number; changes: Array<{ text?: string }> }> = [];
  const ui = boot(async (url, init) => {
    const parsed = new URL(url, "http://local.test");
    if (parsed.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-01T00:00:00Z" });
    if (parsed.pathname === "/api/logs") return response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false });
    if (parsed.pathname.endsWith("/todo") && init?.method === "PUT") {
      requests.push(JSON.parse(String(init.body)) as typeof requests[number]);
      return { status: 409, ok: false, json: async () => await new Promise((resolve) => { finishJson = resolve; }) } as ReturnType<typeof response>;
    }
    if (parsed.pathname.endsWith("/todo")) return response(200, { version: 3, items: [{ id: "todo-1", text: "newer server value", status: "completed" }], total: 1, completed: 1, last_updated_at: "t3" });
    throw new Error("unexpected request " + parsed.href);
  }, [], { "session-todo": fixture.panel }, "todo-session");
  fixture.textarea.listeners.get("input")?.({ target: fixture.textarea }); fixture.save.click(); await settle();
  ui.newest.click(); await settle(); await settle();
  assert.equal(fixture.panel.dataset.version, "3");
  finishJson({ version: 2, items: [{ id: "todo-1", text: "old 409 value", status: "in_progress" }], total: 1, completed: 0, conflict: true }); await settle();
  assert.equal(fixture.panel.dataset.version, "3");
  assert.equal(fixture.latest.textContent, "newer server value");
  fixture.keepDraft.click();
  assert.equal(fixture.panel.dataset.version, "3", "resolving a stale conflict cannot roll back the current version");
  assert.equal(fixture.row.dataset.baseText, "newer server value");
  fixture.save.click(); await settle();
  assert.equal(requests[1]?.expected_version, 3);
  void ui;
});

test("a delayed stale add 409 cannot replace the newer full snapshot", async () => {
  const fixture = todoFixture(); fixture.addText.value = "local add draft";
  let finishJson!: (value: unknown) => void;
  const ui = boot(async (url, init) => {
    const parsed = new URL(url, "http://local.test");
    if (parsed.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-01T00:00:00Z" });
    if (parsed.pathname === "/api/logs") return response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false });
    if (parsed.pathname.endsWith("/todo") && init?.method === "PUT") return { status: 409, ok: false, json: async () => await new Promise((resolve) => { finishJson = resolve; }) } as ReturnType<typeof response>;
    if (parsed.pathname.endsWith("/todo")) return response(200, { version: 3, items: [{ id: "todo-1", text: "new row one", status: "not_started" }, { id: "todo-2", text: "new row two", status: "completed" }], total: 2, completed: 1 });
    throw new Error("unexpected request " + parsed.href);
  }, [], { "session-todo": fixture.panel }, "todo-session");
  fixture.addText.listeners.get("input")?.({ target: fixture.addText }); fixture.addButton.click(); await settle();
  ui.newest.click(); await settle(); await settle();
  assert.equal(fixture.panel.dataset.version, "3");
  finishJson({ version: 2, items: [{ id: "todo-1", text: "stale row one", status: "in_progress" }], total: 1, completed: 0, conflict: true }); await settle();
  fixture.keepDraftAdd.click();
  assert.equal(fixture.panel.dataset.version, "3");
  assert.deepEqual(fixture.list.querySelectorAll<FakeElement>("li[data-todo-id]").map((row) => row.dataset.todoId), ["todo-1", "todo-2"]);
  assert.equal(fixture.list.querySelectorAll<FakeElement>("li[data-todo-id]")[0]?.dataset.baseText, "new row one");
  assert.equal(fixture.addText.value, "local add draft");
  void ui;
});

test("removing the focused Todo row moves focus forward without scrolling", async () => {
  const fixture = todoFixture();
  const next = new FakeElement("li"); next.dataset = { todoId: "todo-2", baseText: "next", baseStatus: "not_started", baseVersion: "1" };
  const nextText = new FakeElement("textarea"); nextText.dataset.todoText = "true"; nextText.value = "next"; next.queries.set("[data-todo-text]", nextText); next.append(nextText); fixture.list.append(next);
  const ui = boot(async (url) => {
    const parsed = new URL(url, "http://local.test");
    if (parsed.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-01T00:00:00Z" });
    if (parsed.pathname === "/api/logs") return response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false });
    if (parsed.pathname.endsWith("/todo")) return response(200, { version: 2, items: [{ id: "todo-2", text: "next", status: "not_started", order: 0 }], total: 1, completed: 0 });
    throw new Error("unexpected request " + parsed.href);
  }, [], { "session-todo": fixture.panel }, "todo-session");
  fixture.textarea.focus(); ui.newest.click(); await settle(); await settle();
  assert.equal(FakeElement.activeElement, nextText);
  assert.equal(nextText.focusOptions?.preventScroll, true);
  assert.equal(ui.scrollTargets.at(-1), 0);
});

test("applied audit warnings are displayed without resending the Todo update", async () => {
  const fixture = todoFixture(); let requests = 0;
  const ui = boot(async (url, init) => {
    const parsed = new URL(url, "http://local.test");
    if (parsed.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-01T00:00:00Z" });
    if (parsed.pathname.endsWith("/todo") && init?.method === "PUT") { requests += 1; return response(200, { version: 2, items: [{ id: "todo-1", text: "server text", status: "not_started" }], total: 1, completed: 0, audit_warning: true, applied: true }); }
    throw new Error("unexpected request " + parsed.href);
  }, [], { "session-todo": fixture.panel }, "todo-session");
  fixture.save.click(); await settle();
  assert.match(fixture.notice.textContent, /適用済み/);
  assert.equal(requests, 1);
  void ui;
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

test("session timestamp disclosure, relative value, open state, and focus survive automatic state refresh", async () => {
  const rows = new FakeElement("tbody");
  const toggle = new FakeElement("input"); toggle.checked = true;
  const now = Date.parse("2026-10-02T02:00:00.000Z");
  const clock = new FakeClock(now);
  let stateCalls = 0;
  const ui = boot(async (url) => {
    const request = new URL(url, "http://local.test");
    if (request.pathname === "/api/console-state") {
      stateCalls += 1;
      return response(200, { ...emptyState, sessions: [{ session_id: "stable-session", created_at: "2026-10-02T01:59:01Z", last_used_at: "2026-09-20T00:00:00Z", state: "active", active: true }] });
    }
    return response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false });
  }, [], { "session-rows": rows, "auto-refresh": toggle }, "", { clock });
  await settle(); await settle();
  let details = rows.children[0]?.children[1]?.children[0];
  assert.equal(details?.tagName, "details");
  assert.equal(details?.open, false);
  assert.equal(details?.children[0]?.children[0]?.textContent, "59秒前");
  assert.match(details?.children[1]?.textContent ?? "", /JST/);

  const oldSummary = details?.children[0];
  assert.ok(oldSummary);
  details!.open = true;
  oldSummary.focus();
  ui.newest.click();
  await settle(); await settle(); await settle();
  details = rows.children[0]?.children[1]?.children[0];
  const newSummary = details?.children[0];
  assert.equal(stateCalls, 2);
  assert.notEqual(newSummary, oldSummary);
  assert.equal(details?.open, true, "the disclosure stays open across automatic refresh");
  assert.equal(FakeElement.activeElement, newSummary, "focus returns to the same timestamp disclosure");
  assert.equal(newSummary?.focusOptions?.preventScroll, true);
  await clock.advance(1_000);
  assert.equal(newSummary?.children[0]?.textContent, "1分前", "relative time updates in place without another state request");
  assert.equal(stateCalls, 2);
});

test("session-link-updated does not bypass a paused auto-refresh setting", async () => {
  const rows = new FakeElement("tbody");
  const toggle = new FakeElement("input"); toggle.checked = false;
  const calls: string[] = [];
  const ui = boot(async (url) => {
    calls.push(url);
    return response(200, {
      stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-03T00:00:00Z",
      sessions: [{ session_id: "paused-link", created_at: "2026-10-03T00:00:00Z", state: "active", active: true, external_url: "https://example.com/old", external_title: "Old title" }],
      running: [],
    });
  }, [], { "session-rows": rows, "auto-refresh": toggle });
  await settle();
  const initialStateCalls = calls.filter((url) => url.startsWith("/api/console-state")).length;
  ui.sources[0]!.dispatch("session-link-updated", JSON.stringify({ session_id: "paused-link" }));
  await settle();
  assert.equal(calls.filter((url) => url.startsWith("/api/console-state")).length, initialStateCalls);
  assert.equal(calls.some((url) => url.startsWith("/api/logs")), false);
  assert.equal(rows.children[0]?.children[7]?.children[0]?.textContent, "Old title");
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

test("process output refresh restores focus to the same session and process without scrolling", async () => {
  const sessionId = "focus-session";
  const processId = "focus-process";
  const at = "2026-10-02T00:00:00.000Z";
  const start = { id: "focus-start", cursor: "c0", event: { event: "process.start", at, sessionId, processId, comment: "focus purpose", command: "echo focus" } };
  const output = { id: "focus-output", cursor: "c1", event: { event: "process.output", at, sessionId, processId, output: "first" } };
  const processDetails = new FakeElement("section");
  const heading = new FakeElement("h2"); processDetails.append(heading);
  const initialBlock = new FakeElement("article"); initialBlock.className = "process-block";
  initialBlock.dataset.sessionId = sessionId; initialBlock.dataset.processId = processId;
  initialBlock.dataset.eventsJson = JSON.stringify([start.event, output.event]);
  const initialDetails = new FakeElement("details"); initialDetails.open = true;
  const initialSummary = new FakeElement("summary"); initialDetails.append(initialSummary); initialBlock.append(initialDetails); processDetails.append(initialBlock);
  const ui = boot(async (url) => {
    const request = new URL(url, "http://local.test");
    if (request.pathname === "/api/console-state") return response(200, { stopped: false, activeSessions: 1, runningProcesses: 1, updatedAt: at });
    if (request.searchParams.get("after") === "c1") return response(200, { items: [{ id: "focus-output-next", cursor: "c2", event: { event: "process.output", at, sessionId, processId, output: "second" } }], newestCursor: "c2", oldestCursor: "c2", hasMoreOlder: false, hasMoreNewer: false });
    if (!request.searchParams.has("after")) return response(200, { items: [{ id: "replacement-output", cursor: "c3", event: { event: "process.output", at, sessionId, processId: "other-process", output: "other output" } }], newestCursor: "c3", oldestCursor: "c3", hasMoreOlder: false, hasMoreNewer: false });
    throw new Error("unexpected request " + request.href);
  }, [output, start], { "process-details": processDetails }, sessionId);
  initialSummary.focus();
  ui.sources[0]!.dispatch("logs-available", JSON.stringify({ addedCount: 1, latestCursor: "c2", overflow: false }));
  ui.newest.click();
  await settle(); await settle();
  const updatedBlock = processDetails.children.find((child) => child.className === "process-block");
  assert.ok(updatedBlock);
  const updatedDetails = updatedBlock.querySelector<FakeElement>("details");
  const updatedSummary = updatedDetails?.children[0];
  assert.equal(updatedDetails?.open, true, "output disclosure remains open after refresh");
  assert.notEqual(updatedSummary, initialSummary);
  const activeElement = FakeElement.activeElement;
  const activeProcess = activeElement?.parent?.parent;
  assert.equal(activeElement === updatedSummary, true, "activeElement is the replacement disclosure, not the detached prior element");
  assert.equal(activeElement?.tagName, "summary", "the restored element kind is the output disclosure control");
  assert.equal(activeProcess?.dataset.sessionId, sessionId, "focus stays in the same session");
  assert.equal(activeProcess?.dataset.processId, processId, "focus stays in the same process");
  assert.equal(activeElement?.focusOptions?.preventScroll, true, "the replacement disclosure receives focus with preventScroll after redraw");
  ui.sources.at(-1)!.dispatch("resync-required");
  await settle(); await settle();
  const otherBlock = processDetails.children.find((child) => child.className === "process-block" && child.dataset.processId === "other-process");
  assert.ok(otherBlock, "resync replaces the original process with a different process");
  const otherSummary = otherBlock.querySelector<FakeElement>("details")?.children[0];
  assert.notEqual(FakeElement.activeElement, otherSummary, "focus is not transferred to another process when the focused process disappears");
  assert.equal(otherSummary?.focusOptions, undefined, "the replacement process receives no focus call");
  assert.equal(ui.scrollTargets.every((target) => target === 0), true, "redraw and focus restoration preserve the current scroll position");
});

test("Issue 55: state refresh and resync retain a running process destination outside the newest log page", async () => {
  const sessionId = "quiet-session";
  const processId = "quiet-process";
  const at = "2026-10-02T00:00:00.000Z";
  const startEvent = { event: "process.start", at, sessionId, processId, comment: "quiet task", command: "echo waiting" };
  const initialDetails = new FakeElement("section");
  const title = new FakeElement("h2"); title.textContent = "コマンドと出力の詳細"; initialDetails.append(title);
  const initialBlock = new FakeElement("article"); initialBlock.className = "process-block";
  initialBlock.dataset.sessionId = sessionId; initialBlock.dataset.processId = processId;
  initialBlock.dataset.eventsJson = JSON.stringify([startEvent]);
  initialDetails.append(initialBlock);
  const runningRows = new FakeElement("tbody");
  const ui = boot(async (url) => {
    const request = new URL(url, "http://local.test");
    if (request.pathname === "/api/console-state") return response(200, {
      stopped: false, activeSessions: 1, runningProcesses: 1, updatedAt: at,
      running: [{ operation_id: processId, connection_id: sessionId, label: "process", status: "running", purpose: "quiet task", command: "echo waiting" }],
    });
    if (request.searchParams.has("after")) return response(200, { items: [{ id: "quiet-output", cursor: "c200", event: { event: "process.output", at, sessionId, processId, output: "still waiting" } }], newestCursor: "c200", oldestCursor: "c200", hasMoreOlder: false, hasMoreNewer: false });
    if (!request.searchParams.has("after")) return response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false });
    throw new Error("unexpected request " + request.href);
  }, Array.from({ length: 200 }, (_, index) => ({ id: "unrelated-" + index, cursor: "c" + index, event: { event: "operation.completed", at, sessionId, operationId: "other-" + index } })), {
    "process-details": initialDetails,
    "running-rows": runningRows,
    "running-table": new FakeElement("div"),
    "running-empty": new FakeElement("p"),
  }, sessionId);
  await settle(); await settle();

  const expectedId = "process-" + encodeURIComponent(sessionId) + "-" + encodeURIComponent(processId);
  const assertDestination = (phase: string) => {
    const block = initialDetails.children.find((child) => child.className === "process-block" && child.dataset.sessionId === sessionId && child.dataset.processId === processId);
    assert.ok(block, `${phase}: running process detail survives even when its start event is outside the newest log page; rendered keys=${JSON.stringify(initialDetails.children.filter((child) => child.className === "process-block").map((child) => [child.dataset.sessionId, child.dataset.processId]))}`);
    const heading = block.children.find((child) => child.tagName === "h3");
    assert.equal(heading?.id, expectedId, `${phase}: fragment targets the corresponding process heading`);
    if (phase === "log resync") assert.ok(heading?.textContent.includes(processId), "log resync: visible heading still identifies the live process when its audit events are unavailable");
    const link = runningRows.allDescendants().find((child) => child.tagName === "a" && child.dataset.sessionId === sessionId && child.dataset.processId === processId);
    assert.equal(link?.href, "#" + expectedId, `${phase}: running row points to its same-session heading`);
  };
  assertDestination("state refresh");
  const focusedHeading = initialDetails.children.find((child) => child.className === "process-block")?.children.find((child) => child.tagName === "h3");
  assert.ok(focusedHeading);
  focusedHeading.focus();
  ui.sources[0]!.dispatch("logs-available", JSON.stringify({ addedCount: 1, latestCursor: "c200", overflow: false }));
  ui.newest.click();
  await settle(); await settle();
  const replacementHeading = initialDetails.children.find((child) => child.className === "process-block")?.children.find((child) => child.tagName === "h3");
  assert.equal(FakeElement.activeElement, replacementHeading, "the heading reached by the running-row fragment remains the focused same-session/process target after output refresh");
  ui.sources.at(-1)!.dispatch("resync-required");
  await settle(); await settle();
  assertDestination("log resync");
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
  const selection = { anchorNode: oldText, focusNode: oldText, anchorOffset: 1, focusOffset: 3, isCollapsed: false, toString: () => "es", getRangeAt: () => ({ intersectsNode: () => true }), setBaseAndExtent: (...args: unknown[]) => { restored = args; }, removeAllRanges: () => undefined, addRange: () => undefined };
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

test("selection wholly outside the session list is not touched by list updates", async () => {
  const rows = new FakeElement("tbody");
  const outside = new FakeElement("p"); const first = new FakeElement("#text"); first.textContent = "log text"; const second = new FakeElement("#text"); second.textContent = "help text"; outside.append(first); outside.append(second);
  let restoreCount = 0; let clearCount = 0;
  const selection = { anchorNode: first, focusNode: second, anchorOffset: 1, focusOffset: 3, isCollapsed: false, toString: () => "og text", setBaseAndExtent: () => { restoreCount += 1; }, removeAllRanges: () => { clearCount += 1; }, addRange: () => undefined };
  boot(async (url) => new URL(url, "http://local.test").pathname === "/api/console-state"
    ? response(200, { ...emptyState, sessions: [{ session_id: "new-session", created_at: "2026-10-01T00:00:00Z", state: "active", active: true, purpose: "test", working_directory: "C:/work" }] })
    : response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false }), [], { "session-rows": rows }, "", { selection });
  await settle(); await settle();
  assert.equal(restoreCount, 0);
  assert.equal(clearCount, 0, "a selection outside the session rows must never be cleared by their redraw");
  assert.equal(selection.toString(), "og text");
});

test("a selection with only one endpoint in the session list is not reset", async () => {
  const rows = new FakeElement("tbody"); const row = new FakeElement("tr"); row.dataset.sessionId = "session-half";
  for (const value of ["link", "date", "access", "active", "purpose", "session-half", "directory"]) { const cell = new FakeElement("td"); cell.textContent = value; const text = new FakeElement("#text"); text.textContent = value; cell.append(text); row.append(cell); }
  rows.append(row);
  const outside = new FakeElement("p"); const outsideText = new FakeElement("#text"); outsideText.textContent = "external"; outside.append(outsideText);
  const insideText = row.cells[5]!.children[0]!; let restoreCount = 0; let clearCount = 0;
  const selection = { anchorNode: outsideText, focusNode: insideText, anchorOffset: 2, focusOffset: 4, isCollapsed: false, toString: () => "ternal session", setBaseAndExtent: () => { restoreCount += 1; }, removeAllRanges: () => { clearCount += 1; }, addRange: () => undefined };
  boot(async (url) => new URL(url, "http://local.test").pathname === "/api/console-state"
    ? response(200, { ...emptyState, sessions: [{ session_id: "session-half", created_at: "2026-10-01T00:00:00Z", state: "active", active: true, purpose: "purpose", working_directory: "directory" }] })
    : response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false }), [], { "session-rows": rows }, "", { selection });
  await settle(); await settle();
  assert.equal(restoreCount, 0, "a selection crossing the list boundary is not partially rebound");
  assert.equal(clearCount, 0, "a selection crossing the list boundary is not explicitly cleared");
});

test("a live range crossing the session list defers replacement and applies only the latest state after selection ends", async () => {
  const rows = new FakeElement("tbody");
  const oldRow = new FakeElement("tr"); oldRow.dataset.sessionId = "old-session"; rows.append(oldRow);
  const outside = new FakeElement("p"); const outsideText = new FakeElement("#text"); outsideText.textContent = "before "; const outsideEnd = new FakeElement("#text"); outsideEnd.textContent = " after"; outside.append(outsideText); outside.append(outsideEnd);
  let selectedText = "before selected session text after";
  const selection = {
    anchorNode: outsideText, focusNode: outsideEnd, anchorOffset: 0, focusOffset: 1, isCollapsed: false,
    toString: () => selectedText,
    getRangeAt: () => ({ intersectsNode: (node: FakeElement) => node === rows && !selection.isCollapsed }),
    setBaseAndExtent: () => assert.fail("a selection crossing the list must not be rebound"),
    removeAllRanges: () => assert.fail("a selection crossing the list must not be cleared"), addRange: () => undefined,
  };
  // A DOM Range whose endpoints are outside this subtree still selects content
  // within it; removing that content changes the live selection's text.
  rows.onReplaceChildren = (removed) => { if (removed.some((child) => child === oldRow)) selectedText = "before after"; };
  let stateRequests = 0;
  const session = (id: string) => ({ session_id: id, created_at: "2026-10-01T00:00:00Z", state: "active", active: true, purpose: id, working_directory: "C:/work" });
  const ui = boot(async (url) => {
    const path = new URL(url, "http://local.test").pathname;
    if (path === "/api/console-state") {
      stateRequests += 1;
      return response(200, { ...emptyState, activeSessions: stateRequests, sessions: [session(stateRequests === 1 ? "first-state" : "latest-state")] });
    }
    return response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false });
  }, [], { "session-rows": rows, "active-session-count": new FakeElement() }, "", { selection });
  await settle(); await settle();
  assert.equal(rows.children[0], oldRow, "the list remains intact while a live range intersects it");
  assert.equal(selectedText, "before selected session text after", "the live range's selected text remains intact");

  ui.newest.click();
  await settle(); await settle(); await settle();
  assert.equal(stateRequests, 2, "a later successful state response can replace the deferred state");
  assert.equal(rows.children[0], oldRow, "later refreshes also defer while selection crosses the list");

  selection.isCollapsed = true;
  selectedText = "";
  ui.documentListeners.get("selectionchange")?.();
  await settle();
  assert.equal(rows.children[0]?.dataset.sessionId, "latest-state", "selection release renders the newest deferred state");
  assert.equal(ui.documentStub.getElementById("active-session-count")?.textContent, "2");
});

test("pagehide and auth expiry discard a deferred session state", async () => {
  for (const ending of ["pagehide", "auth-expired"] as const) {
    const rows = new FakeElement("tbody"); const oldRow = new FakeElement("tr"); oldRow.dataset.sessionId = "old-session"; rows.append(oldRow);
    const outside = new FakeElement("p"); const outsideText = new FakeElement("#text"); outsideText.textContent = "outside"; outside.append(outsideText);
    const insideText = new FakeElement("#text"); insideText.textContent = "inside";
    const selection = { anchorNode: outsideText, focusNode: insideText, anchorOffset: 0, focusOffset: 2, isCollapsed: false, toString: () => "outside inside", getRangeAt: () => ({ intersectsNode: (node: FakeElement) => node === rows && !selection.isCollapsed }), removeAllRanges: () => undefined, addRange: () => undefined };
    const ui = boot(async (url) => new URL(url, "http://local.test").pathname === "/api/console-state"
      ? response(200, { ...emptyState, sessions: [{ session_id: "deferred-session", created_at: "2026-10-01T00:00:00Z", state: "active", active: true }] })
      : response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false }), [], { "session-rows": rows }, "", { selection });
    await settle(); await settle();
    assert.equal(rows.children[0], oldRow, "the initial response is deferred");
    if (ending === "pagehide") ui.windowListeners.get("pagehide")?.();
    else ui.sources[0]!.dispatch("auth-expired");
    selection.isCollapsed = true;
    ui.documentListeners.get("selectionchange")?.();
    await settle();
    assert.equal(rows.children[0], oldRow, `${ending} discards deferred updates`);
  }
});


test("session metadata editor uses the authenticated PATCH contract and preserves input on a version conflict", async () => {
  const directory = { value: "C:/old" };
  const purpose = { value: "Old purpose" };
  const output = { textContent: "" };
  const button = { disabled: false, addEventListener: () => undefined };
  const directoryCell = { textContent: "C:/old" };
  const purposeCell = { textContent: "Old purpose" };
  const row = { querySelector: (selector: string) => selector === "[data-session-directory]" ? directoryCell : purposeCell };
  let handler: ((event: { preventDefault(): void }) => Promise<void>) | undefined;
  const form = {
    dataset: { sessionEdit: "owned/session", version: "3" },
    elements: { namedItem: (name: string) => name === "csrf" ? { value: "csrf-token" } : name === "workingDirectory" ? directory : name === "purpose" ? purpose : null },
    addEventListener: (_name: string, listener: (event: { preventDefault(): void }) => Promise<void>) => { handler = listener; },
    querySelector: (selector: string) => selector === "output" ? output : button,
    closest: () => row,
  };
  const requests: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
  let patchCount = 0;
  runInNewContext(userConsoleClientScript, {
    document: { querySelectorAll: () => [form], getElementById: () => null },
    encodeURIComponent,
    fetch: async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
      requests.push({ url, init });
      if (init.method !== "PATCH") return response(200, { sessions: [{ session_id: "owned/session", active: true, version: 5, working_directory: "C:/latest", purpose: "Latest purpose" }] });
      patchCount++;
      return patchCount === 1 ? response(200, { version: 4, working_directory: "C:/canonical", purpose: "New purpose" }) : response(409, { error: "version_conflict" });
    },
  });
  assert.ok(handler);
  await handler({ preventDefault() {} });
  assert.equal(requests[0]?.url, "/api/sessions/owned%2Fsession");
  assert.equal(requests[0]?.init.method, "PATCH");
  assert.equal(requests[0]?.init.headers["x-csrf-token"], "csrf-token");
  assert.deepEqual(JSON.parse(requests[0]!.init.body), { expectedVersion: 3, workingDirectory: "C:/old", purpose: "Old purpose" });
  assert.equal(form.dataset.version, "4");
  assert.equal(directory.value, "C:/canonical");
  assert.equal(purpose.value, "New purpose");
  assert.equal(directoryCell.textContent, "C:/canonical");
  assert.equal(purposeCell.textContent, "New purpose");
  purpose.value = "Unsaved conflicting input";
  await handler({ preventDefault() {} });
  assert.equal(form.dataset.version, "4");
  assert.equal(purpose.value, "Unsaved conflicting input");
  assert.match(output.textContent, /競合しました/);
  assert.equal(button.disabled, false);
});


test("session metadata editor keeps typing made while a save is pending", async () => {
  const directory = { value: "C:/old" };
  const purpose = { value: "Submitted purpose" };
  const output = { textContent: "" };
  const form = {
    dataset: { sessionEdit: "session-1", version: "1" },
    elements: { namedItem: (name: string) => name === "csrf" ? { value: "csrf" } : name === "workingDirectory" ? directory : name === "purpose" ? purpose : null },
    addEventListener: (_name: string, listener: (event: { preventDefault(): void }) => Promise<void>) => { handler = listener; },
    querySelector: (selector: string) => selector === "output" ? output : button,
    closest: () => row,
  };
  const button = { disabled: false, addEventListener: () => undefined };
  const linkCell = { textContent: "", replaceChildren() {} };
  const row = { querySelector: () => linkCell };
  let release!: (value: ReturnType<typeof response>) => void;
  let handler: ((event: { preventDefault(): void }) => Promise<void>) | undefined;
  runInNewContext(userConsoleClientScript, {
    document: { querySelectorAll: () => [form], getElementById: () => null }, encodeURIComponent,
    fetch: () => new Promise<ReturnType<typeof response>>((resolve) => { release = resolve; }),
  });
  assert.ok(handler);
  const saving = handler({ preventDefault() {} });
  purpose.value = "Typed while waiting";
  release(response(200, { version: 2, working_directory: "C:/old", purpose: "Submitted purpose" }));
  await saving;
  assert.equal(purpose.value, "Typed while waiting");
  assert.equal(form.dataset.version, "2");
  assert.match(output.textContent, /未保存/);
});


test("link editor sends sparse intent so a fetched title survives unrelated saves and explicit clearing is distinct", async () => {
  const directory = { value: "C:/work" };
  const purpose = { value: "Original" };
  const externalUrl = { value: "https://example.com/page" };
  const externalTitle = { value: "Fetched title" };
  const output = { textContent: "" };
  const button = { disabled: false, addEventListener() {} };
  const linkCell = { textContent: "", replaceChildren() {} };
  const row = { querySelector: (selector: string) => selector === "[data-session-external-link]" ? linkCell : null };
  let handler: ((event: { preventDefault(): void }) => Promise<void>) | undefined;
  const form = {
    dataset: { sessionEdit: "session-1", version: "2" },
    elements: { namedItem: (name: string) => ({ csrf: { value: "csrf" }, workingDirectory: directory, purpose, externalUrl, externalTitle } as Record<string, { value: string }>)[name] ?? null },
    addEventListener: (_name: string, listener: (event: { preventDefault(): void }) => Promise<void>) => { handler = listener; },
    querySelector: (selector: string) => selector === "output" ? output : button,
    closest: () => row,
  };
  const requests: Array<{ body: string }> = [];
  let calls = 0;
  runInNewContext(userConsoleClientScript, {
    document: { querySelectorAll: () => [form], getElementById: () => null }, encodeURIComponent,
    fetch: async (_url: string, init: { body: string }) => {
      requests.push(init); calls++;
      return calls === 1
        ? response(200, { version: 3, working_directory: "C:/work", purpose: "Updated", external_url: externalUrl.value, external_title: "Fetched title", external_title_source: "fetched", external_title_status: "resolved" })
        : response(200, { version: 4, working_directory: "C:/work", purpose: "Updated", external_url: externalUrl.value, external_title: null, external_title_source: null, external_title_status: "pending" });
    },
  });
  assert.ok(handler);
  purpose.value = "Updated";
  await handler({ preventDefault() {} });
  const sparse = JSON.parse(requests[0]!.body) as Record<string, unknown>;
  assert.equal(Object.hasOwn(sparse, "externalUrl"), false);
  assert.equal(Object.hasOwn(sparse, "externalTitle"), false, "an unrelated save omits fetched title intent");
  assert.equal(externalTitle.value, "Fetched title");
  externalTitle.value = "";
  await handler({ preventDefault() {} });
  const clearing = JSON.parse(requests[1]!.body) as Record<string, unknown>;
  assert.equal(Object.hasOwn(clearing, "externalUrl"), false);
  assert.equal(clearing.externalTitle, null, "an explicit empty title is sent as a clear operation");
  assert.equal(externalTitle.value, "");
  assert.equal(form.dataset.version, "4");
});


test("a state snapshot started before a successful save cannot restore its older session version", async () => {
  const sessionRows = new FakeElement("tbody");
  const row = new FakeElement("tr"); sessionRows.append(row);
  const directoryCell = new FakeElement("td"); directoryCell.dataset.sessionDirectory = "true"; row.append(directoryCell);
  const purposeCell = new FakeElement("td"); purposeCell.dataset.sessionPurpose = "true"; row.append(purposeCell);
  const editorCell = new FakeElement("td"); row.append(editorCell);
  const disclosure = new FakeElement("details"); editorCell.append(disclosure);
  const summary = new FakeElement("summary"); disclosure.append(summary);
  const form = new FakeElement("form"); form.dataset = { sessionEdit: "session-1", version: "1" }; disclosure.append(form);
  const directory = new FakeElement("input"); directory.value = "C:/new";
  const purpose = new FakeElement("input"); purpose.value = "New purpose";
  const csrf = new FakeElement("input"); csrf.value = "csrf";
  Object.assign(form, { elements: { namedItem: (name: string) => name === "csrf" ? csrf : name === "workingDirectory" ? directory : name === "purpose" ? purpose : null } });
  const output = new FakeElement("output"); const submitButton = new FakeElement("button");
  form.queries.set("output", output); form.queries.set("button[type=submit]", submitButton);
  row.queries.set("[data-session-directory]", directoryCell); row.queries.set("[data-session-purpose]", purposeCell);
  let releaseRefresh!: (value: ReturnType<typeof response>) => void;
  let refreshCount = 0;
  let patchFinished = false;
  const ui = boot(async (url, init) => {
    const request = new URL(url, "http://local.test");
    if (request.pathname === "/api/console-state") {
      if (refreshCount++ === 0) return new Promise((resolve) => { releaseRefresh = resolve; });
      return response(200, { stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-03T00:00:00Z", sessions: [
        { session_id: "session-1", working_directory: "C:/stale", purpose: "Stale purpose", created_at: "2026-10-02T00:00:00Z", state: "active", active: true, version: 1 },
      ] });
    }
    if (request.pathname === "/api/logs") return response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false });
    if (request.pathname === "/api/sessions/session-1" && init?.method === "PATCH") { patchFinished = true; return response(200, { version: 2, working_directory: "C:/new", purpose: "New purpose" }); }
    throw new Error("unexpected request " + request.href);
  }, [], { "session-rows": sessionRows, form });
  await settle();
  const submit = form.listeners.get("submit") as unknown as (event: { preventDefault(): void }) => Promise<void>;
  await submit({ preventDefault() {} });
  assert.equal(patchFinished, true);
  assert.equal(form.dataset.version, "2");
  assert.equal(directoryCell.textContent, "C:/new");
  releaseRefresh(response(200, { stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-03T00:00:00Z", sessions: [
    { session_id: "session-1", working_directory: "C:/old", purpose: "Old purpose", created_at: "2026-10-02T00:00:00Z", state: "active", active: true, version: 1 },
  ] }));
  await settle();
  assert.equal(directoryCell.textContent, "C:/new", "a pre-save response cannot roll back the committed display values");
  assert.equal(purposeCell.textContent, "New purpose");
  assert.equal(form.dataset.version, "2", "the saved compare version advances independently of the editor draft version");
  ui.newest.click();
  await settle(); await settle();
  assert.equal(directoryCell.textContent, "C:/new", "a later response with an older saved version is also ignored");
  assert.equal(form.dataset.version, "2");
  ui.sources[0]?.close();
});


test("out-of-order state refresh responses apply only the newest requested snapshot", async () => {
  const sessionRows = new FakeElement("tbody");
  const pending: Array<(value: ReturnType<typeof response>) => void> = [];
  const ui = boot(async (url) => {
    if (new URL(url, "http://local.test").pathname === "/api/console-state") return new Promise((resolve) => { pending.push(resolve); });
    return response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false });
  }, [], { "session-rows": sessionRows });
  await settle();
  ui.newest.click();
  await settle();
  assert.equal(pending.length, 2);
  const latest = { stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-03T00:02:00Z", sessions: [
    { session_id: "session-1", working_directory: "C:/latest", purpose: "Latest", created_at: "2026-10-02T00:00:00Z", state: "active", active: true, version: 3 },
  ] };
  pending[1]!(response(200, latest));
  await settle();
  pending[0]!(response(200, { ...latest, activeSessions: 0, sessions: [{ ...latest.sessions[0]!, working_directory: "C:/older", purpose: "Older", state: "closed", active: false, version: 2 }] }));
  await settle();
  assert.equal(sessionRows.children[0]?.children[6]?.textContent, "C:/latest");
  assert.equal(sessionRows.children[0]?.children[4]?.textContent, "Latest");
  assert.equal(sessionRows.children[0]?.children[3]?.textContent, "有効", "an older response cannot roll back session lifecycle");
  ui.sources[0]?.close();
});


test("version conflicts load the latest values and require an explicit re-edit choice", async () => {
  const directory = { value: "C:/draft" }; const purpose = { value: "Draft purpose" };
  const output = { textContent: "" }; const summary = { textContent: "" }; const conflict = { hidden: true };
  const keepDraft = { clickHandler: undefined as (() => void) | undefined, addEventListener: (_: string, handler: () => void) => { keepDraft.clickHandler = handler; } };
  const useLatest = { clickHandler: undefined as (() => void) | undefined, addEventListener: (_: string, handler: () => void) => { useLatest.clickHandler = handler; } };
  const submitButton = { disabled: false };
  const row = { querySelector: () => ({ textContent: "" }) };
  let submit: ((event: { preventDefault(): void }) => Promise<void>) | undefined;
  let patchCalls = 0;
  const form = {
    dataset: { sessionEdit: "session-1", version: "1" },
    elements: { namedItem: (name: string) => name === "csrf" ? { value: "csrf" } : name === "workingDirectory" ? directory : name === "purpose" ? purpose : null },
    addEventListener: (_: string, handler: (event: { preventDefault(): void }) => Promise<void>) => { submit = handler; },
    querySelector: (selector: string) => selector === "output" ? output : selector === "[data-session-conflict]" ? conflict : selector === "[data-session-conflict-summary]" ? summary : selector.includes("keep-draft") ? keepDraft : selector.includes("use-latest") ? useLatest : submitButton,
    closest: () => row,
  };
  runInNewContext(userConsoleClientScript, {
    document: { querySelectorAll: () => [form], getElementById: () => null }, encodeURIComponent,
    fetch: async (_url: string, init?: { method?: string }) => {
      if (init?.method === "PATCH") { patchCalls++; return response(409, { error: "version_conflict" }); }
      return response(200, { sessions: [{ session_id: "session-1", active: true, version: 2, working_directory: "C:/latest", purpose: "Latest purpose" }] });
    },
  });
  assert.ok(submit);
  await submit({ preventDefault() {} });
  assert.equal(patchCalls, 1, "a conflict must never trigger an automatic retry");
  assert.equal(conflict.hidden, false);
  assert.match(summary.textContent, /C:\/latest.*Latest purpose/);
  assert.equal(directory.value, "C:/draft");
  keepDraft.clickHandler?.();
  assert.equal(form.dataset.version, "2");
  assert.equal(directory.value, "C:/draft");
  assert.equal(conflict.hidden, true);
  await submit({ preventDefault() {} });
  assert.equal(patchCalls, 2);
  useLatest.clickHandler?.();
  assert.equal(form.dataset.version, "2");
  assert.equal(directory.value, "C:/latest");
  assert.equal(purpose.value, "Latest purpose");
});


test("state refresh reconciles rows by session id while preserving live edit DOM, drafts, time disclosure, and focus", async () => {
  const sessionRows = new FakeElement("tbody");
  const originalRow = new FakeElement("tr"); sessionRows.append(originalRow);
  const linkCell = new FakeElement("td"); originalRow.append(linkCell);
  const createdCell = new FakeElement("td"); originalRow.append(createdCell);
  const createdTime = new FakeElement("details"); createdTime.dataset = { sessionId: "session-1", sessionTime: "created" }; createdTime.open = true;
  const createdSummary = new FakeElement("summary"); createdTime.append(createdSummary); createdCell.append(createdTime);
  const accessCell = new FakeElement("td"); originalRow.append(accessCell);
  const accessTime = new FakeElement("details"); accessTime.dataset = { sessionId: "session-1", sessionTime: "last-access" };
  const accessSummary = new FakeElement("summary"); accessTime.append(accessSummary); accessCell.append(accessTime);
  originalRow.append(new FakeElement("td"));
  const purposeCell = new FakeElement("td"); purposeCell.dataset.sessionPurpose = "true"; originalRow.append(purposeCell);
  const idCell = new FakeElement("td"); idCell.textContent = "session-1"; originalRow.append(idCell);
  const directoryCell = new FakeElement("td"); directoryCell.dataset.sessionDirectory = "true"; originalRow.append(directoryCell);
  const editorCell = new FakeElement("td"); originalRow.append(editorCell);
  const editorDisclosure = new FakeElement("details"); editorDisclosure.open = true; editorCell.append(editorDisclosure);
  const editorSummary = new FakeElement("summary"); editorDisclosure.append(editorSummary);
  const sessionForm = new FakeElement("form"); sessionForm.dataset = { sessionEdit: "session-1", version: "1" }; editorDisclosure.append(sessionForm);
  const directoryInput = new FakeElement("input"); directoryInput.value = "C:/draft";
  const purposeInput = new FakeElement("input"); purposeInput.value = "Unsaved purpose";
  const csrfInput = new FakeElement("input"); csrfInput.value = "csrf";
  sessionForm.append(directoryInput); sessionForm.append(purposeInput); sessionForm.append(csrfInput);
  Object.assign(sessionForm, { elements: { namedItem: (name: string) => name === "workingDirectory" ? directoryInput : name === "purpose" ? purposeInput : name === "csrf" ? csrfInput : null } });

  const stateA = { stopped: false, activeSessions: 2, runningProcesses: 0, updatedAt: "2026-10-03T00:00:00Z", sessions: [
    { session_id: "session-1", working_directory: "C:/server-value", purpose: "Server purpose", external_url: "https://example.com/", external_title: "Fetched title", external_title_source: "fetched", external_title_status: "resolved", created_at: "2026-10-02T00:00:00Z", last_used_at: "2026-10-03T00:00:00Z", state: "active", active: true, version: 2 },
    { session_id: "session-2", working_directory: "C:/added", purpose: "Added session", external_url: null, external_title: "Title without URL", external_title_source: "manual", external_title_status: "not_requested", created_at: "2026-10-01T00:00:00Z", state: "active", active: true, version: 1 },
    { session_id: "session-3", working_directory: "C:/closed", purpose: "Closed session", created_at: "2026-09-30T00:00:00Z", state: "closed", active: false },
  ] };
  const stateB = { stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-03T00:01:00Z", sessions: [
    { session_id: "session-1", working_directory: "C:/server-value-2", purpose: "Ended session", created_at: "2026-10-02T00:00:00Z", last_used_at: "2026-10-03T00:01:00Z", state: "closed", active: false },
    { session_id: "session-2", working_directory: "C:/added-updated", purpose: "Still active", created_at: "2026-10-01T00:00:00Z", state: "active", active: true, version: 2 },
  ] };
  let refresh = 0;
  const ui = boot(async (url) => {
    const request = new URL(url, "http://local.test");
    if (request.pathname === "/api/console-state") { refresh++; return response(200, refresh <= 2 ? stateA : stateB); }
    if (request.pathname === "/api/logs") return response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false });
    throw new Error("unexpected request " + request.href);
  }, [], { "session-rows": sessionRows });
  FakeElement.activeElement = purposeInput;
  await settle();
  assert.equal(refresh, 1);
  assert.equal(sessionRows.children.length, 3, "new and closed sessions are reconciled into the all-sessions table");
  const updatedRow = sessionRows.children.find((row) => row.children[5]?.textContent === "session-1")!;
  assert.ok(updatedRow);
  assert.equal(updatedRow.children[4]?.textContent, "Server purpose");
  assert.equal(updatedRow.children[6]?.textContent, "C:/server-value");
  assert.equal(updatedRow.children[7]?.children[0]?.textContent, "Fetched title", "the owner session link uses fetched title as text");
  assert.equal(updatedRow.children[7]?.children[0]?.rel, "noopener noreferrer");
  assert.equal(updatedRow.children[7]?.children[0]?.referrerPolicy, "no-referrer");
  assert.equal(updatedRow.children[7]?.children[1]?.textContent, "自動取得");
  assert.equal(updatedRow.children[7]?.className, "session-external-link-cell", "auto-refreshed rows retain the narrow-screen wrapping class");
  assert.equal(sessionRows.children[1]?.children[7]?.children[0]?.className, "session-external-title");
  assert.equal(sessionRows.children[1]?.children[7]?.children[0]?.textContent, "Title without URL");
  assert.equal(updatedRow.querySelector("form[data-session-edit]"), sessionForm, "the same editor form is moved into the reconciled row");
  assert.equal(directoryInput.value, "C:/draft");
  assert.equal(purposeInput.value, "Unsaved purpose");
  assert.equal(sessionForm.dataset.version, "1", "a refresh does not silently advance the draft's compare version");
  assert.equal(FakeElement.activeElement, purposeInput);
  assert.equal(purposeInput.focusOptions?.preventScroll, true);
  assert.equal(updatedRow.children[1]?.children[0]?.open, true);
  assert.equal(sessionRows.children[1]?.children[8]?.innerHTML.includes('data-session-edit="session-2"'), true, "new active sessions receive an editor");
  const closedRow = sessionRows.children.find((row) => row.children[5]?.textContent === "session-3")!;
  assert.equal(closedRow.querySelector("form[data-session-edit]"), null, "closed sessions never retain an editor");

  FakeElement.activeElement = editorSummary;
  ui.newest.click();
  await settle(); await settle();
  assert.equal(refresh, 2);
  assert.equal(sessionRows.children.length, 3, "the intermediate refresh retains the active editor row");
  const editorFocusRow = sessionRows.children.find((row) => row.children[5]?.textContent === "session-1")!;
  const restoredEditorSummary = editorFocusRow.children[8]?.querySelector("summary");
  assert.equal(FakeElement.activeElement, restoredEditorSummary, "the editor summary keeps keyboard focus after its row is replaced");
  assert.equal(restoredEditorSummary?.focusOptions?.preventScroll, true);

  const currentCreatedSummary = editorFocusRow.children[1]?.children[0]?.children[0];
  assert.equal(currentCreatedSummary?.tagName, "summary");
  FakeElement.activeElement = currentCreatedSummary ?? null;
  ui.newest.click();
  await settle(); await settle();
  assert.equal(refresh, 3);
  const endedRow = sessionRows.children.find((row) => row.children[5]?.textContent === "session-1")!;
  assert.equal(endedRow.children[3]?.textContent, "終了");
  assert.equal(endedRow.querySelector("form[data-session-edit]"), null, "an editor is removed when its session ends");
  assert.equal(sessionRows.children.some((row) => row.children[5]?.textContent === "session-3"), false, "sessions omitted from current state are removed");
  assert.equal(FakeElement.activeElement?.tagName, "summary");
  assert.equal(FakeElement.activeElement?.focusOptions?.preventScroll, true);
  assert.equal(sessionRows.children.length, 2);
  ui.sources[0]?.close();
});
