import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { createApp, RemoteDesktopService, configFromEnv } from "../src/index.js";
import { readSessionLogs } from "../src/admin.js";
import type { OAuthState } from "../src/public-auth.js";
import { fixture, mcp } from "./fixture.js";

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

test("Issue 48: explicitly clearing an empty failed title retries the fetch", async () => {
  const f = await fixture();
  let requestCount = 0;
  const releaseRetries: Array<(value: { status: number; contentType: string; body: Uint8Array }) => void> = [];
  f.service.cfg.sessionLinkTransport = {
    resolve: async () => ["93.184.216.34"],
    request: async () => {
      requestCount += 1;
      if (requestCount === 1) return { status: 500, contentType: "text/plain", body: new Uint8Array() };
      return new Promise((resolve) => { releaseRetries.push(resolve); });
    },
  };
  const owner = await mcp(f.service);
  const server = createApp(f.service).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const opened = await owner.call("session_open", { working_directory: f.root, purpose: "Retry failed title" });
    const login = await fetch(`${base}/user/login`, { method: "POST", headers: { origin: f.service.cfg.baseUrl, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "owner@example.test", password: "correct-horse-battery" }), redirect: "manual" });
    const token = /rdmcp_user=([^;,]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1]; assert.ok(token);
    const cookie = `rdmcp_user=${token}`;
    const page = await (await fetch(`${base}/user`, { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1]; assert.ok(csrf);
    const patch = (body: Record<string, unknown>) => fetch(`${base}/api/sessions/${encodeURIComponent(String(opened.session_id))}`, { method: "PATCH", headers: { cookie, origin: f.service.cfg.baseUrl, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(body) });

    const initial = await patch({ expectedVersion: 1, externalUrl: "https://example.com/retry" });
    assert.equal(initial.status, 200);
    const session = f.service.sessions.get(String(opened.session_id)); assert.ok(session);
    for (let tries = 0; tries < 100 && session.externalTitleStatus === "pending"; tries += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(session.externalTitleStatus, "failed");
    assert.equal(session.externalTitle, undefined);
    assert.equal(requestCount, 1);

    const retry = await patch({ expectedVersion: 2, externalTitle: null });
    assert.equal(retry.status, 200);
    const retryResult = await retry.json() as { version: number; external_title_status: string; changedFields: string[] };
    assert.equal(retryResult.version, 3, "an explicit clear that retries retrieval is a user metadata action");
    assert.deepEqual(retryResult.changedFields, ["externalTitle"]);
    assert.equal(session.externalTitleStatus, "pending");
    assert.equal(session.linkRevision, 2);
    assert.equal(requestCount, 2, "clearing an empty title starts a new fetch attempt");

    const pendingRetry = await patch({ expectedVersion: 3, externalTitle: null });
    assert.equal(pendingRetry.status, 200, "an explicit clear also supersedes an already-pending attempt");
    assert.equal((await pendingRetry.json() as { version: number }).version, 4);
    assert.equal(session.linkRevision, 3);
    assert.equal(requestCount, 3);

    releaseRetries[0]!({ status: 200, contentType: "text/html; charset=utf-8", body: new TextEncoder().encode("<title>Stale retry</title>") });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(session.externalTitleStatus, "pending", "the superseded attempt cannot complete the newest retrieval");
    assert.equal(session.externalTitle, undefined);

    releaseRetries[1]!({ status: 500, contentType: "text/plain", body: new Uint8Array() });
    for (let tries = 0; tries < 100 && session.externalTitleStatus === "pending"; tries += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(session.externalTitleStatus, "failed");
    assert.equal(session.version, 4, "the asynchronous failure does not advance the edit version");
  } finally {
    for (const release of releaseRetries) release({ status: 500, contentType: "text/plain", body: new Uint8Array() });
    await owner.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.cleanup();
  }
});

test("Issue 48: a fetched title survives rollback of an unrelated audit failure", async () => {
  const f = await fixture();
  let releaseFetch!: (value: { status: number; contentType: string; body: Uint8Array }) => void;
  let markFetchStarted!: () => void;
  const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
  f.service.cfg.sessionLinkTransport = { resolve: async () => ["93.184.216.34"], request: async () => { markFetchStarted(); return new Promise((resolve) => { releaseFetch = resolve; }); } };
  const auditService = f.service as unknown as { audit: (event: string, fields: Record<string, unknown>) => Promise<void> };
  const originalAudit = auditService.audit.bind(f.service);
  let holdMetadataAudit = false;
  let releaseMetadataAudit!: () => void;
  let markMetadataAuditStarted!: () => void;
  const metadataAuditGate = new Promise<void>((resolve) => { releaseMetadataAudit = resolve; });
  const metadataAuditStarted = new Promise<void>((resolve) => { markMetadataAuditStarted = resolve; });
  auditService.audit = async (event, fields) => {
    if (holdMetadataAudit && event === "session.metadata.updated" && fields.version === 3) {
      holdMetadataAudit = false;
      markMetadataAuditStarted();
      await metadataAuditGate;
      throw new Error("injected metadata audit failure");
    }
    await originalAudit(event, fields);
  };
  const owner = await mcp(f.service);
  const server = createApp(f.service).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const opened = await owner.call("session_open", { working_directory: f.root, purpose: "Before rollback" });
    const login = await fetch(`${base}/user/login`, { method: "POST", headers: { origin: f.service.cfg.baseUrl, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "owner@example.test", password: "correct-horse-battery" }), redirect: "manual" });
    const token = /rdmcp_user=([^;,]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1]; assert.ok(token);
    const cookie = `rdmcp_user=${token}`;
    const page = await (await fetch(`${base}/user`, { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1]; assert.ok(csrf);
    const patch = (body: Record<string, unknown>) => fetch(`${base}/api/sessions/${encodeURIComponent(String(opened.session_id))}`, { method: "PATCH", headers: { cookie, origin: f.service.cfg.baseUrl, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(body) });

    const saveLink = await patch({ expectedVersion: 1, externalUrl: "https://example.com/rollback" });
    assert.equal(saveLink.status, 200);
    await fetchStarted;
    holdMetadataAudit = true;
    const purposeSave = patch({ expectedVersion: 2, purpose: "Will roll back" });
    await metadataAuditStarted;
    const session = f.service.sessions.get(String(opened.session_id)); assert.ok(session);
    releaseFetch({ status: 200, contentType: "text/html; charset=utf-8", body: new TextEncoder().encode("<title>Fetched during audit</title>") });
    for (let tries = 0; tries < 100 && session.externalTitleStatus === "pending"; tries += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(session.externalTitle, "Fetched during audit");
    assert.equal(session.externalTitleStatus, "resolved");

    releaseMetadataAudit();
    const failedSave = await purposeSave;
    assert.equal(failedSave.status, 503);
    assert.equal(session.purpose, "Before rollback");
    assert.equal(session.version, 2);
    assert.equal(session.externalTitle, "Fetched during audit", "rollback of unrelated metadata preserves a valid concurrent fetch result");
    assert.equal(session.externalTitleStatus, "resolved");
  } finally {
    releaseMetadataAudit();
    if (releaseFetch) releaseFetch({ status: 500, contentType: "text/plain", body: new Uint8Array() });
    auditService.audit = originalAudit;
    await owner.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.cleanup();
  }
});

test("Issue 48: metadata audit rollback cannot restore session links after emergency stop", async () => {
  const f = await fixture();
  const owner = await mcp(f.service);
  const auditService = f.service as unknown as { audit: (event: string, fields: Record<string, unknown>) => Promise<void> };
  const originalAudit = auditService.audit.bind(f.service);
  let holdMetadataAudit = false;
  let releaseMetadataAudit!: () => void;
  let markMetadataAuditStarted!: () => void;
  const metadataAuditGate = new Promise<void>((resolve) => { releaseMetadataAudit = resolve; });
  const metadataAuditStarted = new Promise<void>((resolve) => { markMetadataAuditStarted = resolve; });
  auditService.audit = async (event, fields) => {
    if (holdMetadataAudit && event === "session.metadata.updated" && fields.version === 3) {
      holdMetadataAudit = false;
      markMetadataAuditStarted();
      await metadataAuditGate;
      throw new Error("injected metadata audit failure");
    }
    await originalAudit(event, fields);
  };
  try {
    const opened = await owner.call("session_open", { working_directory: f.root, purpose: "Stop wins over rollback" });
    const sessionId = String(opened.session_id);
    const session = f.service.sessions.get(sessionId); assert.ok(session);
    const initial = await f.service.updateSessionMetadata("owner@example.test", sessionId, { expectedVersion: 1, externalUrl: "https://example.com/old", externalTitle: "Old title" });
    assert.equal(initial.ok, true);
    assert.equal(session.externalUrl, "https://example.com/old");

    holdMetadataAudit = true;
    const update = f.service.updateSessionMetadata("owner@example.test", sessionId, { expectedVersion: 2, externalUrl: "https://example.com/new", externalTitle: "New title" });
    await metadataAuditStarted;
    assert.equal(session.externalUrl, "https://example.com/new", "the pending update is committed before its audit finishes");

    await f.service.stopUserExecution("owner@example.test");
    assert.equal(session.state, "closed");
    assert.equal(session.externalUrl, undefined, "emergency stop clears the link before the audit failure is released");
    assert.equal(session.externalTitle, undefined);

    releaseMetadataAudit();
    assert.deepEqual(await update, { ok: false, status: 503, error: "update_unavailable" });
    assert.equal(session.state, "closed");
    assert.equal(session.externalUrl, undefined, "rollback must not restore pre-stop URL data");
    assert.equal(session.externalTitle, undefined, "rollback must not restore pre-stop title data");
    assert.equal(session.externalTitleSource, undefined);
    assert.equal(session.externalTitleStatus, "not_requested");
  } finally {
    releaseMetadataAudit();
    auditService.audit = originalAudit;
    await owner.close();
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
