import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { createApp, RemoteDesktopService, configFromEnv } from "../src/index.js";
import { readSessionLogs } from "../src/admin.js";
import type { OAuthState } from "../src/public-auth.js";
import { fixture, mcp } from "./fixture.js";

test("every tool requires a comment that is retained in operation audit history", async () => {
  const f = await fixture();
  const api = await mcp(f.service);
  try {
    const tools = await api.listTools();
    for (const tool of tools.tools) assert.equal((tool.inputSchema as { required?: string[] }).required?.includes("comment"), true, `${tool.name} requires a comment`);
    await assert.rejects(api.callRaw("session_list", {}), /comment/i);
    await api.call("session_list", { comment: "Check currently active work sessions" });
    const event = (await readSessionLogs(f.service)).sessions.flatMap((session) => session.events).findLast((entry) => entry.event === "operation.succeeded" && entry.tool === "session_list");
    assert.equal(event?.comment, "Check currently active work sessions");
  } finally { await api.close(); await f.cleanup(); }
});

test("Issue 22: user log API pages owner-scoped persisted events and exposes SSE notifications without bodies", async () => {
  const f = await fixture(); const server = createApp(f.service).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/api/logs`)).status, 401);
    await f.service.audit("session.open", { user: "owner@example.test", sessionId: "owner-session", workingDirectory: "owner-work", purpose: "Owner test" });
    await f.service.audit("operation.received", { user: "owner@example.test", sessionId: "owner-session", operationId: "owner-operation", tool: "file_read", target: "owner.txt" });
    await f.service.audit("operation.received", { user: "other@example.test", sessionId: "other-session", operationId: "other-operation", tool: "file_read", target: "other-secret.txt" });
    const login = await fetch(`${base}/user/login`, { method: "POST", headers: { origin: f.service.cfg.baseUrl, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "owner@example.test", password: "correct-horse-battery" }), redirect: "manual" });
    const token = /rdmcp_user=([^;,]+)/.exec(login.headers.get("set-cookie")!)?.[1]; assert.ok(token);
    const cookie = `rdmcp_user=${token}`;
    const consoleState = await fetch(`${base}/api/console-state`, { headers: { cookie } }); assert.equal(consoleState.status, 200);
    const stateBody = await consoleState.json() as { updatedAt: unknown; sessions: Array<{ session_id: string; active: boolean }>; running: Array<{ operation_id: string }> };
    assert.equal(typeof stateBody.updatedAt, "string");
    assert.deepEqual(stateBody.sessions.map((session) => session.session_id), ["owner-session"]);
    assert.equal(stateBody.running[0]?.operation_id, "owner-operation");
    const first = await fetch(`${base}/api/logs?limit=1`, { headers: { cookie } }); assert.equal(first.status, 200);
    const firstPage = await first.json() as { items: Array<{ id: string; cursor: string; event: Record<string, unknown> }>; newestCursor: string };
    assert.equal(firstPage.items.length, 1); assert.equal(firstPage.items[0]?.event.target, "owner.txt"); assert.ok(firstPage.items[0]?.id);
    assert.equal((await fetch(`${base}/api/logs?session_id=other-session`, { headers: { cookie } })).status, 404);
    await f.service.audit("operation.succeeded", { user: "owner@example.test", sessionId: "owner-session", operationId: "owner-operation", tool: "file_read", target: "owner.txt", status: "succeeded" });
    const after = await fetch(`${base}/api/logs?after=${encodeURIComponent(firstPage.newestCursor)}&limit=1`, { headers: { cookie } }); assert.equal(after.status, 200);
    const afterPage = await after.json() as { items: Array<{ event: Record<string, unknown> }> }; assert.equal(afterPage.items[0]?.event.status, "succeeded");
    await f.service.audit("operation.rejected", { user: "owner@example.test", operationId: "unassigned-owner", tool: "session_open", status: "rejected" });
    await f.service.audit("operation.rejected", { user: "other@example.test", operationId: "unassigned-other", tool: "session_open", status: "rejected" });
    const ownUnassigned = await fetch(`${base}/api/logs?session_id=request%3Aunassigned-owner`, { headers: { cookie } });
    assert.equal(ownUnassigned.status, 200, "the server-rendered request:<operationId> detail has an owner-scoped API log");
    assert.equal((await ownUnassigned.json() as { items: Array<{ event: { operationId?: string } }> }).items[0]?.event.operationId, "unassigned-owner");
    assert.equal((await fetch(`${base}/api/logs?session_id=request%3Aunassigned-other`, { headers: { cookie } })).status, 404);
    assert.equal((await fetch(`${base}/api/logs?before=${encodeURIComponent(firstPage.newestCursor)}&after=${encodeURIComponent(firstPage.newestCursor)}`, { headers: { cookie } })).status, 400);
    const events = await fetch(`${base}/api/events?after=${encodeURIComponent(firstPage.newestCursor)}`, { headers: { cookie } }); assert.equal(events.status, 200); assert.match(events.headers.get("content-type") ?? "", /text\/event-stream/); events.body?.cancel();
    const livePage = await (await fetch(`${base}/api/logs?limit=1`, { headers: { cookie } })).json() as { newestCursor: string };
    const stream = await fetch(`${base}/api/events?after=${encodeURIComponent(livePage.newestCursor)}`, { headers: { cookie } });
    const reader = stream.body!.getReader(); const decoder = new TextDecoder();
    const initialNotice = decoder.decode((await reader.read()).value); assert.match(initialNotice, /event: logs-available\ndata: \{[^\n]*"addedCount":0/);
    await f.service.audit("operation.succeeded", { user: "other@example.test", sessionId: "other-session", operationId: "foreign-live", status: "succeeded" });
    await f.service.audit("operation.succeeded", { user: "owner@example.test", sessionId: "owner-session", operationId: "owner-live", status: "succeeded" });
    const liveNotice = decoder.decode((await reader.read()).value); assert.match(liveNotice, /event: logs-available\ndata: \{[^\n]*"addedCount":1/);
    await reader.cancel();
    await f.service.audit("operation.received", { user: "owner@example.test", operationId: "stream-unassigned", tool: "session_open" });
    const syntheticPage = await (await fetch(`${base}/api/logs?session_id=request%3Astream-unassigned&limit=1`, { headers: { cookie } })).json() as { newestCursor: string };
    const syntheticStream = await fetch(`${base}/api/events?session_id=request%3Astream-unassigned&after=${encodeURIComponent(syntheticPage.newestCursor)}`, { headers: { cookie } });
    const syntheticReader = syntheticStream.body!.getReader(); await syntheticReader.read();
    await f.service.audit("operation.rejected", { user: "owner@example.test", operationId: "stream-unassigned", tool: "session_open", status: "rejected" });
    const syntheticNotice = decoder.decode((await syntheticReader.read()).value); assert.match(syntheticNotice, /event: logs-available\ndata: \{[^\n]*"addedCount":1/);
    await syntheticReader.cancel();
    await writeFile(`${f.data}/audit.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), event: "operation.received", user: "owner@example.test", sessionId: "owner-session", operationId: "replacement", tool: "file_read" })}\n`);
    const stale = await fetch(`${base}/api/logs?after=${encodeURIComponent(firstPage.newestCursor)}`, { headers: { cookie } });
    assert.equal(stale.status, 409, "audit replacement invalidates cursors rather than mixing generations");
    const staleEvents = await fetch(`${base}/api/events?after=${encodeURIComponent(firstPage.newestCursor)}`, { headers: { cookie } });
    assert.equal(staleEvents.status, 200, "an expired EventSource cursor receives a resync event instead of retrying HTTP 409 forever");
    assert.match(await staleEvents.text(), /event: resync-required\ndata: \{\}/);
    const replacementPage = await (await fetch(`${base}/api/logs?limit=1`, { headers: { cookie } })).json() as { newestCursor: string };
    await writeFile(`${f.data}/audit.jsonl`, "");
    const truncated = await fetch(`${base}/api/logs?after=${encodeURIComponent(replacementPage.newestCursor)}`, { headers: { cookie } });
    assert.equal(truncated.status, 409, "audit truncation invalidates cursors even when the pathname is unchanged");
    const retainedAudit = Array.from({ length: 20_001 }, (_, index) => JSON.stringify({ at: new Date(1_700_000_000_000 + index).toISOString(), event: "operation.succeeded", user: "owner@example.test", sessionId: "owner-session", operationId: `retained-${index}` })).join("\n") + "\n";
    await writeFile(`${f.data}/audit.jsonl`, retainedAudit);
    await f.service.refreshAuditIndex();
    assert.equal(f.service.auditEntriesForConsole().length, 20_000, "the shared audit index evicts the oldest event at its 20,000-event retention bound");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await f.cleanup(); }
});

test("Issue 22: SSE stays open through its heartbeat", async () => {
  const f = await fixture(); const server = createApp(f.service).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`;
  try {
    const login = await fetch(`${base}/user/login`, { method: "POST", headers: { origin: f.service.cfg.baseUrl, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "owner@example.test", password: "correct-horse-battery" }), redirect: "manual" });
    const token = /rdmcp_user=([^;,]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1]; assert.ok(token);
    const malformedStatus = await new Promise<number>((resolve, reject) => {
      const malformed = httpRequest(`${base}/api/events`, { method: "GET", headers: { cookie: `rdmcp_user=${token}`, "content-length": "1" } }, (response) => { response.resume(); response.once("end", () => resolve(response.statusCode ?? 0)); });
      malformed.once("error", reject); malformed.end("x");
    });
    assert.equal(malformedStatus, 400, "event streams reject bodies instead of bypassing request-input protection");
    const stream = await fetch(`${base}/api/events`, { headers: { cookie: `rdmcp_user=${token}` } }); assert.equal(stream.status, 200);
    const reader = stream.body!.getReader(); const decoder = new TextDecoder();
    assert.match(decoder.decode((await reader.read()).value), /event: logs-available/);
    let timeout: NodeJS.Timeout | undefined;
    let heartbeat: ReadableStreamReadResult<Uint8Array>;
    try { heartbeat = await Promise.race([reader.read(), new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("SSE heartbeat was not delivered")), 25_000); })]); }
    finally { if (timeout) clearTimeout(timeout); }
    const heartbeatText = decoder.decode(heartbeat.value); await reader.cancel();
    assert.equal(heartbeat.done, false, "the heartbeat must not close the EventSource response");
    assert.match(heartbeatText, /event: heartbeat\ndata: \{\}/);
  } finally { await f.service.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await f.cleanup(); }
});

test("user console lists each active connection's working directory and purpose for its owner", async () => {
  const f = await fixture();
  const owner = await mcp(f.service);
  const other = await mcp(f.service, "other@example.test");
  const server = createApp(f.service).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const own = await owner.call("session_open", { working_directory: f.root, purpose: "Build <safe> feature" });
    const second = await owner.call("session_open", { working_directory: f.base, purpose: "Second task" });
    const foreign = await other.call("session_open", { working_directory: f.data, purpose: "Other user's private work" });
    await owner.call("session_close", { session_id: second.session_id });
    await f.service.audit("operation.succeeded", { user: "owner@example.test", sessionId: own.session_id, operationId: "operation-first", tool: "file_read", target: "first-only.txt", status: "succeeded", detail: { version: 1, summary: "ファイル読取", entries: [{ label: "本文", value: "<unsafe detail>", format: "text" }] } });
    await f.service.audit("operation.succeeded", { user: "owner@example.test", sessionId: second.session_id, operationId: "operation-second", tool: "file_read", target: "second-only.txt", status: "succeeded" });
    await f.service.audit("process.start", { user: "owner@example.test", sessionId: own.session_id, processId: "process-first", comment: "Generate the first test output", command: "echo first-command", output: "first-output" });
    await f.service.audit("process.output", { user: "owner@example.test", sessionId: own.session_id, processId: "process-first", output: "second-output" });
    await f.service.audit("process.output", { user: "owner@example.test", sessionId: own.session_id, processId: "process-first", output: "third-output" });
    await f.service.audit("process.exit", { user: "owner@example.test", sessionId: own.session_id, processId: "process-first", output: "first-output\nsecond-output\nthird-output\nfinal-only-output", exitCode: 0 });
    await f.service.audit("process.start", { user: "owner@example.test", sessionId: own.session_id, processId: "process-second", command: "echo another-command", output: "another-output" });
    await f.service.audit("process.exit", { user: "owner@example.test", sessionId: own.session_id, processId: "process-second", output: "another-output", exitCode: 0 });
    const login = await fetch(`${base}/user/login`, { method: "POST", headers: { origin: f.service.cfg.baseUrl, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "owner@example.test", password: "correct-horse-battery" }), redirect: "manual" });
    assert.equal(login.status, 303);
    const token = /rdmcp_user=([^;,]+)/.exec(login.headers.get("set-cookie")!)?.[1];
    assert.ok(token);
    const html = await (await fetch(`${base}/user`, { headers: { cookie: `rdmcp_user=${token}` } })).text();
    assert.match(html, new RegExp(String(own.session_id)));
    assert.match(html, /Build &lt;safe&gt; feature/);
    assert.match(html, /作業ディレクトリ/);
    assert.match(html, /セッション一覧/);
    assert.doesNotMatch(html, /http-equiv="refresh"/, "log history does not use whole-page periodic reloads");
    assert.match(html, /作成日時.*最終アクセス日時/);
    assert.match(html, /<th>内容<\/th><th>作成日時/);
    assert.match(html, /data-session-time="created"/, "the session list shows the creation time disclosure");
    assert.match(html, /data-session-time="last-access"/, "the session list shows the last access time disclosure");
    assert.match(html, /<summary><time datetime="[^"]+" data-session-relative="true">[^<]+<\/time><\/summary><time datetime="[^"]+">[^<]+ JST<\/time>/, "the disclosure exposes a relative label and an exact JST value");
    assert.match(html, /Second task/);
    assert.match(html, /終了/);
    assert.match(html, /現在実行中の操作: <span id="running-count">0/);
    assert.doesNotMatch(html.replace(/<script[\s\S]*<\/script>/, ""), /request:/, "successful session opens must not leave provisional entries");
    assert.ok(html.includes(f.root));
    assert.doesNotMatch(html, /Other user's private work/);
    assert.ok(!html.includes(f.data));
    assert.doesNotMatch(html, /first-only\.txt|first-command|first-output|second-only\.txt/);
    const detail = await (await fetch(`${base}/user/sessions/${encodeURIComponent(String(own.session_id))}`, { headers: { cookie: `rdmcp_user=${token}` } })).text();
    assert.match(detail, /セッションの内容/);
    assert.match(detail, /<details><summary>操作履歴<\/summary>/);
    assert.doesNotMatch(detail, /http-equiv="refresh"/);
    assert.match(detail, /作成日時: .*最終アクセス日時:/);
    assert.match(detail, /first-only\.txt/);
    assert.match(detail, /<th>詳細<\/th>/);
    assert.match(detail, /<details><summary>詳細<\/summary>/, "operation detail starts collapsed");
    assert.match(detail, /&lt;unsafe detail&gt;/, "operation detail text is HTML escaped");
    assert.match(detail, /first-command/);
    assert.match(detail, /実行目的/);
    assert.match(detail, /Generate the first test output/);
    assert.match(detail, /first-output/);
    assert.match(detail, /second-output/);
    assert.match(detail, /third-output/);
    assert.match(detail, /final-only-output/);
    assert.match(detail, /終了時の出力/);
    const renderedOutput = [...detail.replace(/<script[\s\S]*<\/script>/, "").matchAll(/<pre>([\s\S]*?)<\/pre>/g)].map((match) => match[1]).join("\n");
    assert.equal(renderedOutput.split("first-output").length - 1, 1, "the final snapshot does not repeat earlier output");
    assert.match(detail, /終了コード: 0/);
    const processBlocks = [...detail.matchAll(/<article class="process-block"[^>]*>([\s\S]*?)<\/article>/g)].map((match) => match[1]!);
    assert.equal(processBlocks.length, 2);
    assert.ok(processBlocks.some((block) => block.includes("first-command") && block.includes("third-output") && !block.includes("another-output")));
    assert.ok(processBlocks.some((block) => block.includes("another-command") && block.includes("another-output") && !block.includes("first-output")));
    assert.ok(detail.indexOf("first-output") < detail.indexOf("second-output") && detail.indexOf("second-output") < detail.indexOf("third-output"));
    assert.doesNotMatch(detail, /second-only\.txt/);
    const closedDetail = await (await fetch(`${base}/user/sessions/${encodeURIComponent(String(second.session_id))}`, { headers: { cookie: `rdmcp_user=${token}` } })).text();
    assert.match(closedDetail, /second-only\.txt/);
    assert.doesNotMatch(closedDetail, /first-only\.txt|first-command|first-output/);
    assert.equal((await fetch(`${base}/user/sessions/${encodeURIComponent(String(foreign.session_id))}`, { headers: { cookie: `rdmcp_user=${token}` } })).status, 404);
    const preferences = await fetch(`${base}/user?filter=active&refresh=30`, { headers: { cookie: `rdmcp_user=${token}` } });
    const preferenceCookies = preferences.headers.get("set-cookie") ?? "";
    assert.match(preferenceCookies, /rdmcp_user_filter=active/);
    const persistedCookie = `rdmcp_user=${token}; rdmcp_user_filter=active`;
    const filtered = await (await fetch(`${base}/user`, { headers: { cookie: persistedCookie } })).text();
    assert.doesNotMatch(filtered, /http-equiv="refresh"/);
    assert.match(filtered, new RegExp(String(own.session_id)));
    assert.doesNotMatch(filtered, new RegExp(String(second.session_id)));
    const persistedDetail = await (await fetch(`${base}/user/sessions/${encodeURIComponent(String(own.session_id))}`, { headers: { cookie: persistedCookie } })).text();
    assert.doesNotMatch(persistedDetail, /http-equiv="refresh"/);
    const paused = await (await fetch(`${base}/user?refresh=0`, { headers: { cookie: persistedCookie } })).text();
    assert.doesNotMatch(paused, /http-equiv="refresh"/);
    await assert.rejects(owner.call("file_read", { session_id: own.session_id, root_id: "missing", relative_path: "missing.txt" }));
    const failedAccessAt = f.service.sessions.get(String(own.session_id))?.touched;
    assert.ok(failedAccessAt);
    const rejectedAt = new Date(Date.now() + 60_000).toISOString();
    await f.service.audit("operation.received", { at: rejectedAt, user: "owner@example.test", sessionId: own.session_id, operationId: "rejected-after-close", tool: "file_read" });
    await f.service.audit("operation.rejected", { at: rejectedAt, user: "owner@example.test", sessionId: own.session_id, operationId: "rejected-after-close", tool: "file_read", status: "rejected" });
    f.service.sessions.delete(String(own.session_id));
    const historicalSession = (await readSessionLogs(f.service)).sessions.find((session) => session.id === own.session_id);
    assert.ok(historicalSession?.lastAccessAt && Date.parse(historicalSession.lastAccessAt) < Date.parse(rejectedAt), "a rejected attempt does not extend historical last access");
    assert.ok(Date.parse(historicalSession.lastAccessAt) >= failedAccessAt, "a validated but failed operation still updates historical last access");
    const history = await (await fetch(`${base}/user`, { headers: { cookie: `rdmcp_user=${token}` } })).text();
    assert.match(history, /Build &lt;safe&gt; feature/);
    assert.ok(history.includes(f.root), "the list retains working-directory metadata from the audit history");
  } finally { await owner.close(); await other.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await f.cleanup(); }
});

test("emergency stop persists per principal, terminates known processes, and requires a new connection after resume", async () => {
  const f = await fixture();
  const terminated: number[] = [];
  f.service.cfg.processAdapter = { start: async () => "PID 771", read: async () => "Reading 0 new lines (total: 0 lines)", terminate: async (pid) => { terminated.push(pid); return "Successfully initiated termination of session"; }, sessions: async () => "PID: 771" };
  const api = await mcp(f.service);
  try {
    const connection = await api.call("session_open", {});
    const sessionId = connection.session_id as string;
    const operationEvents = (await readSessionLogs(f.service)).sessions.flatMap((session) => session.events).filter((event) => event.tool === "session_open");
    const started = operationEvents.find((event) => event.event === "operation.started")!;
    const succeeded = operationEvents.find((event) => event.event === "operation.succeeded")!;
    assert.ok(String(started.connectionId).startsWith("request:"));
    assert.equal(typeof started.startAt, "string");
    assert.equal(succeeded.connectionId, sessionId);
    const process = await api.call("process_start", { session_id: sessionId, command: "test process" });
    assert.ok(process.process_id);
    const stopped = await f.service.stopUserExecution("owner@example.test");
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.stopGeneration, 1);
    assert.deepEqual(terminated, [771]);
    await assert.rejects(api.call("session_open", {}), /USER_STOP_REQUESTED/);
    const stored = JSON.parse(await readFile(`${f.data}/user-execution-states.json`, "utf8")) as Array<{ stopped: boolean; stopGeneration: number }>;
    assert.deepEqual(stored, [{ stopped: true, stopGeneration: 1, principalId: "owner@example.test", stoppedAt: stopped.stoppedAt, stopId: stopped.stopId }]);
    await f.service.resumeUserExecution("owner@example.test");
    await assert.rejects(api.call("node_list", { session_id: sessionId }), /Session is invalid/);
    const newConnection = await api.call("session_open", {});
    assert.ok(newConnection.connection_id);
  } finally { await api.close(); await f.cleanup(); }
});

test("user console authenticates the principal, applies CSRF checks, and hides another principal's logs", async () => {
  const f = await fixture();
  f.service.cfg.processAdapter = { start: async () => "PID 1", read: async () => "", terminate: async () => "", sessions: async () => "" };
  await f.service.stopUserExecution("owner@example.test");
  await f.service.audit("process.owner_stop_unconfirmed", { user: "owner@example.test", stopId: f.service.userExecutionState("owner@example.test").stopId, pid: 444 });
  await f.service.audit("process.owner_stop_failed", { user: "other@example.test", stopId: "other-stop", pid: 555 });
  const server = createApp(f.service).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await f.service.audit("session.open", { user: "other@example.test", sessionId: "other-connection" });
    await f.service.audit("session.open", { user: "owner@example.test", sessionId: "own-connection" });
    await f.service.audit("operation.received", { user: "owner@example.test", sessionId: "own-connection", connectionId: "own-connection", operationId: "operation-own", tool: "file_read", target: "own-file.txt", receivedAt: "2026-09-27T00:00:00.000Z", status: "running" });
    await f.service.audit("operation.succeeded", { user: "owner@example.test", sessionId: "own-connection", connectionId: "own-connection", operationId: "operation-own", tool: "file_read", target: "own-file.txt", startAt: "2026-09-27T00:00:01.000Z", endedAt: "2026-09-27T00:00:02.000Z", durationMs: 1000, status: "succeeded" });
    await f.service.audit("operation.received", { user: "owner@example.test", operationId: "operation-open", tool: "session_open", target: "—", receivedAt: "2026-09-27T00:01:00.000Z", status: "running" });
    await f.service.audit("operation.started", { user: "owner@example.test", operationId: "operation-open", tool: "session_open", target: "—", startAt: "2026-09-27T00:01:01.000Z", status: "running" });
    await f.service.audit("operation.succeeded", { user: "owner@example.test", sessionId: "own-connection", connectionId: "own-connection", operationId: "operation-open", tool: "session_open", target: "—", endedAt: "2026-09-27T00:01:02.000Z", durationMs: 2000, status: "succeeded" });
    await f.service.audit("operation.received", { user: "owner@example.test", operationId: "operation-rejected-open", tool: "session_open", target: "—", receivedAt: "2026-09-27T00:02:00.000Z", status: "running" });
    await f.service.audit("operation.rejected", { user: "owner@example.test", operationId: "operation-rejected-open", tool: "session_open", target: "—", endedAt: "2026-09-27T00:02:01.000Z", status: "rejected", reason: "USER_STOP_REQUESTED" });
    await f.service.audit("process.start", { user: "owner@example.test", sessionId: "own-connection", processId: "own-process", command: "echo private command", output: "same-process-output" });
    await f.service.audit("process.exit", { user: "owner@example.test", sessionId: "own-connection", processId: "own-process", output: "same-process-output", exitCode: 0 });
    await f.service.audit("operation.received", { user: "other@example.test", sessionId: "other-connection", connectionId: "other-connection", operationId: "operation-other", tool: "file_read", target: "secret-other.txt", receivedAt: "2026-09-27T00:00:00.000Z", status: "running" });
    await f.service.audit("operation.rejected", { user: "other@example.test", sessionId: "own-connection", connectionId: "own-connection", operationId: "spoofed-operation", tool: "file_read", target: "foreign secret", status: "rejected" });
    await f.service.audit("operation.rejected", { user: "owner@example.test", sessionId: "other-connection", connectionId: "other-connection", operationId: "spoofed-session", tool: "file_read", target: "other owner's secret", status: "rejected" });
    assert.equal((await fetch(`${base}/user`, { redirect: "manual" })).headers.get("location"), "/user/login");
    const login = await fetch(`${base}/user/login`, { method: "POST", headers: { origin: f.service.cfg.baseUrl, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "owner@example.test", password: "correct-horse-battery" }), redirect: "manual" });
    assert.equal(login.status, 303);
    const loginCookie = /rdmcp_user=([^;,]+)/.exec(login.headers.get("set-cookie")!)?.[1];
    assert.ok(loginCookie);
    const cookie = `rdmcp_user=${loginCookie}`;
    const page = await (await fetch(`${base}/user`, { headers: { cookie } })).text();
    assert.match(page, /RDMCP User Console/);
    assert.match(page, /own-connection/);
    assert.match(page, /セッション一覧/);
    assert.match(page, /operation-rejected-open/);
    assert.match(page, /request:operation-rejected-open/);
    assert.match(page, /停止を再試行/);
    assert.match(page, /停止担当機能から終了確認応答がありません/);
    assert.match(page, /PID 444/);
    assert.doesNotMatch(page, /own-file\.txt|same-process-output/);
    assert.doesNotMatch(page, /other-connection|PID 555/);
    assert.doesNotMatch(page, /operation-other|secret-other\.txt|spoofed-operation|foreign secret|spoofed-session|other owner's secret/);
    const detail = await (await fetch(`${base}/user/sessions/own-connection`, { headers: { cookie } })).text();
    assert.match(detail, /operation-own|file_read/);
    assert.match(detail, /succeeded|1000 ms/);
    assert.match(detail, /operation-open|9:01:01/);
    assert.match(detail, /実行中の操作はありません/);
    const visibleProcessOutput = [...detail.replace(/<script[\s\S]*<\/script>/, "").matchAll(/<pre>([\s\S]*?)<\/pre>/g)].map((match) => match[1]).join("\n");
    assert.equal(visibleProcessOutput.split("same-process-output").length - 1, 1, "one process detail shows its final output once");
    assert.doesNotMatch(detail, /other-connection|operation-other|secret-other\.txt|spoofed-operation|foreign secret|spoofed-session|other owner's secret/);
    const beforeSession = await (await fetch(`${base}/user/sessions/${encodeURIComponent("request:operation-rejected-open")}`, { headers: { cookie } })).text();
    assert.match(beforeSession, /operation-rejected-open|rejected/);
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
    assert.equal((await fetch(`${base}/user/emergency-stop`, { method: "POST", headers: { cookie, origin: f.service.cfg.baseUrl }, redirect: "manual" })).status, 403, "Origin alone must not satisfy CSRF validation");
    const stopped = await fetch(`${base}/user/emergency-stop`, { method: "POST", headers: { cookie, origin: f.service.cfg.baseUrl, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf }), redirect: "manual" });
    assert.equal(stopped.status, 303);
    assert.equal(f.service.userExecutionState("owner@example.test").stopped, true);
    const afterRetry = await (await fetch(`${base}/user`, { headers: { cookie } })).text();
    assert.doesNotMatch(afterRetry, /PID 444/, "warnings from the previous stopId disappear after retry");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await f.cleanup(); }
});

test("custom Desktop Commander launchers remain bootstrap-managed", () => {
  const shared = { BASE_URL: "http://127.0.0.1", TOKEN_SECRET: "x".repeat(32), AUTHORIZED_USERS_JSON: '[{"email":"u","passwordHash":"scrypt$x$y"}]', FILE_ROOTS_JSON: '[{"id":"r","path":"reference"}]', DESKTOP_COMMANDER_COMMAND: process.execPath, DESKTOP_COMMANDER_ARGS: "entry.mjs" };
  assert.throws(() => configFromEnv(shared), /managed Desktop Commander launcher is supported/i);
  assert.throws(() => configFromEnv({ ...shared, DESKTOP_COMMANDER_ARGS: "" }), /managed Desktop Commander launcher is supported/i);
});

test("Google user login binds callback cookie at the callback path and rechecks approval", async () => {
  const identity = { iss: "https://accounts.google.com", sub: "user-sub" };
  const state: OAuthState = { version: 1, epoch: 1, allowedSubjects: [identity], refreshes: [], families: {} };
  const cfg = configFromEnv({ BASE_URL: "https://example.test", TOKEN_SECRET: "x".repeat(40), REMOTE_AUTH_MODE: "google", GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret", FILE_ROOTS_JSON: '[{"id":"files","path":"reference"}]' });
  cfg.publicAuthOptions = { store: { load: async () => structuredClone(state), save: async () => undefined }, verifier: { authorizationUrl: ({ state }) => `https://accounts.google.com/?state=${state}`, exchangeCode: async () => identity } };
  const service = new RemoteDesktopService(cfg);
  const server = createApp(service).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const begin = await fetch(`${base}/user/login`, { method: "POST", headers: { origin: cfg.baseUrl }, redirect: "manual" });
    assert.equal(begin.status, 303);
    assert.match(begin.headers.get("content-security-policy")!, /default-src 'none'/);
    const callbackUrl = new URL(begin.headers.get("location")!);
    const flowState = callbackUrl.searchParams.get("state")!;
    const setCookie = begin.headers.get("set-cookie")!;
    const binding = /rdmcp_user_google_binding=([^;,]+)/.exec(setCookie)?.[1];
    assert.ok(binding);
    const callback = await fetch(`${base}/google/callback?state=${encodeURIComponent(flowState)}&code=valid`, { headers: { cookie: `rdmcp_user_google_binding=${binding}` }, redirect: "manual" });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get("cache-control"), "no-store");
    assert.equal(callback.headers.get("x-content-type-options"), "nosniff");
    const userCookie = /rdmcp_user=([^;,]+)/.exec(callback.headers.get("set-cookie")!)?.[1];
    assert.ok(userCookie);
    const csrfGuard = { method: "POST", headers: { cookie: `rdmcp_user=${userCookie}`, origin: cfg.baseUrl }, redirect: "manual" as RequestRedirect };
    assert.equal((await fetch(`${base}/user/resume`, csrfGuard)).status, 403, "an approved browser session reaches the CSRF guard");
    state.allowedSubjects = [];
    const revoked = await fetch(`${base}/user/resume`, csrfGuard);
    assert.equal(revoked.status, 303);
    assert.equal(revoked.headers.get("location"), "/user/login");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("Issue 48: session metadata edits require owner and CSRF, compare versions, and reject unsupported states and fields", async () => {
  const f = await fixture();
  const owner = await mcp(f.service);
  const other = await mcp(f.service, "other@example.test");
  f.service.cfg.processAdapter = { start: async () => "PID 81", read: async () => "", terminate: async () => "", sessions: async () => "" };
  const server = createApp(f.service).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const owned = await owner.call("session_open", { working_directory: f.root, purpose: "Initial purpose" });
    const foreign = await other.call("session_open", { working_directory: f.data, purpose: "Private purpose" });
    const linked = await owner.call("session_open", { working_directory: f.root, purpose: "Link edit contract" });
    const login = await fetch(`${base}/user/login`, { method: "POST", headers: { origin: f.service.cfg.baseUrl, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "owner@example.test", password: "correct-horse-battery" }), redirect: "manual" });
    const cookieValue = /rdmcp_user=([^;,]+)/.exec(login.headers.get("set-cookie")!)?.[1]; assert.ok(cookieValue);
    const cookie = `rdmcp_user=${cookieValue}`;
    const page = await (await fetch(`${base}/user`, { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
    assert.match(page, new RegExp(`data-session-edit="${String(owned.session_id)}"`), "active owned sessions expose an edit control");
    const update = (sessionId: string, body: Record<string, unknown>, csrfToken = csrf, origin = f.service.cfg.baseUrl, withCookie = true) => fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH", headers: { ...(withCookie ? { cookie } : {}), origin, "content-type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify(body),
    });
    const linkUpdate = await update(String(linked.session_id), { expectedVersion: 1, externalUrl: "https://example.com/manual", externalTitle: "Manual link title" });
    assert.equal(linkUpdate.status, 200, "URL and title edits are accepted atomically");
    assert.deepEqual(await linkUpdate.json(), {
      session_id: linked.session_id,
      working_directory: f.root,
      purpose: "Link edit contract",
      external_url: "https://example.com/manual",
      external_title: "Manual link title",
      external_title_source: "manual",
      external_title_status: "not_requested",
      version: 2,
      changedFields: ["externalUrl", "externalTitle"],
    });
    assert.equal(f.service.sessions.get(String(linked.session_id))?.linkRevision, 1);
    const linkedState = await (await fetch(`${base}/api/console-state`, { headers: { cookie } })).json() as { sessions: Array<Record<string, unknown>> };
    const linkedOwnerState = linkedState.sessions.find((session) => session.session_id === linked.session_id)!;
    assert.equal(linkedOwnerState.external_url, "https://example.com/manual");
    assert.equal(linkedOwnerState.external_title, "Manual link title");
    assert.equal(linkedOwnerState.external_title_source, "manual");
    assert.equal(linkedOwnerState.external_title_status, "not_requested");
    assert.equal(Object.hasOwn(linkedOwnerState, "link_revision"), false, "the internal fetch generation is not exposed to the browser");
    const clearUrl = await update(String(linked.session_id), { expectedVersion: 2, externalUrl: null });
    assert.equal(clearUrl.status, 200);
    const afterUrlClear = await clearUrl.json() as { external_url: string | null; external_title: string | null; external_title_source: string | null; version: number };
    assert.equal(afterUrlClear.external_url, null);
    assert.equal(afterUrlClear.external_title, "Manual link title", "clearing a URL keeps a manual title");
    assert.equal(afterUrlClear.version, 3);
    assert.equal(f.service.sessions.get(String(linked.session_id))?.linkRevision, 2);
    const clearTitle = await update(String(linked.session_id), { expectedVersion: 3, externalTitle: "   " });
    assert.equal(clearTitle.status, 200, "blank text clears a title field");
    const afterTitleClear = await clearTitle.json() as { external_title: string | null; external_title_source: string | null; external_title_status: string; version: number };
    assert.equal(afterTitleClear.external_title, null);
    assert.equal(afterTitleClear.external_title_source, null);
    assert.equal(afterTitleClear.external_title_status, "not_requested");
    assert.equal(afterTitleClear.version, 4);
    assert.equal(f.service.sessions.get(String(linked.session_id))?.linkRevision, 3);
    assert.equal((await update(String(owned.session_id), { expectedVersion: 1, purpose: "No login" }, "", f.service.cfg.baseUrl, false)).status, 401);
    assert.equal((await update(String(owned.session_id), { expectedVersion: 1, purpose: "No token" }, "")).status, 403);
    assert.equal((await update(String(owned.session_id), { expectedVersion: 1, purpose: "Wrong origin" }, csrf, "https://attacker.example")).status, 403);
    const externalUrlRejected = await update(String(owned.session_id), { expectedVersion: 1, workingDirectory: f.base, purpose: "Must not partially commit", externalUrl: "file:///etc/passwd" });
    assert.equal(externalUrlRejected.status, 400, "invalid explicit link fields reject the whole PATCH");
    assert.equal((await externalUrlRejected.json() as { error: string }).error, "invalid_external_link");
    const unchangedAfterInvalidLink = f.service.sessions.get(String(owned.session_id))!;
    assert.equal(unchangedAfterInvalidLink.workingDirectory, f.root);
    assert.equal(unchangedAfterInvalidLink.purpose, "Initial purpose");
    assert.equal(unchangedAfterInvalidLink.version, 1);
    assert.equal((await update(String(owned.session_id), { expectedVersion: 1, externalTitle: 17 })).status, 400, "link fields require strings or null");
    assert.equal((await update(String(owned.session_id), { expectedVersion: 1, unexpected: true })).status, 400, "unknown fields are rejected");
    assert.equal((await update(String(owned.session_id), { expectedVersion: 1, workingDirectory: f.base, purpose: "Updated purpose" })).status, 200);
    const state = await (await fetch(`${base}/api/console-state`, { headers: { cookie } })).json() as { sessions: Array<{ session_id: string; working_directory: string; purpose: string; version: number }> };
    const current = state.sessions.find((session) => session.session_id === owned.session_id);
    assert.ok(current);
    assert.equal(current.session_id, owned.session_id);
    assert.equal(current.working_directory, f.base);
    assert.equal(current.purpose, "Updated purpose");
    assert.equal(current.version, 2);
    const directoryAccessService = f.service as unknown as { checkSessionWorkingDirectoryAccess?: (directory: string) => Promise<void> };
    const originalDirectoryAccess = directoryAccessService.checkSessionWorkingDirectoryAccess;
    let checkedDirectory = "";
    directoryAccessService.checkSessionWorkingDirectoryAccess = async (directory) => {
      checkedDirectory = directory;
      const denied = new Error("EACCES: execute permission denied") as NodeJS.ErrnoException;
      denied.code = "EACCES";
      throw denied;
    };
    try {
      const denied = await update(String(owned.session_id), { expectedVersion: 2, workingDirectory: f.root, purpose: "Must remain unchanged" });
      assert.equal(denied.status, 400, "an X_OK access denial rejects the metadata PATCH");
      assert.deepEqual(await denied.json(), { error: "invalid_working_directory" });
      assert.equal(checkedDirectory, f.root, "the access check receives the resolved requested directory");
      const deniedState = await (await fetch(`${base}/api/console-state`, { headers: { cookie } })).json() as typeof state;
      const unchanged = deniedState.sessions.find((session) => session.session_id === owned.session_id);
      assert.ok(unchanged);
      assert.equal(unchanged.working_directory, current.working_directory);
      assert.equal(unchanged.purpose, current.purpose);
      assert.equal(unchanged.version, current.version);
    } finally {
      if (originalDirectoryAccess) directoryAccessService.checkSessionWorkingDirectoryAccess = originalDirectoryAccess;
      else delete directoryAccessService.checkSessionWorkingDirectoryAccess;
    }
    await writeFile(`${f.base}/not-a-directory`, "file");
    assert.equal((await update(String(owned.session_id), { expectedVersion: 2, workingDirectory: `${f.base}/not-a-directory` })).status, 400);
    const audit = f.service.auditEntriesForConsole().find((event) => event.event === "session.metadata.updated" && event.sessionId === owned.session_id);
    assert.ok(audit);
    assert.deepEqual(audit.changedFields, ["workingDirectory", "purpose"]);
    assert.equal(audit.previousVersion, 1);
    assert.equal(audit.version, 2);
    assert.equal(JSON.stringify(audit).includes(f.base), false, "updated values are not copied into the audit event");
    const auditCount = f.service.auditEntriesForConsole().filter((event) => event.event === "session.metadata.updated").length;
    const noOp = await update(String(owned.session_id), { expectedVersion: 2, workingDirectory: f.base, purpose: "Updated purpose" });
    assert.equal(noOp.status, 200);
    assert.equal((await noOp.json() as { version: number }).version, 2);
    assert.equal(f.service.auditEntriesForConsole().filter((event) => event.event === "session.metadata.updated").length, auditCount);
    const concurrent = await Promise.all([
      update(String(owned.session_id), { expectedVersion: 2, purpose: "Concurrent edit A" }),
      update(String(owned.session_id), { expectedVersion: 2, purpose: "Concurrent edit B" }),
    ]);
    assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 409]);
    const concurrentState = await (await fetch(`${base}/api/console-state`, { headers: { cookie } })).json() as typeof state;
    const concurrentPurpose = concurrentState.sessions.find((session) => session.session_id === owned.session_id)?.purpose;
    assert.ok(["Concurrent edit A", "Concurrent edit B"].includes(String(concurrentPurpose)));
    assert.equal(concurrentState.sessions.find((session) => session.session_id === owned.session_id)?.version, 3);
    const conflict = await update(String(owned.session_id), { expectedVersion: 2, purpose: "Stale overwrite" });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json() as { error: string }).error, "version_conflict");
    assert.equal((await (await fetch(`${base}/api/console-state`, { headers: { cookie } })).json() as typeof state).sessions.find((session) => session.session_id === owned.session_id)?.purpose, concurrentPurpose);
    assert.equal((await update(String(owned.session_id), { expectedVersion: 3, workingDirectory: `${f.base}-missing` })).status, 400);
    assert.equal((await update(String(foreign.session_id), { expectedVersion: 1, purpose: "Attempt" })).status, 404);
    assert.equal((await update("missing-session-id-00000000", { expectedVersion: 1, purpose: "Attempt" })).status, 404);
    const closed = await owner.call("session_open", { working_directory: f.root, purpose: "Closed session" });
    await owner.call("session_close", { session_id: closed.session_id });
    assert.equal((await update(String(closed.session_id), { expectedVersion: 1, purpose: "Attempt" })).status, 404);
    const expired = await owner.call("session_open", { working_directory: f.root, purpose: "Expired session" });
    f.service.sessions.get(String(expired.session_id))!.expires = Date.now() - 1;
    assert.equal((await update(String(expired.session_id), { expectedVersion: 1, purpose: "Attempt" })).status, 404);
    const stopped = await owner.call("session_open", { working_directory: f.root, purpose: "Stopped session" });
    await f.service.stopUserExecution("owner@example.test");
    assert.equal((await update(String(stopped.session_id), { expectedVersion: 1, purpose: "Attempt" })).status, 404);
  } finally { await owner.close(); await other.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await f.cleanup(); }
});

test("Issue 48: a fetched title does not advance the edit version or get erased by a stale sparse PATCH", async () => {
  const f = await fixture();
  let releaseResponse!: (value: { status: number; contentType: string; body: Uint8Array }) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  f.service.cfg.sessionLinkTransport = { resolve: async () => ["93.184.216.34"], request: async () => { markStarted(); return new Promise((resolve) => { releaseResponse = resolve; }); } };
  const owner = await mcp(f.service);
  const server = createApp(f.service).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const opened = await owner.call("session_open", { working_directory: f.root, purpose: "Before link edit" });
    const login = await fetch(`${base}/user/login`, { method: "POST", headers: { origin: f.service.cfg.baseUrl, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "owner@example.test", password: "correct-horse-battery" }), redirect: "manual" });
    const token = /rdmcp_user=([^;,]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1]; assert.ok(token);
    const cookie = `rdmcp_user=${token}`;
    const page = await (await fetch(`${base}/user`, { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1]; assert.ok(csrf);
    const patch = (body: Record<string, unknown>) => fetch(`${base}/api/sessions/${encodeURIComponent(String(opened.session_id))}`, { method: "PATCH", headers: { cookie, origin: f.service.cfg.baseUrl, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(body) });
    const saved = await patch({ expectedVersion: 1, purpose: "Edited purpose", externalUrl: "https://example.com/fetched" });
    assert.equal(saved.status, 200);
    const saveResult = await saved.json() as { version: number; external_title_status: string };
    assert.equal(saveResult.version, 2);
    assert.equal(saveResult.external_title_status, "pending");
    await started;
    const session = f.service.sessions.get(String(opened.session_id)); assert.ok(session);
    releaseResponse({ status: 200, contentType: "text/html; charset=utf-8", body: new TextEncoder().encode("<title>Auto title</title>") });
    for (let tries = 0; tries < 100 && session.externalTitleStatus === "pending"; tries += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(session.externalTitle, "Auto title");
    assert.equal(session.version, 2, "background title retrieval does not consume the user's compare version");
    const staleDraftSave = await patch({ expectedVersion: 2, workingDirectory: f.base, purpose: "Edited purpose" });
    assert.equal(staleDraftSave.status, 200, "a form opened at the unchanged user version can save fields without link intent");
    const result = await staleDraftSave.json() as { version: number; external_title: string | null };
    assert.equal(result.version, 3);
    assert.equal(result.external_title, "Auto title", "omitting URL/title preserves the fetched title");
    assert.equal(session.externalTitle, "Auto title");
    assert.equal(session.version, 3);
  } finally { await owner.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await f.cleanup(); }
});

test("Issue 48: emergency stop is accepted while a session working directory is being validated", async () => {
  const f = await fixture();
  const owner = await mcp(f.service);
  let releasePathCheck!: (value: string) => void;
  let releaseStopMarker!: () => void;
  let stop: Promise<unknown> | undefined;
  let update: Promise<unknown> | undefined;
  let stopMarkerWasEntered = false;
  let enterPathCheck!: () => void;
  const pathCheckEntered = new Promise<void>((resolve) => { enterPathCheck = resolve; });
  const delayedPathCheck = new Promise<string>((resolve) => { releasePathCheck = resolve; });
  const delayedStopMarker = new Promise<void>((resolve) => { releaseStopMarker = resolve; });
  try {
    const opened = await owner.call("session_open", { working_directory: f.root, purpose: "Delayed path validation" });
    const service = f.service as unknown as {
      resolveSessionWorkingDirectory: (path: string) => Promise<string | undefined>;
      writeExecutionStopMarker: (state: unknown) => Promise<void>;
    };
    service.resolveSessionWorkingDirectory = async () => { enterPathCheck(); return delayedPathCheck; };
    update = f.service.updateSessionMetadata("owner@example.test", String(opened.session_id), { expectedVersion: 1, workingDirectory: f.base });
    await pathCheckEntered;
    const writeStopMarker = service.writeExecutionStopMarker.bind(f.service);
    service.writeExecutionStopMarker = async (state) => {
      stopMarkerWasEntered = true;
      await delayedStopMarker;
      await writeStopMarker(state);
    };
    stop = f.service.stopUserExecution("owner@example.test");
    await Promise.resolve();
    assert.equal(f.service.userExecutionState("owner@example.test").stopped, true, "stop must latch before persistence while path validation is still pending");
    assert.equal(stopMarkerWasEntered, true, "stop must reach persistence while path validation is still pending");
    releaseStopMarker();
    assert.equal((await stop as { stopped: boolean }).stopped, true);
    releasePathCheck(f.base);
    assert.deepEqual(await update as { ok: boolean; status: number; error: string }, { ok: false, status: 404, error: "session_unavailable" });
  } finally {
    releaseStopMarker();
    releasePathCheck(f.base);
    await Promise.allSettled([...(stop ? [stop] : []), ...(update ? [update] : [])]);
    await owner.close().catch(() => undefined);
    await f.cleanup();
  }
});

test("session edit and process start use one ordering boundary and preserve each start snapshot", async () => {
  const f = await fixture();
  const owner = await mcp(f.service);
  const startedDirectories: string[] = [];
  let releaseFirstStart!: () => void;
  let firstStartEntered!: () => void;
  const firstEntered = new Promise<void>((resolve) => { firstStartEntered = resolve; });
  const release = new Promise<void>((resolve) => { releaseFirstStart = resolve; });
  let calls = 0;
  f.service.cfg.processAdapter = {
    start: async (_command, _timeout, workingDirectory) => {
      startedDirectories.push(String(workingDirectory));
      calls++;
      if (calls === 1) { firstStartEntered(); await release; }
      return `PID ${80 + calls}\nProcess completed with exit code 0`;
    },
    read: async () => "", terminate: async () => "", sessions: async () => "",
  };
  const server = createApp(f.service).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const owned = await owner.call("session_open", { working_directory: f.root, purpose: "Snapshot test" });
    const login = await fetch(`${base}/user/login`, { method: "POST", headers: { origin: f.service.cfg.baseUrl, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "owner@example.test", password: "correct-horse-battery" }), redirect: "manual" });
    const cookieValue = /rdmcp_user=([^;,]+)/.exec(login.headers.get("set-cookie")!)?.[1]; assert.ok(cookieValue);
    const cookie = `rdmcp_user=${cookieValue}`;
    const page = await (await fetch(`${base}/user`, { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
    const firstProcess = owner.call("process_start", { session_id: owned.session_id, command: "first" });
    await firstEntered;
    const update = fetch(`${base}/api/sessions/${encodeURIComponent(String(owned.session_id))}`, {
      method: "PATCH", headers: { cookie, origin: f.service.cfg.baseUrl, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ expectedVersion: 1, workingDirectory: f.base, purpose: "Updated while start waits" }),
    });
    let updateSettled = false;
    void update.then(() => { updateSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(updateSettled, false, "edit waits until the in-flight start snapshots and launches with the old directory");
    releaseFirstStart();
    assert.ok((await firstProcess).process_id);
    const updated = await update;
    assert.equal(updated.status, 200);
    const secondProcess = await owner.call("process_start", { session_id: owned.session_id, command: "second" });
    assert.ok(secondProcess.process_id);
    assert.deepEqual(startedDirectories, [f.root, f.base]);
    const sessionProcesses = [...f.service.processes.values()].filter((process) => process.sessionId === owned.session_id).sort((left, right) => left.pid - right.pid);
    assert.deepEqual(sessionProcesses.map((process) => process.workingDirectorySnapshot), [f.root, f.base]);
    const startAudit = f.service.auditEntriesForConsole().filter((event) => event.event === "process.start");
    assert.deepEqual(startAudit.map((event) => event.workingDirectorySnapshot), [f.root, f.base]);
  } finally { releaseFirstStart(); await owner.close().catch(() => undefined); await new Promise<void>((resolve) => server.close(() => resolve())); await f.cleanup(); }
});
