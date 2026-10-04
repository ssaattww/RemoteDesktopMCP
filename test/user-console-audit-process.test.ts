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

test("Issue 55: running process details stay ahead of completed details and missing metadata never borrows another process", async () => {
  const f = await fixture(); const server = createApp(f.service).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`;
  try {
    const sessionId = "issue55-session";
    const otherSessionId = "issue55-other-session";
    await f.service.audit("session.open", { user: "owner@example.test", sessionId });
    await f.service.audit("session.open", { user: "owner@example.test", sessionId: otherSessionId });
    const starts = [
      { at: "2026-10-01T00:00:00.000Z", sessionId, processId: "running-no-metadata", command: "", comment: "" },
      { at: "2026-10-01T00:00:01.000Z", sessionId, processId: "completed-process", command: "echo completed", comment: "Completed job" },
      { at: "2026-10-01T00:00:02.000Z", sessionId, processId: "shared-process", command: "echo first-running", comment: "First running job" },
      { at: "2026-10-01T00:00:03.000Z", sessionId: otherSessionId, processId: "shared-process", command: "echo other-session", comment: "Other session secret" },
    ];
    for (const entry of starts) await f.service.audit("process.start", { ...entry, user: "owner@example.test" });
    await f.service.audit("process.exit", { at: "2026-10-03T00:00:00.000Z", user: "owner@example.test", sessionId, processId: "completed-process", exitCode: 0 });
    const activeProcess = (id: string, processSession: string, pid: number, state: "running" | "finished") => ({ id, sessionId: processSession, user: "owner@example.test", generation: "fixture-generation", pid, state, output: "", cursor: 0 });
    f.service.processes.set("fixture-first-running", activeProcess("shared-process", sessionId, 1001, "running"));
    f.service.processes.set("fixture-empty-metadata-running", activeProcess("running-no-metadata", sessionId, 1002, "running"));
    f.service.processes.set("fixture-finished", activeProcess("completed-process", sessionId, 1003, "finished"));
    f.service.processes.set("fixture-same-id-other-session", activeProcess("shared-process", otherSessionId, 1004, "running"));
    const login = await fetch(`${base}/user/login`, { method: "POST", headers: { origin: f.service.cfg.baseUrl, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "owner@example.test", password: "correct-horse-battery" }), redirect: "manual" });
    const token = /rdmcp_user=([^;,]+)/.exec(login.headers.get("set-cookie")!)?.[1]; assert.ok(token);
    const cookie = `rdmcp_user=${token}`;
    const stateResponse = await fetch(`${base}/api/console-state?session_id=${encodeURIComponent(sessionId)}`, { headers: { cookie } });
    const state = await stateResponse.json() as { running: Array<Record<string, unknown>> };
    const mismatches: string[] = [];
    if (stateResponse.status !== 200) mismatches.push(`same-session console-state status was ${stateResponse.status}`);
    if (JSON.stringify(state.running.map((entry) => entry.operation_id)) !== JSON.stringify(["shared-process", "running-no-metadata"])) mismatches.push(`same-session running IDs were ${JSON.stringify(state.running.map((entry) => entry.operation_id))}`);
    if (JSON.stringify(state.running.map((entry) => [entry.purpose, entry.command])) !== JSON.stringify([["First running job", "echo first-running"], ["", ""]])) mismatches.push("same-session console-state omitted purpose/command needed after refresh");
    const detail = await (await fetch(`${base}/user/sessions/${encodeURIComponent(sessionId)}`, { headers: { cookie } })).text();
    const runningSection = /<h2>Running operations<\/h2>([\s\S]*?)<\/section>/.exec(detail)?.[1] ?? "";
    const runningRows = [...runningSection.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].slice(1).map((match) => match[1] ?? "");
    if (!/shared-process/.test(runningRows[0] ?? "") || !/First running job[\s\S]*echo first-running/.test(runningRows[0] ?? "")) mismatches.push(`first Running operations row omitted its purpose/command or process identity: ${runningRows[0] ?? "<missing>"}`);
    if (!/running-no-metadata/.test(runningRows[1] ?? "") || !/未記録/.test(runningRows[1] ?? "")) mismatches.push(`second Running operations row omitted its process identity or missing-value fallback: ${runningRows[1] ?? "<missing>"}`);
    const runningLink = /<a\b[^>]*href="#([^"]+)"[^>]*data-session-id="issue55-session"[^>]*data-process-id="shared-process"[^>]*>[^<]*<\/a>/.exec(runningSection);
    if (!runningLink) mismatches.push("running row lacks an in-page link identified by session and process IDs");
    else if (!new RegExp(`<article[^>]*data-session-id="issue55-session"[^>]*data-process-id="shared-process"[^>]*>[\\s\\S]*?<h3[^>]*id="${runningLink[1]}"`).test(detail)) mismatches.push("running link does not resolve to the heading of its same-session process detail");
    if (/Other session secret|echo other-session/.test(detail)) mismatches.push("duplicate process ID leaked metadata from another session");
    const blocks = [...detail.matchAll(/<article class="process-block"[^>]*data-process-id="([^"]+)"[\s\S]*?<\/article>/g)];
    const blockFor = (processId: string) => blocks.find((match) => match[1] === processId)?.[0] ?? "";
    const missingBlock = blockFor("running-no-metadata");
    const order = blocks.map((match) => match[1]);
    if (JSON.stringify(order) !== JSON.stringify(["shared-process", "running-no-metadata", "completed-process"])) mismatches.push(`running-first order was ${JSON.stringify(order)}`);
    if (!/未記録/.test(missingBlock)) mismatches.push("empty purpose/command did not render 未記録");
    if (/First running job|echo first-running|Completed job|echo completed/.test(missingBlock)) mismatches.push("missing metadata borrowed another process's values");
    if (!/First running job/.test(blockFor("shared-process")) || !/echo first-running/.test(blockFor("shared-process"))) mismatches.push("shared-process purpose/command are not in its own same-session detail");
    if (!/Completed job/.test(blockFor("completed-process")) || !/echo completed/.test(blockFor("completed-process"))) mismatches.push("completed-process purpose/command are not in its own detail");
    assert.deepEqual(mismatches, [], "process order and missing-metadata isolation contract");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await f.cleanup(); }
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
    assert.match(html, /id="auto-refresh"/);
    assert.match(html, /自動更新を停止中は新しい情報を自動反映しません。手動更新（↻ 更新）を使用してください。/, "the paused toggle explains that automatic reflection stops and manual refresh remains available");
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
    assert.doesNotMatch(detail, /id="auto-refresh"/);
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
