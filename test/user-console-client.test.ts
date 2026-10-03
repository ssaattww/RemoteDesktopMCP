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
  dateTime = "";
  value = "";
  name = "";
  type = "";
  required = false;
  maxLength = 0;
  innerHTML = "";
  parent: FakeElement | null = null;
  focusOptions?: { preventScroll?: boolean };
  colSpan = 1;
  children: FakeElement[] = [];
  listeners = new Map<string, () => void>();
  queries = new Map<string, FakeElement>();
  closestNodes = new Map<string, FakeElement>();
  rect = { top: 0, bottom: 100, left: 0, right: 100 };
  classList = { toggle: (name: string, force?: boolean) => Boolean(name && force !== false) };
  constructor(tagName = "div") { this.tagName = tagName.toLowerCase(); }
  addEventListener(name: string, listener: () => void) { this.listeners.set(name, listener); }
  click(name = "click") { this.listeners.get(name)?.(); }
  replaceChildren(...children: FakeElement[]) { for (const child of this.children) child.parent = null; this.children = children; for (const child of children) { child.parent?.remove(child); child.parent = this; } }
  append(child: FakeElement) { child.parent?.remove(child); child.parent = this; this.children.push(child); }
  remove(child: FakeElement) { this.children = this.children.filter((candidate) => candidate !== child); child.parent = null; }
  insertRow() { const row = new FakeElement("tr"); row.parent = this; this.children.push(row); return row; }
  insertCell() { const cell = new FakeElement("td"); cell.parent = this; this.children.push(cell); return cell; }
  focus(options?: { preventScroll?: boolean }) { FakeElement.activeElement = this; this.focusOptions = options; }
  allDescendants(): FakeElement[] { return this.children.flatMap((child) => [child, ...child.allDescendants()]); }
  querySelectorAll<T extends FakeElement>(selector: string) {
    const override = this.queries.get(selector);
    if (override) return [override] as T[];
    if (selector.startsWith(".process-block")) return this.children.filter((child) => child.className === "process-block" && (!selector.includes("data-events-json") || child.dataset.eventsJson !== undefined)) as T[];
    if (selector.startsWith("tr[data-event-json]")) return this.children.filter((child) => child.tagName === "tr" && child.dataset.eventJson !== undefined) as T[];
    const descendants = this.allDescendants();
    if (selector === "form[data-session-edit]" || selector === "[data-session-edit]") return descendants.filter((child) => child.tagName === "form" && child.dataset.sessionEdit !== undefined) as T[];
    if (selector === "details[data-session-time]") return descendants.filter((child) => child.tagName === "details" && child.dataset.sessionTime !== undefined) as T[];
    if (selector === "time[data-session-relative]") return descendants.filter((child) => child.tagName === "time" && child.dataset.sessionRelative !== undefined) as T[];
    return [] as T[];
  }
  querySelector<T extends FakeElement>(selector: string) {
    const override = this.queries.get(selector);
    if (override) return override as T;
    if (selector === "form[data-session-edit]") return (this.allDescendants().find((child) => child.tagName === "form" && child.dataset.sessionEdit !== undefined) ?? null) as T | null;
    if (selector === "h2") return (this.children.find((child) => child.tagName === "h2") ?? null) as T | null;
    if (selector === "summary") return (this.children.find((child) => child.tagName === "summary") ?? this.children.map((child) => child.querySelector<FakeElement>(selector)).find(Boolean) ?? null) as T | null;
    if (selector === ".process-block") return (this.children.find((child) => child.className === "process-block") ?? null) as T | null;
    if (selector === "details") return (this.children.find((child) => child.tagName === "details") ?? this.children.map((child) => child.querySelector<FakeElement>(selector)).find(Boolean) ?? null) as T | null;
    return null;
  }
  contains(element: FakeElement | null) { return element === this || this.allDescendants().includes(element as FakeElement); }
  closest<T extends FakeElement>(selector: string) {
    const override = this.closestNodes.get(selector);
    if (override) return override as T;
    let current: FakeElement | null = this;
    while (current) {
      if ((selector === "tr" && current.tagName === "tr") || (selector === "td" && current.tagName === "td") || (selector === "form[data-session-edit]" && current.tagName === "form" && current.dataset.sessionEdit !== undefined)) return current as T;
      current = current.parent;
    }
    return null as T | null;
  }
  getBoundingClientRect() { return this.rect; }
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

function response(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

async function settle() { await new Promise((resolve) => setTimeout(resolve, 0)); }

function boot(fetchImpl: (url: string, init?: { method?: string }) => Promise<ReturnType<typeof response>>, initialItems: ConsoleLogItem[] = [], extras: Record<string, FakeElement> = {}, sessionId = "", initialNow = Date.now()) {
  FakeEventSource.instances = [];
  FakeElement.activeElement = null;
  let clockNow = initialNow;
  class TestDate extends Date { static now() { return clockNow; } }
  const root = new FakeElement(); root.dataset = { sessionId, newestCursor: initialItems[0]?.cursor ?? "c0", oldestCursor: initialItems.at(-1)?.cursor ?? "c-older", hasMoreOlder: String(initialItems.length > 0), initialItems: JSON.stringify(initialItems) };
  const status = new FakeElement();
  const newest = new FakeElement(); newest.hidden = true;
  const older = new FakeElement(); older.hidden = true;
  const elements = new Map<string, FakeElement>([["log-console", root], ["log-status", status], ["log-new-button", newest], ["log-older-button", older], ...Object.entries(extras)]);
  const scrollY = 0; let scrollCalls = 0;
  const windowListeners = new Map<string, () => void>();
  const intervals = new Map<number, { callback: () => void; delay: number }>(); let nextInterval = 0;
  const timeouts = new Map<number, { callback: () => void; delay: number; dueAt: number }>(); let nextTimeout = 0;
  const windowStub = {
    scrollY, scrollX: 0, innerHeight: 600,
    addEventListener: (name: string, listener: () => void) => { windowListeners.set(name, listener); },
    setInterval: (callback: () => void, delay: number) => { const id = ++nextInterval; intervals.set(id, { callback, delay }); return id; },
    clearInterval: (id: number) => { intervals.delete(id); },
    setTimeout: (callback: () => void, delay: number) => { const id = ++nextTimeout; timeouts.set(id, { callback, delay, dueAt: clockNow + delay }); return id; },
    clearTimeout: (id: number) => { timeouts.delete(id); },
    scrollTo: () => { scrollCalls += 1; }, getSelection: () => ({ toString: () => "" }),
  };
  const documentStub = { getElementById: (id: string) => elements.get(id) ?? null, querySelectorAll: (selector: string) => [...elements.values()].flatMap((element) => element.querySelectorAll(selector)), createElement: (tagName: string) => new FakeElement(tagName), get activeElement() { return FakeElement.activeElement; }, documentElement: { scrollHeight: 1200 } };
  runInNewContext(userConsoleClientScript, { document: documentStub, window: windowStub, fetch: fetchImpl, EventSource: FakeEventSource, URLSearchParams, encodeURIComponent, Element: FakeElement, Date: TestDate });
  return { root, status, newest, older, windowStub, windowListeners, intervals, timeouts, tickIntervals: () => { for (const timer of [...intervals.values()]) timer.callback(); }, tickInterval: (delay: number) => { for (const timer of [...intervals.values()]) if (timer.delay === delay) timer.callback(); }, advanceTime: (milliseconds: number) => { const target = clockNow + milliseconds; while (true) { const due = [...timeouts.entries()].filter(([, timer]) => timer.dueAt <= target).sort((a, b) => a[1].dueAt - b[1].dueAt)[0]; if (!due) break; clockNow = due[1].dueAt; timeouts.delete(due[0]); due[1].callback(); } clockNow = target; }, setNow: (value: number) => { clockNow = value; }, get scrollCalls() { return scrollCalls; }, sources: FakeEventSource.instances };
}

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
    elements: { namedItem: (name: string) => name === "csrf" ? { value: "csrf-token" } : name === "workingDirectory" ? directory : purpose },
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
    elements: { namedItem: (name: string) => name === "csrf" ? { value: "csrf" } : name === "workingDirectory" ? directory : purpose },
    addEventListener: (_name: string, listener: (event: { preventDefault(): void }) => Promise<void>) => { handler = listener; },
    querySelector: (selector: string) => selector === "output" ? output : button,
    closest: () => row,
  };
  const button = { disabled: false, addEventListener: () => undefined };
  const row = { querySelector: () => ({ textContent: "" }) };
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
  Object.assign(form, { elements: { namedItem: (name: string) => name === "csrf" ? csrf : name === "workingDirectory" ? directory : purpose } });
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
    elements: { namedItem: (name: string) => name === "csrf" ? { value: "csrf" } : name === "workingDirectory" ? directory : purpose },
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
  Object.assign(sessionForm, { elements: { namedItem: (name: string) => name === "workingDirectory" ? directoryInput : name === "purpose" ? purposeInput : csrfInput } });

  const stateA = { stopped: false, activeSessions: 2, runningProcesses: 0, updatedAt: "2026-10-03T00:00:00Z", sessions: [
    { session_id: "session-1", working_directory: "C:/server-value", purpose: "Server purpose", created_at: "2026-10-02T00:00:00Z", last_used_at: "2026-10-03T00:00:00Z", state: "active", active: true, version: 2 },
    { session_id: "session-2", working_directory: "C:/added", purpose: "Added session", created_at: "2026-10-01T00:00:00Z", state: "active", active: true, version: 1 },
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
  assert.equal(updatedRow.querySelector("form[data-session-edit]"), sessionForm, "the same editor form is moved into the reconciled row");
  assert.equal(directoryInput.value, "C:/draft");
  assert.equal(purposeInput.value, "Unsaved purpose");
  assert.equal(sessionForm.dataset.version, "1", "a refresh does not silently advance the draft's compare version");
  assert.equal(FakeElement.activeElement, purposeInput);
  assert.equal(purposeInput.focusOptions?.preventScroll, true);
  assert.equal(updatedRow.children[1]?.children[0]?.open, true);
  assert.equal(sessionRows.children[1]?.children[7]?.innerHTML.includes('data-session-edit="session-2"'), true, "new active sessions receive an editor");
  const closedRow = sessionRows.children.find((row) => row.children[5]?.textContent === "session-3")!;
  assert.equal(closedRow.querySelector("form[data-session-edit]"), null, "closed sessions never retain an editor");

  FakeElement.activeElement = editorSummary;
  ui.newest.click();
  await settle(); await settle();
  assert.equal(refresh, 2);
  assert.equal(sessionRows.children.length, 3, "the intermediate refresh retains the active editor row");
  const editorFocusRow = sessionRows.children.find((row) => row.children[5]?.textContent === "session-1")!;
  const restoredEditorSummary = editorFocusRow.children[7]?.querySelector("summary");
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

test("session timestamp cells expose relative and exact values as native disclosure elements", async () => {
  const sessionRows = new FakeElement("tbody");
  const calls: URL[] = [];
  const now = Date.parse("2026-10-02T02:00:00.000Z");
  const ui = boot(async (url) => {
    const request = new URL(url, "http://local.test");
    calls.push(request);
    if (request.pathname === "/api/console-state") return response(200, {
      stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-02T00:00:00Z",
      sessions: [{ session_id: "stable-session", created_at: "2026-10-02T01:59:01Z", last_used_at: "2026-09-20T00:00:00Z", state: "active", active: true }],
    });
    return response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false });
  }, [], { "session-rows": sessionRows }, "", now);
  await settle();
  let createdDetails = sessionRows.children[0]?.children[1]?.children[0];
  const lastAccessDetails = sessionRows.children[0]?.children[2]?.children[0];
  assert.equal(createdDetails?.tagName, "details");
  assert.equal(lastAccessDetails?.tagName, "details");
  assert.equal(createdDetails?.open, false);
  assert.equal(createdDetails?.children[0]?.children[0]?.textContent, "59\u79d2\u524d");
  assert.match(createdDetails?.children[1]?.textContent ?? "", /JST/);
  assert.equal(createdDetails?.children[0]?.children[0]?.dateTime, "2026-10-02T01:59:01.000Z");
  assert.deepEqual([...ui.intervals.values()].map((timer) => timer.delay).sort(), [1_000, 60_000]);

  const oldSummary = createdDetails?.children[0];
  assert.ok(oldSummary);
  createdDetails!.open = true;
  oldSummary.focus();
  ui.sources[0]!.dispatch("logs-available", JSON.stringify({ addedCount: 1, latestCursor: "c1", overflow: false }));
  ui.newest.click();
  await settle();
  await settle();
  await settle();
  createdDetails = sessionRows.children[0]?.children[1]?.children[0];
  const restoredSummary = createdDetails?.children[0];
  assert.notEqual(restoredSummary, oldSummary);
  assert.equal(createdDetails?.open, true, "the open state survives the state refresh redraw");
  assert.equal(FakeElement.activeElement, restoredSummary, "the active summary for the same session time receives focus again");
  assert.equal(restoredSummary?.focusOptions?.preventScroll, true);

  const exactValue = createdDetails?.children[1]?.textContent;
  const relativeTime = restoredSummary?.children[0];
  const redrawRow = sessionRows.children[0];
  const requestCount = calls.length;
  ui.setNow(now + 1_000);
  ui.tickInterval(1_000);
  assert.equal(createdDetails?.children[0]?.children[0]?.textContent, "1分前");
  assert.equal(ui.intervals.size, 1, "the one-second timer releases itself when no timestamp uses seconds");
  assert.equal(restoredSummary?.children[0], relativeTime, "the seconds callback changes only the existing time text");
  assert.equal(createdDetails?.children[1]?.textContent, exactValue);
  assert.equal(sessionRows.children[0], redrawRow);
  assert.equal(calls.length, requestCount);
  assert.equal(createdDetails?.open, true);
  assert.equal(FakeElement.activeElement, restoredSummary);
  ui.setNow(now + 60_000);
  ui.tickIntervals();
  assert.equal(createdDetails?.children[0]?.children[0]?.textContent, "1分前");
  assert.equal(restoredSummary?.children[0], relativeTime, "the interval changes text without replacing the time element");
  assert.equal(createdDetails?.children[1]?.textContent, exactValue);
  assert.equal(sessionRows.children[0], redrawRow, "the interval changes text without replacing the row");
  assert.equal(ui.intervals.size, 1);
  assert.equal(calls.length, requestCount, "the interval does not issue a network request");
  assert.equal(createdDetails?.open, true);
  assert.equal(FakeElement.activeElement, restoredSummary);

  ui.windowListeners.get("pagehide")?.();
  assert.equal(ui.intervals.size, 0, "page departure releases the interval");
  ui.windowListeners.get("pageshow")?.();
  ui.windowListeners.get("pageshow")?.();
  assert.equal(ui.intervals.size, 1, "restoration starts a single interval");
  assert.equal(ui.sources.length, 2, "the applied log refresh restarts the event stream once");
});

test("future session times schedule their seconds boundary and release updates across page lifecycle", async () => {
  const sessionRows = new FakeElement("tbody");
  const calls: URL[] = [];
  const now = Date.parse("2026-10-02T02:00:00.000Z");
  const ui = boot(async (url) => {
    const request = new URL(url, "http://local.test"); calls.push(request);
    if (request.pathname === "/api/console-state") return response(200, {
      stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-02T00:00:00Z",
      sessions: [{ session_id: "future-session", created_at: "2026-10-02T02:01:01Z", last_used_at: "2026-10-02T03:00:00Z", state: "active", active: true }],
    });
    return response(200, { items: [], newestCursor: "c0", oldestCursor: "c0", hasMoreOlder: false, hasMoreNewer: false });
  }, [], { "session-rows": sessionRows }, "", now);
  await settle();
  const createdRelative = sessionRows.children[0]?.children[1]?.children[0]?.children[0]?.children[0];
  const lastAccessRelative = sessionRows.children[0]?.children[2]?.children[0]?.children[0]?.children[0];
  assert.equal(createdRelative?.textContent, "1\u5206\u5f8c");
  assert.equal(lastAccessRelative?.textContent, "1\u6642\u9593\u5f8c");
  assert.deepEqual([...ui.intervals.values()].map((timer) => timer.delay), [60_000]);
  assert.deepEqual([...ui.timeouts.values()].map((timeout) => timeout.delay), [1_001]);

  const requestCount = calls.length;
  ui.advanceTime(2_000);

  assert.equal(createdRelative?.textContent, "59\u79d2\u5f8c", "the scheduled boundary fires during two seconds of elapsed time");
  assert.equal(lastAccessRelative?.textContent, "59\u5206\u5f8c");
  assert.deepEqual([...ui.intervals.values()].map((timer) => timer.delay).sort(), [1_000, 60_000]);
  assert.equal(ui.timeouts.size, 1, "the next future timestamp keeps one later boundary wakeup");

  ui.windowListeners.get("pagehide")?.();
  assert.equal(ui.intervals.size, 0, "page departure releases the active seconds and minute intervals");
  assert.equal(ui.timeouts.size, 0, "page departure releases the future boundary wakeup");
  ui.windowListeners.get("pageshow")?.();
  ui.windowListeners.get("pageshow")?.();
  assert.deepEqual([...ui.intervals.values()].map((timer) => timer.delay).sort(), [1_000, 60_000], "repeated restoration creates one interval at each cadence");
  assert.equal(ui.timeouts.size, 1, "repeated restoration creates only one future boundary wakeup");
  ui.setNow(now + 3_000);
  ui.tickInterval(1_000);
  assert.equal(createdRelative?.textContent, "58\u79d2\u5f8c");
  assert.equal(calls.length, requestCount, "relative-time updates do not issue requests");
});

test("pages without a session list do not create relative-time intervals", async () => {
  const ui = boot(async () => response(200, { stopped: false, activeSessions: 0, runningProcesses: 0, updatedAt: "2026-10-02T00:00:00Z" }));
  await settle();
  assert.equal(ui.intervals.size, 0);
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
