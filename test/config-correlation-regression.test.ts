import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { configFromEnv, createApp, RemoteDesktopService, type RuntimeConfig } from "../src/index.js";
import { absent, captureProtectedConfigPin, fixture, mcp } from "./fixture.js";

async function openSession(api: Awaited<ReturnType<typeof mcp>>) {
  return (await api.call("session_open", {})).session_id as string;
}



test("configuration rejects resolved overlap and traversal aliases", async () => {
  const f = await fixture();
  try {
    const env = { BASE_URL: "http://127.0.0.1", TOKEN_SECRET: "x".repeat(32), AUTHORIZED_USERS_JSON: JSON.stringify([{ email: "u", passwordHash: "scrypt$x$y" }]), FILE_ROOTS_JSON: JSON.stringify([{ id: "r", path: f.data }]), DATA_DIR: f.data };
    await assert.rejects(new RemoteDesktopService(configFromEnv(env)).initialize(), /must not overlap/);
  } finally { await f.cleanup(); }
});





test("REV001: operation correlation ownership only accepts active owned sessions", async () => {
  const f = await fixture();
  try {
    await f.service.audit("session.open", { user: "owner@example.test", sessionId: "historical-session" });
    assert.equal(f.service.userOwnsActiveSession("owner@example.test", "historical-session"), false);
    const api = await mcp(f.service);
    const opened = await api.call("session_open", { working_directory: process.cwd(), purpose: "REV001 correlation test" });
    assert.equal(f.service.userOwnsActiveSession("owner@example.test", String(opened.session_id)), true);
    await api.close();
  } finally { await f.cleanup(); }
});





test("REV001: accepted and rejected operations preserve safe correlation contracts", async () => {
  const f = await fixture();
  try {
    const api = await mcp(f.service);
    const session = await openSession(api);
    const owner = "owner@example.test";
    const historical = "historical-only-session";
    await f.service.audit("session.open", { user: owner, sessionId: historical });

    await api.call("node_list", { session_id: session });
    const unverifiedSession = "unverified-input-session";
    await assert.rejects(api.callRaw("file_read", {
      comment: "Verify rejected correlation contract",
      session_id: unverifiedSession,
      root_id: "files",
      relative_path: "missing.txt",
      offset: -1,
      length: 3,
    }), /Input validation error/);

    const events = f.service.auditEntriesForConsole();
    const received = events.find((event) => event.event === "operation.received" && event.tool === "node_list" && event.sessionId === session);
    assert.ok(received, "normal operations must record received with active session correlation");
    const rejected = events.find((event) => event.event === "operation.rejected" && event.reason === "input_validation");
    assert.ok(rejected, "input validation rejection must record rejected event");
    assert.equal(String(rejected.sessionId).startsWith("request:"), true, "rejected input must not trust submitted session correlation");
    assert.equal(f.service.userOwnsActiveSession("other-owner@example.test", session), false, "other owner cannot use the active session");
    assert.equal(f.service.userOwnsActiveSession(owner, historical), false, "history alone is not active ownership");
    assert.equal(f.service.userOwnsActiveSession(owner, "expired-session"), false, "expired sessions are not active ownership");
    assert.equal(f.service.userOwnsActiveSession(owner, "missing-session"), false, "missing sessions are not active ownership");
    assert.equal(f.service.userOwnsAuditSession(owner, historical), true, "audit viewing keeps historical ownership semantics");
    await api.close();
  } finally { await f.cleanup(); }
});
