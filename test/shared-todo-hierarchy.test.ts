import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RemoteDesktopService, type RuntimeConfig } from "../src/index.js";

type Item = { id: string; text: string; status: string; parent_id: string | null; order: number; child_total: number; child_completed: number; descendant_incomplete: number };
type Snapshot = { session_id: string; version: number; items: Item[]; total: number; completed: number; last_updated_at: string | null; conflict?: boolean };

// 実際のMCP受付を通し、入力スキーマと共通処理の両方を検証する。
async function setup(t: TestContext) {
  const owner = "owner@example.test";
  const config: RuntimeConfig = { baseUrl: "http://127.0.0.1", tokenSecret: "x".repeat(32), users: [{ email: owner, passwordHash: "unused" }], roots: [], dataDir: path.join(process.cwd(), "reference/subtasks/contract-data"), port: 0, chunkBytes: 1024, nodeId: "local", nodeLabel: "This PC", dcCommand: process.execPath, dcArgs: [], allowedRedirectOrigins: new Set() };
  const service = new RemoteDesktopService(config);
  const auditEvents: string[] = [];
  service.audit = async (event) => { auditEvents.push(event); };
  const [left, right] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "shared-todo-hierarchy-contract", version: "1" });
  const server = service.server(owner);
  await Promise.all([client.connect(left), server.connect(right)]);
  t.after(async () => { await client.close(); await server.close(); await service.close(); });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: { comment: "親子構成の契約テスト", ...args } });
    const block = "content" in result ? result.content.find((entry) => entry.type === "text") : undefined;
    if (result.isError) throw new Error(block?.text ?? "MCP failed");
    return JSON.parse(block?.text ?? "{}");
  };
  const open = async () => String((await call("session_open", { working_directory: process.cwd(), purpose: "親子構成のテスト" })).session_id);
  const session = await open();
  const get = async (): Promise<Snapshot> => call("todo_get", { session_id: session });
  const update = async (changes: unknown[], version?: number): Promise<Snapshot> => call("todo_update", { session_id: session, expected_version: version ?? (await get()).version, changes });
  const add = async (text: string, parent_id?: string | null, status = "not_started") => {
    const result = await update([{ op: "add", text, status, ...(parent_id === undefined ? {} : { parent_id }) }]);
    const item = result.items.find((entry) => entry.text === text); assert.ok(item); return item.id;
  };
  return { service, owner, session, auditEvents, call, open, get, update, add };
}

test("MCP応答から親子孫の構成と直属・配下の進捗を復元できる", async (t) => {
  const h = await setup(t);
  const a = await h.add("親A", undefined, "in_progress");
  const b = await h.add("親B");
  const c = await h.add("子C", a, "completed");
  const d = await h.add("子D", a, "completed");
  const e = await h.add("孫E", c);
  const snapshot = await h.get();
  assert.deepEqual(snapshot.items.map((item) => [item.id, item.parent_id, item.order]), [[a, null, 0], [c, a, 0], [e, c, 0], [d, a, 1], [b, null, 1]]);
  const parent = snapshot.items.find((item) => item.id === a)!;
  assert.equal(parent.child_total, 2);
  assert.equal(parent.child_completed, 2);
  assert.equal(parent.descendant_incomplete, 1);
  assert.equal(parent.status, "in_progress");
  assert.equal(snapshot.total, 5);
  assert.equal(snapshot.completed, 2);
  await h.update([{ op: "status", id: a, status: "completed" }]);
  assert.equal((await h.get()).items.find((item) => item.id === e)?.status, "not_started");
  await h.update([{ op: "status", id: e, status: "completed" }, { op: "status", id: c, status: "in_progress" }]);
  assert.equal((await h.get()).items.find((item) => item.id === a)?.status, "completed");
});

test("兄弟の並べ替えと親変更・解除は配下の識別子と状態を保持する", async (t) => {
  const h = await setup(t);
  const a = await h.add("A"); const b = await h.add("B");
  const c = await h.add("C", a); const d = await h.add("D", a);
  const e = await h.add("E", c, "in_progress");
  await h.update([{ op: "move", id: b, order: 0 }, { op: "move", id: d, order: 0 }]);
  assert.deepEqual((await h.get()).items.map((item) => item.id), [b, a, d, c, e]);
  await h.update([{ op: "reparent", id: c, parent_id: b }]);
  assert.deepEqual((await h.get()).items.map((item) => item.id), [b, c, e, a, d]);
  await h.update([{ op: "reparent", id: c, parent_id: null }]);
  const detached = await h.get();
  assert.deepEqual(detached.items.map((item) => item.id), [b, a, d, c, e]);
  assert.equal(detached.items.find((item) => item.id === e)?.parent_id, c);
  assert.equal(detached.items.find((item) => item.id === e)?.status, "in_progress");
  await h.update([{ op: "edit", id: e, text: "E更新" }]);
  assert.equal((await h.get()).items.find((item) => item.id === e)?.parent_id, c);
  await h.update([{ op: "reparent", id: b, parent_id: null }]);
  assert.deepEqual((await h.get()).items.filter((item) => item.parent_id === null).map((item) => item.id), [b, a, c]);
});

test("深さ8を許可し、作成と子孫を伴う親変更の深さ9を拒否する", async (t) => {
  const h = await setup(t);
  const chain: string[] = [];
  for (let index = 0; index < 8; index += 1) chain.push(await h.add(`階層${index + 1}`, chain.at(-1)));
  const before = await h.get();
  await assert.rejects(h.add("階層9", chain[7]), /TODO_DEPTH_LIMIT/);
  assert.deepEqual(await h.get(), before);
  const a = await h.add("移動A"); const b = await h.add("移動B", a); const c = await h.add("移動C", b);
  await h.update([{ op: "reparent", id: a, parent_id: chain[4] }]);
  assert.equal((await h.get()).items.find((item) => item.id === c)?.parent_id, b);
  const atEight = await h.get();
  await assert.rejects(h.update([{ op: "reparent", id: a, parent_id: chain[5] }]), /TODO_DEPTH_LIMIT/);
  assert.deepEqual(await h.get(), atEight);
});

test("自己・循環・不存在・別セッションの親を拒否する", async (t) => {
  const h = await setup(t);
  const a = await h.add("A"); const b = await h.add("B", a); const c = await h.add("C", b);
  const before = await h.get();
  await assert.rejects(h.update([{ op: "reparent", id: a, parent_id: a }]), /TODO_PARENT_CYCLE/);
  await assert.rejects(h.update([{ op: "reparent", id: a, parent_id: c }]), /TODO_PARENT_CYCLE/);
  await assert.rejects(h.add("不正な子", "missing-parent"), /TODO_PARENT_UNAVAILABLE/);
  const otherSession = await h.open();
  const other = await h.call("todo_update", { session_id: otherSession, expected_version: 0, changes: [{ op: "add", text: "別セッション" }] });
  await assert.rejects(h.update([{ op: "reparent", id: b, parent_id: other.items[0].id }]), /TODO_PARENT_UNAVAILABLE/);
  assert.deepEqual(await h.get(), before);
  await assert.rejects(h.service.todoGet("another@example.test", h.session), /invalid|expired|another user/i);
});

test("子を持つ親の削除と一括更新の後半失敗は状態・版・期限を変えない", async (t) => {
  const h = await setup(t);
  const a = await h.add("A"); const b = await h.add("B", a, "completed");
  const before = await h.get();
  const deadline = h.service.sessions.get(h.session)!.todo.lastTodoUpdatedMono;
  const updates = h.auditEvents.filter((event) => event === "todo.updated").length;
  await assert.rejects(h.update([{ op: "edit", id: a, text: "保存されない" }, { op: "status", id: b, status: "in_progress" }, { op: "delete", id: a }]), /TODO_HAS_CHILDREN/);
  assert.deepEqual(await h.get(), before);
  assert.equal(h.service.sessions.get(h.session)!.todo.lastTodoUpdatedMono, deadline);
  assert.equal(h.auditEvents.filter((event) => event === "todo.updated").length, updates);
  await assert.rejects(h.update([{ op: "move", id: b, order: 999 }, { op: "reparent", id: a, parent_id: b }]), /TODO_PARENT_CYCLE/);
  assert.deepEqual(await h.get(), before);
  await h.update([{ op: "reparent", id: b, parent_id: null }, { op: "delete", id: a }]);
  assert.deepEqual((await h.get()).items.map((item) => [item.id, item.parent_id]), [[b, null]]);
});

test("親子孫を合わせた200件上限を維持する", async (t) => {
  const h = await setup(t);
  const parent = await h.add("親");
  await h.update(Array.from({ length: 198 }, (_, index) => ({ op: "add", text: `子${index}`, parent_id: parent })));
  const last = await h.add("200件目", parent);
  const before = await h.get();
  assert.equal(before.total, 200);
  assert.equal(before.items[0]?.child_total, 199);
  await assert.rejects(h.add("201件目", parent), /limit/i);
  assert.deepEqual(await h.get(), before);
  await h.update([{ op: "reparent", id: last, parent_id: null }]);
  assert.equal((await h.get()).total, 200);
});

test("同じ版からの親変更は一つだけ成功し、競合応答は最新の階層を返す", async (t) => {
  const h = await setup(t);
  const a = await h.add("A"); const b = await h.add("B"); const c = await h.add("C");
  const version = (await h.get()).version;
  const results = await Promise.all([h.update([{ op: "reparent", id: c, parent_id: a }], version), h.update([{ op: "reparent", id: c, parent_id: b }], version)]);
  assert.equal(results.filter((result) => result.conflict === true).length, 1);
  const snapshot = await h.get();
  assert.equal(snapshot.version, version + 1);
  assert.ok([a, b].includes(snapshot.items.find((item) => item.id === c)!.parent_id!));
  assert.deepEqual(results.find((result) => result.conflict)?.items, snapshot.items);
});

test("親を指定しない従来の追加・編集・状態変更・並べ替え・削除を維持する", async (t) => {
  const h = await setup(t);
  const a = await h.add("A"); const b = await h.add("B"); const c = await h.add("C");
  await h.update([{ op: "edit", id: a, text: "A編集" }, { op: "status", id: b, status: "completed" }, { op: "move", id: c, order: 0 }]);
  const snapshot = await h.get();
  assert.deepEqual(snapshot.items.map((item) => [item.id, item.parent_id, item.order]), [[c, null, 0], [a, null, 1], [b, null, 2]]);
  assert.equal(snapshot.completed, 1);
  await h.update([{ op: "move", id: c, order: 999 }, { op: "delete", id: a }]);
  assert.deepEqual((await h.get()).items.map((item) => item.id), [b, c]);
});
