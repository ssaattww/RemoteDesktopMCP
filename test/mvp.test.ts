import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { hashPassword } from "../src/hash-password.js";
import { RemoteDesktopService, configFromEnv, createApp, type RuntimeConfig } from "../src/index.js";
import { protectPrivateDirectory } from "../src/private-storage.js";

async function fixture(): Promise<{ service: RemoteDesktopService; root: string; data: string; cleanup: () => Promise<void> }> {
  const workspace = path.resolve(process.cwd());
  const validation = path.resolve(workspace, "reference", "validation");
  const relativeValidation = path.relative(workspace, validation);
  if (!relativeValidation || relativeValidation.startsWith("..") || path.isAbsolute(relativeValidation)) throw new Error("MVP fixture directory must stay within the workspace.");
  await mkdir(validation, { recursive: true });
  const base = await mkdtemp(path.join(validation, "rdmcp-test-"));
  const relativeBase = path.relative(validation, base);
  if (!relativeBase || relativeBase.startsWith("..") || path.isAbsolute(relativeBase)) throw new Error("MVP fixture escaped its validation directory.");
  const root = path.join(base, "files"); const data = path.join(base, "data");
  await mkdir(root); await mkdir(data);
  await protectPrivateDirectory(data);
  const cfg: RuntimeConfig = { baseUrl: "http://127.0.0.1", tokenSecret: "x".repeat(32), users: [{ email: "owner@example.test", passwordHash: await hashPassword("correct-horse-battery") }], dataDir: data, port: 0, chunkBytes: 1024, nodeId: "local", nodeLabel: "This PC", dcCommand: process.execPath, dcArgs: [path.resolve("node_modules/@wonderwhy-er/desktop-commander/dist/index.js"), "--no-onboarding"], allowedRedirectOrigins: new Set(["https://chatgpt.com"]) };
  const service = new RemoteDesktopService(cfg);
  try { await service.initialize(); }
  catch (error) { await service.close().catch(() => undefined); await rm(base, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined); throw error; }
  return { service, root, data, cleanup: async () => { await service.close(); await rm(base, { recursive: true, force: true }); } };
}
async function mcp(service: RemoteDesktopService, user = "owner@example.test") {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" }); const server = service.server(user);
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args });
    assert.ok("content" in response); const block = response.content.find((item) => item.type === "text");
    if (response.isError) throw new Error(block?.text ?? "tool failed");
    return JSON.parse(block?.text ?? "{}") as Record<string, unknown>;
  };
  return { call, close: async () => { await client.close(); await server.close(); } };
}

test("configuration does not require a file-root allowlist", () => {
  const cfg = configFromEnv({
    BASE_URL: "http://127.0.0.1",
    TOKEN_SECRET: "x".repeat(32),
    AUTHORIZED_USERS_JSON: JSON.stringify([{ email: "u", passwordHash: "scrypt$x$y" }]),
    DATA_DIR: path.resolve("reference", "validation", "config-data"),
  });
  assert.equal((cfg as unknown as { roots?: unknown }).roots, undefined);
});

test("file and transfer tools accept absolute OS paths while service state stays protected", async () => {
  const f = await fixture();
  const outside = path.join(path.dirname(f.root), "outside");
  await mkdir(outside);
  const source = path.join(outside, "outside.txt");
  await writeFile(source, "before unrestricted access");
  const api = await mcp(f.service);
  try {
    const opened = await api.call("session_open", {});
    const session = opened.session_id as string;
    const nodes = await api.call("node_list", { session_id: session });
    const node = (nodes.nodes as Array<Record<string, unknown>>)[0];
    assert.equal("root_ids" in node, false);

    const read = await api.call("file_read", { session_id: session, path: source });
    assert.match(String(read.output), /before unrestricted access/);
    await api.call("file_patch", { session_id: session, path: source, old_string: "before", new_string: "after", expected_replacements: 1 });
    assert.equal(await readFile(source, "utf8"), "after unrestricted access");

    const files = await api.call("file_search", { session_id: session, path: outside, query: "outside.txt" });
    assert.match(String(files.output), /outside\.txt/);
    const content = await api.call("content_search", { session_id: session, path: outside, query: "after unrestricted" });
    assert.match(String(content.output), /outside\.txt/);

    const payload = Buffer.from("absolute upload");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const uploadPath = path.join(outside, "upload.bin");
    const upload = await api.call("file_transfer_upload_begin", { session_id: session, path: uploadPath, size: payload.length, sha256, overwrite: false });
    await api.call("file_transfer_upload_chunk", { session_id: session, transfer_id: upload.transfer_id, offset: 0, data: payload.toString("base64") });
    await api.call("file_transfer_upload_commit", { session_id: session, transfer_id: upload.transfer_id });
    assert.deepEqual(await readFile(uploadPath), payload);

    const download = await api.call("file_transfer_download_begin", { session_id: session, path: uploadPath });
    const chunk = await api.call("file_transfer_download_chunk", { session_id: session, transfer_id: download.transfer_id, offset: 0 });
    assert.deepEqual(Buffer.from(chunk.data as string, "base64"), payload);

    await assert.rejects(api.call("file_read", { session_id: session, path: path.join(f.data, "audit.jsonl") }), /Protected service files/);
  } finally {
    await api.close();
    await f.cleanup();
  }
});

test("file tools require absolute OS paths", async () => {
  const f = await fixture();
  const api = await mcp(f.service);
  try {
    const opened = await api.call("session_open", {});
    await assert.rejects(api.call("file_read", { session_id: opened.session_id, path: "relative.txt" }), /absolute path/);
  } finally {
    await api.close();
    await f.cleanup();
  }
});

test("OAuth authorization code is PKCE-bound and one use", async () => {
  const f = await fixture();
  const app = createApp(f.service); const server = app.listen(0, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port; const url = `http://127.0.0.1:${port}`;
  try {
    const register = await fetch(`${url}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "test", redirect_uris: ["https://chatgpt.com/callback"] }) }); const client = await register.json() as { client_id: string };
    const verifier = "v".repeat(64); const challenge = createHash("sha256").update(verifier).digest("base64url");
    const auth = await fetch(`${url}/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent("https://chatgpt.com/callback")}&response_type=code&code_challenge_method=S256&code_challenge=${challenge}`);
    const page = await auth.text(); const transaction = /value="([^"]+)"/.exec(page)?.[1]; assert.ok(transaction);
    const confirmation = await fetch(`${url}/authorize/confirm`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ transaction_id: transaction, email: "owner@example.test", password: "correct-horse-battery" }), redirect: "manual" });
    const location = confirmation.headers.get("location"); assert.ok(location); const code = new URL(location).searchParams.get("code"); assert.ok(code);
    const token = await fetch(`${url}/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", client_id: client.client_id, code, code_verifier: verifier, redirect_uri: "https://chatgpt.com/callback" }) }); assert.equal(token.status, 200);
    const tokenBody = await token.json() as { access_token: string };
    const httpClient = new Client({ name: "http-test", version: "1" });
    const httpTransport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokenBody.access_token}` } } });
    await httpClient.connect(httpTransport);
    const httpSession = await httpClient.callTool({ name: "session_open", arguments: {} });
    assert.ok("content" in httpSession && !httpSession.isError);
    await httpClient.close();
    const reused = await fetch(`${url}/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", client_id: client.client_id, code, code_verifier: verifier, redirect_uri: "https://chatgpt.com/callback" }) }); assert.equal(reused.status, 400);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await f.cleanup(); }
});

test("transfer snapshot remains immutable and no-replace preserves a racing destination", async () => {
  const f = await fixture();
  try {
    const source = path.join(f.root, "source.bin"); const original = Buffer.from("original content");
    await writeFile(source, original); const originalStat = await stat(source);
    const api = await mcp(f.service); const opened = await api.call("session_open", {}); const session = opened.session_id as string;
    const other = await mcp(f.service, "other@example.test");
    await assert.rejects(other.call("node_list", { session_id: session }));
    await other.close();
    const begin = await api.call("file_transfer_download_begin", { session_id: session, path: source }); const transfer = begin.transfer_id as string;
    await writeFile(source, Buffer.from("changed! content")); await utimes(source, originalStat.atime, originalStat.mtime);
    const chunk = await api.call("file_transfer_download_chunk", { session_id: session, transfer_id: transfer, offset: 0 }); assert.deepEqual(Buffer.from(chunk.data as string, "base64"), original);
    const payload = Buffer.from("upload data"); const digest = createHash("sha256").update(payload).digest("hex");
    const upload = await api.call("file_transfer_upload_begin", { session_id: session, path: path.join(f.root, "race.bin"), size: payload.length, sha256: digest, overwrite: false });
    await assert.rejects(api.call("file_transfer_upload_chunk", { session_id: session, transfer_id: upload.transfer_id, offset: 0, data: "***" }));
    await api.call("file_transfer_upload_chunk", { session_id: session, transfer_id: upload.transfer_id, offset: 0, data: payload.toString("base64") });
    await writeFile(path.join(f.root, "race.bin"), "winner");
    await assert.rejects(api.call("file_transfer_upload_commit", { session_id: session, transfer_id: upload.transfer_id as string }));
    assert.equal(await readFile(path.join(f.root, "race.bin"), "utf8"), "winner");
    await api.close();
  } finally { await f.cleanup(); }
});
