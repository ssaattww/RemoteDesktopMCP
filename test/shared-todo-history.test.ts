import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApp, RemoteDesktopService, type RuntimeConfig } from "../src/index.js";
import { protectPrivateDirectory } from "../src/private-storage.js";
import { hashPassword } from "../src/hash-password.js";

const owner = "owner@example.test";
const sessionId = "history-session-0001";
async function setup(t: TestContext) {
  const base = await mkdtemp(path.join(tmpdir(), "rdmcp-history-"));
  const dataDir = path.join(base, "data"); await mkdir(dataDir); await protectPrivateDirectory(dataDir);
  const cfg: RuntimeConfig = { baseUrl: "http://127.0.0.1", tokenSecret: "h".repeat(32), users: [{ email: owner, passwordHash: await hashPassword("history-password") }, { email: "other@example.test", passwordHash: await hashPassword("history-password") }], roots: [], dataDir, port: 0, chunkBytes: 1024, nodeId: "local", nodeLabel: "This PC", dcCommand: process.execPath, dcArgs: [], allowedRedirectOrigins: new Set() };
  const service = new RemoteDesktopService(cfg);
  service.sessions.set(sessionId, { id: sessionId, user: owner, version: 1, workingDirectory: process.cwd(), purpose: "history", created: Date.now(), touched: Date.now(), expires: Date.now() + 86400000, state: "active", todo: { items: [], version: 0, lastTodoUpdatedMono: null, lastUpdatedAt: null, enabled: true, enabledAtMono: 0 } } as never);
  await service.audit("session.open", { user: owner, sessionId, workingDirectory: process.cwd(), purpose: "history" });
  t.after(async () => { await service.close(); await rm(base, { recursive: true, force: true }); });
  const update = async (changes: unknown, source: "mcp" | "user_console" = "mcp") => service.todoUpdate(owner, sessionId, service.sessions.get(sessionId)!.todo.version, changes, source);
  const history = () => service.todoHistory(owner, sessionId);
  return { service, cfg, dataDir, update, history };
}

test("history stores committed before/after values including implicit sibling changes and deleted items", async (t) => {
  const h = await setup(t);
  const first = await h.update([{ op: "add", text: "A" }, { op: "add", text: "B" }]);
  const [a, b] = first.items;
  assert.ok(a && b);
  await h.update([{ op: "edit", id: a.id, text: "intermediate" }, { op: "edit", id: a.id, text: "final <script>" }, { op: "status", id: a.id, status: "completed" }, { op: "move", id: b.id, order: 0 }], "user_console");
  await h.update([{ op: "reparent", id: a.id, parent_id: b.id }]);
  await h.update([{ op: "delete", id: a.id }]);
  const page = await h.history();
  assert.equal(page.revisions.length, 4);
  assert.equal(page.revisions[0]!.changes[0]!.before, null);
  const edited = page.revisions[1]!;
  assert.equal(edited.actor, owner); assert.equal(edited.source, "user_console");
  assert.match(edited.at, /^\d{4}-\d\d-/);
  assert.deepEqual(edited.changes.map((entry) => entry.item_id).sort(), [a.id, b.id].sort());
  const change = edited.changes.find((entry) => entry.item_id === a.id)!;
  assert.equal(change.before!.text, "A"); assert.equal(change.after!.text, "final <script>");
  assert.equal(change.after!.status, "completed"); assert.equal(change.after!.order, 1);
  assert.ok(!JSON.stringify(edited).includes("intermediate"));
  assert.equal(page.revisions[2]!.changes.find((entry) => entry.item_id === a.id)!.after!.parent_id, b.id);
  assert.equal(page.revisions[3]!.changes.find((entry) => entry.item_id === a.id)!.after, null);
  assert.deepEqual(page.revisions[3]!.snapshot.map((entry) => entry.id), [b.id]);
  assert.equal(page.current_version, 4); assert.equal(page.window.pre_feature_history, "unavailable");
});

test("conflict, rejection and failure remain separate; submitted rejected text is not persisted", async (t) => {
  const h = await setup(t);
  await h.update([{ op: "add", text: "saved" }]);
  const id = h.service.sessions.get(sessionId)!.todo.items[0]!.id;
  const conflict = await h.service.todoUpdate(owner, sessionId, 0, [{ op: "edit", id, text: "PRIVATE-CONFLICT" }]);
  assert.equal("conflict" in conflict && conflict.conflict, true);
  await assert.rejects(h.update([{ op: "edit", id, text: "PRIVATE-REJECT" }, { op: "delete", id: "missing" }]));
  await assert.rejects(h.update([{ op: "add", text: "PRIVATE-INVALID", status: "wrong" }]));
  const items = h.service.sessions.get(sessionId)!.todo.items;
  h.service.sessions.get(sessionId)!.todo.items = new Proxy(items, { get(target, key, receiver) { if (key === "map") throw new Error("PRIVATE-FAILURE"); return Reflect.get(target, key, receiver); } });
  await assert.rejects(h.update([{ op: "add", text: "PRIVATE-FAILED" }]));
  h.service.sessions.get(sessionId)!.todo.items = items;
  const page = await h.history();
  assert.equal(page.revisions.length, 1);
  assert.deepEqual(page.attempts.map((entry) => entry.outcome), ["conflict", "rejected", "rejected", "failed"]);
  assert.ok(!JSON.stringify(page).includes("PRIVATE-"));
  assert.ok(!(await readFile(path.join(h.dataDir, "audit.jsonl"), "utf8")).includes("PRIVATE-"));
  assert.equal((await h.service.todoGet(owner, sessionId)).version, 1);
});

test("append failure reports applied state and later history discloses version gaps", async (t) => {
  const h = await setup(t); await h.update([{ op: "add", text: "before" }]);
  const id = h.service.sessions.get(sessionId)!.todo.items[0]!.id;
  const audit = h.service.audit.bind(h.service);
  h.service.audit = async (event, fields) => { if (event === "todo.updated") throw new Error("injected failure"); return audit(event, fields); };
  const result = await h.update([{ op: "edit", id, text: "applied without confirmed history" }]);
  assert.equal(result.applied, true); assert.equal(result.audit_warning, true); assert.equal(result.history_recorded, false);
  const gap = await h.history(); assert.equal(gap.current_version, 2); assert.equal(gap.window.latest_recorded_version, 1); assert.equal(gap.window.current_version_unrecorded, true);
  h.service.audit = audit;
  await h.update([{ op: "status", id, status: "completed" }]);
  assert.equal((await h.history()).window.version_gaps, true);
});

test("owner-scoped history is readonly, retained after close/expiry/restart and bounded without inferred history", async (t) => {
  const h = await setup(t);
  for (let index = 0; index < 52; index++) await h.update(index === 0 ? [{ op: "add", text: "item" }] : [{ op: "edit", id: h.service.sessions.get(sessionId)!.todo.items[0]!.id, text: String(index) }]);
  await h.service.audit("todo.update_attempt", { user: "other@example.test", sessionId, history_schema: 1, source: "mcp", actor: "other@example.test", outcome: "rejected", reason: "invalid_changes", expected_version: 0 });
  const before = structuredClone(h.service.sessions.get(sessionId));
  const auditBefore = await readFile(path.join(h.dataDir, "audit.jsonl"), "utf8");
  const page = await h.history();
  assert.equal(page.revisions.length, 50); assert.equal(page.window.response_truncated, true); assert.equal(page.revisions[0]!.version, 3); assert.equal(page.attempts.length, 0);
  assert.deepEqual(h.service.sessions.get(sessionId), before);
  assert.equal(await readFile(path.join(h.dataDir, "audit.jsonl"), "utf8"), auditBefore);
  await assert.rejects(h.service.todoHistory("other@example.test", sessionId), /unavailable/i);
  await assert.rejects(h.service.todoHistory(owner, "unknown"), /unavailable/i);
  for (const state of ["closed", "expired"] as const) { h.service.sessions.get(sessionId)!.state = state; assert.equal((await h.history()).revisions.length, 50); }
  const restarted = new RemoteDesktopService(h.cfg); t.after(() => restarted.close());
  assert.equal((await restarted.todoHistory(owner, sessionId)).revisions.length, 50);
  await assert.rejects(restarted.todoHistory("other@example.test", sessionId), /unavailable/i);
});

test("MCP history bypasses stale gate, operation audit and session touch", async (t) => {
  const h = await setup(t); await h.update([{ op: "add", text: "MCP" }]);
  h.service.sessions.get(sessionId)!.todo.lastTodoUpdatedMono = -10000000;
  const [left, right] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "history-contract", version: "1" }); const server = h.service.server(owner);
  await Promise.all([client.connect(left), server.connect(right)]); t.after(async () => { await client.close(); await server.close(); });
  const updated = await client.callTool({ name: "todo_update", arguments: { session_id: sessionId, expected_version: 1, changes: [{ op: "status", id: h.service.sessions.get(sessionId)!.todo.items[0]!.id, status: "completed" }], comment: "Record an MCP update" } });
  assert.ok(!updated.isError);
  const before = structuredClone(h.service.sessions.get(sessionId));
  const auditBefore = await readFile(path.join(h.dataDir, "audit.jsonl"), "utf8");
  const result = await client.callTool({ name: "todo_history", arguments: { session_id: sessionId, comment: "Read historical revisions" } });
  assert.ok(!result.isError); const content = "content" in result ? result.content.find((entry) => entry.type === "text") : undefined;
  const page = JSON.parse(content?.text ?? "{}");
  assert.equal(page.revisions.length, 2); assert.equal(page.revisions[1].source, "mcp");
  const malformed = await client.callTool({ name: "todo_history", arguments: { session_id: "short", comment: "Check invalid history input" } });
  assert.equal(malformed.isError, true, "invalid readonly requests must not enter operation audit either");
  assert.deepEqual(h.service.sessions.get(sessionId), before);
  assert.equal(await readFile(path.join(h.dataDir, "audit.jsonl"), "utf8"), auditBefore);
});

test("history reports the audit-window boundary and proves ownership without the older session-open record", async (t) => {
  const h = await setup(t);
  h.service.sessions.get(sessionId)!.todo.version = 7;
  const empty = await h.history();
  assert.deepEqual(empty.revisions, []); assert.equal(empty.window.complete, false); assert.equal(empty.window.current_version_unrecorded, true);
  const filler = JSON.stringify({ at: "2026-11-08T00:00:00Z", event: "unrelated" }) + "\n";
  await appendFile(path.join(h.dataDir, "audit.jsonl"), filler.repeat(20000));
  await h.update([{ op: "add", text: "retained" }]);
  const record = (await h.history()).revisions[0]!;
  await h.service.audit("todo.updated", { ...record, sessionId: "different-owned-session", snapshot: record.snapshot.map((item) => ({ ...item, text: "PRIVATE-OTHER-SESSION" })) });
  h.service.sessions.clear();
  const page = await h.history();
  assert.equal(page.window.index_truncated, true); assert.equal(page.revisions[0]!.version, 8);
  assert.ok(!JSON.stringify(page).includes("PRIVATE-OTHER-SESSION"));
  await assert.rejects(h.service.todoHistory("other@example.test", sessionId), /unavailable/i);
  const restarted = new RemoteDesktopService(h.cfg); t.after(() => restarted.close());
  assert.equal((await restarted.todoHistory(owner, sessionId)).revisions[0]!.version, 8);
});

test("authenticated HTTP and SSR expose escaped readonly history and preserve owner isolation", async (t) => {
  const h = await setup(t); await h.update([{ op: "add", text: "<script>history</script>" }], "user_console");
  const server = createApp(h.service).listen(0, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string"); const baseUrl = `http://127.0.0.1:${address.port}`;
  const login = async (email: string) => { const response = await fetch(`${baseUrl}/user/login`, { method: "POST", headers: { origin: h.cfg.baseUrl, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email, password: "history-password" }), redirect: "manual" }); return `rdmcp_user=${/rdmcp_user=([^;,]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1]}`; };
  const cookie = await login(owner); const other = await login("other@example.test");
  const route = `${baseUrl}/api/sessions/${sessionId}/todo/history`;
  assert.equal((await fetch(route)).status, 401);
  assert.equal((await fetch(route, { headers: { cookie: other } })).status, 404);
  const response = await fetch(route, { headers: { cookie } }); assert.equal(response.status, 200); assert.equal((await response.json()).revisions.length, 1);
  const html = await (await fetch(`${baseUrl}/user/sessions/${sessionId}`, { headers: { cookie } })).text();
  assert.ok(html.includes('id="todo-history"')); assert.ok(html.includes('data-history-prev')); assert.ok(html.includes('data-history-next'));
  assert.ok(html.includes("&lt;script&gt;history&lt;/script&gt;")); assert.ok(!html.includes("<script>history</script>"));
  assert.ok(!html.includes("サブTodoは各親の"));
  const csrf = /data-csrf="([^"]+)"/.exec(html)?.[1]; assert.ok(csrf);
  const id = h.service.sessions.get(sessionId)!.todo.items[0]!.id;
  const changed = await fetch(`${baseUrl}/api/sessions/${sessionId}/todo`, { method: "PUT", headers: { cookie, origin: h.cfg.baseUrl, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ expected_version: 1, changes: [{ op: "edit", id, text: "via authenticated HTTP" }] }) });
  assert.equal(changed.status, 200);
  const history = await (await fetch(route, { headers: { cookie } })).json();
  assert.equal(history.revisions.at(-1).source, "user_console"); assert.equal(history.revisions.at(-1).changes[0].after.text, "via authenticated HTTP");
  h.service.sessions.get(sessionId)!.state = "closed";
  assert.equal((await fetch(route, { headers: { cookie } })).status, 200);
});

test("R84-N03 ended history remains accessible in SSR beyond 500 sessions before and after restart", async (t) => {
  const h = await setup(t);
  await h.update([{ op: "add", text: "<script>retained ended history</script>" }]);
  h.service.sessions.get(sessionId)!.state = "closed";
  await h.service.audit("session.close", { user: owner, sessionId });
  h.service.sessions.delete(sessionId);
  const later = Array.from({ length: 501 }, (_, index) => JSON.stringify({ at: "2026-11-08T00:00:00Z", event: "session.open", user: owner, sessionId: `later-owned-session-${index}` }) + "\n").join("");
  await appendFile(path.join(h.dataDir, "audit.jsonl"), later);
  const restarted = new RemoteDesktopService(h.cfg); t.after(() => restarted.close());
  for (const service of [h.service, restarted]) {
    const server = createApp(service).listen(0, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const address = server.address(); assert.ok(address && typeof address !== "string"); const baseUrl = `http://127.0.0.1:${address.port}`;
      const login = async (email: string) => {
        const result = await fetch(`${baseUrl}/user/login`, { method: "POST", headers: { origin: h.cfg.baseUrl, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email, password: "history-password" }), redirect: "manual" });
        const token = /rdmcp_user=([^;,]+)/.exec(result.headers.get("set-cookie") ?? "")?.[1]; assert.ok(token); return `rdmcp_user=${token}`;
      };
      const cookie = await login(owner); const other = await login("other@example.test");
      const sessionsBefore = structuredClone([...service.sessions]);
      const auditBefore = await readFile(path.join(h.dataDir, "audit.jsonl"), "utf8");
      const api = await fetch(`${baseUrl}/api/sessions/${sessionId}/todo/history`, { headers: { cookie } });
      assert.equal(api.status, 200); const history = await api.json();
      assert.equal(history.revisions.length, 1); assert.equal(history.window.index_truncated, false);
      const shown = await fetch(`${baseUrl}/user/sessions/${sessionId}`, { headers: { cookie } });
      assert.equal(shown.status, 200, "the UI must retain the same ended-session access as the history API");
      const html = await shown.text(); const main = /<main>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? "";
      const encoded = /data-history="([^"]+)"/.exec(main)?.[1]; assert.ok(encoded);
      const decoded = encoded.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      assert.deepEqual(JSON.parse(decoded), history);
      assert.ok(main.includes("&lt;script&gt;retained ended history&lt;/script&gt;"));
      assert.ok(!main.includes("<script>retained ended history</script>"));
      assert.ok(!main.includes('id="session-todo"')); assert.ok(!main.includes("作成日時:")); assert.ok(!main.includes("作業ディレクトリ:"));
      assert.ok(main.includes('href="/user"')); assert.ok(html.includes("initializeTodoHistory"));
      assert.equal((await fetch(`${baseUrl}/user/sessions/${sessionId}`, { headers: { cookie: other } })).status, 404);
      assert.equal((await fetch(`${baseUrl}/api/sessions/${sessionId}/todo/history`, { headers: { cookie: other } })).status, 404);
      assert.equal((await fetch(`${baseUrl}/user/sessions/unknown-session-0000`, { headers: { cookie } })).status, 404);
      assert.equal((await fetch(`${baseUrl}/api/sessions/unknown-session-0000/todo/history`, { headers: { cookie } })).status, 404);
      assert.equal((await fetch(`${baseUrl}/api/sessions/${sessionId}/todo`, { headers: { cookie } })).status, 404);
      assert.deepEqual([...service.sessions], sessionsBefore); assert.equal(service.sessions.size, 0);
      assert.equal(await readFile(path.join(h.dataDir, "audit.jsonl"), "utf8"), auditBefore);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  }
});
