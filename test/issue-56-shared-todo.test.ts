import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createApp, RemoteDesktopService, type RuntimeConfig } from "../src/index.js";
import { hashPassword } from "../src/hash-password.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { performance } from "node:perf_hooks";
import { protectPrivateDirectory } from "../src/private-storage.js";

async function harness() {
  const config: RuntimeConfig = {
    baseUrl: "http://127.0.0.1",
    tokenSecret: "x".repeat(32),
    users: [{ email: "owner@example.test", passwordHash: "unused" }],
    roots: [],
    dataDir: "/tmp/rdmcp-issue-56-contract-test",
    port: 0,
    chunkBytes: 1024,
    nodeId: "local",
    nodeLabel: "This PC",
    dcCommand: process.execPath,
    dcArgs: [],
    allowedRedirectOrigins: new Set(),
  };
  const service = new RemoteDesktopService(config);
  const audits: Array<{ event: string; fields: Record<string, unknown> }> = [];
  let auditFailure: Error | undefined;
  service.audit = async (event, fields) => {
    if (auditFailure) throw auditFailure;
    audits.push({ event, fields });
  };

  async function connect(user: string) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "issue-56-contract-test", version: "1" });
    const server = service.server(user);
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    return {
      async listTools() { return client.listTools(); },
      async call(name: string, args: Record<string, unknown> = {}) {
        const response = await client.callTool({ name, arguments: { comment: "テスト", ...args } });
        const content = "content" in response ? response.content.find((item) => item.type === "text") : undefined;
        if (response.isError) throw new Error(content?.text ?? "tool failed");
        return JSON.parse(content?.text ?? "{}") as Record<string, unknown>;
      },
      async close() { await client.close(); await server.close(); },
    };
  }

  return { service, audits, connect, setAuditFailure(error?: Error) { auditFailure = error; }, async close() { await service.close(); } };
}

async function consoleHarness() {
  const base = await mkdtemp(path.join(tmpdir(), "rdmcp-issue-56-console-"));
  const dataDir = path.join(base, "data");
  await mkdir(dataDir);
  await protectPrivateDirectory(dataDir);
  const config: RuntimeConfig = { baseUrl: "http://127.0.0.1", tokenSecret: "x".repeat(32), users: [{ email: "owner@example.test", passwordHash: await hashPassword("correct-horse-battery") }], roots: [], dataDir, port: 0, chunkBytes: 1024, nodeId: "local", nodeLabel: "This PC", dcCommand: process.execPath, dcArgs: [], allowedRedirectOrigins: new Set() };
  const service = new RemoteDesktopService(config);
  const sessionId = "session-owner-console-0001";
  service.sessions.set(sessionId, { id: sessionId, user: "owner@example.test", workingDirectory: process.cwd(), purpose: "todo console", created: Date.now(), touched: Date.now(), expires: Date.now() + 86_400_000, state: "active", todo: { items: [], version: 0, lastTodoUpdatedMono: null, lastUpdatedAt: null, enabled: true, enabledAtMono: performance.now() } } as never);
  await service.audit("session.open", { user: "owner@example.test", sessionId, workingDirectory: process.cwd(), purpose: "todo console" });
  const server = createApp(service).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${baseUrl}/user/login`, { method: "POST", headers: { origin: config.baseUrl, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "owner@example.test", password: "correct-horse-battery" }), redirect: "manual" });
  const token = /rdmcp_user=([^;,]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(token);
  return { service, sessionId, baseUrl, cookie: `rdmcp_user=${token}`, server, close: async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); await service.close(); await rm(base, { recursive: true, force: true }); } };
}

test("session Todo tools initialize an empty version and accept an authorized update", async () => {
  const h = await harness();
  const owner = await h.connect("owner@example.test");
  const other = await h.connect("other@example.test");
  try {
    const { tools } = await owner.listTools();
    const names = new Set(tools.map((tool) => tool.name));
    assert.ok(names.has("todo_get"), "the session Todo must be readable by the chat");
    assert.ok(names.has("todo_update"), "the session Todo must be writable by the chat");
    assert.ok(names.has("todo_enforcement_set"), "the session freshness gate must be switchable");

    const opened = await owner.call("session_open", { working_directory: process.cwd(), purpose: "todo test" });
    const sessionId = String(opened.session_id);
    const initial = await owner.call("todo_get", { session_id: sessionId });
    assert.equal(initial.version, 0);
    assert.equal(initial.last_updated_at, null);
    await assert.rejects(other.call("todo_get", { session_id: sessionId }), /invalid|expired|another user/i);
    const updated = await owner.call("todo_update", {
      session_id: sessionId,
      expected_version: 0,
      changes: [{ op: "add", text: "complete setup" }],
    });
    assert.equal(updated.version, 1);
    assert.ok(updated.last_updated_at);
    const readBack = await owner.call("todo_get", { session_id: sessionId });
    assert.equal(readBack.version, 1);
  } finally {
    await owner.close();
    await other.close();
    await h.close();
  }
});

test("ordinary session operations allow 299999ms and are denied at the 300000ms boundary", async () => {
  const originalNow = performance.now.bind(performance);
  const originalWallNow = Date.now.bind(Date);
  let monotonicNow = originalNow();
  let wallNow = originalWallNow();
  performance.now = () => monotonicNow;
  Date.now = () => wallNow;
  const h = await harness();
  const owner = await h.connect("owner@example.test");
  try {
    const opened = await owner.call("session_open", { working_directory: process.cwd(), purpose: "freshness test" });
    const sessionId = String(opened.session_id);
    monotonicNow += 299_999;
    wallNow += 299_999;
    await owner.call("node_list", { session_id: sessionId });
    monotonicNow += 1;
    wallNow += 1;
    await assert.rejects(owner.call("node_list", { session_id: sessionId }), /TODO_STALE/);
  } finally {
    performance.now = originalNow;
    Date.now = originalWallNow;
    await owner.close();
    await h.close();
  }
});

test("Todo updates remain available when audit storage fails and report the committed state", async () => {
  const h = await harness();
  const owner = await h.connect("owner@example.test");
  try {
    const opened = await owner.call("session_open", { working_directory: process.cwd(), purpose: "audit recovery test" });
    h.setAuditFailure(new Error("audit unavailable"));
    const updated = await owner.call("todo_update", {
      session_id: String(opened.session_id),
      expected_version: 0,
      changes: [{ op: "add", text: "recover audit" }],
    });
    assert.equal(updated.version, 1);
    assert.equal(updated.audit_warning, true);
    assert.equal(updated.applied, true);
  } finally {
    await owner.close();
    await h.close();
  }
});

test("a failed gate audit prevents dispatching an ordinary side effect", async () => {
  const h = await harness();
  const owner = await h.connect("owner@example.test");
  let started = 0;
  try {
    const opened = await owner.call("session_open", { working_directory: process.cwd(), purpose: "fail closed test" });
    (h.service.cfg as unknown as { processAdapter: RuntimeConfig["processAdapter"] }).processAdapter = {
      async start() { started += 1; return "PID 42"; },
      async read() { return ""; },
      async terminate() { return ""; },
      async sessions() { return "[]"; },
    };
    h.setAuditFailure(new Error("audit unavailable"));
    await assert.rejects(owner.call("process_start", { session_id: String(opened.session_id), node_id: "local", command: "echo side effect", timeout_ms: 1000 }), /TODO_GATE_AUDIT_UNAVAILABLE/);
    assert.equal(started, 0);
  } finally {
    await owner.close();
    await h.close();
  }
});

test("session detail renders the Todo panel before session metadata", async () => {
  const h = await consoleHarness();
  try {
    const response = await fetch(`${h.baseUrl}/user/sessions/${encodeURIComponent(h.sessionId)}`, { headers: { cookie: h.cookie } });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.ok(html.includes('id="session-todo"'));
    assert.ok(html.indexOf('id="session-todo"') < html.indexOf("セッションの内容"));
  } finally { await h.close(); }
});

test("the authenticated Todo HTTP API reads and updates only an owned active session", async () => {
  const h = await consoleHarness();
  try {
    const endpoint = `${h.baseUrl}/api/sessions/${encodeURIComponent(h.sessionId)}/todo`;
    const initial = await fetch(endpoint, { headers: { cookie: h.cookie } });
    assert.equal(initial.status, 200);
    assert.equal((await initial.json() as { version: number }).version, 0);
    const detail = await fetch(`${h.baseUrl}/user/sessions/${encodeURIComponent(h.sessionId)}`, { headers: { cookie: h.cookie } });
    const csrf = /name="csrf" value="([^"]+)"/.exec(await detail.text())?.[1]; assert.ok(csrf);
    const updated = await fetch(endpoint, { method: "PUT", headers: { cookie: h.cookie, origin: "http://127.0.0.1", "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ expected_version: 0, changes: [{ op: "add", text: "shared from UI" }] }) });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json() as { version: number }).version, 1);
    assert.equal((await fetch(`${h.baseUrl}/api/sessions/not-owned-session-00001/todo`, { headers: { cookie: h.cookie } })).status, 404);
  } finally { await h.close(); }
});
