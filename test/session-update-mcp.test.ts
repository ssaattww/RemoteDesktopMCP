import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/index.js";
import { fixture, mcp } from "./fixture.js";

test("Issue 71: MCP session_update updates one field through the shared versioned mutation", async () => {
  const f = await fixture({ initializeService: false });
  const owner = await mcp(f.service);
  const server = createApp(f.service).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const tools = new Map((await owner.listTools()).tools.map((tool) => [tool.name, tool]));
    const updateTool = tools.get("session_update");
    assert.ok(updateTool, "session_update is published");
    const input = updateTool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    assert.deepEqual([...(input.required ?? [])].sort(), ["comment", "expected_version", "session_id"]);
    for (const field of ["working_directory", "purpose", "url", "title"]) assert.ok(input.properties?.[field], `${field} is available`);

    const opened = await owner.call("session_open", { working_directory: f.root, purpose: "Before update" });
    const sessionId = String(opened.session_id);
    const before = await owner.call("session_list", {}) as { sessions: Array<Record<string, unknown>> };
    assert.equal(before.sessions.find((row) => row.session_id === sessionId)?.version, 1);

    const login = await fetch(`${base}/user/login`, {
      method: "POST",
      headers: { origin: f.service.cfg.baseUrl, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "owner@example.test", password: "correct-horse-battery" }),
      redirect: "manual",
    });
    const cookieValue = /rdmcp_user=([^;,]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];
    assert.ok(cookieValue);
    const cookie = `rdmcp_user=${cookieValue}`;

    const updated = await owner.call("session_update", { session_id: sessionId, expected_version: 1, working_directory: f.base, purpose: "After update", url: "https://example.com/session", title: "Example session" });
    assert.equal(updated.ok, true);
    assert.equal(updated.version, 2);
    assert.deepEqual(updated.changed_fields, ["working_directory", "purpose", "url", "title"]);
    assert.equal(updated.working_directory, f.base);
    assert.equal(updated.purpose, "After update");
    assert.equal(updated.external_url, "https://example.com/session");
    assert.equal(updated.external_title, "Example session");
    assert.equal(updated.applied, true);

    const after = await owner.call("session_list", {}) as { sessions: Array<Record<string, unknown>> };
    const listed = after.sessions.find((row) => row.session_id === sessionId);
    assert.equal(listed?.working_directory, f.base);
    assert.equal(listed?.purpose, "After update");
    assert.equal(listed?.external_url, updated.external_url);
    assert.equal(listed?.external_title, updated.external_title);
    assert.equal(listed?.version, 2);

    const consoleState = await (await fetch(`${base}/api/console-state`, { headers: { cookie } })).json() as { sessions: Array<Record<string, unknown>> };
    const apiSession = consoleState.sessions.find((row) => row.session_id === sessionId);
    assert.equal(apiSession?.working_directory, listed?.working_directory);
    assert.equal(apiSession?.purpose, listed?.purpose);
    assert.equal(apiSession?.external_url, listed?.external_url);
    assert.equal(apiSession?.external_title, listed?.external_title);
    assert.equal(apiSession?.version, listed?.version);

    const metadataAuditCount = () => f.service.auditEntriesForConsole().filter((entry) => entry.event === "session.metadata.updated").length;
    const auditsBeforeSameValue = metadataAuditCount();
    const sameValue = await owner.call("session_update", { session_id: sessionId, expected_version: 2, purpose: "After update" });
    assert.equal(sameValue.ok, true);
    assert.equal(sameValue.applied, false);
    assert.deepEqual(sameValue.changed_fields, []);
    assert.equal(sameValue.version, 2);
    assert.equal(metadataAuditCount(), auditsBeforeSameValue);

    const originalAudit = f.service.audit.bind(f.service);
    f.service.audit = async (event, fields) => {
      if (event === "operation.succeeded") throw new Error("injected terminal audit failure");
      return originalAudit(event, fields);
    };
    const terminalAuditFailure = await owner.call("session_update", { session_id: sessionId, expected_version: 2, purpose: "Applied despite terminal audit failure" });
    assert.equal(terminalAuditFailure.ok, true);
    assert.equal(terminalAuditFailure.audit_warning, true);
    assert.equal(terminalAuditFailure.applied, true);
    assert.equal(terminalAuditFailure.version, 3);
    assert.equal(f.service.sessions.get(sessionId)?.purpose, "Applied despite terminal audit failure");
  } finally {
    await owner.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.cleanup();
  }
});
test("Issue 71: MCP session_update requires a version, rejects foreign/invalid updates, and never marks rejection applied", async () => {
  const f = await fixture({ initializeService: false });
  const owner = await mcp(f.service);
  const other = await mcp(f.service, "other@example.test");
  try {
    const opened = await owner.call("session_open", { working_directory: f.root, purpose: "Owned session" });
    const foreign = await other.call("session_open", { working_directory: f.root, purpose: "Foreign session" });
    const sessionId = String(opened.session_id);

    await assert.rejects(owner.callRaw("session_update", { comment: "Missing expected version", session_id: sessionId, purpose: "No version" }), /expected_version/i);

    const foreignResult = await owner.call("session_update", { session_id: String(foreign.session_id), expected_version: 1, purpose: "Attempted edit" });
    assert.equal(foreignResult.ok, false);
    assert.equal(foreignResult.error, "session_unavailable");
    assert.equal(foreignResult.applied, false);

    const invalid = await owner.call("session_update", { session_id: sessionId, expected_version: 1, working_directory: "relative/path" });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error, "invalid_working_directory");
    assert.equal(invalid.applied, false);
    assert.equal(f.service.sessions.get(sessionId)?.version, 1);
    assert.equal(f.service.sessions.get(sessionId)?.workingDirectory, f.root);

    const originalAudit = f.service.audit.bind(f.service);
    f.service.audit = async (event, fields) => {
      if (event === "operation.succeeded") throw new Error("injected terminal audit failure");
      return originalAudit(event, fields);
    };
    const conflict = await owner.call("session_update", { session_id: sessionId, expected_version: 99, purpose: "Stale update" });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error, "version_conflict");
    assert.equal(conflict.current_version, 1);
    assert.equal(conflict.audit_warning, true);
    assert.equal(conflict.applied, false);
    assert.equal(f.service.sessions.get(sessionId)?.version, 1);
    assert.equal(f.service.sessions.get(sessionId)?.purpose, "Owned session");

    f.service.audit = async (event, fields) => {
      if (event === "session.metadata.updated") throw new Error("injected metadata audit failure");
      return originalAudit(event, fields);
    };
    const metadataAuditFailure = await owner.call("session_update", { session_id: sessionId, expected_version: 1, purpose: "Must roll back" });
    assert.equal(metadataAuditFailure.ok, false);
    assert.equal(metadataAuditFailure.error, "update_unavailable");
    assert.equal(metadataAuditFailure.applied, false);
    assert.equal(f.service.sessions.get(sessionId)?.version, 1);
    assert.equal(f.service.sessions.get(sessionId)?.purpose, "Owned session");
  } finally {
    await owner.close();
    await other.close();
    await f.cleanup();
  }
});

