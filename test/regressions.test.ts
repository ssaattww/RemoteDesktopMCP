import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { configFromEnv, createApp, RemoteDesktopService } from "../src/index.js";
import { absent, fixture, mcp } from "./fixture.js";

const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const old = () => Date.now() - 31 * 60_000;
const configFile = (data: string) => path.join(data, "desktop-commander-home", ".claude-server-commander", "config.json");
const nodeScriptCommand = (file: string) => `${process.execPath} ${file}`;
const hasAuditEvent = (text: string, event: string, processId: string) => text.split("\n").some((line) => {
  try { const entry = JSON.parse(line) as { event?: unknown; processId?: unknown }; return entry.event === event && entry.processId === processId; } catch { return false; }
});
async function safeDcDiagnostics(data: string): Promise<string> {
  const identity = await stat(configFile(data)).then((info) => `${info.dev}:${info.ino}`).catch(() => "unavailable");
  const events = await readFile(path.join(data, "audit.jsonl"), "utf8").then((text) => text.split("\n").flatMap((line) => {
    try {
      const value = JSON.parse(line) as { event?: unknown; tool?: unknown; reason?: unknown; category?: unknown };
      if (typeof value.event !== "string" || !/^[a-z._-]+$/.test(value.event)) return [];
      const fields = [value.tool, value.reason, value.category].filter((field): field is string => typeof field === "string" && /^[a-z._-]+$/.test(field));
      return [`${value.event}${fields.length ? `:${fields.join(":")}` : ""}`];
    } catch { return []; }
  }).slice(-8)).catch(() => [] as string[]);
  return `config_identity=${identity}; recent_audit_events=${events.join(",") || "none"}`;
}

async function openSession(api: Awaited<ReturnType<typeof mcp>>) {
  return (await api.call("session_open", {})).session_id as string;
}

async function upload(api: Awaited<ReturnType<typeof mcp>>, session: string, name: string, bytes: Buffer, overwrite = false) {
  const begun = await api.call("file_transfer_upload_begin", { session_id: session, root_id: "files", relative_path: name, size: bytes.length, sha256: sha256(bytes), overwrite });
  return begun.transfer_id as string;
}

test("DR001: downloads use one immutable multi-chunk snapshot and clean failed snapshots", async () => {
  const f = await fixture();
  const api = await mcp(f.service);
  try {
    const source = path.join(f.root, "source.bin");
    const original = Buffer.concat([Buffer.alloc(1024, 0x41), Buffer.alloc(1024, 0x42), Buffer.alloc(333, 0x43)]);
    await writeFile(source, original);
    const originalStat = await stat(source);
    const session = await openSession(api);
    const begun = await api.call("file_transfer_download_begin", { session_id: session, root_id: "files", relative_path: "source.bin" });
    const id = begun.transfer_id as string;
    const replacement = path.join(f.root, "replacement.bin");
    await writeFile(replacement, Buffer.alloc(original.length, 0x5a));
    await utimes(replacement, originalStat.atime, originalStat.mtime);
    await rename(replacement, source);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < original.length; offset += 1024) {
      const chunk = await api.call("file_transfer_download_chunk", { session_id: session, transfer_id: id, offset });
      chunks.push(Buffer.from(chunk.data as string, "base64"));
    }
    assert.deepEqual(Buffer.concat(chunks), original);
    assert.equal(sha256(Buffer.concat(chunks)), begun.sha256);
    assert.equal(f.service.transfers.get(id)?.state, "complete", "completed transfers retain only bounded terminal metadata");

    const failing = await api.call("file_transfer_download_begin", { session_id: session, root_id: "files", relative_path: "source.bin" });
    const failedId = failing.transfer_id as string;
    const failed = f.service.transfers.get(failedId)!;
    await unlink(failed.snapshot!);
    await assert.rejects(api.call("file_transfer_download_chunk", { session_id: session, transfer_id: failedId, offset: 0 }));
    await absent(failed.snapshot!);
    assert.equal(f.service.transfers.get(failedId)?.state, "failed", "read failures must become terminal and cannot revive");
  } finally { await api.close(); await f.cleanup(); }
});

test("DR002: no-replace commit preserves a winner and removes the losing temp", async () => {
  const f = await fixture(); const api = await mcp(f.service);
  try {
    const session = await openSession(api); const payload = Buffer.from("losing upload");
    const id = await upload(api, session, "race.bin", payload);
    const item = f.service.transfers.get(id)!;
    await api.call("file_transfer_upload_chunk", { session_id: session, transfer_id: id, offset: 0, data: payload.toString("base64") });
    await writeFile(path.join(f.root, "race.bin"), "winner");
    await assert.rejects(api.call("file_transfer_upload_commit", { session_id: session, transfer_id: id }));
    assert.equal(await readFile(path.join(f.root, "race.bin"), "utf8"), "winner");
    await absent(item.temp!);
    assert.equal(f.service.transfers.get(id)?.state, "failed");
  } finally { await api.close(); await f.cleanup(); }
});

test("DR002: upload begin fails safely when the destination lacks atomic no-replace support", async () => {
  const f = await fixture(); let unsupported: RemoteDesktopService | undefined; let api: Awaited<ReturnType<typeof mcp>> | undefined;
  try {
    await f.service.close();
    const cfg = { ...f.service.cfg, linkNoReplace: async () => { throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" }); } };
    unsupported = new RemoteDesktopService(cfg); await unsupported.initialize(); api = await mcp(unsupported);
    const session = await openSession(api);
    await assert.rejects(upload(api, session, "unsupported.bin", Buffer.from("x")));
    assert.equal(unsupported.transfers.size, 0, "unsupported storage must fail before creating transfer state");
    assert.deepEqual((await readdir(f.root)).filter((name) => name.startsWith(".__rdmcp_")), [], "capability probes must clean their own artifacts");
  } finally { await api?.close(); await unsupported?.close(); await f.cleanup(); }
});

test("DR003: protected config aliases cannot be read, searched, or reached by a swapped upload temp", async () => {
  const f = await fixture(); const api = await mcp(f.service);
  try {
    const session = await openSession(api);
    const protectedPath = configFile(f.data);
    const historicalAlias = path.join(f.root, "config-historical-alias.json");
    const replacement = `${protectedPath}.replacement`;
    await link(protectedPath, historicalAlias);
    await writeFile(replacement, JSON.stringify({ allowedDirectories: [f.root], telemetryEnabled: false }));
    await rename(replacement, protectedPath);
    const config = await readFile(protectedPath, "utf8");
    const currentAlias = path.join(f.root, "config-current-alias.json");
    await link(protectedPath, currentAlias);
    await assert.rejects(api.call("file_read", { session_id: session, root_id: "files", relative_path: "config-historical-alias.json" }), "a config inode retained across an atomic replacement remains protected");
    await assert.rejects(api.call("file_read", { session_id: session, root_id: "files", relative_path: "config-current-alias.json" }), "the replacement config inode is protected after identity refresh");
    await assert.rejects(api.call("content_search", { session_id: session, root_id: "files", query: "allowedDirectories" }));

    const bytes = Buffer.from("x"); const id = await upload(api, session, "swap.bin", bytes, true);
    const item = f.service.transfers.get(id)!;
    await unlink(item.temp!); await link(protectedPath, item.temp!);
    await assert.rejects(api.call("file_transfer_upload_chunk", { session_id: session, transfer_id: id, offset: 0, data: bytes.toString("base64") }));
    assert.equal(await readFile(protectedPath, "utf8"), config, "a path swap must never write the protected inode");
    assert.equal(f.service.transfers.get(id)?.state, "failed");

    await assert.rejects(api.call("file_read", { session_id: session, root_id: "files", relative_path: "../data/audit.jsonl" }));
    await assert.rejects(api.call("file_read", { session_id: session, root_id: "files", relative_path: "config-historical-alias.json" }));
  } finally { await api.close(); await f.cleanup(); }
});

test("NR009: canonical allowed roots work through a symlink or Windows junction", async (t) => {
  const f = await fixture(); let service: RemoteDesktopService | undefined; let api: Awaited<ReturnType<typeof mcp>> | undefined;
  try {
    await f.service.close();
    const aliasedRoot = path.join(f.base, "allowed-root-link");
    try { await symlink(f.root, aliasedRoot, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") { t.skip(`directory link capability unavailable: ${code}`); return; }
      throw error;
    }
    await writeFile(path.join(f.root, "ordinary.txt"), "ordinary allowed-root content");
    service = new RemoteDesktopService({ ...f.service.cfg, roots: [{ id: "files", path: aliasedRoot }] });
    await service.initialize(); api = await mcp(service);
    const session = await openSession(api);
    const read = await api.call("file_read", { session_id: session, root_id: "files", relative_path: "ordinary.txt" });
    assert.match(String(read.output), /ordinary allowed-root content/);
    const search = await api.call("file_search", { session_id: session, root_id: "files", query: "ordinary" });
    assert.match(String(search.output), /ordinary\.txt/);
  } finally { await api?.close(); await service?.close(); await f.cleanup(); }
});

test("NR002 and NR006: expiry sweeps cancel transfers, clean files, and list session state", async () => {
  const f = await fixture(); const api = await mcp(f.service);
  try {
    const session = await openSession(api);
    const listed = await api.call("session_list", {});
    const row = (listed.sessions as Array<Record<string, unknown>>).find((value) => value.session_id === session);
    assert.equal(row?.state, "active"); assert.equal(typeof row?.expires_at, "string");
    const id = await upload(api, session, "expired.bin", Buffer.from("x"));
    const item = f.service.transfers.get(id)!; item.touched = old();
    await f.service.sweepExpired();
    assert.equal(f.service.transfers.get(id)?.state, "expired"); await absent(item.temp!);
    assert.equal((await api.call("file_transfer_status", { session_id: session, transfer_id: id })).state, "expired");
    await assert.rejects(api.call("file_transfer_upload_chunk", { session_id: session, transfer_id: id, offset: 0, data: "eA==" }));

    const cancellable = await upload(api, session, "cancel.bin", Buffer.from("x"));
    const cancellableItem = f.service.transfers.get(cancellable)!;
    await api.call("file_transfer_cancel", { session_id: session, transfer_id: cancellable });
    await absent(cancellableItem.temp!);

    const session2 = await openSession(api); const id2 = await upload(api, session2, "session-expired.bin", Buffer.from("x"));
    const item2 = f.service.transfers.get(id2)!;
    const expiredSession = f.service.sessions.get(session2)!;
    expiredSession.touched = Date.now() - 25 * 60 * 60_000;
    expiredSession.expires = Date.now() - 1;
    await f.service.sweepExpired();
    assert.equal(f.service.sessions.get(session2)?.state, "expired"); assert.equal(f.service.transfers.get(id2)?.state, "expired"); await absent(item2.temp!);
    await assert.rejects(api.call("node_list", { session_id: session2 }));
    assert.equal((await api.call("session_list", {}) as { sessions: Array<{ session_id: string }> }).sessions.some((entry) => entry.session_id === session2), false, "expired sessions must not be listed");

    const closed = await openSession(api);
    await api.call("session_close", { session_id: closed });
    assert.equal((await api.call("session_list", {}) as { sessions: Array<{ session_id: string }> }).sessions.some((entry) => entry.session_id === closed), false, "closed sessions must not be listed");
  } finally { await api.close(); await f.cleanup(); }
});

test("NR008: startup preserves unowned lookalikes and removes only manifest-owned orphan artifacts", async () => {
  const f = await fixture();
  let restarted: RemoteDesktopService | undefined;
  try {
    await f.service.close();
    const snapshot = path.join(f.data, "transfers", "orphan.snapshot");
    const legitimate = path.join(f.root, ".__rdmcp_legitimate.upload");
    const owned = path.join(f.root, ".__rdmcp_owned.upload");
    const manifest = path.join(f.data, "transfers", "owned-uploads.json");
    await mkdir(path.dirname(snapshot), { recursive: true });
    await Promise.all([writeFile(snapshot, "orphan"), writeFile(legitimate, "keep me"), writeFile(owned, "remove me")]);
    const identity = await stat(owned);
    await writeFile(manifest, JSON.stringify([{ rootId: "files", path: owned, dev: identity.dev, ino: identity.ino }]));
    restarted = new RemoteDesktopService(f.service.cfg); await restarted.initialize();
    await Promise.all([absent(snapshot), absent(owned)]);
    assert.equal(await readFile(legitimate, "utf8"), "keep me");
  } finally { await restarted?.close(); await f.cleanup(); }
});

test("NR003 and NR004: searches return every page and portable Node processes retain output/audit", async () => {
  const f = await fixture(); const api = await mcp(f.service);
  try {
    const session = await openSession(api);
    await Promise.all(Array.from({ length: 115 }, (_, index) => writeFile(path.join(f.root, `needle-${index}.txt`), `literal [term] ${index}`)));
    let files: Record<string, unknown>;
    try { files = await api.call("file_search", { session_id: session, root_id: "files", query: "needle-" }); }
    catch { throw new Error(`file_search returned an MCP error; ${await safeDcDiagnostics(f.data)}`); }
    const fileHits = new Set([...String(files.output).matchAll(/needle-(\d+)\.txt/g)].map((match) => Number(match[1])));
    assert.deepEqual([...fileHits].sort((left, right) => left - right), Array.from({ length: 115 }, (_, index) => index));
    const content = await api.call("content_search", { session_id: session, root_id: "files", query: "[term]" });
    assert.match(String(content.output), /Pattern: "\[term\]"/);
    const contentHits = new Set([...String(content.output).matchAll(/needle-(\d+)\.txt/g)].map((match) => Number(match[1])));
    assert.deepEqual([...contentHits].sort((left, right) => left - right), Array.from({ length: 115 }, (_, index) => index));

    const linesScript = path.join(f.root, "emit-lines.cjs");
    const naturalScript = path.join(f.root, "natural-exit.cjs");
    const longScript = path.join(f.root, "long-running.cjs");
    await Promise.all([
      writeFile(linesScript, "for (let index = 0; index < 1005; index += 1) console.log(`line-${index}`);"),
      writeFile(naturalScript, "setTimeout(() => process.exit(7), 150);"),
      writeFile(longScript, "console.log('ready'); setTimeout(() => process.exit(0), 4_500);"),
    ]);
    const natural = await api.call("process_start", { session_id: session, command: nodeScriptCommand(naturalScript), timeout_ms: 10_000 });
    const naturalId = natural.process_id as string;
    let autonomousAudit = "";
    for (let attempt = 0; attempt < 30; attempt++) {
      autonomousAudit = await readFile(path.join(f.data, "audit.jsonl"), "utf8");
      if (hasAuditEvent(autonomousAudit, "process.exit", naturalId)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(hasAuditEvent(autonomousAudit, "process.exit", naturalId), "natural exit must be audited without process status/output polling");

    const started = await api.call("process_start", { session_id: session, command: nodeScriptCommand(linesScript), timeout_ms: 10_000 });
    const processId = started.process_id as string;
    let observed = "";
    for (let attempt = 0; attempt < 40; attempt++) {
      const output = await api.call("process_output", { session_id: session, process_id: processId }); observed = String(output.output);
      if (output.state === "finished") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(observed, /line-1004/, "the final output page must be returned");
    const longRunning = await api.call("process_start", { session_id: session, command: nodeScriptCommand(longScript), timeout_ms: 200 });
    const killedId = longRunning.process_id as string;
    assert.equal((await api.call("process_status", { session_id: session, process_id: killedId })).state, "running", "the portable process must be alive before termination is requested");
    const killStarted = Date.now();
    const killed = await api.call("process_kill", { session_id: session, process_id: killedId });
    assert.ok(Date.now() - killStarted < 10_000, "kill must be bounded when Desktop Commander cannot confirm a process tree stop");
    assert.ok(killed.state === "terminating" || killed.state === "finished");
    let terminationAudit = "";
    if (killed.state === "finished") {
      terminationAudit = await readFile(path.join(f.data, "audit.jsonl"), "utf8");
      assert.match(terminationAudit, new RegExp(`"event":"process\\.exit"[^\\n]*"processId":"${killedId}"`));
    } else if (killed.termination_unconfirmed === true) {
      await new Promise((resolve) => setTimeout(resolve, 4_700));
      terminationAudit = await readFile(path.join(f.data, "audit.jsonl"), "utf8");
      assert.match(terminationAudit, new RegExp(`"event":"process\\.termination_unconfirmed"[^\\n]*"processId":"${killedId}"`));
    } else {
      for (let attempt = 0; attempt < 140; attempt++) {
        terminationAudit = await readFile(path.join(f.data, "audit.jsonl"), "utf8");
        if (hasAuditEvent(terminationAudit, "process.exit", killedId)) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!hasAuditEvent(terminationAudit, "process.exit", killedId)) await api.call("process_status", { session_id: session, process_id: killedId });
      terminationAudit = await readFile(path.join(f.data, "audit.jsonl"), "utf8");
      assert.match(terminationAudit, new RegExp(`"event":"process\\.exit"[^\\n]*"processId":"${killedId}"`));
    }
    const audit = await readFile(path.join(f.data, "audit.jsonl"), "utf8");
    assert.match(audit, /"event":"process\.exit"/);
    assert.match(audit, new RegExp(`"processId":"${killedId}"`));
  } finally { await api.close(); await f.cleanup(); }
});

test("NR005: real HTTP OAuth validates PKCE, scope, redirect, replay, claims, and MCP file operations", async () => {
  const f = await fixture(); const app = createApp(f.service); const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port; const url = `http://127.0.0.1:${port}`;
  const request = (endpoint: string, init?: RequestInit) => fetch(`${url}${endpoint}`, init);
  const register = async () => {
    const response = await request("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "regression", redirect_uris: ["https://chatgpt.com/callback"] }) });
    assert.equal(response.status, 201); return response.json() as Promise<{ client_id: string }>;
  };
  const authorize = async (clientId: string, verifier = "v".repeat(64), extra = "") => {
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const response = await request(`/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent("https://chatgpt.com/callback")}&response_type=code&code_challenge_method=S256&code_challenge=${challenge}&scope=mcp${extra}`);
    assert.equal(response.status, 200); const page = await response.text(); const transaction = /value="([^"]+)"/.exec(page)?.[1]; assert.ok(transaction);
    const confirmation = await request("/authorize/confirm", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ transaction_id: transaction, email: "owner@example.test", password: "correct-horse-battery" }), redirect: "manual" });
    const code = new URL(confirmation.headers.get("location")!).searchParams.get("code"); assert.ok(code); return { code, verifier };
  };
  const token = (clientId: string, code: string, verifier: string, redirectUri = "https://chatgpt.com/callback") => request("/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri }) });
  try {
    const registered = await register();
    assert.equal((await request(`/authorize?client_id=${registered.client_id}&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fcallback&response_type=code&code_challenge_method=S256&code_challenge=short&scope=mcp`)).status, 400);
    assert.equal((await request(`/authorize?client_id=${registered.client_id}&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fcallback&response_type=code&code_challenge_method=S256&code_challenge=${"a".repeat(43)}&scope=wrong`)).status, 400);
    const badVerifier = await authorize(registered.client_id); assert.equal((await token(registered.client_id, badVerifier.code, "x".repeat(42))).status, 400);
    const badRedirect = await authorize(registered.client_id); assert.equal((await token(registered.client_id, badRedirect.code, badRedirect.verifier, "https://chatgpt.com/other")).status, 400);
    const good = await authorize(registered.client_id); const issued = await token(registered.client_id, good.code, good.verifier); assert.equal(issued.status, 200); const accessToken = (await issued.json() as { access_token: string }).access_token;
    assert.equal((await token(registered.client_id, good.code, good.verifier)).status, 400);
    for (const claim of [{ aud: "wrong" }, { scope: "other" }, { iss: "wrong" }]) {
      const response = await request("/mcp", { method: "POST", headers: { authorization: `Bearer ${f.service.sign({ type: "access", sub: "owner@example.test", aud: "http://127.0.0.1/mcp", scope: "mcp", iss: "http://127.0.0.1", exp: Math.floor(Date.now() / 1000) + 60, ...claim })}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      assert.equal(response.status, 401);
    }
    assert.equal((await request("/mcp", { method: "POST", headers: { authorization: "Bearer tampered", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).status, 401);
    await writeFile(path.join(f.root, "http.txt"), "before");
    const client = new Client({ name: "http-regression", version: "1" }); const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } });
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      if (response.isError) throw new Error(`HTTP MCP ${name} returned isError; ${await safeDcDiagnostics(f.data)}`);
      return JSON.parse(response.content.find((item) => item.type === "text")?.text ?? "{}") as Record<string, unknown>;
    };
    const session = (await call("session_open", {})).session_id as string;
    assert.match(String((await call("file_read", { session_id: session, root_id: "files", relative_path: "http.txt" })).output), /before/);
    await call("file_patch", { session_id: session, root_id: "files", relative_path: "http.txt", old_string: "before", new_string: "after" });
    assert.match(String((await call("content_search", { session_id: session, root_id: "files", query: "after" })).output), /after/);
    await client.close();
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await f.cleanup(); }
});

test("configuration rejects resolved overlap and traversal aliases", async () => {
  const f = await fixture();
  try {
    const env = { BASE_URL: "http://127.0.0.1", TOKEN_SECRET: "x".repeat(32), AUTHORIZED_USERS_JSON: JSON.stringify([{ email: "u", passwordHash: "scrypt$x$y" }]), FILE_ROOTS_JSON: JSON.stringify([{ id: "r", path: f.data }]), DATA_DIR: f.data };
    await assert.rejects(new RemoteDesktopService(configFromEnv(env)).initialize(), /must not overlap/);
  } finally { await f.cleanup(); }
});
