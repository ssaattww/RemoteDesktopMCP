import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
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
    const config = await readFile(protectedPath, "utf8");
    const alias = path.join(f.root, "config-alias.json");
    await link(protectedPath, alias);
    await assert.rejects(api.call("file_read", { session_id: session, root_id: "files", relative_path: "config-alias.json" }));
    await assert.rejects(api.call("content_search", { session_id: session, root_id: "files", query: "allowedDirectories" }));

    const bytes = Buffer.from("x"); const id = await upload(api, session, "swap.bin", bytes, true);
    const item = f.service.transfers.get(id)!;
    await unlink(item.temp!); await link(protectedPath, item.temp!);
    await assert.rejects(api.call("file_transfer_upload_chunk", { session_id: session, transfer_id: id, offset: 0, data: bytes.toString("base64") }));
    assert.equal(await readFile(protectedPath, "utf8"), config, "a path swap must never write the protected inode");
    assert.equal(f.service.transfers.get(id)?.state, "failed");

    await assert.rejects(api.call("file_read", { session_id: session, root_id: "files", relative_path: "../data/audit.jsonl" }));
    await assert.rejects(api.call("file_read", { session_id: session, root_id: "files", relative_path: "config-alias.json" }));
  } finally { await api.close(); await f.cleanup(); }
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
  } finally { await api.close(); await f.cleanup(); }
});

test("NR002: startup removes only owned orphan transfer artifacts", async () => {
  const f = await fixture();
  let restarted: RemoteDesktopService | undefined;
  try {
    await f.service.close();
    const snapshot = path.join(f.data, "transfers", "orphan.snapshot");
    const uploadTemp = path.join(f.root, ".__rdmcp_orphan.upload");
    await mkdir(path.dirname(snapshot), { recursive: true });
    await Promise.all([writeFile(snapshot, "orphan"), writeFile(uploadTemp, "orphan")]);
    restarted = new RemoteDesktopService(f.service.cfg); await restarted.initialize();
    await Promise.all([absent(snapshot), absent(uploadTemp)]);
  } finally { await restarted?.close(); await f.cleanup(); }
});

test("NR003 and NR004: search pages literal text and process output/audit retain completion", async () => {
  const f = await fixture(); const api = await mcp(f.service);
  try {
    const session = await openSession(api);
    await Promise.all(Array.from({ length: 115 }, (_, index) => writeFile(path.join(f.root, `needle-${index}.txt`), `literal [term] ${index}`)));
    const files = await api.call("file_search", { session_id: session, root_id: "files", query: "needle-" });
    assert.match(String(files.output), /needle-114/);
    const content = await api.call("content_search", { session_id: session, root_id: "files", query: "[term]" });
    assert.match(String(content.output), /Pattern: "\[term\]"/);
    assert.match(String(content.output), /Total results found: 115/);

    const command = "for /L %i in (1,1,1005) do @echo line-%i";
    const started = await api.call("process_start", { session_id: session, command, timeout_ms: 10_000 });
    const processId = started.process_id as string;
    let observed = "";
    for (let attempt = 0; attempt < 40; attempt++) {
      const output = await api.call("process_output", { session_id: session, process_id: processId }); observed = String(output.output);
      if (output.state === "finished") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(observed, /line-1004/, "the final output page must be returned");
    const longRunning = await api.call("process_start", { session_id: session, command: "ping -n 3 127.0.0.1 > nul", timeout_ms: 10_000 });
    const killedId = longRunning.process_id as string;
    await api.call("process_kill", { session_id: session, process_id: killedId });
    let killed: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      killed = await api.call("process_status", { session_id: session, process_id: killedId });
      if (killed.state === "finished") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(killed?.state, "finished"); assert.equal(typeof killed?.exit_code, "number");
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
    const call = async (name: string, args: Record<string, unknown>) => { const response = await client.callTool({ name, arguments: args }); assert.ok(!response.isError); return JSON.parse(response.content.find((item) => item.type === "text")?.text ?? "{}") as Record<string, unknown>; };
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
