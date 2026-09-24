import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { hashPassword } from "../src/hash-password.js";
import { RemoteDesktopService, configFromEnv, createApp, type RuntimeConfig } from "../src/index.js";

async function fixture(): Promise<{ service: RemoteDesktopService; root: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(path.join(tmpdir(), "rdmcp-test-"));
  const root = path.join(base, "files"); const data = path.join(base, "data");
  await mkdir(root); await mkdir(data);
  const cfg: RuntimeConfig = { baseUrl: "http://127.0.0.1", tokenSecret: "x".repeat(32), users: [{ email: "owner@example.test", passwordHash: await hashPassword("correct-horse-battery") }], roots: [{ id: "files", path: root }], dataDir: data, port: 0, chunkBytes: 1024, nodeId: "local", nodeLabel: "This PC", dcCommand: process.execPath, dcArgs: [path.resolve("node_modules/@wonderwhy-er/desktop-commander/dist/index.js"), "--no-onboarding"], allowedRedirectOrigins: new Set(["https://chatgpt.com"]) };
  const service = new RemoteDesktopService(cfg); await service.initialize();
  return { service, root, cleanup: async () => { await service.close(); await rm(base, { recursive: true, force: true }); } };
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

test("configuration fails before Desktop Commander for protected root overlap", () => {
  const env = { BASE_URL: "http://127.0.0.1", TOKEN_SECRET: "x".repeat(32), AUTHORIZED_USERS_JSON: JSON.stringify([{ email: "u", passwordHash: "scrypt$x$y" }]), FILE_ROOTS_JSON: JSON.stringify([{ id: "r", path: "data" }]) };
  const cfg = configFromEnv(env); const service = new RemoteDesktopService(cfg);
  return assert.rejects(service.initialize(), /must not overlap/);
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
    const begin = await api.call("file_transfer_download_begin", { session_id: session, root_id: "files", relative_path: "source.bin" }); const transfer = begin.transfer_id as string;
    await writeFile(source, Buffer.from("changed! content")); await utimes(source, originalStat.atime, originalStat.mtime);
    const chunk = await api.call("file_transfer_download_chunk", { session_id: session, transfer_id: transfer, offset: 0 }); assert.deepEqual(Buffer.from(chunk.data as string, "base64"), original);
    const payload = Buffer.from("upload data"); const digest = createHash("sha256").update(payload).digest("hex");
    const upload = await api.call("file_transfer_upload_begin", { session_id: session, root_id: "files", relative_path: "race.bin", size: payload.length, sha256: digest, overwrite: false });
    await assert.rejects(api.call("file_transfer_upload_chunk", { session_id: session, transfer_id: upload.transfer_id, offset: 0, data: "***" }));
    await api.call("file_transfer_upload_chunk", { session_id: session, transfer_id: upload.transfer_id, offset: 0, data: payload.toString("base64") });
    await writeFile(path.join(f.root, "race.bin"), "winner");
    await assert.rejects(api.call("file_transfer_upload_commit", { session_id: session, transfer_id: upload.transfer_id as string }));
    assert.equal(await readFile(path.join(f.root, "race.bin"), "utf8"), "winner");
    await api.close();
  } finally { await f.cleanup(); }
});
