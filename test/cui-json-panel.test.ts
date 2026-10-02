import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { userConsoleClientScript } from "../src/user-console-client.js";

class FakeElement {
  dataset: Record<string, string> = {};
  hidden = false;
  disabled = false;
  textContent = "";
  children: FakeElement[] = [];
  listeners = new Map<string, (event?: { preventDefault?: () => void }) => void>();
  constructor(readonly id = "", readonly tagName = "div") {}
  addEventListener(name: string, listener: (event?: { preventDefault?: () => void }) => void) { this.listeners.set(name, listener); }
  click(name = "click") { if (!this.disabled) this.listeners.get(name)?.(); }
  submit() { this.listeners.get("submit")?.({ preventDefault: () => undefined }); }
  replaceChildren(...children: FakeElement[]) { this.children = children; }
  append(child: FakeElement) { this.children.push(child); }
  insertRow() { const row = new FakeElement("", "tr"); this.children.push(row); return row; }
  insertCell() { const cell = new FakeElement("", "td"); this.children.push(cell); return cell; }
  querySelectorAll<T extends FakeElement>() { return [] as T[]; }
  querySelector<T extends FakeElement>() { return null as T | null; }
  closest<T extends FakeElement>() { return null as T | null; }
  getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0 }; }
  get classList() { return { toggle: () => undefined }; }
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
  close() { this.closed = true; this.readyState = 2; }
}

const httpResponse = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const baseState = {
  stopped: false,
  activeSessions: 2,
  runningProcesses: 1,
  updatedAt: "2026-10-02T00:00:00.000Z",
  sessions: [
    { session_id: "selected-session", purpose: null, working_directory: null, created_at: "2026-10-01T00:00:00.000Z", last_used_at: "2026-10-02T00:00:00.000Z", state: "active", active: true },
    { session_id: "other-session", purpose: "not selected", working_directory: "C:/other", created_at: "2026-10-01T00:00:00.000Z", last_used_at: "2026-10-02T00:00:00.000Z", state: "closed", active: false },
  ],
  running: [{ operation_id: "operation-1", connection_id: "selected-session", label: "SENSITIVE COMMAND STRING", status: "running" }],
};
const logPage = {
  items: Array.from({ length: 201 }, (_, index) => ({
    id: `log-${index}`,
    cursor: `PRIVATE_CURSOR_${index}`,
    event: { at: "2026-10-02T00:00:00.000Z", event: "operation.started", output: "PRIVATE OUTPUT" },
  })),
  newestCursor: "PRIVATE_NEWEST_CURSOR",
  oldestCursor: "PRIVATE_OLDEST_CURSOR",
  hasMoreOlder: true,
  hasMoreNewer: false,
};

function createPanel(fetchRoute: (url: URL, init: RequestInit | undefined, index: number) => Promise<ReturnType<typeof httpResponse>>) {
  FakeEventSource.instances = [];
  const ids = ["log-console", "log-status", "log-new-button", "log-older-button", "cui-json-panel", "cui-json-output", "cui-json-status", "cui-json-refresh", "user-logout"];
  const elements = new Map(ids.map((id) => [id, new FakeElement(id, id.includes("button") || id.includes("refresh") ? "button" : "div")]));
  const root = elements.get("log-console")!;
  root.dataset = { sessionId: "selected-session", newestCursor: "", oldestCursor: "", hasMoreOlder: "false", initialItems: "[]" };
  elements.get("cui-json-panel")!.dataset = { sessionId: "selected-session" };
  const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
  const fetchImpl = (url: string, init?: RequestInit) => {
    const request = new URL(url, "http://local.test");
    calls.push({ url: request, init });
    return fetchRoute(request, init, calls.length);
  };
  const windowListeners = new Map<string, () => void>();
  const windowStub = { scrollY: 0, scrollX: 0, innerHeight: 600, addEventListener: (name: string, listener: () => void) => windowListeners.set(name, listener), scrollTo: () => undefined, getSelection: () => ({ toString: () => "" }) };
  const documentStub = { getElementById: (id: string) => elements.get(id) ?? null, createElement: (tag: string) => new FakeElement("", tag), documentElement: { scrollHeight: 1200 } };
  runInNewContext(userConsoleClientScript, { document: documentStub, window: windowStub, fetch: fetchImpl, EventSource: FakeEventSource, URLSearchParams, encodeURIComponent, Element: FakeElement, AbortController });
  return { elements, calls, windowListeners, streams: FakeEventSource.instances };
}

async function settle() { await new Promise((resolve) => setTimeout(resolve, 0)); }

test("JSON panel sends selected session scope and renders only the fixed allowlist", async () => {
  const ui = createPanel(async (url) => url.pathname === "/api/console-state"
    ? httpResponse(200, baseState)
    : httpResponse(200, logPage));
  await settle();
  const button = ui.elements.get("cui-json-refresh")!;
  const output = ui.elements.get("cui-json-output")!;
  const status = ui.elements.get("cui-json-status")!;
  assert.match(button.textContent, /取得/);
  button.click();
  button.click();
  assert.match(status.textContent, /読込/);
  assert.equal(output.textContent, "");
  assert.equal(button.disabled, true);
  await settle();
  await settle();
  const payload = JSON.parse(output.textContent) as { sessions: unknown[]; operations: Array<Record<string, unknown>>; logs: unknown[] };
  assert.equal(payload.sessions.length, 1, "the selected session is the only session shown");
  assert.deepEqual(payload.sessions[0], { sessionId: "selected-session", purpose: null, workingDirectory: null, createdAt: "2026-10-01T00:00:00.000Z", lastAccessAt: "2026-10-02T00:00:00.000Z", state: "active" });
  assert.equal(payload.operations[0]?.connectionId, "selected-session");
  assert.equal(payload.operations[0]?.label, undefined, "command-like label is excluded");
  assert.equal(payload.logs.length, 200, "display count is bounded");
  assert.ok(ui.calls.some(({ url }) => url.pathname === "/api/console-state" && url.searchParams.get("session_id") === "selected-session"));
  assert.ok(ui.calls.some(({ url }) => url.pathname === "/api/logs" && url.searchParams.get("session_id") === "selected-session" && url.searchParams.get("limit") === "200"));
  assert.equal(ui.calls.filter(({ url }) => url.pathname === "/api/logs").length, 1, "rapid refresh clicks do not start duplicate requests");
  assert.doesNotMatch(output.textContent, /SENSITIVE COMMAND|PRIVATE OUTPUT|PRIVATE_CURSOR|PRIVATE_NEWEST/);
  assert.match(status.textContent, /一部/);
});

test("401 clears prior JSON and never falls back to the last successful response", async () => {
  let expire = false;
  const ui = createPanel(async (url) => url.pathname === "/api/console-state"
    ? expire ? httpResponse(401, { error: "unauthorized" }) : httpResponse(200, baseState)
    : httpResponse(200, logPage));
  await settle();
  const button = ui.elements.get("cui-json-refresh")!;
  const output = ui.elements.get("cui-json-output")!;
  button.click(); await settle(); await settle();
  assert.notEqual(output.textContent, "");
  expire = true;
  button.click();
  assert.equal(output.textContent, "", "old data is cleared before the re-fetch completes");
  await settle(); await settle();
  assert.equal(output.textContent, "");
  assert.match(ui.elements.get("cui-json-status")!.textContent, /認証/);
});

test("pagehide invalidates delayed success after the selected session page is left", async () => {
  let resolveState!: (value: ReturnType<typeof httpResponse>) => void;
  let stateCalls = 0;
  const ui = createPanel(async (url) => {
    if (url.pathname === "/api/console-state") {
      stateCalls += 1;
      if (stateCalls === 1) return httpResponse(200, baseState);
      return await new Promise((resolve) => { resolveState = resolve; });
    }
    return httpResponse(200, logPage);
  });
  await settle();
  const button = ui.elements.get("cui-json-refresh")!;
  const output = ui.elements.get("cui-json-output")!;
  button.click(); await settle();
  assert.equal(output.textContent, "");
  ui.windowListeners.get("pagehide")?.();
  resolveState(httpResponse(200, baseState));
  await settle(); await settle();
  assert.equal(output.textContent, "", "late response from the left page cannot repaint its old session");
});

test("logout clears JSON immediately and prevents another request", async () => {
  const ui = createPanel(async (url) => url.pathname === "/api/console-state" ? httpResponse(200, baseState) : httpResponse(200, logPage));
  await settle();
  const button = ui.elements.get("cui-json-refresh")!;
  const output = ui.elements.get("cui-json-output")!;
  button.click(); await settle(); await settle();
  assert.notEqual(output.textContent, "");
  ui.elements.get("user-logout")!.submit();
  assert.equal(output.textContent, "");
  assert.equal(button.disabled, true);
});

test("logout aborts and invalidates a delayed response", async () => {
  let stateCalls = 0;
  let resolveState!: (value: ReturnType<typeof httpResponse>) => void;
  const ui = createPanel(async (url) => {
    if (url.pathname !== "/api/console-state") return httpResponse(200, logPage);
    stateCalls += 1;
    if (stateCalls === 1 || stateCalls === 2) return httpResponse(200, baseState);
    return await new Promise((resolve) => { resolveState = resolve; });
  });
  await settle();
  const button = ui.elements.get("cui-json-refresh")!;
  const output = ui.elements.get("cui-json-output")!;
  button.click(); await settle(); await settle();
  assert.notEqual(output.textContent, "");
  button.click(); await settle();
  const pending = ui.calls.findLast(({ url }) => url.pathname === "/api/console-state")!;
  assert.equal(output.textContent, "");
  ui.elements.get("user-logout")!.submit();
  assert.equal((pending.init?.signal as AbortSignal).aborted, true);
  resolveState(httpResponse(200, baseState));
  await settle(); await settle();
  assert.equal(output.textContent, "");
});

test("SSE auth expiry clears JSON and ends the panel session", async () => {
  const ui = createPanel(async (url) => url.pathname === "/api/console-state" ? httpResponse(200, baseState) : httpResponse(200, logPage));
  await settle();
  const button = ui.elements.get("cui-json-refresh")!;
  const output = ui.elements.get("cui-json-output")!;
  button.click(); await settle(); await settle();
  assert.notEqual(output.textContent, "");
  ui.streams[0]!.dispatch("auth-expired");
  assert.equal(output.textContent, "");
  assert.equal(button.disabled, true);
});

test("unselected panel caps all three arrays at 200 and marks the output partial", async () => {
  const manyState = {
    ...baseState,
    sessions: Array.from({ length: 201 }, (_, index) => ({ session_id: `session-${index}`, purpose: null, working_directory: null, created_at: "2026-10-01T00:00:00.000Z", last_used_at: "2026-10-02T00:00:00.000Z", state: "closed", active: false })),
    running: Array.from({ length: 201 }, (_, index) => ({ operation_id: `op-${index}`, connection_id: `connection-${index}`, label: "PRIVATE LABEL", status: "running" })),
  };
  const ui = createPanel(async (url) => url.pathname === "/api/console-state" ? httpResponse(200, manyState) : httpResponse(200, logPage));
  await settle();
  ui.elements.get("log-console")!.dataset.sessionId = "";
  ui.elements.get("cui-json-panel")!.dataset.sessionId = "";
  const button = ui.elements.get("cui-json-refresh")!;
  button.click(); await settle(); await settle();
  const payload = JSON.parse(ui.elements.get("cui-json-output")!.textContent) as { sessions: unknown[]; operations: unknown[]; logs: unknown[] };
  assert.equal(payload.sessions.length, 200);
  assert.equal(payload.operations.length, 200);
  assert.equal(payload.logs.length, 200);
  assert.match(ui.elements.get("cui-json-status")!.textContent, /一部/);
  assert.ok(ui.calls.some(({ url }) => url.pathname === "/api/logs" && !url.searchParams.has("session_id")));
});

test("invalid required date clears the panel instead of coercing null", async () => {
  const invalid = { ...baseState, sessions: [{ ...baseState.sessions[0], created_at: null }] };
  const ui = createPanel(async (url) => url.pathname === "/api/console-state" ? httpResponse(200, invalid) : httpResponse(200, logPage));
  await settle();
  ui.elements.get("cui-json-refresh")!.click(); await settle(); await settle();
  assert.equal(ui.elements.get("cui-json-output")!.textContent, "");
  assert.match(ui.elements.get("cui-json-status")!.textContent, /取得できません/);
});

test("server failure clears data and leaves a retryable error state", async () => {
  const ui = createPanel(async (url) => url.pathname === "/api/console-state" ? httpResponse(200, baseState) : httpResponse(503, { error: "private internal detail" }));
  await settle();
  ui.elements.get("cui-json-refresh")!.click(); await settle(); await settle();
  assert.equal(ui.elements.get("cui-json-output")!.textContent, "");
  assert.match(ui.elements.get("cui-json-status")!.textContent, /取得できません/);
  assert.doesNotMatch(ui.elements.get("cui-json-status")!.textContent, /private/);
  assert.equal(ui.elements.get("cui-json-refresh")!.disabled, false);
});

test("invalid enum response clears panel content instead of rendering partial data", async () => {
  const invalid = { ...baseState, running: [{ ...baseState.running[0], status: "complete" }] };
  const ui = createPanel(async (url) => url.pathname === "/api/console-state" ? httpResponse(200, invalid) : httpResponse(200, logPage));
  await settle();
  const button = ui.elements.get("cui-json-refresh")!;
  const output = ui.elements.get("cui-json-output")!;
  button.click(); await settle(); await settle();
  assert.equal(output.textContent, "");
  assert.match(ui.elements.get("cui-json-status")!.textContent, /取得できません/);
});
