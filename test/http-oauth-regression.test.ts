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

const configFile = (data: string) => path.join(data, "desktop-commander-home", ".claude-server-commander", "config.json");

const safeAuditDetail = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const redacted = value.replace(/(?:[A-Za-z]:)?(?:[\\/][^\s"']+)+/g, "[path]").replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]");
  return redacted.replace(/[^\w .,:()[\]-]/g, "?").slice(0, 240);
};

async function safeIdentityTrace(candidate: string): Promise<string> {
  try {
    const [numeric, exact] = await Promise.all([stat(candidate), stat(candidate, { bigint: true })]);
    return `number=${numeric.dev}:${numeric.ino};bigint=${exact.dev}:${exact.ino}`;
  } catch { return "unavailable"; }
}

async function safeDcDiagnostics(data: string, service?: RemoteDesktopService, candidate?: string): Promise<string> {
  const identity = await safeIdentityTrace(configFile(data));
  const candidateIdentity = candidate ? await safeIdentityTrace(candidate) : undefined;
  const identities = (service as unknown as { protectedConfigIdentities?: Map<unknown, unknown> } | undefined)?.protectedConfigIdentities;
  const identityKeys = identities instanceof Map ? [...identities.keys()].filter((key): key is string => typeof key === "string" && /^\d+:\d+$/.test(key)).sort() : [];
  const pinDirectory = path.join(data, "transfers", "protected-config-pins");
  const pinIdentities = await readdir(pinDirectory).then(async (names) => Promise.all(names.map(async (name) => safeIdentityTrace(path.join(pinDirectory, name))))).catch(() => [] as string[]);
  const manifestIdentities = await readFile(path.join(data, "transfers", "protected-config-identities.json"), "utf8").then((text) => {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as { dev?: unknown; ino?: unknown };
      const exact = typeof record.dev === "string" && /^\d+$/.test(record.dev) && typeof record.ino === "string" && /^\d+$/.test(record.ino);
      return exact || (Number.isSafeInteger(record.dev) && Number.isSafeInteger(record.ino)) ? [`${record.dev}:${record.ino}`] : [];
    }) : [];
  }).catch(() => [] as string[]);
  const events = await readFile(path.join(data, "audit.jsonl"), "utf8").then((text) => text.split("\n").flatMap((line) => {
    try {
      const value = JSON.parse(line) as { event?: unknown; tool?: unknown; reason?: unknown; category?: unknown; detail?: unknown };
      if (typeof value.event !== "string" || !/^[a-z._-]+$/.test(value.event)) return [];
      const fields = [value.tool, value.reason, value.category].filter((field): field is string => typeof field === "string" && /^[a-z._-]+$/.test(field));
      const detail = value.event === "desktop_commander.rejected" ? safeAuditDetail(value.detail) : undefined;
      return [`${value.event}${fields.length ? `:${fields.join(":")}` : ""}${detail ? `:detail=${detail}` : ""}`];
    } catch { return []; }
  }).slice(-8)).catch(() => [] as string[]);
  return `config_identity=${identity};${candidateIdentity === undefined ? "" : ` candidate_identity=${candidateIdentity};`} protected_identity_count=${identityKeys.length}; protected_identity_keys=${identityKeys.join(",") || "none"}; pin_identities=${pinIdentities.join("|") || "none"}; manifest_identity_keys=${manifestIdentities.join(",") || "none"}; recent_audit_events=${events.join(",") || "none"}`;
}



test("NR005: real HTTP OAuth validates PKCE, scope, redirect, replay, claims, and MCP file operations", async () => {
  const f = await fixture(); const app = createApp(f.service); const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port; const url = `http://127.0.0.1:${port}`;
  type Commander = { call: (name: string, args: Record<string, unknown>, timeout?: number) => Promise<string> };
  const commander = (f.service as unknown as { dc: Commander }).dc;
  const originalCommanderCall = commander.call;
  const traceStarted = Date.now(); const dcTrace: string[] = [];
  const trace = () => dcTrace.join(",") || "none";
  commander.call = async (name, args, timeout) => {
    dcTrace.push(`start:${name}@${Date.now() - traceStarted}`);
    try {
      const output = await originalCommanderCall.call(commander, name, args, timeout);
      dcTrace.push(`ok:${name}@${Date.now() - traceStarted}`);
      return output;
    } catch (error) {
      dcTrace.push(`error:${name}@${Date.now() - traceStarted}`);
      throw error;
    }
  };
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
    try { await client.connect(transport); }
    catch (error) { throw new Error(`NR005 MCP RPC failed at transport connect; DC trace=${trace()}`, { cause: error }); }
    const call = async (name: string, args: Record<string, unknown>) => {
      let response;
      try { response = await client.callTool({ name, arguments: { comment: "Automated HTTP regression", ...args } }); }
      catch (error) { throw new Error(`NR005 MCP RPC failed at ${name}; DC trace=${trace()}`, { cause: error }); }
      if (response.isError) throw new Error(`HTTP MCP ${name} returned isError; ${await safeDcDiagnostics(f.data, f.service)}`);
      return JSON.parse(response.content.find((item) => item.type === "text")?.text ?? "{}") as Record<string, unknown>;
    };
    const session = (await call("session_open", { working_directory: f.root, purpose: "HTTP file regression" })).session_id as string;
    assert.match(String((await call("file_read", { session_id: session, root_id: "files", relative_path: "http.txt" })).output), /before/);
    await call("file_patch", { session_id: session, root_id: "files", relative_path: "http.txt", old_string: "before", new_string: "after" });
    assert.match(String((await call("content_search", { session_id: session, root_id: "files", query: "after" })).output), /after/);
    await client.close();
  } finally { commander.call = originalCommanderCall; await new Promise<void>((resolve) => server.close(() => resolve())); await f.cleanup(); }
});
