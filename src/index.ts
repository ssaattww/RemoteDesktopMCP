import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { verifyPassword } from "./hash-password.js";

type User = { email: string; passwordHash: string };
type LaunchPreset = { id: string; label: string; command: string; args: string[]; cwd?: string };
type FileRoot = { id: string; path: string };
type OAuthClient = { client_id: string; client_name: string; redirect_uris: string[] };
type Authorization = { clientId: string; redirectUri: string; state?: string; challenge: string; email?: string };

const MAX_RESULTS = 100;
const MAX_DEPTH = 8;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const CODE_TTL_MS = 5 * 60_000;
const TOKEN_TTL_SECONDS = 60 * 60;
const DOWNLOAD_TTL_SECONDS = 60;
const dataDir = path.resolve(process.env.DATA_DIR ?? "data");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required. See .env.example.`);
  return value;
}

function jsonEnv<T>(name: string): T {
  try { return JSON.parse(requireEnv(name)) as T; }
  catch { throw new Error(`${name} must contain valid JSON.`); }
}

const baseUrl = requireEnv("BASE_URL").replace(/\/$/, "");
const baseUrlObject = new URL(baseUrl);
if (baseUrlObject.protocol !== "https:" && baseUrlObject.hostname !== "localhost") {
  throw new Error("BASE_URL must use HTTPS (HTTP is allowed only for localhost development).");
}
const tokenSecret = requireEnv("TOKEN_SECRET");
if (tokenSecret.length < 32) throw new Error("TOKEN_SECRET must contain at least 32 characters.");
const users = jsonEnv<User[]>("AUTHORIZED_USERS_JSON");
const presets = jsonEnv<LaunchPreset[]>("LAUNCH_PRESETS_JSON");
const roots = jsonEnv<FileRoot[]>("FILE_ROOTS_JSON").map((root) => ({ ...root, path: path.resolve(root.path) }));
const allowedRedirectOrigins = new Set((process.env.ALLOWED_REDIRECT_ORIGINS ?? "https://chatgpt.com").split(",").map((x) => x.trim()).filter(Boolean));

if (!users.length || !presets.length || !roots.length) throw new Error("At least one user, launch preset, and file root are required.");
if (users.some((item) => !item.email || !item.passwordHash) || presets.some((item) => !item.id || !item.command) || roots.some((item) => !item.id || !item.path)) throw new Error("Configured users, presets, and roots must be complete.");
if (new Set(presets.map((item) => item.id)).size !== presets.length) throw new Error("Launch preset ids must be unique.");
if (new Set(roots.map((item) => item.id)).size !== roots.length) throw new Error("File root ids must be unique.");

const clientsPath = path.join(dataDir, "oauth-clients.json");
let clients = new Map<string, OAuthClient>();
const authorizations = new Map<string, Authorization>();
const codes = new Map<string, Authorization & { expiresAt: number }>();

function base64url(value: Buffer | string): string { return Buffer.from(value).toString("base64url"); }
function randomId(): string { return randomBytes(32).toString("base64url"); }
function sign(value: string): string { return createHmac("sha256", tokenSecret).update(value).digest("base64url"); }
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function encodeToken(payload: object): string {
  const encoded = base64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded)}`;
}
function decodeToken(token: string): Record<string, unknown> | undefined {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature || !safeEqual(sign(encoded), signature)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
    return typeof payload.exp === "number" && payload.exp > Math.floor(Date.now() / 1000) ? payload : undefined;
  } catch { return undefined; }
}
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }
function getRoot(rootId: string): FileRoot { const root = roots.find((item) => item.id === rootId); if (!root) throw new Error("Unknown file root."); return root; }
function resolveInRoot(root: FileRoot, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0")) throw new Error("A relative path is required.");
  const candidate = path.resolve(root.path, relativePath);
  const relative = path.relative(root.path, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Path is outside the allowed root.");
  return candidate;
}
async function audit(event: string, details: Record<string, unknown>): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await appendFile(path.join(dataDir, "audit.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`, { mode: 0o600 });
}
async function loadClients(): Promise<void> {
  try {
    const stored = JSON.parse(await readFile(clientsPath, "utf8")) as OAuthClient[];
    clients = new Map(stored.map((client) => [client.client_id, client]));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
async function saveClients(): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(clientsPath, JSON.stringify([...clients.values()], null, 2), { mode: 0o600 });
}
function validateRedirectUri(uri: string): boolean {
  try { return allowedRedirectOrigins.has(new URL(uri).origin); } catch { return false; }
}
function errorResult(message: string) { return { isError: true as const, content: [{ type: "text" as const, text: message }] }; }

async function searchFiles(root: FileRoot, query: string): Promise<Array<{ path: string; size: number; modified: string }>> {
  const results: Array<{ path: string; size: number; modified: string }> = [];
  const normalizedQuery = query.toLocaleLowerCase();
  async function walk(folder: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || results.length >= MAX_RESULTS) return;
    let entries;
    try { entries = await readdir(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (results.length >= MAX_RESULTS || entry.isSymbolicLink()) continue;
      const fullPath = path.join(folder, entry.name);
      if (entry.isDirectory()) { await walk(fullPath, depth + 1); continue; }
      if (!entry.isFile() || !entry.name.toLocaleLowerCase().includes(normalizedQuery)) continue;
      const info = await stat(fullPath);
      results.push({ path: path.relative(root.path, fullPath), size: info.size, modified: info.mtime.toISOString() });
    }
  }
  await walk(root.path, 0);
  return results;
}

function makeServer(email: string): McpServer {
  const server = new McpServer({ name: "remote-desktop-mcp", version: "0.1.0" });
  server.registerTool("launch_configured_process", {
    title: "Launch configured process",
    description: "Starts one administrator-configured desktop application. It cannot run arbitrary commands or arguments.",
    inputSchema: { preset_id: z.string().describe("Configured launch preset id") },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ preset_id }) => {
    const preset = presets.find((item) => item.id === preset_id);
    if (!preset) return errorResult("Unknown launch preset.");
    try {
      const child = spawn(preset.command, preset.args, { cwd: preset.cwd, detached: false, stdio: "ignore", windowsHide: true });
      child.unref();
      await audit("process.launch", { user: email, presetId: preset.id, pid: child.pid });
      return { content: [{ type: "text" as const, text: `Started ${preset.label} (PID ${child.pid ?? "unknown"}).` }] };
    } catch (error) {
      await audit("process.launch_failed", { user: email, presetId: preset.id, reason: error instanceof Error ? error.message : "unknown" });
      return errorResult("The configured process could not be started. Check the server audit log.");
    }
  });
  server.registerTool("search_files", {
    title: "Search allowed files",
    description: "Searches file names inside an administrator-configured folder. Symbolic links and paths outside that folder are excluded.",
    inputSchema: { root_id: z.string().describe("Configured file-root id"), query: z.string().min(1).max(120).describe("Part of a filename") },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, async ({ root_id, query }) => {
    try {
      const root = getRoot(root_id); const matches = await searchFiles(root, query);
      await audit("file.search", { user: email, rootId: root.id, query, count: matches.length });
      return { content: [{ type: "text" as const, text: JSON.stringify({ root_id, matches, capped: matches.length === MAX_RESULTS }, null, 2) }] };
    } catch { return errorResult("The requested file root could not be searched."); }
  });
  server.registerTool("create_file_download", {
    title: "Create a temporary file download",
    description: "Creates a one-minute download link for a regular file below an administrator-configured folder. Maximum file size is 25 MB.",
    inputSchema: { root_id: z.string().describe("Configured file-root id"), relative_path: z.string().min(1).max(500).describe("Path returned by search_files") },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, async ({ root_id, relative_path }) => {
    try {
      const root = getRoot(root_id); const filePath = resolveInRoot(root, relative_path); const info = await lstat(filePath);
      if (!info.isFile() || info.isSymbolicLink()) return errorResult("Only regular files can be downloaded.");
      if (info.size > MAX_DOWNLOAD_BYTES) return errorResult("This file exceeds the 25 MB download limit.");
      const exp = Math.floor(Date.now() / 1000) + DOWNLOAD_TTL_SECONDS;
      const token = encodeToken({ type: "download", sub: email, rootId: root.id, relativePath: relative_path, exp });
      const url = `${baseUrl}/downloads/${encodeURIComponent(token)}`;
      await audit("file.download_link", { user: email, rootId: root.id, relativePath: relative_path, size: info.size });
      return { content: [{ type: "text" as const, text: `Temporary download link (expires in ${DOWNLOAD_TTL_SECONDS} seconds): ${url}` }] };
    } catch { return errorResult("The requested file is unavailable or outside the allowed root."); }
  });
  return server;
}

const app = express();
app.disable("x-powered-by");
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "1mb" }));
app.get("/health", (_req, res) => res.json({ ok: true, service: "remote-desktop-mcp" }));
app.get("/.well-known/oauth-protected-resource", (_req, res) => res.json({ resource: `${baseUrl}/mcp`, authorization_servers: [baseUrl], scopes_supported: ["mcp"] }));
app.get("/.well-known/oauth-authorization-server", (_req, res) => res.json({
  issuer: baseUrl, authorization_endpoint: `${baseUrl}/authorize`, token_endpoint: `${baseUrl}/token`, registration_endpoint: `${baseUrl}/register`,
  response_types_supported: ["code"], grant_types_supported: ["authorization_code"], token_endpoint_auth_methods_supported: ["none"],
  code_challenge_methods_supported: ["S256"], scopes_supported: ["mcp", "offline_access"]
}));
app.post("/register", async (req, res) => {
  const redirectUris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris.filter((uri: unknown): uri is string => typeof uri === "string") : [];
  if (!redirectUris.length || !redirectUris.every(validateRedirectUri)) return res.status(400).json({ error: "invalid_redirect_uri" });
  const client: OAuthClient = { client_id: randomId(), client_name: typeof req.body?.client_name === "string" ? req.body.client_name.slice(0, 100) : "MCP client", redirect_uris: redirectUris };
  clients.set(client.client_id, client); await saveClients(); await audit("oauth.client_registered", { clientId: client.client_id, name: client.client_name });
  res.status(201).json({ ...client, token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] });
});
app.get("/authorize", (req, res) => {
  const clientId = typeof req.query.client_id === "string" ? req.query.client_id : "";
  const redirectUri = typeof req.query.redirect_uri === "string" ? req.query.redirect_uri : "";
  const challenge = typeof req.query.code_challenge === "string" ? req.query.code_challenge : "";
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  const client = clients.get(clientId);
  if (!client || !client.redirect_uris.includes(redirectUri) || req.query.response_type !== "code" || req.query.code_challenge_method !== "S256" || !challenge) return res.status(400).send("Invalid OAuth authorization request.");
  const transactionId = randomId(); authorizations.set(transactionId, { clientId, redirectUri, state, challenge });
  res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Authorize Remote Desktop MCP</title><main><h1>Remote Desktop MCP</h1><p>${escapeHtml(client.client_name)} requests access to the approved remote desktop tools.</p><form method="post" action="/authorize/confirm"><input type="hidden" name="transaction_id" value="${escapeHtml(transactionId)}"><label>Email <input name="email" type="email" required autocomplete="username"></label><br><label>Password <input name="password" type="password" required autocomplete="current-password"></label><br><button type="submit">Authorize</button></form></main>`);
});
app.post("/authorize/confirm", async (req, res) => {
  const transactionId = typeof req.body?.transaction_id === "string" ? req.body.transaction_id : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLocaleLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const authorization = authorizations.get(transactionId); authorizations.delete(transactionId);
  const user = users.find((item) => item.email.toLocaleLowerCase() === email);
  if (!authorization || !user || !(await verifyPassword(password, user.passwordHash))) { await audit("oauth.authorization_denied", { email: email || "unknown" }); return res.status(403).send("Access denied."); }
  const code = randomId(); codes.set(code, { ...authorization, email: user.email, expiresAt: Date.now() + CODE_TTL_MS });
  await audit("oauth.authorization_granted", { user: user.email, clientId: authorization.clientId });
  const redirect = new URL(authorization.redirectUri); redirect.searchParams.set("code", code); if (authorization.state) redirect.searchParams.set("state", authorization.state);
  res.redirect(303, redirect.toString());
});
app.post("/token", async (req, res) => {
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  const clientId = typeof req.body?.client_id === "string" ? req.body.client_id : "";
  const verifier = typeof req.body?.code_verifier === "string" ? req.body.code_verifier : "";
  const grantType = req.body?.grant_type;
  const authorization = codes.get(code); codes.delete(code);
  if (grantType !== "authorization_code" || !authorization || authorization.expiresAt < Date.now() || authorization.clientId !== clientId || !authorization.email) return res.status(400).json({ error: "invalid_grant" });
  // PKCE uses an unkeyed SHA-256. Dynamic import keeps the crypto imports above focused on token signing.
  const { createHash } = await import("node:crypto");
  if (!verifier || !safeEqual(createHash("sha256").update(verifier).digest("base64url"), authorization.challenge)) return res.status(400).json({ error: "invalid_grant" });
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const accessToken = encodeToken({ type: "access", sub: authorization.email, aud: `${baseUrl}/mcp`, scope: "mcp", exp });
  await audit("oauth.token_issued", { user: authorization.email, clientId });
  res.json({ access_token: accessToken, token_type: "Bearer", expires_in: TOKEN_TTL_SECONDS, scope: "mcp" });
});
app.get("/downloads/:token", async (req, res) => {
  const payload = decodeToken(req.params.token);
  if (payload?.type !== "download" || typeof payload.rootId !== "string" || typeof payload.relativePath !== "string" || typeof payload.sub !== "string") return res.status(401).send("Invalid or expired download link.");
  try {
    const root = getRoot(payload.rootId); const filePath = resolveInRoot(root, payload.relativePath); const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_DOWNLOAD_BYTES) return res.status(404).send("File unavailable.");
    await audit("file.downloaded", { user: payload.sub, rootId: root.id, relativePath: payload.relativePath, size: info.size });
    res.download(filePath, path.basename(filePath));
  } catch { res.status(404).send("File unavailable."); }
});
app.all("/mcp", async (req: Request, res: Response) => {
  if (req.method !== "POST") return res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  const auth = req.header("authorization"); const payload = auth?.startsWith("Bearer ") ? decodeToken(auth.slice(7)) : undefined;
  if (payload?.type !== "access" || typeof payload.sub !== "string" || payload.aud !== `${baseUrl}/mcp`) {
    res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`);
    return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Authentication required." }, id: null });
  }
  const server = makeServer(payload.sub);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport); await transport.handleRequest(req, res, req.body);
    res.on("close", () => { void transport.close(); void server.close(); });
  } catch (error) {
    console.error("MCP request failed", error);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error." }, id: null });
  }
});

await loadClients();
app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0", () => console.log(`Remote Desktop MCP listening at ${baseUrl}/mcp`));
