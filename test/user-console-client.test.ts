import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { chronologicalPage, mergeBoundedItems, userConsoleClientScript, type ConsoleLogItem } from "../src/user-console-client.js";

const item = (id: string): ConsoleLogItem => ({ id, cursor: "cursor-" + id, event: { id } });

test("client paging helpers preserve cursor order, deduplicate, and cap retained events", () => {
  assert.deepEqual(chronologicalPage([item("3"), item("2"), item("1")]).map((entry) => entry.id), ["1", "2", "3"]);
  assert.deepEqual(mergeBoundedItems([item("1"), item("2")], [item("2"), item("3")], 2).map((entry) => entry.id), ["2", "3"]);
});

class FakeElement {
  dataset: Record<string, string> = {};
  hidden = false;
  disabled = false;
  textContent = "";
  listeners = new Map<string, () => void>();
  addEventListener(name: string, listener: () => void) { this.listeners.set(name, listener); }
  click(name = "click") { this.listeners.get(name)?.(); }
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

function response(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

async function settle() { await new Promise((resolve) => setTimeout(resolve, 0)); }

function boot(fetchImpl: (url: string) => Promise<ReturnType<typeof response>>) {
  FakeEventSource.instances = [];
  const root = new FakeElement(); root.dataset = { sessionId: "", newestCursor: "c0", oldestCursor: "c-older", hasMoreOlder: "false" };
  const status = new FakeElement();
  const newest = new FakeElement(); newest.hidden = true;
  const older = new FakeElement(); older.hidden = true;
  const stateButton = new FakeElement();
  const elements = new Map<string, FakeElement>([["log-console", root], ["log-status", status], ["log-new-button", newest], ["log-older-button", older], ["state-refresh", stateButton]]);
  const scrollY = 0; let scrollCalls = 0;
  const windowStub = { scrollY, scrollX: 0, innerHeight: 600, addEventListener: () => undefined, scrollTo: () => { scrollCalls += 1; } };
  const documentStub = { getElementById: (id: string) => elements.get(id) ?? null, documentElement: { scrollHeight: 1200 } };
  runInNewContext(userConsoleClientScript, { document: documentStub, window: windowStub, fetch: fetchImpl, EventSource: FakeEventSource, URLSearchParams, encodeURIComponent });
  return { root, status, newest, older, stateButton, windowStub, get scrollCalls() { return scrollCalls; }, sources: FakeEventSource.instances };
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
  assert.equal(ui.newest.textContent, "新しいログ 3件");
  assert.equal(calls.filter((url) => url.pathname === "/api/logs").length, 0, "SSE notification does not fetch log bodies");
  assert.equal(ui.scrollCalls, 0, "SSE notification does not move the page");

  ui.newest.click();
  await settle();
  await settle();
  assert.equal(ui.root.dataset.newestCursor, "c3");
  assert.equal(initialSource.closed, true, "the old stream closes after applying logs");
  assert.match(ui.sources[1]!.url, /after=c3/);
  assert.deepEqual(calls.filter((url) => url.pathname === "/api/logs").map((url) => url.searchParams.get("after")), ["c0", "c2"]);
  assert.equal(ui.newest.hidden, true);
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
