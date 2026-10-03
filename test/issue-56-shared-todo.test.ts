import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createApp, RemoteDesktopService, type RuntimeConfig } from "../src/index.js";
import { hashPassword } from "../src/hash-password.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
  let auditFailureEvents: Set<string> | undefined;
  service.audit = async (event, fields) => {
    if (auditFailure && (!auditFailureEvents || auditFailureEvents.has(event))) throw auditFailure;
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

  return { service, audits, connect, setAuditFailure(error?: Error, events?: string[]) { auditFailure = error; auditFailureEvents = events ? new Set(events) : undefined; }, async close() { await service.close(); } };
}

function seedProcess(service: RemoteDesktopService, values: { id?: string; sessionId: string; user?: string; state?: "running" | "terminating" | "finished"; output?: string }) {
  const internals = service as unknown as { processes: Map<string, unknown>; currentProcessOwners: Map<string, string>; dc: { currentGeneration(): string; generation?: string; client?: unknown } };
  const generation = "issue-56-process-generation";
  internals.dc.generation = generation;
  internals.dc.client = { close: async () => undefined };
  const id = values.id ?? "owned-process-issue-56";
  const pid = 4242;
  const user = values.user ?? "owner@example.test";
  internals.processes.set(id, { id, sessionId: values.sessionId, user, generation, pid, state: values.state ?? "running", output: values.output ?? "cached process output", cursor: 0 });
  if (values.state !== "finished") internals.currentProcessOwners.set(`local:${generation}:${pid}`, id);
  return { id, pid, generation, internals };
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

test("clock anomalies are audited, fail closed, and clear only after a Todo update", async () => {
  const originalNow = performance.now.bind(performance);
  const originalWallNow = Date.now.bind(Date);
  let monotonicNow = originalNow();
  let wallNow = originalWallNow();
  performance.now = () => monotonicNow;
  Date.now = () => wallNow;
  const h = await harness();
  const owner = await h.connect("owner@example.test");
  try {
    const opened = await owner.call("session_open", { working_directory: process.cwd(), purpose: "clock anomaly test" });
    const sessionId = String(opened.session_id);
    monotonicNow += 1;
    wallNow += 60_002;
    await assert.rejects(owner.call("node_list", { session_id: sessionId }), /TODO_STALE/);
    assert.ok(h.audits.some((entry) => entry.event === "todo.clock_anomaly"), "clock anomaly needs its own audit record");
    await owner.call("todo_update", { session_id: sessionId, expected_version: 0, changes: [{ op: "add", text: "reset clock baseline" }] });
    await owner.call("node_list", { session_id: sessionId });
  } finally {
    performance.now = originalNow;
    Date.now = originalWallNow;
    await owner.close();
    await h.close();
  }
});

test("disabling bypasses freshness and re-enabling starts a new five-minute grace period", async () => {
  const originalNow = performance.now.bind(performance);
  const originalWallNow = Date.now.bind(Date);
  let monotonicNow = originalNow();
  let wallNow = originalWallNow();
  performance.now = () => monotonicNow;
  Date.now = () => wallNow;
  const h = await harness();
  const owner = await h.connect("owner@example.test");
  try {
    const opened = await owner.call("session_open", { working_directory: process.cwd(), purpose: "toggle grace test" });
    const sessionId = String(opened.session_id);
    await owner.call("todo_enforcement_set", { session_id: sessionId, enabled: false });
    monotonicNow += 600_000;
    wallNow += 600_000;
    await owner.call("node_list", { session_id: sessionId });
    await owner.call("todo_enforcement_set", { session_id: sessionId, enabled: true });
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

test("a versioned Todo with a missing monotonic update time is stale until updated", async () => {
  const h = await harness();
  const owner = await h.connect("owner@example.test");
  try {
    const opened = await owner.call("session_open", { working_directory: process.cwd(), purpose: "missing timestamp test" });
    const sessionId = String(opened.session_id);
    await owner.call("todo_update", { session_id: sessionId, expected_version: 0, changes: [{ op: "add", text: "timestamped" }] });
    h.service.sessions.get(sessionId)!.todo.lastTodoUpdatedMono = null;
    await assert.rejects(owner.call("node_list", { session_id: sessionId }), /TODO_STALE/);
    const snapshot = await owner.call("todo_get", { session_id: sessionId });
    const itemId = (snapshot.items as Array<{ id: string }>)[0]!.id;
    const updated = await owner.call("todo_update", { session_id: sessionId, expected_version: 1, changes: [{ op: "edit", id: itemId, text: "recovered" }] });
    assert.equal(updated.version, 2);
    await owner.call("node_list", { session_id: sessionId });
  } finally {
    await owner.close();
    await h.close();
  }
});

test("versioned Todos reject every nonfinite or invalid update timestamp and recover only by updating", async () => {
  const h = await harness();
  const owner = await h.connect("owner@example.test");
  try {
    const opened = await owner.call("session_open", { working_directory: process.cwd(), purpose: "invalid timestamp matrix" });
    const sessionId = String(opened.session_id);
    await owner.call("node_list", { session_id: sessionId });
    let updated = await owner.call("todo_update", { session_id: sessionId, expected_version: 0, changes: [{ op: "add", text: "timestamp baseline" }] });
    const todo = h.service.sessions.get(sessionId)!.todo as unknown as { lastTodoUpdatedMono: unknown };
    const invalidValues: unknown[] = [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "invalid", -1, Number.MAX_VALUE];
    for (const [index, invalid] of invalidValues.entries()) {
      todo.lastTodoUpdatedMono = invalid;
      const auditCount = h.audits.length;
      await assert.rejects(owner.call("node_list", { session_id: sessionId }), /TODO_STALE/);
      assert.ok(h.audits.slice(auditCount).some((entry) => entry.event === "todo.clock_anomaly" && entry.fields.reason === "updated_timestamp_invalid"), `invalid value at index ${index} must be audited`);
      const current = await owner.call("todo_get", { session_id: sessionId });
      updated = await owner.call("todo_update", { session_id: sessionId, expected_version: Number(current.version), changes: [{ op: "add", text: `recovery ${index}` }] });
      assert.equal(updated.version, Number(current.version) + 1);
      await owner.call("node_list", { session_id: sessionId });
    }
  } finally {
    await owner.close();
    await h.close();
  }
});

test("stale process status returns the cached snapshot without reading Desktop Commander", async () => {
  const originalNow = performance.now.bind(performance);
  const originalWallNow = Date.now.bind(Date);
  let monotonicNow = originalNow();
  let wallNow = originalWallNow();
  performance.now = () => monotonicNow;
  Date.now = () => wallNow;
  const h = await harness();
  const owner = await h.connect("owner@example.test");
  let reads = 0;
  try {
    const opened = await owner.call("session_open", { working_directory: process.cwd(), purpose: "cached process status test" });
    const sessionId = String(opened.session_id);
    const processId = "owned-process-status-test";
    const internals = h.service as unknown as { processes: Map<string, unknown>; currentProcessOwners: Map<string, string>; dc: { currentGeneration(): string; generation?: string; client?: unknown }; cfg: RuntimeConfig };
    internals.dc.generation = "test-generation";
    internals.dc.client = { close: async () => undefined };
    const generation = internals.dc.currentGeneration();
    internals.processes.set(processId, { id: processId, sessionId, user: "owner@example.test", generation, pid: 42, state: "running", output: "cached output", cursor: 10 });
    internals.currentProcessOwners.set(`local:${generation}:42`, processId);
    internals.cfg.processAdapter = { async start() { return ""; }, async read() { reads += 1; return "fresh output"; }, async terminate() { return ""; }, async sessions() { return "PID: 42"; } };
    monotonicNow += 300_000;
    wallNow += 300_000;
    const snapshot = await owner.call("process_status", { session_id: sessionId, node_id: "local", process_id: processId });
    assert.equal(snapshot.state, "running");
    assert.equal(snapshot.output, "cached output");
    assert.equal(reads, 0, "stale process status must not fetch output after the gate expires");
  } finally {
    performance.now = originalNow;
    Date.now = originalWallNow;
    await owner.close();
    await h.close();
  }
});

test("owned process status and output survive receipt-audit failure in fresh and stale states", async () => {
  const originalNow = performance.now.bind(performance);
  const originalWallNow = Date.now.bind(Date);
  for (const toolName of ["process_status", "process_output"] as const) {
    for (const stale of [false, true]) {
      let monotonicNow = originalNow();
      let wallNow = originalWallNow();
      performance.now = () => monotonicNow;
      Date.now = () => wallNow;
      const h = await harness();
      const owner = await h.connect("owner@example.test");
      let reads = 0;
      try {
        const opened = await owner.call("session_open", { working_directory: process.cwd(), purpose: `${toolName} receipt audit failure` });
        const sessionId = String(opened.session_id);
        const fixture = seedProcess(h.service, { sessionId, id: `${toolName}-${stale ? "stale" : "fresh"}` });
        h.service.cfg.processAdapter = { async start() { return ""; }, async read() { reads += 1; return "fresh downstream output"; }, async terminate() { return ""; }, async sessions() { return `PID: ${fixture.pid}`; } };
        if (stale) { monotonicNow += 300_000; wallNow += 300_000; }
        h.setAuditFailure(new Error("receipt audit unavailable"), ["operation.received", "todo.gate_allowed"]);
        const result = await owner.call(toolName, { session_id: sessionId, node_id: "local", process_id: fixture.id });
        assert.equal(result.audit_warning, true, `${toolName} must disclose the missing receipt audit`);
        assert.equal(result.output, stale ? "cached process output" : "fresh downstream output");
        assert.equal(reads, stale ? 0 : 1, `${toolName} should read fresh output only before the Todo deadline`);
      } finally {
        performance.now = originalNow;
        Date.now = originalWallNow;
        await owner.close();
        await h.close();
      }
    }
  }
});

test("process kill is owner scoped, serializes duplicates, retries terminating after two seconds, and rejects finished processes", async () => {
  const originalNow = performance.now.bind(performance);
  let monotonicNow = 10_000;
  performance.now = () => monotonicNow;
  const h = await harness();
  const owner = await h.connect("owner@example.test");
  const other = await h.connect("other@example.test");
  let releaseFirst!: (value: string) => void;
  let signalFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => { signalFirst = resolve; });
  let terminateCalls = 0;
  try {
    const opened = await owner.call("session_open", { working_directory: process.cwd(), purpose: "kill retry test" });
    const sessionId = String(opened.session_id);
    const wrongSession = await owner.call("session_open", { working_directory: process.cwd(), purpose: "other process session" });
    const processFixture = seedProcess(h.service, { sessionId });
    h.service.cfg.processAdapter = {
      async start() { return ""; },
      async read() { return ""; },
      async terminate() {
        terminateCalls += 1;
        if (terminateCalls === 1) {
          signalFirst();
          return new Promise<string>((resolve) => { releaseFirst = resolve; });
        }
        return "Successfully initiated termination of session";
      },
      async sessions() { return `PID: ${processFixture.pid}`; },
    };
    await assert.rejects(owner.call("process_kill", { session_id: String(wrongSession.session_id), node_id: "local", process_id: processFixture.id }), /session|Process/i);
    await assert.rejects(other.call("process_kill", { session_id: sessionId, node_id: "local", process_id: processFixture.id }), /session|Process/i);
    const first = owner.call("process_kill", { session_id: sessionId, node_id: "local", process_id: processFixture.id });
    await firstStarted;
    const concurrent = owner.call("process_kill", { session_id: sessionId, node_id: "local", process_id: processFixture.id });
    releaseFirst("Successfully initiated termination of session");
    const pair = await Promise.allSettled([first, concurrent]);
    assert.equal(pair.filter((entry) => entry.status === "fulfilled").length, 1, "the process lock and throttle must admit one concurrent termination request");
    assert.equal(pair.filter((entry) => entry.status === "rejected").length, 1);
    assert.equal(terminateCalls, 1);
    monotonicNow += 1_999;
    await assert.rejects(owner.call("process_kill", { session_id: sessionId, node_id: "local", process_id: processFixture.id }), /throttled/i);
    assert.equal(terminateCalls, 1, "a retry at 1999ms must remain throttled");
    monotonicNow += 1;
    const retried = await owner.call("process_kill", { session_id: sessionId, node_id: "local", process_id: processFixture.id });
    assert.equal(retried.state, "terminating");
    assert.equal(terminateCalls, 2);
    const item = h.service.processes.get(processFixture.id)! as unknown as { state: string };
    item.state = "finished";
    await assert.rejects(owner.call("process_kill", { session_id: sessionId, node_id: "local", process_id: processFixture.id }), /Process/i);
    assert.equal(terminateCalls, 2);
  } finally {
    performance.now = originalNow;
    await owner.close();
    await other.close();
    await h.close();
  }
});

test("accepted process kill remains successful with an applied warning when its event audit fails", async () => {
  const h = await harness();
  const owner = await h.connect("owner@example.test");
  try {
    const opened = await owner.call("session_open", { working_directory: process.cwd(), purpose: "kill audit failure" });
    const sessionId = String(opened.session_id);
    const fixture = seedProcess(h.service, { sessionId });
    let terminateCalls = 0;
    h.service.cfg.processAdapter = { async start() { return ""; }, async read() { return ""; }, async terminate() { terminateCalls += 1; return "Successfully initiated termination of session"; }, async sessions() { return `PID: ${fixture.pid}`; } };
    h.setAuditFailure(new Error("kill audit unavailable"), ["process.kill_requested"]);
    const result = await owner.call("process_kill", { session_id: sessionId, node_id: "local", process_id: fixture.id });
    assert.equal(result.state, "terminating");
    assert.equal(result.audit_warning, true);
    assert.equal(result.applied, true);
    assert.equal(terminateCalls, 1);
  } finally {
    await owner.close();
    await h.close();
  }
});

test("process kill preserves applied certainty across internal and common audit failure combinations", async () => {
  const cases = [
    { outcome: "accepted", failure: "internal", event: "process.kill_requested", applied: true, state: "terminating" },
    { outcome: "accepted", failure: "common", event: "operation.succeeded", applied: true, state: "terminating" },
    { outcome: "rejected", failure: "internal", event: "process.kill_rejected", applied: false, state: "running" },
    { outcome: "rejected", failure: "common", event: "operation.succeeded", applied: false, state: "running" },
    { outcome: "timed_out", failure: "internal", event: "process.termination_unconfirmed", applied: "unknown", state: "terminating" },
    { outcome: "timed_out", failure: "common", event: "operation.succeeded", applied: "unknown", state: "terminating" },
    { outcome: "timed_out", failure: "both", event: ["process.termination_unconfirmed", "operation.succeeded"], applied: "unknown", state: "terminating" },
  ] as const;
  for (const entry of cases) {
    const h = await harness();
    const owner = await h.connect("owner@example.test");
    let terminateCalls = 0;
    try {
      const opened = await owner.call("session_open", { working_directory: process.cwd(), purpose: `kill certainty ${entry.outcome} ${entry.failure}` });
      const sessionId = String(opened.session_id);
      const fixture = seedProcess(h.service, { sessionId, id: `kill-${entry.outcome}-${entry.failure}` });
      h.service.cfg.processAdapter = {
        async start() { return ""; },
        async read() { return ""; },
        async terminate() {
          terminateCalls += 1;
          if (entry.outcome === "accepted") return "Successfully initiated termination of session";
          if (entry.outcome === "rejected") return "Termination was rejected";
          throw Object.assign(new Error("termination request timed out"), { code: -32001 });
        },
        async sessions() { return `PID: ${fixture.pid}`; },
      };
      h.setAuditFailure(new Error("kill audit unavailable"), Array.isArray(entry.event) ? [...entry.event] : [entry.event]);
      const result = await owner.call("process_kill", { session_id: sessionId, node_id: "local", process_id: fixture.id });
      assert.equal(result.state, entry.state, `${entry.outcome}/${entry.failure} state`);
      assert.equal(result.audit_warning, true, `${entry.outcome}/${entry.failure} warning`);
      assert.equal(result.applied, entry.applied, `${entry.outcome}/${entry.failure} applied semantics`);
      assert.equal(terminateCalls, 1, `${entry.outcome}/${entry.failure} must not redispatch`);
    } finally {
      await owner.close();
      await h.close();
    }
  }
});

test("Desktop Commander SDK request timeout stays unknown through the default process kill path", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "issue-56-timeout-fixture", version: "1" });
  const server = new McpServer({ name: "issue-56-timeout-fixture", version: "1" });
  server.registerTool("slow_fixture", { description: "Safe in-memory timeout fixture", inputSchema: {} }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { content: [{ type: "text", text: "completed after timeout" }] };
  });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  let timeoutError: unknown;
  try {
    await client.callTool({ name: "slow_fixture", arguments: {} }, undefined, { timeout: 10 });
  } catch (error) {
    timeoutError = error;
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 60));
    await Promise.all([client.close(), server.close()]);
  }
  assert.ok(timeoutError instanceof Error, "the SDK must reject the in-memory request on timeout");
  assert.equal((timeoutError as Error & { code?: unknown }).code, -32001, "the SDK timeout error code must match the Desktop Commander path");

  const h = await harness();
  const owner = await h.connect("owner@example.test");
  let terminateCalls = 0;
  try {
    const opened = await owner.call("session_open", { working_directory: process.cwd(), purpose: "SDK timeout mapping" });
    const sessionId = String(opened.session_id);
    const fixture = seedProcess(h.service, { sessionId, id: "sdk-timeout-process" });
    const internals = h.service as unknown as { dc: { call(name: string, args: Record<string, unknown>, timeout: number): Promise<string> } };
    internals.dc.call = async (name, args, timeout) => {
      terminateCalls += 1;
      assert.equal(name, "force_terminate");
      assert.deepEqual(args, { pid: fixture.pid });
      assert.equal(timeout, 2_000);
      throw timeoutError;
    };
    h.setAuditFailure(new Error("termination audit unavailable"), ["process.termination_unconfirmed"]);
    const result = await owner.call("process_kill", { session_id: sessionId, node_id: "local", process_id: fixture.id });
    assert.equal(result.termination_unconfirmed, true);
    assert.equal(result.audit_warning, true);
    assert.equal(result.applied, "unknown");
    assert.equal(terminateCalls, 1, "a timed out Desktop Commander request must not be retried");
  } finally {
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

test("session close completes when its audit write fails and reports the applied cleanup", async () => {
  const h = await harness();
  const owner = await h.connect("owner@example.test");
  try {
    const opened = await owner.call("session_open", { working_directory: process.cwd(), purpose: "safe cleanup audit test" });
    const sessionId = String(opened.session_id);
    h.setAuditFailure(new Error("audit unavailable"));
    const closed = await owner.call("session_close", { session_id: sessionId });
    assert.equal(closed.closed, true);
    assert.equal(closed.audit_warning, true);
    assert.equal(closed.applied, true);
    assert.equal(h.service.sessions.get(sessionId)?.state, "closed");
  } finally {
    await owner.close();
    await h.close();
  }
});

test("transfer cancellation performs owner cleanup when its audit write fails", async () => {
  const h = await harness();
  const owner = await h.connect("owner@example.test");
  const other = await h.connect("other@example.test");
  const temp = await mkdtemp(path.join(tmpdir(), "rdmcp-issue-56-cancel-"));
  const snapshot = path.join(temp, "snapshot");
  try {
    const opened = await owner.call("session_open", { working_directory: process.cwd(), purpose: "transfer cancel audit test" });
    const sessionId = String(opened.session_id);
    const wrongSession = await owner.call("session_open", { working_directory: process.cwd(), purpose: "wrong transfer session" });
    const transferId = "owned-transfer-issue-56";
    await writeFile(snapshot, "private transfer snapshot");
    (h.service.transfers as unknown as Map<string, unknown>).set(transferId, { id: transferId, direction: "download", sessionId, nodeId: "local", rootId: "root", target: snapshot, snapshot, size: 24, sha256: "", offset: 0, touched: Date.now(), state: "active" });
    await assert.rejects(owner.call("file_transfer_cancel", { session_id: String(wrongSession.session_id), transfer_id: transferId }), /Transfer/i);
    await assert.rejects(other.call("file_transfer_cancel", { session_id: sessionId, transfer_id: transferId }), /session/i);
    await access(snapshot);
    h.setAuditFailure(new Error("audit unavailable"), ["transfer.cancel"]);
    const cancelled = await owner.call("file_transfer_cancel", { session_id: sessionId, transfer_id: transferId });
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.audit_warning, true);
    assert.equal(cancelled.applied, true);
    assert.equal((h.service.transfers.get(transferId) as unknown as { state: string }).state, "cancelled");
    await assert.rejects(access(snapshot));
  } finally {
    await owner.close();
    await other.close();
    await h.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("emergency stop persists the stop and cleans session resources when audit storage fails", async () => {
  const h = await harness();
  const owner = await h.connect("owner@example.test");
  const stopDataDir = await mkdtemp(path.join(tmpdir(), "rdmcp-issue-56-stop-"));
  try {
    await protectPrivateDirectory(stopDataDir);
    h.service.cfg.dataDir = stopDataDir;
    const opened = await owner.call("session_open", { working_directory: process.cwd(), purpose: "emergency stop audit test" });
    const sessionId = String(opened.session_id);
    const snapshot = path.join(stopDataDir, "active.snapshot");
    await writeFile(snapshot, "cleanup me");
    const transferId = "stop-cancel-transfer-issue-56";
    (h.service.transfers as unknown as Map<string, unknown>).set(transferId, { id: transferId, direction: "download", sessionId, nodeId: "local", rootId: "root", target: snapshot, snapshot, size: 10, sha256: "", offset: 0, touched: Date.now(), state: "active" });
    h.service.cfg.processAdapter = { async start() { return ""; }, async read() { return ""; }, async terminate() { return ""; }, async sessions() { return "[]"; } };
    h.setAuditFailure(new Error("audit unavailable"));
    const stopped = await h.service.stopUserExecution("owner@example.test");
    assert.equal(stopped.stopped, true);
    assert.equal(h.service.sessions.get(sessionId)?.state, "closed");
    assert.equal((h.service.transfers.get(transferId) as unknown as { state: string }).state, "cancelled");
    await assert.rejects(access(snapshot));
  } finally {
    await owner.close();
    await h.close();
    await rm(stopDataDir, { recursive: true, force: true });
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

test("common wrapper keeps ordinary gate audit failures fail closed and reports post-audit results truthfully", async () => {
  const h = await harness();
  const owner = await h.connect("owner@example.test");
  let starts = 0;
  try {
    const opened = await owner.call("session_open", { working_directory: process.cwd(), purpose: "wrapper audit phases" });
    const sessionId = String(opened.session_id);
    seedProcess(h.service, { sessionId });
    h.service.cfg.processAdapter = { async start() { starts += 1; return "PID 9"; }, async read() { return ""; }, async terminate() { return ""; }, async sessions() { return "[]"; } };
    h.setAuditFailure(new Error("start audit unavailable"), ["operation.started"]);
    await assert.rejects(owner.call("process_start", { session_id: sessionId, node_id: "local", command: "echo gated", timeout_ms: 1000 }), /TODO_GATE_AUDIT_UNAVAILABLE/);
    assert.equal(starts, 0, "pre-handler audit failure must prevent the side effect");
    h.setAuditFailure(new Error("receipt audit unavailable"), ["operation.received"]);
    await assert.rejects(owner.call("process_start", { session_id: sessionId, node_id: "local", command: "echo unreceived", timeout_ms: 1000 }), /TODO_GATE_AUDIT_UNAVAILABLE/);
    assert.equal(starts, 0, "failed receipt audit must also prevent an enabled gated operation");
    h.setAuditFailure(new Error("post audit unavailable"), ["operation.succeeded"]);
    const listed = await owner.call("node_list", { session_id: sessionId });
    assert.equal(listed.audit_warning, true);
    assert.equal(listed.applied, true);
  } finally {
    await owner.close();
    await h.close();
  }
});

test("common wrapper marks a completed safe cleanup applied when pre and post audit writes fail", async () => {
  const h = await harness();
  const owner = await h.connect("owner@example.test");
  try {
    const opened = await owner.call("session_open", { working_directory: process.cwd(), purpose: "safe wrapper result semantics" });
    const sessionId = String(opened.session_id);
    h.setAuditFailure(new Error("wrapper audit unavailable"), ["operation.received", "operation.started", "operation.succeeded"]);
    const closed = await owner.call("session_close", { session_id: sessionId });
    assert.equal(closed.closed, true);
    assert.equal(closed.audit_warning, true);
    assert.equal(closed.applied, true, "the response must say cleanup was applied despite missing wrapper audit records");
    assert.equal(h.service.sessions.get(sessionId)?.state, "closed");
  } finally {
    await owner.close();
    await h.close();
  }
});

test("ordinary side effect failures after dispatch return an unknown applied state without retry", async () => {
  const h = await harness();
  const owner = await h.connect("owner@example.test");
  let dispatches = 0;
  try {
    const opened = await owner.call("session_open", { working_directory: process.cwd(), purpose: "unknown outcome semantics" });
    h.service.cfg.processAdapter = { async start() { dispatches += 1; throw new Error("adapter lost response after dispatch"); }, async read() { return ""; }, async terminate() { return ""; }, async sessions() { return "[]"; } };
    h.setAuditFailure(new Error("completion audit unavailable"), ["operation.failed"]);
    await assert.rejects(owner.call("process_start", { session_id: String(opened.session_id), node_id: "local", command: "echo possibly started", timeout_ms: 1000 }), /TODO_OPERATION_OUTCOME_UNKNOWN.*unknown/);
    assert.equal(dispatches, 1, "an uncertain operation must not be automatically retried");
  } finally {
    await owner.close();
    await h.close();
  }
});

test("clock rollback and unavailable monotonic time fail closed and record the anomaly reason", async () => {
  const originalNow = performance.now.bind(performance);
  const originalWallNow = Date.now.bind(Date);
  let monotonicNow = originalNow();
  let wallNow = originalWallNow();
  performance.now = () => monotonicNow;
  Date.now = () => wallNow;
  const h = await harness();
  const owner = await h.connect("owner@example.test");
  try {
    const opened = await owner.call("session_open", { working_directory: process.cwd(), purpose: "clock failure cases" });
    const sessionId = String(opened.session_id);
    monotonicNow += 10;
    wallNow -= 1;
    await assert.rejects(owner.call("node_list", { session_id: sessionId }), /TODO_STALE/);
    assert.ok(h.audits.some((entry) => entry.event === "todo.clock_anomaly" && entry.fields.reason === "clock_anomaly"));
    performance.now = () => Number.NaN;
    await assert.rejects(owner.call("node_list", { session_id: sessionId }), /TODO_STALE/);
    assert.ok(h.audits.some((entry) => entry.event === "todo.clock_anomaly" && entry.fields.reason === "clock_unavailable"));
  } finally {
    performance.now = originalNow;
    Date.now = originalWallNow;
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

test("Todo forms enforce CSRF and ownership while handling add, conflict, and enforcement toggle", async () => {
  const h = await consoleHarness();
  try {
    const detailUrl = `${h.baseUrl}/user/sessions/${encodeURIComponent(h.sessionId)}`;
    const detail = await fetch(detailUrl, { headers: { cookie: h.cookie } });
    const csrf = /name="csrf" value="([^"]+)"/.exec(await detail.text())?.[1]; assert.ok(csrf);
    const endpoint = `${detailUrl}/todo`;
    const form = (entries: Record<string, string>) => new URLSearchParams({ csrf, ...entries });
    const headers = { cookie: h.cookie, origin: "http://127.0.0.1", "content-type": "application/x-www-form-urlencoded" };
    const added = await fetch(endpoint, { method: "POST", headers, body: form({ expected_version: "0", op: "add", text: "from form" }), redirect: "manual" });
    assert.equal(added.status, 303);
    assert.equal((await h.service.todoGet("owner@example.test", h.sessionId)).version, 1);
    const conflict = await fetch(endpoint, { method: "POST", headers, body: form({ expected_version: "0", op: "add", text: "stale form" }), redirect: "manual" });
    assert.equal(conflict.status, 303);
    assert.match(conflict.headers.get("location") ?? "", /todo=conflict/);
    const denied = await fetch(endpoint, { method: "POST", headers, body: new URLSearchParams({ expected_version: "1", op: "add", text: "no csrf" }), redirect: "manual" });
    assert.equal(denied.status, 403);
    const toggle = await fetch(`${endpoint}/enforcement`, { method: "POST", headers, body: form({ enabled: "false" }), redirect: "manual" });
    assert.equal(toggle.status, 303);
    assert.equal(h.service.sessions.get(h.sessionId)?.todo.enabled, false);
    const notOwned = await fetch(`${h.baseUrl}/user/sessions/not-owned-session-00001/todo`, { method: "POST", headers, body: form({ expected_version: "0", op: "add", text: "x" }), redirect: "manual" });
    assert.equal(notOwned.status, 404);
  } finally { await h.close(); }
});
