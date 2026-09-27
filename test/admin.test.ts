import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { configFromEnv, createApp, RemoteDesktopService } from "../src/index.js";
import type { OAuthState } from "../src/public-auth.js";
import { readSessionLogs } from "../src/admin.js";
import { fixture, mcp } from "./fixture.js";

test("admin session page requires an explicit administrator and renders escaped JST history", async () => {
  const f = await fixture();
  const server = createApp(f.service).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const login = () => fetch(`${base}/admin/login`, { method: "POST", headers: { origin: new URL(f.service.cfg.baseUrl).origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "owner@example.test", password: "correct-horse-battery" }), redirect: "manual" });
  try {
    assert.equal((await fetch(`${base}/admin/sessions`, { redirect: "manual" })).headers.get("location"), "/admin/login");
    assert.equal((await login()).status, 403);
    f.service.cfg.adminUsers = ["owner@example.test"];
    const response = await login(); assert.equal(response.status, 303);
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    await f.service.audit("session.open", { at: "2026-09-26T16:00:00.000Z", user: "owner@example.test", sessionId: "session-admin-test" });
    await f.service.audit("process.start", { sessionId: "session-admin-test", processId: "p1", command: "echo <script>alert(1)</script>", output: "example output" });
    await f.service.audit("process.exit", { processId: "p1", exitCode: 0 });
    const detail = await fetch(`${base}/admin/sessions?session=session-admin-test`, { headers: { cookie } });
    const html = await detail.text();
    assert.equal(detail.headers.get("cache-control"), "no-store");
    assert.match(html, /2026\/09\/27 01:00:00 JST/);
    assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
    assert.match(html, /example output/); assert.match(html, /終了コード: 0/);
    const restarted = new RemoteDesktopService(f.service.cfg);
    assert.equal((await readSessionLogs(restarted)).sessions.find((entry) => entry.id === "session-admin-test")?.state, "unavailable");
    f.service.cfg.adminUsers = [];
    assert.equal((await fetch(`${base}/admin/sessions`, { headers: { cookie }, redirect: "manual" })).headers.get("location"), "/admin/login");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await f.cleanup(); }
});

test("local admin password attempts ignore forwarding headers and cookie omission", async () => {
  const f = await fixture();
  f.service.cfg.adminUsers = ["owner@example.test"];
  const server = createApp(f.service).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const login = (forwarded: string, email = "missing@example.test", password = "incorrect") => fetch(`${base}/admin/login`, { method: "POST", headers: { origin: new URL(f.service.cfg.baseUrl).origin, "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": forwarded }, body: new URLSearchParams({ email, password }), redirect: "manual" });
  try {
    const first = await login("198.51.100.1");
    assert.equal(first.status, 403);
    assert.match(first.headers.get("set-cookie")!, /HttpOnly/);
    for (let attempt = 2; attempt <= 10; attempt += 1) assert.equal((await login(`198.51.100.${attempt}`)).status, 403);
    assert.equal((await login("198.51.100.11", "owner@example.test", "correct-horse-battery")).status, 429, "omitting the browser budget cookie cannot reset local password admission");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await f.cleanup(); }
});

test("process output and completion are persisted with session correlation and redaction", async () => {
  const f = await fixture();
  f.service.cfg.processAdapter = { start: async () => "PID 123\nhello\npassword=hidden\nProcess completed with exit code 0", read: async () => "", terminate: async () => "", sessions: async () => "" };
  const api = await mcp(f.service);
  try {
    const sid = (await api.call("session_open", {})).session_id as string;
    await api.call("process_start", { session_id: sid, command: "echo hello --password hidden" });
    await api.call("session_close", { session_id: sid });
    const session = (await readSessionLogs(f.service)).sessions.find((entry) => entry.id === sid)!;
    assert.equal(session.state, "closed");
    const start = session.events.find((entry) => entry.event === "process.start")!;
    const exit = session.events.find((entry) => entry.event === "process.exit")!;
    assert.match(String(start.command), /\[redacted\]/);
    assert.match(String(exit.output), /hello/);
    assert.doesNotMatch(JSON.stringify(session.events), /hidden/);
    assert.equal(exit.exitCode, 0);
    let finished = false;
    f.service.cfg.processAdapter = { start: async () => "PID 124", read: async () => finished ? "Reading 1 new lines (total: 1 lines)\nfinished\nProcess completed with exit code 0" : "Reading 0 new lines (total: 0 lines)", terminate: async () => "", sessions: async () => "PID: 124" };
    const nextSid = (await api.call("session_open", {})).session_id as string;
    const processId = (await api.call("process_start", { session_id: nextSid, command: "test idle output" })).process_id;
    await api.call("process_output", { session_id: nextSid, process_id: processId });
    const idle = (await readSessionLogs(f.service)).sessions.find((entry) => entry.id === nextSid)!;
    assert.equal(idle.events.filter((entry) => entry.event === "process.output").length, 0);
    finished = true;
    await api.call("process_output", { session_id: nextSid, process_id: processId });
    const completed = (await readSessionLogs(f.service)).sessions.find((entry) => entry.id === nextSid)!;
    assert.ok(completed.events.some((entry) => entry.event === "process.output" && String(entry.output).includes("finished")));

  } finally { await api.close(); await f.cleanup(); }
});

test("session log retains a redacted process command with a result beyond the event window", async () => {
  const f = await fixture();
  const sessionId = "session-process-history";
  const processId = "process-history";
  try {
    await f.service.audit("session.open", { user: "owner@example.test", sessionId });
    await f.service.audit("process.start", { sessionId, processId, command: "echo [redacted]" });
    const at = new Date().toISOString();
    await appendFile(path.join(f.data, "audit.jsonl"), `${Array.from({ length: 200 }, (_, event) => JSON.stringify({ at, event: "process.output", sessionId, processId, output: `output ${event}` })).join("\n")}\n`);
    let session = (await readSessionLogs(f.service)).sessions.find((entry) => entry.id === sessionId)!;
    assert.equal(session.events.length, 200);
    assert.ok(!session.events.some((entry) => entry.event === "process.start"));
    assert.equal(session.events.findLast((entry) => entry.event === "process.output")?.command, "echo [redacted]");
    await f.service.audit("process.exit", { sessionId, processId, output: "completed", exitCode: 0 });
    session = (await readSessionLogs(f.service)).sessions.find((entry) => entry.id === sessionId)!;
    const exit = session.events.find((entry) => entry.event === "process.exit")!;
    assert.equal(exit.command, "echo [redacted]");
    assert.equal(exit.output, "completed");
  } finally { await f.cleanup(); }
});

test("session log associates retained output when unrelated events evict its process start", async () => {
  const f = await fixture();
  const sessionId = "session-process-eviction";
  const processId = "process-eviction";
  try {
    await f.service.audit("process.start", { sessionId, processId, command: "echo [redacted]" });
    await f.service.audit("process.output", { sessionId, processId, output: "still running" });
    const at = new Date().toISOString();
    await appendFile(path.join(f.data, "audit.jsonl"), `${Array.from({ length: 199 }, (_, event) => JSON.stringify({ at, event: "file.read", sessionId, output: `unrelated ${event}` })).join("\n")}\n`);
    const session = (await readSessionLogs(f.service)).sessions.find((entry) => entry.id === sessionId)!;
    assert.equal(session.events.length, 200);
    assert.ok(!session.events.some((entry) => entry.event === "process.start"));
    const output = session.events.find((entry) => entry.event === "process.output")!;
    assert.equal(output.command, "echo [redacted]");
    assert.equal(output.output, "still running");
  } finally { await f.cleanup(); }
});

test("admin list filters, sorts, and retains latest command metadata outside the event window", async () => {
  const f = await fixture();
  f.service.cfg.adminUsers = ["owner@example.test"];
  const server = createApp(f.service).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/admin/login`, { method: "POST", headers: { origin: new URL(f.service.cfg.baseUrl).origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "owner@example.test", password: "correct-horse-battery" }), redirect: "manual" });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const api = await mcp(f.service);
  try {
    const emptyList = await (await fetch(`${base}/admin/sessions`, { headers: { cookie } })).text();
    assert.match(emptyList, /data-empty-session-message>該当するセッションログはありません。/);
    const client = await (await fetch(`${base}/admin/client.js`, { headers: { cookie } })).text();
    assert.match(client, /empty\.hidden = payload\.sessions\.length > 0/);
    const activeId = (await api.call("session_open", {})).session_id as string;
    await f.service.audit("process.start", { at: "2026-09-25T00:00:00.000Z", sessionId: activeId, processId: "old-process", command: "echo old" });
    await f.service.audit("session.open", { at: "2026-09-21T00:00:00.000Z", user: "owner@example.test", sessionId: "new-closed" });
    await f.service.audit("process.start", { at: "2026-09-26T00:00:00.000Z", sessionId: "new-closed", processId: "new-process", command: "echo new" });
    await f.service.audit("session.close", { sessionId: "new-closed" });
    await f.service.audit("session.open", { at: "2026-09-22T00:00:00.000Z", user: "owner@example.test", sessionId: "never-ran" });
    await f.service.audit("session.close", { sessionId: "never-ran" });
    const noiseAt = "2026-09-27T00:00:00.000Z";
    await appendFile(path.join(f.data, "audit.jsonl"), `${Array.from({ length: 201 }, (_, event) => JSON.stringify({ at: noiseAt, event: "file.read", sessionId: activeId, output: `noise ${event}` })).join("\n")}\n`);
    const retained = (await readSessionLogs(f.service)).sessions.find((session) => session.id === activeId)!;
    assert.equal(retained.events.length, 200);
    assert.equal(retained.latestCommandAt, "2026-09-25T00:00:00.000Z");
    const json = await fetch(`${base}/admin/sessions.json?state=inactive&sort=latest&direction=desc`, { headers: { cookie } });
    assert.equal(json.status, 200);
    const sessions = (await json.json() as { sessions: Array<{ id: string; latestCommandAtLabel: string }> }).sessions;
    assert.deepEqual(sessions.map((session) => session.id), ["new-closed", "never-ran"]);
    assert.match(sessions[0]!.latestCommandAtLabel, /2026\/09\/26 09:00:00 JST/);
    const all = await (await fetch(`${base}/admin/sessions.json?sort=created&direction=asc`, { headers: { cookie } })).json() as { sessions: Array<{ id: string; latestCommandAtLabel: string }> };
    assert.equal(all.sessions.find((session) => session.id === "never-ran")?.latestCommandAtLabel, "未実行");
    const active = await (await fetch(`${base}/admin/sessions.json?state=active`, { headers: { cookie } })).json() as { sessions: Array<{ id: string }> };
    assert.deepEqual(active.sessions.map((session) => session.id), [activeId]);
    const list = await fetch(`${base}/admin/sessions`, { headers: { cookie } });
    const html = await list.text();
    assert.match(list.headers.get("content-security-policy")!, /script-src 'self'; connect-src 'self'/);
    assert.doesNotMatch(list.headers.get("content-security-policy")!, /unsafe-inline'.*script/);
    assert.doesNotMatch(html, /owner@example\.test/);
    assert.doesNotMatch(html, />old-active</);
    assert.match(html, /data-empty-session-message hidden/);
    assert.equal((await fetch(`${base}/admin/sessions.json`)).status, 401);
  } finally { await api.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await f.cleanup(); }
});

test("admin detail groups interleaved process records and only coalesces duplicate start and exit snapshots", async () => {
  const f = await fixture();
  f.service.cfg.adminUsers = ["owner@example.test"];
  const server = createApp(f.service).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/admin/login`, { method: "POST", headers: { origin: new URL(f.service.cfg.baseUrl).origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "owner@example.test", password: "correct-horse-battery" }), redirect: "manual" });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  try {
    const sessionId = "interleaved";
    await f.service.audit("process.start", { sessionId, processId: "one", command: "echo one", output: "initial snapshot" });
    await f.service.audit("process.start", { sessionId, processId: "two", command: "echo two", output: "two output" });
    await f.service.audit("process.output", { sessionId, processId: "one", output: "same distinct output" });
    await f.service.audit("process.output", { sessionId, processId: "one", output: "same distinct output" });
    await f.service.audit("process.exit", { sessionId, processId: "one", output: "initial snapshot\nidle poll not audited\nsame distinct output\nsame distinct output", exitCode: 0 });
    await f.service.audit("legacy.event", { sessionId, output: "legacy output" });
    const html = await (await fetch(`${base}/admin/sessions?session=${sessionId}`, { headers: { cookie } })).text();
    assert.equal((html.match(/initial snapshot/g) ?? []).length, 1);
    assert.equal((html.match(/same distinct output/g) ?? []).length, 2);
    assert.match(html, /two output/);
    assert.doesNotMatch(html, /idle poll not audited/);
    assert.match(html, /開始: .*JST/);
    assert.match(html, /完了: .*JST/);
    assert.match(html, /開始情報は履歴上限により表示されません|コマンド実行/);
    assert.match(html, /legacy.event/);
    assert.doesNotMatch(html, /interleaved/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await f.cleanup(); }
});

test("Google admin login binds the callback to the browser and checks approval on each request", async () => {
  const identity = { iss: "https://accounts.google.com", sub: "admin-sub" };
  const state: OAuthState = { version: 1, epoch: 1, allowedSubjects: [identity], refreshes: [], families: {} };
  const cfg = configFromEnv({ BASE_URL: "https://example.test", TOKEN_SECRET: "x".repeat(40), REMOTE_AUTH_MODE: "google", GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret", FILE_ROOTS_JSON: '[{"id":"files","path":"reference"}]', ADMIN_USERS: "admin-sub" });
  cfg.publicAuthOptions = { store: { load: async () => structuredClone(state), save: async () => undefined }, verifier: { authorizationUrl: ({ state }) => `https://accounts.google.com/?state=${state}`, exchangeCode: async () => identity } };
  const service = new RemoteDesktopService(cfg);
  const server = createApp(service).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const login = await fetch(`${base}/admin/login`, { method: "POST", headers: { origin: cfg.baseUrl }, redirect: "manual" });
    assert.match(login.headers.get("content-security-policy")!, /form-action 'self' https:\/\/accounts\.google\.com;/);
    assert.equal(login.headers.get("referrer-policy"), "same-origin");
    assert.equal((await fetch(`${base}/admin/login`, { method: "POST", headers: { origin: "null" }, redirect: "manual" })).status, 403, "a null Origin must not bypass the CSRF check");
    const callback = `${base}/google/callback?state=${new URL(login.headers.get("location")!).searchParams.get("state")}&code=test`;
    assert.equal((await fetch(callback, { redirect: "manual" })).status, 403);
    const signedIn = await fetch(callback, { headers: { cookie: login.headers.get("set-cookie")!.split(";")[0] }, redirect: "manual" });
    assert.equal(signedIn.status, 303);
    assert.match(signedIn.headers.get("set-cookie")!, /Secure/);
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await fetch(`${base}/admin/missing`, { headers: { cookie }, redirect: "manual" })).status, 404);
    state.allowedSubjects = [];
    assert.equal((await fetch(`${base}/admin/missing`, { headers: { cookie }, redirect: "manual" })).headers.get("location"), "/admin/login");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
