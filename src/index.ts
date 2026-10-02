import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFile, copyFile, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type Request, type Response } from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { verifyPassword } from "./hash-password.js";
import { AUTH_COOKIE, CHATGPT_CLIENT_ID, CHATGPT_REDIRECT_URI, PublicAuthService, type PublicAuthConfig, type PublicAuthOptions } from "./public-auth.js";
import { assertPrivateAuditStorage, createPrivateFile, ensurePrivateDirectory, ensureSafeDataDirectory, protectPrivateFile } from "./private-storage.js";
import { type NodeListEntry, type NodeRegistry } from "./node-registry.js";
import {
  createNodeOperationRequest,
  nodeOperationContract,
  parseNodeOperationRequest,
  parseNodeOperationResponse,
  type NodeOperationName,
  type NodeOperationRequest,
} from "./node-operation.js";

import { mountAdmin } from "./admin.js";
import { mountUserConsole } from "./user-console.js";

type User = { email: string; passwordHash: string };
type Root = { id: string; path: string };
type OAuthClient = { client_id: string; client_name: string; redirect_uris: string[] };
type Authorization = { clientId: string; redirectUri: string; state?: string; challenge: string; email?: string; expires: number; scope: "mcp" };
type Session = { id: string; user: string; nodeId: string; workingDirectory: string; purpose: string; created: number; touched: number; expires: number; state: "active" | "expired" | "closed" };
// Node's default Stats numbers lose NTFS file-id precision above 2^53.  Keep
// identity values as decimal strings derived from bigint stats so unrelated
// files cannot collide with a protected config pin or an owned upload.
type FileIdentity = { dev: string; ino: string };
type OwnedUploadArtifact = FileIdentity & { rootId: string; path: string };
type ProtectedConfigIdentity = FileIdentity & { pin: string };
type DownloadChunkReplay = { offset: number; data: string; nextOffset: number; complete: boolean };
type Transfer = { id: string; direction: "download" | "upload"; principalId: string; sessionId: string; nodeId: string; rootId: string; target: string; snapshot?: string; temp?: string; tempHandle?: FileHandle; tempIdentity?: FileIdentity; size: number; sha256: string; offset: number; touched: number; state: "active" | "complete" | "cancelled" | "failed" | "expired"; overwrite?: boolean; sent?: ReturnType<typeof createHash>; downloadReplay?: DownloadChunkReplay; committedPreview?: OperationDetailEntry };
type Process = { id: string; sessionId: string; user: string; generation: string; pid: number; state: "running" | "terminating" | "stale" | "finished"; output: string; cursor: number; exitCode?: number; exitAudited?: boolean; completionPending?: boolean; outputDrained?: boolean; terminationRequested?: boolean; terminationUnconfirmed?: boolean; observationFailures?: number; nextObservationAt?: number };
export type UserExecutionState = { principalId: string; stopped: boolean; stopGeneration: number; stoppedAt?: string; stopId?: string };
type ExecutionOperation = { user: string; operationId: string; stopGeneration: number; comment?: string; sessionAccessAt?: string };
type OperationDetailEntry = { label: string; value: string; format: "text" | "diff"; truncated?: boolean };
type OperationDetail = { version: 1; summary: string; entries: OperationDetailEntry[] };
export type AuditLogItem = { id: string; cursor: string; event: Record<string, unknown> & { event: string; at: string } };
type AuditLogEntry = { sequence: number; event: Record<string, unknown> & { event: string; at: string } };

class UserStopRequested extends Error {
  constructor(readonly state: UserExecutionState) { super("USER_STOP_REQUESTED"); }
}

const SESSION_TTL = 24 * 60 * 60_000;
const TRANSFER_TTL = 30 * 60_000;
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_TRANSFERS = 20;
const MAX_TERMINAL_TRANSFERS = 100;
const MAX_PROCESS_OUTPUT_CHARS = 2 * 1024 * 1024;
const MAX_AUDIT_EVENTS = 20_000;
const REQUIRED_TOOLS = ["get_config", "start_search", "get_more_search_results", "stop_search", "read_file", "edit_block", "start_process", "read_process_output", "force_terminate", "list_sessions", "_rdmcp_stop_owner", "_rdmcp_resume_owner"];

export type ProcessAdapter = { start(command: string, timeoutMs: number, workingDirectory?: string): Promise<string>; read(pid: number, offset: number, timeoutMs: number): Promise<string>; terminate(pid: number, timeoutMs: number): Promise<string>; sessions(): Promise<string> };
export type RuntimeConfig = { adminUsers?: string[]; baseUrl: string; tokenSecret: string; users: User[]; roots: Root[]; dataDir: string; port: number; chunkBytes: number; nodeId: string; nodeLabel: string; dcCommand: string; dcArgs: string[]; dcManagedConfig?: boolean; allowedRedirectOrigins: Set<string>; authMode?: "password" | "google"; publicAuth?: PublicAuthConfig; publicAuthOptions?: PublicAuthOptions; linkNoReplace?: (existingPath: string, newPath: string) => Promise<void>; linkProtectedConfig?: (existingPath: string, newPath: string) => Promise<void>; processAdapter?: ProcessAdapter; nodeRegistry?: NodeRegistry; nodeRequest?: (nodeId: string, payload: NodeOperationRequest) => Promise<unknown> };
const get = (env: NodeJS.ProcessEnv, name: string) => { const value = env[name]; if (!value) throw new Error(`${name} is required. See .env.example.`); return value; };
const parse = <T>(env: NodeJS.ProcessEnv, name: string): T => { try { return JSON.parse(get(env, name)) as T; } catch { throw new Error(`${name} must contain valid JSON.`); } };
const makeId = () => randomBytes(32).toString("base64url");
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const inside = (parent: string, candidate: string) => { const relative = path.relative(parent, candidate); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); };
const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a);
const result = (body: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] });
const failure = (message: string) => ({ isError: true as const, content: [{ type: "text" as const, text: message }] });
const stoppedFailure = (state: UserExecutionState) => ({ isError: true as const, content: [{ type: "text" as const, text: JSON.stringify({ error: { code: "USER_STOP_REQUESTED", message: "The user has explicitly requested that remote execution stop.", required_action: "Do not retry, continue the task, or create another execution path until the user explicitly resumes remote execution.", stop_id: state.stopId, stop_generation: state.stopGeneration } }) }] });
const equal = (left: string, right: string) => { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); };

export function configFromEnv(env = process.env): RuntimeConfig {
  const baseUrl = get(env, "BASE_URL").replace(/\/$/, "");
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("BASE_URL must use HTTPS except for loopback local development.");
  const authMode = env.REMOTE_AUTH_MODE ?? "password";
  if (authMode !== "password" && authMode !== "google") throw new Error("REMOTE_AUTH_MODE must be password or google.");
  if (authMode === "password" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Password authentication is limited to loopback local development.");
  if (authMode === "google" && url.protocol !== "https:") throw new Error("Google authentication requires an HTTPS BASE_URL.");
  const tokenSecret = get(env, "TOKEN_SECRET");
  if (tokenSecret.length < 32) throw new Error("TOKEN_SECRET must contain at least 32 characters.");
  const users = authMode === "password" ? parse<User[]>(env, "AUTHORIZED_USERS_JSON") : [];
  const roots = parse<Root[]>(env, "FILE_ROOTS_JSON").map((root) => ({ ...root, path: path.resolve(root.path) }));
  if (authMode === "password" && (users.length !== 1 || !users[0]?.email || !users[0]?.passwordHash)) throw new Error("AUTHORIZED_USERS_JSON must contain exactly one complete local-development user.");
  if (!roots.length || roots.some((root) => !root.id || !root.path) || new Set(roots.map((root) => root.id)).size !== roots.length) throw new Error("FILE_ROOTS_JSON must contain unique complete roots.");
  if (env.REMOTE_NODES_JSON || env.NODE_ROLE && env.NODE_ROLE !== "local") throw new Error("This MVP supports one local node only; remote roles are rejected.");
  const chunkBytes = Number(env.TRANSFER_CHUNK_BYTES ?? 512 * 1024);
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1024 || chunkBytes > 512 * 1024) throw new Error("TRANSFER_CHUNK_BYTES must be between 1024 and 524288.");
  const bundled = fileURLToPath(new URL("../node_modules/@wonderwhy-er/desktop-commander/dist/index.js", import.meta.url));
  const allowedRedirectOrigins = new Set((env.ALLOWED_REDIRECT_ORIGINS ?? "https://chatgpt.com").split(",").map((value) => value.trim()).filter(Boolean));
  const dataDir = path.resolve(env.DATA_DIR ?? "data");
  const googleClientId = env.GOOGLE_CLIENT_ID;
  const googleClientSecret = env.GOOGLE_CLIENT_SECRET;
  const googleRedirectUri = env.GOOGLE_REDIRECT_URI ?? `${baseUrl}/google/callback`;
  if (authMode === "google" && (!googleClientId || !googleClientSecret || googleRedirectUri !== `${baseUrl}/google/callback`)) throw new Error("Google mode requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI=${BASE_URL}/google/callback.");
  // Owner-scoped termination depends on the fixed Desktop Commander module
  // layout. Arbitrary launchers cannot be verified to install that bridge.
  const customArgs = (env.DESKTOP_COMMANDER_ARGS ?? "").split(" ").filter(Boolean);
  if (env.DESKTOP_COMMANDER_COMMAND || customArgs.length) throw new Error("Only the managed Desktop Commander launcher is supported because owner-scoped emergency stop requires the pinned backend.");
  return { adminUsers: (env.ADMIN_USERS ?? "").split(",").map((value) => value.trim()).filter(Boolean), baseUrl, tokenSecret, users, roots, dataDir, port: Number(env.PORT ?? 3000), chunkBytes, nodeId: env.LOCAL_NODE_ID ?? "local", nodeLabel: env.LOCAL_NODE_LABEL ?? "This PC", dcCommand: process.execPath, dcArgs: [bundled, "--no-onboarding"], dcManagedConfig: true, allowedRedirectOrigins, authMode, ...(authMode === "google" ? { publicAuth: { baseUrl, tokenSecret, dataDir, googleClientId: googleClientId!, googleClientSecret: googleClientSecret!, googleRedirectUri } } : {}) };
}

class Mutex {
  private tail = Promise.resolve();
  async run<T>(work: () => Promise<T>): Promise<T> { let release!: () => void; const next = new Promise<void>((resolve) => { release = resolve; }); const previous = this.tail; this.tail = next; await previous; try { return await work(); } finally { release(); } }
}

class DesktopCommander {
  private client?: Client;
  private transport?: StdioClientTransport;
  private generation?: string;
  private tools = new Set<string>();
  private allowedDirectories: string[] = [];
  constructor(private readonly cfg: RuntimeConfig, private readonly audit: (name: string, data: Record<string, unknown>) => Promise<void>, private readonly configPrepared: () => Promise<void>, private readonly requireCurrentOperation: () => void) {}
  currentGeneration(): string { if (!this.client || !this.generation) throw new Error("Desktop Commander is unavailable for this operation."); return this.generation; }
  async start(): Promise<void> {
    const home = path.join(this.cfg.dataDir, "desktop-commander-home");
    const config = path.join(home, ".claude-server-commander", "config.json");
    const expected = path.resolve(home, ".claude-server-commander", "config.json");
    if (path.resolve(config) !== expected || !inside(this.cfg.dataDir, expected)) throw new Error("Desktop Commander config path did not resolve inside DATA_DIR.");
    await mkdir(path.dirname(config), { recursive: true, mode: 0o700 });
    this.allowedDirectories = await Promise.all(this.cfg.roots.map((root) => realpath(root.path)));
    await writeFile(config, JSON.stringify({ allowedDirectories: this.allowedDirectories, telemetryEnabled: false, welcomeOnboardingEligible: false, pendingWelcomeOnboarding: false }), { mode: 0o600 });
    await this.configPrepared();
    const blocked = new Set(["TOKEN_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "REMOTE_AUTH_MODE", "AUTHORIZED_USERS_JSON"]);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => !blocked.has(key) && value !== undefined)) as Record<string, string>;
    let args = this.cfg.dcArgs;
    if (this.cfg.dcManagedConfig) {
      const entry = args[0];
      if (!entry) throw new Error("Managed Desktop Commander requires an entry module.");
      const bootstrap = fileURLToPath(new URL("../scripts/desktop-commander-bootstrap.mjs", import.meta.url));
      args = [bootstrap, entry, config, ...args.slice(1)];
    }
    this.transport = new StdioClientTransport({ command: this.cfg.dcCommand, args, env, stderr: "pipe", cwd: process.cwd() });
    // Desktop Commander writes diagnostics for every get_config call. Consume
    // the private pipe without retaining or exposing its contents; otherwise
    // stderr backpressure can block the child and its MCP stdout responses.
    this.transport.stderr?.on("data", () => undefined);
    this.client = new Client({ name: "remote-desktop-mcp", version: "0.1.0" });
    await this.client.connect(this.transport);
    this.generation = randomBytes(16).toString("base64url");
    const available = await this.client.listTools(); this.tools = new Set(available.tools.map((tool) => tool.name));
    const missing = REQUIRED_TOOLS.filter((tool) => !this.tools.has(tool));
    if (missing.length) { await this.close(); throw new Error(`Desktop Commander is missing required tools: ${missing.join(", ")}`); }
    try { await this.verifyAllowedRoots(); } catch (error) { await this.close(); throw error; }
    await this.audit("desktop_commander.ready", { toolCount: this.tools.size });
  }
  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.transport = undefined;
    this.generation = undefined;
    if (!client) return;

    // The SDK's stdio close path uses unreferenced fallback timers while it waits
    // for the child process. Keep this service shutdown bounded and referenced so
    // Node can run the SDK's SIGTERM/SIGKILL fallbacks even if the child emitted
    // its close event just before the SDK attached its listener.
    let timeout: NodeJS.Timeout | undefined;
    const closed = await Promise.race([
      client.close().then(() => true).catch(() => false),
      new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), 5_000); }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!closed) await this.audit("desktop_commander.shutdown_timeout", {});
  }
  async call(name: string, args: Record<string, unknown>, timeout?: number, options: { skipRootPreflight?: boolean; allowStoppedOperation?: boolean } = {}): Promise<string> {
    if (!this.client || !this.tools.has(name)) throw new Error("Desktop Commander is unavailable for this operation.");
    // Emergency-stop control is deliberately independent from ordinary tool
    // preflight: a wedged backend must not make the owner latch wait on an
    // unbounded get_config request.
    if (!options.skipRootPreflight && name !== "get_config" && name !== "_rdmcp_stop_owner" && name !== "_rdmcp_resume_owner") await this.verifyAllowedRoots();
    // Root verification is asynchronous. Recheck the operation generation
    // after it and immediately before any ordinary backend request.
    if (!options.allowStoppedOperation) this.requireCurrentOperation();
    const value = await this.client.callTool({ name, arguments: args }, undefined, timeout ? { timeout } : undefined);
    if ("isError" in value && value.isError) {
      const content = value.content as Array<{ type: string; text?: string }>;
      const text = content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
      const detail = text.replace(/(?:[A-Za-z]:)?(?:[\\/][^\s"']+)+/g, "[path]").replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]").slice(0, 240);
      await this.audit("desktop_commander.rejected", { tool: name, detail });
      throw new Error("Desktop Commander rejected the operation.");
    }
    if (!("content" in value)) throw new Error("Desktop Commander returned an unsupported response.");
    const content = value.content as Array<{ type: string; text?: string }>;
    return content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
  }
  private async verifyAllowedRoots(): Promise<void> {
    const reported = await this.call("get_config", {});
    const start = reported.indexOf("{");
    let config: { allowedDirectories?: unknown };
    try { config = JSON.parse(reported.slice(start)) as { allowedDirectories?: unknown }; } catch { throw new Error("Desktop Commander returned an unreadable configuration."); }
    if (!Array.isArray(config.allowedDirectories) || !config.allowedDirectories.every((value) => typeof value === "string")) throw new Error("Desktop Commander did not return allowedDirectories.");
    const normalize = (value: string) => {
      const normalized = path.resolve(value).replaceAll("\\", "/").replace(/\/+/g, "/");
      return process.platform === "win32" ? normalized.toLowerCase() : normalized;
    };
    const configured = new Set(config.allowedDirectories.map(normalize));
    if (configured.size !== this.allowedDirectories.length || !this.allowedDirectories.every((root) => configured.has(normalize(root)))) throw new Error("Desktop Commander allowedDirectories changed unexpectedly.");
  }
}

export class RemoteDesktopService {
  readonly sessions = new Map<string, Session>();
  readonly transfers = new Map<string, Transfer>();
  readonly processes = new Map<string, Process>();
  private readonly currentProcessOwners = new Map<string, string>();
  readonly clients = new Map<string, OAuthClient>();
  readonly authorizations = new Map<string, Authorization>();
  readonly codes = new Map<string, Authorization>();
  private readonly processLock = new Mutex();
  private readonly transferLock = new Mutex();
  private readonly dc: DesktopCommander;
  private readonly linkNoReplace: (existingPath: string, newPath: string) => Promise<void>;
  private readonly linkProtectedConfig: (existingPath: string, newPath: string) => Promise<void>;
  private readonly terminalTransfers: string[] = [];
  private readonly ownedUploads = new Map<string, OwnedUploadArtifact>();
  private readonly processWatchers = new Map<string, NodeJS.Timeout>();
  private readonly protectedConfigIdentities = new Map<string, ProtectedConfigIdentity>();
  private readonly configIdentityLock = new Mutex();
  private readonly executionStates = new Map<string, UserExecutionState>();
  private readonly executionStateLock = new Mutex();
  private readonly executionResumes = new Set<string>();
  private readonly operationContext = new AsyncLocalStorage<ExecutionOperation>();
  private auditGeneration = makeId();
  private readonly auditEntries: AuditLogEntry[] = [];
  private readonly auditListeners = new Set<(event: Record<string, unknown> & { event: string; at: string }) => void>();
  private readonly auditConnectionClosers = new Set<() => void>();
  private readonly auditProcessOwners = new Map<string, { user: string; sessionId?: string }>();
  private readonly auditLock = new Mutex();
  private auditSequence = 0;
  private auditFileIdentity?: FileIdentity;
  private auditFileBytes = 0n;
  private executionStateUnavailable = false;
  readonly publicAuth?: PublicAuthService;
  private expiryTimer?: NodeJS.Timeout;
  constructor(readonly cfg: RuntimeConfig) { this.dc = new DesktopCommander(cfg, this.audit.bind(this), () => this.rememberProtectedConfigIdentity(), () => this.requireCurrentOperation()); this.linkNoReplace = cfg.linkNoReplace ?? link; this.linkProtectedConfig = cfg.linkProtectedConfig ?? link; this.publicAuth = cfg.publicAuth ? new PublicAuthService(cfg.publicAuth, cfg.publicAuthOptions) : undefined; }
  async initialize(): Promise<void> {
    await ensureSafeDataDirectory(this.cfg.dataDir);
    await this.loadAuditIndex();
    await this.loadExecutionStates();
    const protectedParent = path.join(this.cfg.dataDir, "desktop-commander-home", ".claude-server-commander");
    const actualData = await realpath(this.cfg.dataDir);
    for (const root of this.cfg.roots) {
      const actualRoot = await realpath(root.path);
      if (overlaps(actualRoot, actualData) || overlaps(actualRoot, protectedParent)) throw new Error("FILE_ROOTS_JSON must not overlap DATA_DIR or Desktop Commander config parent.");
      root.path = actualRoot;
    }
    const transferDirectory = path.join(this.cfg.dataDir, "transfers");
    await ensurePrivateDirectory(transferDirectory);
    await this.loadProtectedConfigIdentities();
    await this.rememberProtectedConfigIdentity(true);
    for (const entry of await readdir(transferDirectory, { withFileTypes: true })) if (entry.isFile() && entry.name.endsWith(".snapshot")) await rm(path.join(transferDirectory, entry.name), { force: true });
    await this.cleanupOwnedUploadArtifacts();
    if (this.publicAuth) { await this.publicAuth.initialize(); if (!this.publicAuth.hasAllowedSubject()) throw new Error("Google mode requires a locally approved Google subject. Run remote-auth authorize-google."); }
    await this.dc.start();
    await this.rememberProtectedConfigIdentity();
    await this.pruneProtectedConfigIdentities();
    this.expiryTimer = setInterval(() => { void this.sweepExpired(); }, 60_000);
    this.expiryTimer.unref();
  }
  async close(): Promise<void> { if (this.expiryTimer) clearInterval(this.expiryTimer); for (const watcher of this.processWatchers.values()) clearInterval(watcher); this.processWatchers.clear(); for (const close of this.auditConnectionClosers) close(); this.auditConnectionClosers.clear(); this.auditListeners.clear(); await this.transferLock.run(async () => { for (const item of this.transfers.values()) await this.cleanup(item); }); await this.dc.close(); }
  async audit(event: string, fields: Record<string, unknown>): Promise<void> { await this.auditLock.run(async () => { await this.refreshAuditIndexLocked(); const file = path.join(this.cfg.dataDir, "audit.jsonl"); try { await assertPrivateAuditStorage(this.cfg.dataDir, file); } catch (error) { if (!(typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT")) throw error; await createPrivateFile(file, ""); await assertPrivateAuditStorage(this.cfg.dataDir, file); await this.refreshAuditIndexLocked(); } const entry = { at: new Date().toISOString(), event, ...fields }; const line = `${JSON.stringify(entry)}\n`; await appendFile(file, line); this.rememberAuditEntry(entry); const stats = await lstat(file, { bigint: true }); const identity = this.identityFromStats(stats); const expectedBytes = this.auditFileBytes + BigInt(Buffer.byteLength(line)); if (this.auditFileIdentity && this.auditFileIdentity.dev === identity.dev && this.auditFileIdentity.ino === identity.ino && stats.size === expectedBytes) this.auditFileBytes = stats.size;
    else await this.loadAuditIndex(true);
  }); }
  private rememberAuditEntry(value: Record<string, unknown>, notify = true): void {
    if (typeof value.event !== "string" || typeof value.at !== "string") return;
    const processId = typeof value.processId === "string" ? value.processId : undefined;
    const known = processId ? this.auditProcessOwners.get(processId) : undefined;
    const user = typeof value.user === "string" ? value.user : known?.user;
    const sessionId = typeof value.sessionId === "string" ? value.sessionId : known?.sessionId;
    const event = { ...value, ...(user ? { user } : {}), ...(sessionId ? { sessionId } : {}) } as Record<string, unknown> & { event: string; at: string };
    if (processId && typeof event.user === "string") { this.auditProcessOwners.delete(processId); while (this.auditProcessOwners.size >= 2_000) this.auditProcessOwners.delete(this.auditProcessOwners.keys().next().value!); this.auditProcessOwners.set(processId, { user: event.user, ...(typeof event.sessionId === "string" ? { sessionId: event.sessionId } : {}) }); }
    this.auditEntries.push({ sequence: ++this.auditSequence, event });
    while (this.auditEntries.length > MAX_AUDIT_EVENTS) this.auditEntries.shift();
    if (notify) for (const listener of this.auditListeners) listener(event);
  }
  private async loadAuditIndex(reset = false): Promise<void> {
    const file = path.join(this.cfg.dataDir, "audit.jsonl");
    if (reset) { this.auditGeneration = makeId(); this.auditEntries.length = 0; this.auditProcessOwners.clear(); this.auditSequence = 0; }
    try { await assertPrivateAuditStorage(this.cfg.dataDir, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.auditFileIdentity = undefined; this.auditFileBytes = 0n; return; } throw error; }
    const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      try { this.rememberAuditEntry(JSON.parse(line) as Record<string, unknown>, false); }
      catch { /* Keep valid persisted entries available when one historical line is malformed. */ }
    }
    const stats = await lstat(file, { bigint: true }); this.auditFileIdentity = this.identityFromStats(stats); this.auditFileBytes = stats.size;
  }
  private async refreshAuditIndexLocked(): Promise<void> {
    const file = path.join(this.cfg.dataDir, "audit.jsonl");
    let stats: Awaited<ReturnType<typeof lstat>>;
    try { stats = await lstat(file, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { if (this.auditFileIdentity || this.auditFileBytes !== 0n || this.auditEntries.length) await this.loadAuditIndex(true); return; } throw error; }
    const identity = this.identityFromStats(stats as Awaited<ReturnType<typeof lstat>> & { dev: bigint; ino: bigint });
    if (!this.auditFileIdentity || this.auditFileIdentity.dev !== identity.dev || this.auditFileIdentity.ino !== identity.ino || this.auditFileBytes !== (stats as { size: bigint }).size) await this.loadAuditIndex(true);
  }
  async refreshAuditIndex(): Promise<void> { await this.auditLock.run(() => this.refreshAuditIndexLocked()); }
  private auditCursor(user: string, sessionId: string | undefined, sequence: number): string {
    const encoded = Buffer.from(JSON.stringify({ generation: this.auditGeneration, sequence, user, sessionId: sessionId ?? null })).toString("base64url");
    return `${encoded}.${createHmac("sha256", this.cfg.tokenSecret).update(encoded).digest("base64url")}`;
  }
  private parseAuditCursor(cursor: string, user: string, sessionId: string | undefined): number {
    const [encoded, signature, extra] = cursor.split(".");
    if (!encoded || !signature || extra || !equal(createHmac("sha256", this.cfg.tokenSecret).update(encoded).digest("base64url"), signature)) throw new Error("Invalid log cursor.");
    let body: { generation?: unknown; sequence?: unknown; user?: unknown; sessionId?: unknown };
    try { body = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { throw new Error("Invalid log cursor."); }
    if (body.generation !== this.auditGeneration) throw new Error("Log cursor expired.");
    const sequence = body.sequence;
    if (body.user !== user || body.sessionId !== (sessionId ?? null) || typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0 || sequence > this.auditSequence) throw new Error("Invalid log cursor.");
    const first = this.auditEntries[0]?.sequence;
    if (first !== undefined && sequence < first - 1) throw new Error("Log cursor expired.");
    return sequence;
  }
  private ownsAuditEvent(event: AuditLogEntry["event"], user: string, sessionId?: string): boolean {
    if (event.user !== user) return false;
    if (sessionId === undefined || event.sessionId === sessionId) return true;
    // A session-less rejected/open operation is rendered as `request:<operationId>`.
    // Only accept that server-derived identifier when its exact operation record
    // belongs to this principal; never turn an arbitrary supplied session ID into
    // an owner correlation.
    const operationId = sessionId.startsWith("request:") ? sessionId.slice("request:".length) : "";
    return Boolean(operationId && event.sessionId === undefined && event.operationId === operationId);
  }
  getUserAuditPage(user: string, sessionId: string | undefined, query: { limit: number; before?: string; after?: string }) {
    if (query.before && query.after) throw new Error("before and after cannot be combined.");
    const boundary = query.before ? this.parseAuditCursor(query.before, user, sessionId) : query.after ? this.parseAuditCursor(query.after, user, sessionId) : undefined;
    const available = this.auditEntries.filter((entry) => this.ownsAuditEvent(entry.event, user, sessionId));
    const selected = query.after
      ? available.filter((entry) => entry.sequence > boundary!).slice(0, query.limit).reverse()
      : available.filter((entry) => boundary === undefined || entry.sequence < boundary).slice(-query.limit).reverse();
    const newest = selected[0]?.sequence ?? (boundary ?? this.auditSequence);
    const oldest = selected.at(-1)?.sequence ?? (boundary ?? this.auditSequence);
    return {
      items: selected.map((entry) => ({ id: `${this.auditGeneration}:${entry.sequence}`, cursor: this.auditCursor(user, sessionId, entry.sequence), event: entry.event })),
      newestCursor: this.auditCursor(user, sessionId, newest),
      oldestCursor: this.auditCursor(user, sessionId, oldest),
      hasMoreOlder: available.some((entry) => entry.sequence < oldest),
      hasMoreNewer: available.some((entry) => entry.sequence > newest),
    };
  }
  countNewUserAuditEvents(user: string, sessionId: string | undefined, after?: string): { count: number; latestCursor: string; overflow: boolean } {
    const boundary = after ? this.parseAuditCursor(after, user, sessionId) : this.auditSequence;
    const count = this.auditEntries.filter((entry) => entry.sequence > boundary && this.ownsAuditEvent(entry.event, user, sessionId)).length;
    return { count: Math.min(count, 1_000), latestCursor: this.auditCursor(user, sessionId, this.auditSequence), overflow: count > 1_000 };
  }
  userCanViewAuditEvent(user: string, sessionId: string | undefined, event: Record<string, unknown>): boolean {
    return typeof event.event === "string" && typeof event.at === "string" && this.ownsAuditEvent(event as AuditLogEntry["event"], user, sessionId);
  }
  userOwnsActiveSession(user: string, sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return Boolean(session && session.user === user && session.state === "active" && session.expires > Date.now());
  }
  userOwnsAuditSession(user: string, sessionId: string): boolean {
    if (this.userOwnsActiveSession(user, sessionId)) return true;
    if (this.auditEntries.some((entry) => entry.event.event === "session.open" && entry.event.user === user && entry.event.sessionId === sessionId)) return true;
    const operationId = sessionId.startsWith("request:") ? sessionId.slice("request:".length) : "";
    return Boolean(operationId && this.auditEntries.some((entry) => entry.event.user === user && entry.event.sessionId === undefined && entry.event.operationId === operationId));
  }
  auditEntriesForConsole(): Array<Record<string, unknown> & { event: string; at: string }> { return this.auditEntries.map((entry) => entry.event); }
  subscribeAudit(listener: (event: Record<string, unknown> & { event: string; at: string }) => void): () => void { this.auditListeners.add(listener); return () => this.auditListeners.delete(listener); }
  subscribeAuditConnection(close: () => void): () => void { this.auditConnectionClosers.add(close); return () => this.auditConnectionClosers.delete(close); }
  sign(body: object): string { const encoded = Buffer.from(JSON.stringify(body)).toString("base64url"); return `${encoded}.${createHmac("sha256", this.cfg.tokenSecret).update(encoded).digest("base64url")}`; }
  validRedirect(uri: string): boolean { try { return this.cfg.allowedRedirectOrigins.has(new URL(uri).origin); } catch { return false; } }
  authenticate(header?: string): string | undefined {
    if (!header?.startsWith("Bearer ")) return undefined;
    const [encoded, signature] = header.slice(7).split(".");
    if (!encoded || !signature || !equal(createHmac("sha256", this.cfg.tokenSecret).update(encoded).digest("base64url"), signature)) return undefined;
    try { const body = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>; const user = this.cfg.users[0]; return body.type === "access" && body.sub === user.email && body.iss === this.cfg.baseUrl && body.aud === `${this.cfg.baseUrl}/mcp` && body.scope === "mcp" && typeof body.exp === "number" && body.exp > Math.floor(Date.now() / 1000) ? user.email : undefined; } catch { return undefined; }
  }
  private executionStatePath(): string { return path.join(this.cfg.dataDir, "user-execution-states.json"); }
  private executionStopMarkerPath(): string { return path.join(this.cfg.dataDir, "user-execution-stop-pending.json"); }
  private validateExecutionState(value: unknown): value is UserExecutionState {
    if (!value || typeof value !== "object") return false;
    const state = value as UserExecutionState;
    return typeof state.principalId === "string" && state.principalId.length > 0 && state.principalId.length <= 512
      && typeof state.stopped === "boolean" && Number.isSafeInteger(state.stopGeneration) && state.stopGeneration >= 0
      && (state.stoppedAt === undefined || (typeof state.stoppedAt === "string" && !Number.isNaN(Date.parse(state.stoppedAt))))
      && (state.stopId === undefined || (typeof state.stopId === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(state.stopId)));
  }
  private async loadExecutionStates(): Promise<void> {
    const file = this.executionStatePath();
    let raw: string;
    try { raw = await readFile(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") { this.executionStateUnavailable = true; throw new Error("User execution state could not be read; remote execution remains stopped.", { cause: error }); }
      raw = "[]";
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { this.executionStateUnavailable = true; throw new Error("User execution state is invalid; remote execution remains stopped."); }
    if (!Array.isArray(parsed) || parsed.length > 10_000 || parsed.some((value) => !this.validateExecutionState(value)) || new Set(parsed.map((value) => (value as UserExecutionState).principalId)).size !== parsed.length) {
      this.executionStateUnavailable = true;
      throw new Error("User execution state is invalid; remote execution remains stopped.");
    }
    for (const state of parsed as UserExecutionState[]) this.executionStates.set(state.principalId, state);
    const marker = await readFile(this.executionStopMarkerPath(), "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (marker !== undefined) {
      let pending: unknown;
      try { pending = JSON.parse(marker); } catch { this.executionStateUnavailable = true; throw new Error("Emergency stop recovery marker is invalid; remote execution remains stopped."); }
      if (!this.validateExecutionState(pending) || !pending.stopped || !pending.stopId) { this.executionStateUnavailable = true; throw new Error("Emergency stop recovery marker is invalid; remote execution remains stopped."); }
      const recovered = pending as UserExecutionState;
      const stored = this.executionStates.get(recovered.principalId);
      try {
        if (stored?.stopped !== true || stored.stopId !== recovered.stopId || stored.stopGeneration !== recovered.stopGeneration) { this.executionStates.set(recovered.principalId, recovered); await this.persistExecutionStates(); }
        await rm(this.executionStopMarkerPath(), { force: true });
      } catch { this.executionStateUnavailable = true; throw new Error("Emergency stop recovery could not be persisted; remote execution remains stopped."); }
    }
  }
  private async persistExecutionStates(): Promise<void> {
    const file = this.executionStatePath();
    const pending = `${file}.next`;
    try {
      await writeFile(pending, JSON.stringify([...this.executionStates.values()]), { mode: 0o600 });
      const handle = await open(pending, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
      await rename(pending, file);
      await protectPrivateFile(file);
    } catch (error) {
      this.executionStateUnavailable = true;
      await rm(pending, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  private async writeExecutionStopMarker(state: UserExecutionState): Promise<void> {
    if (!state.stopped || !state.stopId) throw new Error("A stopped execution state is required for recovery.");
    const markerPath = this.executionStopMarkerPath();
    await writeFile(markerPath, JSON.stringify(state), { mode: 0o600 });
    const marker = await open(markerPath, "r+");
    try { await marker.sync(); } finally { await marker.close(); }
    await protectPrivateFile(markerPath);
  }
  private executionStateFor(user: string): UserExecutionState { return this.executionStates.get(user) ?? { principalId: user, stopped: false, stopGeneration: 0 }; }
  userExecutionState(user: string): UserExecutionState {
    const state = this.executionStateFor(user);
    return { ...state, stopped: state.stopped || this.executionStateUnavailable || this.executionResumes.has(user) };
  }
  private requireExecutionAllowed(user: string): void {
    const state = this.userExecutionState(user);
    if (state.stopped) throw new UserStopRequested(state);
  }
  private requireCurrentOperation(): void {
    const operation = this.operationContext.getStore();
    if (!operation) return;
    const state = this.userExecutionState(operation.user);
    if (state.stopped || state.stopGeneration !== operation.stopGeneration) throw new UserStopRequested(state);
  }
  async stopUserExecution(user: string): Promise<UserExecutionState> { return this.executionStateLock.run(async () => {
    const prior = this.executionStateFor(user);
    const state: UserExecutionState = { principalId: user, stopped: true, stopGeneration: prior.stopGeneration + 1, stoppedAt: new Date().toISOString(), stopId: makeId() };
    this.executionStates.set(user, state);
    let persistenceFailure: Error | undefined;
    try { await this.writeExecutionStopMarker(state); }
    catch { this.executionStateUnavailable = true; persistenceFailure = new Error("Emergency stop recovery marker could not be persisted; remote execution remains stopped."); await this.audit("user.stop_marker_failed", { user }).catch(() => undefined); }
    if (!persistenceFailure) try { await this.persistExecutionStates(); await rm(this.executionStopMarkerPath(), { force: true }); }
    catch { persistenceFailure = new Error("Emergency stop state could not be persisted; remote execution remains stopped."); await this.audit("user.stop_persistence_failed", { user }).catch(() => undefined); }
    for (const session of this.sessions.values()) if (session.user === user && session.state === "active") session.state = "closed";
    // Do not queue behind a long-running process_start/output operation. The
    // bridge latches the owner and also catches a PID published after this call.
    let bridgeAvailable = false;
    const bridgeTerminatedPids = new Set<number>();
    if (!this.cfg.processAdapter) {
      try {
        const reply = await this.dc.call("_rdmcp_stop_owner", { owner: user }, 2_000, { skipRootPreflight: true, allowStoppedOperation: true });
        const bridgeResult = JSON.parse(reply) as { stopped?: unknown; terminated_pids?: unknown; failed_pids?: unknown };
        if (bridgeResult.stopped !== true || !Array.isArray(bridgeResult.terminated_pids) || !bridgeResult.terminated_pids.every((pid) => Number.isInteger(pid) && pid > 0)) throw new Error("Owner stop result is invalid.");
        bridgeAvailable = true;
        for (const pid of bridgeResult.terminated_pids) bridgeTerminatedPids.add(pid);
        if (Array.isArray(bridgeResult.failed_pids)) for (const pid of bridgeResult.failed_pids) if (Number.isInteger(pid) && pid > 0) await this.audit("process.owner_stop_failed", { user, pid, stopId: state.stopId }).catch(() => undefined);
      }
      catch { await this.audit("process.owner_stop_unconfirmed", { user, stopId: state.stopId }).catch(() => undefined); }
    }
    for (const item of this.processes.values()) if (item.user === user && (item.state === "running" || item.state === "terminating")) {
      item.state = "terminating"; item.terminationRequested = true;
      try {
        if (this.cfg.processAdapter) await this.cfg.processAdapter.terminate(item.pid, 2_000);
        // A PID can be reused after its old process exits.  Only the private
        // owner bridge can prove that this PID still belongs to this user; a
        // generic PID kill here could terminate another user's new process.
        else if (!bridgeAvailable || !bridgeTerminatedPids.has(item.pid)) {
          item.terminationUnconfirmed = true;
          await this.audit("process.stop_unconfirmed", { user, processId: item.id, pid: item.pid, stopId: state.stopId, reason: "owner_not_confirmed" }).catch(() => undefined);
          continue;
        }
        await this.audit("process.stop_requested", { user, processId: item.id, pid: item.pid, stopId: state.stopId }).catch(() => undefined);
      } catch {
        item.terminationUnconfirmed = true;
        await this.audit("process.stop_unconfirmed", { user, processId: item.id, pid: item.pid, stopId: state.stopId }).catch(() => undefined);
      }
    }
    await this.audit("user.stop_requested", { user, stopId: state.stopId, stopGeneration: state.stopGeneration }).catch(() => undefined);
    await this.transferLock.run(async () => {
      for (const item of this.transfers.values()) if (item.sessionId && this.sessions.get(item.sessionId)?.user === user && item.state === "active") {
        item.state = "cancelled"; await this.cleanup(item); this.rememberTerminal(item);
        await this.audit("transfer.cancelled_by_user_stop", { user, transferId: item.id, stopId: state.stopId }).catch(() => undefined);
      }
    });
    if (persistenceFailure) throw persistenceFailure;
    return { ...state };
  }); }
  async resumeUserExecution(user: string): Promise<UserExecutionState> { return this.executionStateLock.run(async () => {
    if (this.executionStateUnavailable) throw new Error("Remote execution state is unavailable and cannot be resumed.");
    const prior = this.executionStateFor(user);
    if (!prior.stopped || !prior.stopId) throw new Error("Remote execution is not stopped.");
    const state: UserExecutionState = { principalId: user, stopped: false, stopGeneration: prior.stopGeneration + 1 };
    // Persist the prospective state before exposing it. A failed resume must
    // leave the in-memory latch closed as well as the durable one.
    this.executionResumes.add(user);
    try {
      try {
        // Keep a durable stopped record until both the new state and the backend
        // latch have changed.  In particular, persistExecutionStates can fail
        // after rename (for example while restoring the private ACL), leaving a
        // false state on disk even though this resume must fail closed.
        await this.writeExecutionStopMarker(prior);
        this.executionStates.set(user, state);
        await this.persistExecutionStates();
      } catch (error) {
        this.executionStates.set(user, prior);
        throw error;
      }
      try {
        if (!this.cfg.processAdapter) await this.dc.call("_rdmcp_resume_owner", { owner: user }, 2_000, { skipRootPreflight: true, allowStoppedOperation: true });
      } catch (error) {
        // The backend latch must reopen together with the durable user state.
        // If it cannot, restore a durable stopped state rather than exposing a
        // resume that still rejects (or could later partially reopen) processes.
        this.executionStates.set(user, prior);
        try { await this.persistExecutionStates(); } catch { this.executionStateUnavailable = true; }
        throw error;
      }
      try { await rm(this.executionStopMarkerPath(), { force: true }); }
      catch { this.executionStateUnavailable = true; throw new Error("Emergency stop recovery marker could not be cleared; remote execution remains stopped."); }
      await this.audit("user.execution_resumed", { user, stopGeneration: state.stopGeneration });
      return { ...state };
    } finally { this.executionResumes.delete(user); }
  }); }
  private async sweepExpiredLocked(now = Date.now()): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.state === "active" && session.expires <= now) {
        await this.audit("session.expired", { user: session.user, sessionId: session.id });
        session.state = "expired";
        for (const transfer of this.transfers.values()) if (transfer.sessionId === session.id && transfer.state === "active") await this.fail(transfer, "session_expired");
      }
    }
    for (const transfer of this.transfers.values()) if (transfer.state === "active" && now - transfer.touched > TRANSFER_TTL) await this.fail(transfer, "expired");
    for (const [id, session] of this.sessions) if (session.state !== "active" && now - session.expires > SESSION_TTL) this.sessions.delete(id);
  }
  async sweepExpired(): Promise<void> { await this.transferLock.run(() => this.sweepExpiredLocked()); }
  session(user: string, sessionId: string): Session { this.requireCurrentOperation(); const value = this.sessions.get(sessionId); if (!value || value.user !== user || value.state !== "active" || value.expires <= Date.now()) throw new Error("Session is invalid, expired, or belongs to another user."); value.touched = Date.now(); value.expires = value.touched + SESSION_TTL; const operation = this.operationContext.getStore(); if (operation?.user === user) operation.sessionAccessAt = new Date(value.touched).toISOString(); return value; }
  private nodeEntries(): NodeListEntry[] {
    if (this.cfg.nodeRegistry) return this.cfg.nodeRegistry.list();
    return [{
      node_id: this.cfg.nodeId,
      label: this.cfg.nodeLabel,
      root_ids: this.cfg.roots.map((root) => root.id),
      roots: this.cfg.roots.map((root) => ({ root_id: root.id, absolute_path: root.path })),
      path_base: "root",
      connected: true,
      coordinator: true,
      operations: ["file", "process", "transfer"],
      last_seen_at: null,
    }];
  }
  private sessionTarget(nodeId?: string): NodeListEntry {
    const nodes = this.nodeEntries();
    let target: NodeListEntry | undefined;
    if (nodeId) {
      target = nodes.find((node) => node.node_id === nodeId);
      if (!target) throw new Error("Unknown or unsupported node.");
    } else {
      if (nodes.length !== 1) throw new Error("node_id is required when multiple operation targets are configured.");
      target = nodes[0];
    }
    if (!target.connected) throw new Error("Selected node is disconnected.");
    return target;
  }
  private async validateSessionWorkingDirectory(user: string, target: NodeListEntry, requested: string): Promise<string> {
    const operation: NodeOperationName = "session_validate_working_directory";
    const response = target.node_id === this.cfg.nodeId
      ? await this.executeLocalNodeOperation(user, undefined, operation, { working_directory: requested })
      : await this.requestRemoteWithoutSession(user, target, operation, { working_directory: requested });
    if (!isRecord(response) || typeof response.working_directory !== "string") {
      throw new Error("Remote node did not validate the working directory.");
    }
    const workingDirectory = response.working_directory.trim();
    if (!workingDirectory || workingDirectory.length > 4096 || (!path.win32.isAbsolute(workingDirectory) && !path.posix.isAbsolute(workingDirectory))) {
      throw new Error("Remote node returned an invalid working directory.");
    }
    return workingDirectory;
  }
  private operationTarget(user: string, sessionId: string, nodeId?: string): { session: Session; target: NodeListEntry } {
    const session = this.session(user, sessionId);
    if (nodeId !== undefined && nodeId !== session.nodeId) {
      throw new Error("Session node mismatch: SESSION_NODE_MISMATCH.");
    }
    const target = this.nodeEntries().find((node) => node.node_id === session.nodeId);
    if (!target) throw new Error("Unknown or unsupported node.");
    if (!target.connected) throw new Error("Selected node is disconnected.");
    return { session, target };
  }
  private async requestRemoteWithoutSession(
    user: string,
    target: NodeListEntry,
    operation: NodeOperationName,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (target.node_id === this.cfg.nodeId) throw new Error("Remote node request targeted the local node.");
    const contract = nodeOperationContract(operation);
    if (!target.operations.includes(contract.capability)) {
      throw new Error(`Remote node does not provide the ${contract.capability} operation capability.`);
    }
    if (!this.cfg.nodeRequest) throw new Error("Remote node request handling is unavailable.");
    const state = this.userExecutionState(user);
    const request = createNodeOperationRequest(user, state.stopGeneration, undefined, operation, args);
    return parseNodeOperationResponse(operation, await this.cfg.nodeRequest(target.node_id, request));
  }
  private async requestRemote(
    user: string,
    session: Session,
    target: NodeListEntry,
    operation: NodeOperationName,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (target.node_id === this.cfg.nodeId) throw new Error("Remote node request targeted the local node.");
    const contract = nodeOperationContract(operation);
    if (!target.operations.includes(contract.capability)) {
      throw new Error(`Remote node does not provide the ${contract.capability} operation capability.`);
    }
    if (!this.cfg.nodeRequest) throw new Error("Remote node request handling is unavailable.");
    const state = this.userExecutionState(user);
    const request = createNodeOperationRequest(user, state.stopGeneration, session.id, operation, args);
    return parseNodeOperationResponse(operation, await this.cfg.nodeRequest(target.node_id, request));
  }
  private async dispatchNodeOperation(
    user: string,
    session: Session,
    target: NodeListEntry,
    operation: NodeOperationName,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    return target.node_id === this.cfg.nodeId
      ? this.executeLocalNodeOperation(user, session.id, operation, args)
      : this.requestRemote(user, session, target, operation, args);
  }
  private async executeLocalNodeOperation(
    user: string,
    sessionId: string | undefined,
    operation: NodeOperationName,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const state = this.userExecutionState(user);
    const request = createNodeOperationRequest(user, state.stopGeneration, sessionId, operation, args);
    return parseNodeOperationResponse(operation, await this.executeNodeOperation(request));
  }
  private processKey(item: Pick<Process, "generation" | "pid">): string {
    return `${this.cfg.nodeId}:${item.generation}:${item.pid}`;
  }
  private stopWatchingProcess(processId: string): void {
    const watcher = this.processWatchers.get(processId);
    if (watcher) clearInterval(watcher);
    this.processWatchers.delete(processId);
  }
  private markProcessStale(item: Process): void {
    if (this.currentProcessOwners.get(this.processKey(item)) === item.id) {
      this.currentProcessOwners.delete(this.processKey(item));
    }
    item.state = "stale";
    this.stopWatchingProcess(item.id);
  }
  private requireCurrentProcess(item: Process): Process {
    let generation: string;
    try {
      generation = this.dc.currentGeneration();
    } catch {
      this.markProcessStale(item);
      throw new Error("Process id is stale or finished.");
    }
    if (item.generation !== generation || this.currentProcessOwners.get(this.processKey(item)) !== item.id) {
      this.markProcessStale(item);
      throw new Error("Process id is stale or finished.");
    }
    return item;
  }
  private redactCommand(command: string): string {
    return [
      this.cfg.tokenSecret,
      this.cfg.publicAuth?.googleClientSecret ?? "",
      ...this.cfg.users.map((configured) => configured.passwordHash),
    ]
      .filter(Boolean)
      .reduce((value, secret) => value.split(secret).join("[redacted]"), command)
      .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
      .replace(
        /((?:--)?(?:token|password|secret|credential|api[_-]?key|authorization)\s*(?:=|:|\s)\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
        "$1[redacted]",
      )
      .slice(0, 4000);
  }
  private startProcessBackend(
    command: string,
    timeout: number,
    owner: string,
    operationId: string,
    workingDirectory: string,
  ): Promise<string> {
    return this.cfg.processAdapter?.start(command, timeout, workingDirectory)
      ?? this.dc.call("start_process", {
        command,
        timeout_ms: timeout,
        __rdmcp_owner: owner,
        __rdmcp_operation: operationId,
        __rdmcp_cwd: workingDirectory,
      });
  }
  private readProcessBackend(item: Process): Promise<string> {
    return this.cfg.processAdapter?.read(item.pid, item.cursor, 1_000)
      ?? this.dc.call("read_process_output", {
        pid: item.pid,
        offset: item.cursor,
        length: 1000,
        timeout_ms: 100,
      }, 1_000);
  }
  private terminateProcessBackend(item: Process): Promise<string> {
    return this.cfg.processAdapter?.terminate(item.pid, 2_000)
      ?? this.dc.call("force_terminate", { pid: item.pid }, 2_000);
  }
  private listProcessSessions(): Promise<string> {
    return this.cfg.processAdapter?.sessions() ?? this.dc.call("list_sessions", {}, 1_000);
  }
  private async auditProcessExit(item: Process): Promise<void> {
    if (item.exitAudited) return;
    await this.audit("process.exit", {
      sessionId: item.sessionId,
      processId: item.id,
      output: this.redactCommand(item.output),
      outputTruncated: item.output.length > 4000,
      result: item.terminationRequested ? "exit_after_termination_request" : "natural",
      exitCode: item.exitCode ?? null,
    });
    item.exitAudited = true;
  }
  private async finishProcessWhenRootIsGone(item: Process): Promise<void> {
    if (item.state === "finished") return;
    this.requireCurrentProcess(item);
    await this.auditProcessExit(item);
    item.state = "finished";
    item.terminationUnconfirmed = false;
    if (this.currentProcessOwners.get(this.processKey(item)) === item.id) {
      this.currentProcessOwners.delete(this.processKey(item));
    }
  }
  private async processActiveInDesktopCommander(item: Process): Promise<boolean> {
    this.requireCurrentProcess(item);
    const output = await this.listProcessSessions();
    return new RegExp(`PID:\\s*${item.pid}(?:\\D|$)`, "i").test(output);
  }
  private async observeProcess(item: Process): Promise<string> {
    const pages: string[] = [];
    let drained = false;
    item.outputDrained = false;
    for (let page = 0; page < 100; page += 1) {
      this.requireCurrentProcess(item);
      const output = await this.readProcessBackend(item);
      pages.push(output);
      const read = /Reading (\d+) (?:new )?lines(?: from line (\d+))?/i.exec(output);
      const remaining = /, (\d+) remaining\)/i.exec(output);
      if (read) item.cursor = Number(read[2] ?? item.cursor) + Number(read[1]);
      const completion = /Process completed with exit code\s+(?:(-?\d+)|null|undefined)/i.exec(output);
      if (completion) {
        item.completionPending = true;
        item.exitCode = completion[1] === undefined ? undefined : Number(completion[1]);
      }
      if (!remaining || Number(remaining[1]) === 0) {
        drained = true;
        break;
      }
    }
    item.outputDrained = drained;
    item.observationFailures = 0;
    item.nextObservationAt = undefined;
    item.output = `${item.output}\n${pages.join("\n")}`.slice(-MAX_PROCESS_OUTPUT_CHARS);
    const observed = pages.join("\n");
    if (
      observed
      && pages.some((page) => !/^Reading 0 (?:new )?lines(?: from line \d+)? \(total: \d+ lines(?:, 0 remaining)?\)\s*$/i.test(page.trim()))
    ) {
      await this.audit("process.output", {
        sessionId: item.sessionId,
        processId: item.id,
        output: this.redactCommand(observed),
        outputTruncated: observed.length > 4000,
      });
    }
    if (drained && item.completionPending) {
      await this.auditProcessExit(item);
      item.state = "finished";
      item.completionPending = false;
      item.terminationUnconfirmed = false;
      if (this.currentProcessOwners.get(this.processKey(item)) === item.id) {
        this.currentProcessOwners.delete(this.processKey(item));
      }
    }
    return observed;
  }
  private watchProcess(processId: string): void {
    if (this.processWatchers.has(processId)) return;
    let checking = false;
    const watcher = setInterval(() => {
      if (checking) return;
      checking = true;
      void this.processLock.run(async () => {
        const item = this.processes.get(processId);
        if (!item || item.state === "finished" || item.state === "stale") {
          this.stopWatchingProcess(processId);
          return;
        }
        if (item.nextObservationAt && item.nextObservationAt > Date.now()) return;
        try {
          const active = await this.processActiveInDesktopCommander(item);
          if (item.state === "terminating" && active) return;
          await this.observeProcess(item);
          if (!active && item.outputDrained) await this.finishProcessWhenRootIsGone(item);
        } catch {
          if (this.processes.get(processId)?.state === "stale") {
            this.stopWatchingProcess(processId);
            return;
          }
          item.observationFailures = (item.observationFailures ?? 0) + 1;
          item.nextObservationAt = Date.now() + Math.min(5_000, 250 * 2 ** Math.min(item.observationFailures, 4));
          if (item.observationFailures === 1) {
            await this.audit("process.observe_failed", { processId });
          }
          return;
        }
        if (this.processes.get(processId)?.state === "finished") {
          this.stopWatchingProcess(processId);
        }
      }).finally(() => {
        checking = false;
      });
    }, 250);
    watcher.unref();
    this.processWatchers.set(processId, watcher);
  }
  private processForOperation(user: string, sessionId: string, processId: string): Process {
    const item = this.processes.get(processId);
    if (!item || item.user !== user || item.sessionId !== sessionId || item.state === "stale") {
      throw new Error("Process id is stale or finished.");
    }
    if (item.state !== "finished") this.requireCurrentProcess(item);
    return item;
  }
  private currentProcessForOperation(user: string, sessionId: string, processId: string): Process {
    const item = this.processForOperation(user, sessionId, processId);
    if (item.state !== "running") throw new Error("Process id is stale or finished.");
    return item;
  }
  async executeNodeRequest(payload: unknown): Promise<unknown> {
    const request = parseNodeOperationRequest(payload);
    const state = this.userExecutionState(request.principal_id);
    if (state.stopped || state.stopGeneration !== request.stop_generation) {
      throw new Error("Remote node user state is stopped, stale, or unsynchronized.");
    }
    const operation: ExecutionOperation = {
      user: request.principal_id,
      operationId: makeId(),
      stopGeneration: request.stop_generation,
    };
    const response = await this.operationContext.run(operation, async () => {
      this.requireCurrentOperation();
      return this.executeNodeOperation(request);
    });
    return parseNodeOperationResponse(request.operation, response);
  }
  private async executeNodeOperation(request: NodeOperationRequest): Promise<unknown> {
    const user = request.principal_id;
    const sessionId = request.session_id;
    switch (request.operation) {
      case "session_validate_working_directory": {
        const { working_directory } = request.args as { working_directory: string };
        try {
          if (!path.isAbsolute(working_directory)) throw new Error();
          const resolved = await realpath(working_directory);
          if (!(await lstat(resolved)).isDirectory()) throw new Error();
          return { working_directory: resolved };
        } catch {
          throw new Error("Working directory must be an existing absolute directory.");
        }
      }
      case "file_search": {
        const { root_id, query } = request.args as { root_id: string; query: string };
        const output = await this.search(this.root(root_id), query, "files");
        await this.audit(nodeOperationContract(request.operation).auditEvent, { user, sessionId, nodeId: this.cfg.nodeId, rootId: root_id });
        return { output };
      }
      case "content_search": {
        const { root_id, query } = request.args as { root_id: string; query: string };
        const output = await this.search(this.root(root_id), query, "content");
        await this.audit(nodeOperationContract(request.operation).auditEvent, { user, sessionId, nodeId: this.cfg.nodeId, rootId: root_id });
        return { output };
      }
      case "file_read": {
        const { root_id, relative_path, offset, length } = request.args as {
          root_id: string; relative_path: string; offset?: number; length?: number;
        };
        const filePath = await this.safePath(root_id, relative_path);
        this.requireCurrentOperation();
        const output = await this.dc.call("read_file", { path: filePath, offset, length });
        await this.audit(nodeOperationContract(request.operation).auditEvent, { user, sessionId, nodeId: this.cfg.nodeId, rootId: root_id, relativePath: relative_path });
        return { output };
      }
      case "file_patch": {
        const { root_id, relative_path, old_string, new_string, expected_replacements } = request.args as {
          root_id: string; relative_path: string; old_string: string; new_string: string; expected_replacements: number;
        };
        const filePath = await this.safePath(root_id, relative_path);
        this.requireCurrentOperation();
        const output = await this.dc.call("edit_block", {
          file_path: filePath,
          old_string,
          new_string,
          expected_replacements,
        });
        await this.audit(nodeOperationContract(request.operation).auditEvent, { user, sessionId, nodeId: this.cfg.nodeId, rootId: root_id, relativePath: relative_path });
        return { output };
      }
      case "file_transfer_download_begin":
        return this.transferLock.run(async () => {
          if (!sessionId) throw new Error("Node operation session is required.");
          const { root_id, relative_path, inline } = request.args as { root_id: string; relative_path: string; inline?: boolean };
          await this.sweepExpiredLocked();
          if ([...this.transfers.values()].filter((item) => item.state === "active").length >= MAX_TRANSFERS) throw new Error("Transfer limit reached.");
          const source = await this.safePath(root_id, relative_path);
          const info = await lstat(source);
          if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw new Error("Only regular files within the transfer limit are allowed.");
          const directory = path.join(this.cfg.dataDir, "transfers");
          this.requireCurrentOperation();
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const snapshot = path.join(directory, `${makeId()}.snapshot`);
          try {
            this.requireCurrentOperation();
            const metadata = await this.privateSnapshot(source, snapshot);
            const item: Transfer = {
              id: makeId(),
              direction: "download",
              principalId: user,
              sessionId,
              nodeId: this.cfg.nodeId,
              rootId: root_id,
              target: source,
              snapshot,
              ...metadata,
              offset: 0,
              touched: Date.now(),
              state: "active",
              sent: createHash("sha256"),
            };
            this.transfers.set(item.id, item);
            await this.audit(nodeOperationContract(request.operation).auditEvent, { transferId: item.id, direction: item.direction, sessionId, nodeId: this.cfg.nodeId, size: item.size, sha256: item.sha256 });
            const base = { transfer_id: item.id, filename: path.basename(source), resolved_path: await realpath(source), root_id, path_base: "root" as const, size: item.size, sha256: item.sha256, chunk_bytes: this.cfg.chunkBytes };
            if (!inline || item.size > this.cfg.chunkBytes) return { ...base, complete: false };
            const data = await readFile(snapshot);
            item.sent?.update(data);
            item.offset = data.length;
            if (item.sent?.digest("hex") !== item.sha256) { await this.fail(item, "snapshot_read_failed"); throw new Error("Snapshot integrity check failed."); }
            await this.completeDownload(item);
            return { ...base, data: data.toString("base64"), next_offset: item.offset, complete: true };
          } catch (error) {
            await rm(snapshot, { force: true }).catch(() => undefined);
            throw error;
          }
        });
      case "file_transfer_download_chunk":
        return this.transferLock.run(async () => {
          if (!sessionId) throw new Error("Node operation session is required.");
          const { transfer_id, offset } = request.args as { transfer_id: string; offset: number };
          await this.sweepExpiredLocked();
          const item = this.downloadTransfer(user, sessionId, transfer_id);
          const replay = item.downloadReplay;
          if (replay && replay.offset === offset) {
            return { data: replay.data, next_offset: replay.nextOffset, complete: replay.complete };
          }
          if (item.state !== "active" || item.offset !== offset || !item.snapshot) throw new Error("Chunk offset or direction is invalid.");
          let handle: FileHandle | undefined;
          try {
            handle = await open(item.snapshot, "r");
            const length = Math.min(this.cfg.chunkBytes, item.size - item.offset);
            const bytes = Buffer.alloc(length);
            const read = await handle.read(bytes, 0, length, item.offset);
            if (read.bytesRead !== length) throw new Error("Snapshot read failed.");
            const data = bytes.subarray(0, read.bytesRead);
            item.sent?.update(data);
            item.offset += read.bytesRead;
            const complete = item.offset === item.size;
            if (complete && item.sent?.digest("hex") !== item.sha256) throw new Error("Snapshot integrity check failed.");
            const encoded = data.toString("base64");
            item.downloadReplay = { offset, data: encoded, nextOffset: item.offset, complete };
            if (complete) await this.completeDownload(item);
            return { data: encoded, next_offset: item.offset, complete };
          } catch (error) {
            await this.fail(item, "snapshot_read_failed");
            throw error;
          } finally {
            await handle?.close().catch(() => undefined);
          }
        });
      case "file_transfer_upload_begin":
        return this.transferLock.run(async () => {
          if (!sessionId) throw new Error("Node operation session is required.");
          const { root_id, relative_path, size, sha256, overwrite, data } = request.args as {
            root_id: string;
            relative_path: string;
            size: number;
            sha256: string;
            overwrite: boolean;
            data?: string;
          };
          let inlineBytes: Buffer | undefined;
          if (data !== undefined) {
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4) throw new Error("Inline upload must be valid base64.");
            inlineBytes = Buffer.from(data, "base64");
            if (inlineBytes.length > this.cfg.chunkBytes) throw new Error("Inline upload exceeds the configured chunk size.");
            if (inlineBytes.length !== size || createHash("sha256").update(inlineBytes).digest("hex") !== sha256) throw new Error("Inline upload size or SHA-256 does not match the declaration.");
          }
          await this.sweepExpiredLocked();
          if ([...this.transfers.values()].filter((item) => item.state === "active").length >= MAX_TRANSFERS) throw new Error("Transfer limit reached.");
          const target = await this.safePath(root_id, relative_path, true);
          const resolvedTarget = path.join(await realpath(path.dirname(target)), path.basename(target));
          this.requireCurrentOperation();
          if (!overwrite) await this.verifyNoReplaceCapability(path.dirname(target));
          const temp = path.join(path.dirname(target), `.__rdmcp_${makeId()}.upload`);
          let handle: FileHandle | undefined;
          try {
            this.requireCurrentOperation();
            handle = await open(temp, "wx", 0o600);
            const identity = this.identityFromStats(await handle.stat({ bigint: true }));
            await this.trackOwnedUpload(root_id, temp, identity);
            const item: Transfer = {
              id: makeId(),
              direction: "upload",
              principalId: user,
              sessionId,
              nodeId: this.cfg.nodeId,
              rootId: root_id,
              target,
              temp,
              tempHandle: handle,
              tempIdentity: identity,
              size,
              sha256,
              offset: 0,
              touched: Date.now(),
              state: "active",
              overwrite,
            };
            this.transfers.set(item.id, item);
            await this.audit(nodeOperationContract(request.operation).auditEvent, {
              transferId: item.id,
              direction: item.direction,
              sessionId,
              nodeId: this.cfg.nodeId,
              size,
              sha256,
            });
            const base = { transfer_id: item.id, resolved_path: resolvedTarget, root_id, path_base: "root" as const, chunk_bytes: this.cfg.chunkBytes };
            if (inlineBytes === undefined) return { ...base, complete: false };
            this.requireCurrentOperation();
            if (inlineBytes.length) await handle.write(inlineBytes, 0, inlineBytes.length, 0);
            item.offset = inlineBytes.length;
            const completed = await this.completeUpload(item);
            return { ...base, ...completed, complete: true };
          } catch (error) {
            await handle?.close().catch(() => undefined);
            await rm(temp, { force: true }).catch(() => undefined);
            await this.untrackOwnedUpload(temp).catch(() => undefined);
            throw error;
          }
        });
      case "file_transfer_upload_chunk":
        return this.transferLock.run(async () => {
          if (!sessionId) throw new Error("Node operation session is required.");
          const { transfer_id, offset, data } = request.args as { transfer_id: string; offset: number; data: string };
          await this.sweepExpiredLocked();
          const item = this.transfer(user, sessionId, transfer_id);
          if (item.direction !== "upload" || item.offset !== offset || !item.temp || !item.tempHandle || !item.tempIdentity) throw new Error("Chunk offset or direction is invalid.");
          const pathInfo = await this.identityForPath(item.temp).catch(() => undefined);
          if (!pathInfo || pathInfo.dev !== item.tempIdentity.dev || pathInfo.ino !== item.tempIdentity.ino) {
            await this.fail(item, "temp_path_replaced");
            throw new Error("Upload temporary file identity changed.");
          }
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4) throw new Error("Chunk must be valid base64.");
          const bytes = Buffer.from(data, "base64");
          if (!bytes.length || bytes.length > this.cfg.chunkBytes || item.offset + bytes.length > item.size) throw new Error("Chunk exceeds declared upload size.");
          this.requireCurrentOperation();
          await item.tempHandle.write(bytes, 0, bytes.length, item.offset);
          item.offset += bytes.length;
          return { next_offset: item.offset };
        });
      case "file_transfer_upload_commit":
        return this.transferLock.run(async () => {
          if (!sessionId) throw new Error("Node operation session is required.");
          const { transfer_id } = request.args as { transfer_id: string };
          await this.sweepExpiredLocked();
          const item = this.transfer(user, sessionId, transfer_id);
          return this.completeUpload(item);
        });
      case "file_transfer_status":
        return this.transferLock.run(async () => {
          if (!sessionId) throw new Error("Node operation session is required.");
          const { transfer_id } = request.args as { transfer_id: string };
          await this.sweepExpiredLocked();
          const item = this.transfers.get(transfer_id);
          if (!item || item.principalId !== user || item.sessionId !== sessionId) throw new Error("Transfer is unavailable.");
          return { state: item.state, next_offset: item.offset, transferred_bytes: item.offset };
        });
      case "file_transfer_cancel":
        return this.transferLock.run(async () => {
          if (!sessionId) throw new Error("Node operation session is required.");
          const { transfer_id } = request.args as { transfer_id: string };
          await this.sweepExpiredLocked();
          const item = this.transfer(user, sessionId, transfer_id);
          item.state = "cancelled";
          await this.cleanup(item);
          this.rememberTerminal(item);
          await this.audit(nodeOperationContract(request.operation).auditEvent, { transferId: item.id, sessionId });
          return { cancelled: true };
        });
      case "process_start":
        return this.processLock.run(async () => {
          if (!sessionId) throw new Error("Node operation session is required.");
          const { command, timeout_ms, working_directory } = request.args as {
            command: string;
            timeout_ms: number;
            working_directory: string;
          };
          let workingDirectory: string;
          try {
            if (!path.isAbsolute(working_directory)) throw new Error();
            workingDirectory = await realpath(working_directory);
            if (!(await lstat(workingDirectory)).isDirectory()) throw new Error();
          } catch {
            throw new Error("Working directory must be an existing absolute directory.");
          }

          const execution = this.operationContext.getStore();
          const operationId = execution?.operationId ?? makeId();
          const comment = execution?.comment ?? "";
          let output: string;
          try {
            output = await this.startProcessBackend(command, timeout_ms, user, operationId, workingDirectory);
          } catch {
            await this.audit("process.start_failed", {
              user,
              sessionId,
              command: this.redactCommand(command),
              comment,
              result: "実行を開始できませんでした。",
            });
            throw new Error("Process start failed.");
          }

          const match = output.match(/PID\s+(-?\d+)/i);
          if (!match) {
            await this.audit("process.start_failed", {
              user,
              sessionId,
              command: this.redactCommand(command),
              comment,
              output: this.redactCommand(output),
              outputTruncated: output.length > 4000,
              result: "Process ID unavailable.",
            });
            throw new Error("Desktop Commander did not return a process id.");
          }

          const pid = Number(match[1]);
          try {
            this.requireCurrentOperation();
          } catch (error) {
            if (this.cfg.processAdapter) {
              await this.cfg.processAdapter.terminate(pid, 2_000).catch(() => undefined);
            }
            await this.audit(
              this.cfg.processAdapter ? "process.stop_requested_after_start" : "process.stop_unconfirmed_after_start",
              { user, sessionId, pid },
            );
            throw error;
          }

          const initialCompletion = /Process completed with exit code\s+(?:(-?\d+)|null|undefined)/i.exec(output);
          const item: Process = {
            id: makeId(),
            sessionId,
            user,
            generation: this.dc.currentGeneration(),
            pid,
            state: initialCompletion ? "finished" : "running",
            output,
            cursor: 0,
            exitCode: initialCompletion?.[1] === undefined ? undefined : Number(initialCompletion[1]),
          };
          const priorId = this.currentProcessOwners.get(this.processKey(item));
          if (priorId) {
            const prior = this.processes.get(priorId);
            if (prior) this.markProcessStale(prior);
          }
          this.processes.set(item.id, item);
          if (item.state === "running") this.currentProcessOwners.set(this.processKey(item), item.id);
          try {
            await this.audit(nodeOperationContract(request.operation).auditEvent, {
              user,
              sessionId,
              nodeId: this.cfg.nodeId,
              processId: item.id,
              pid: item.pid,
              command: this.redactCommand(command),
              comment,
              output: this.redactCommand(output),
              outputTruncated: output.length > 4000,
            });
          } finally {
            if (item.state === "running") this.watchProcess(item.id);
          }
          if (item.state === "finished") await this.auditProcessExit(item);
          return { process_id: item.id, output };
        });
      case "process_output":
      case "process_status":
        return this.processLock.run(async () => {
          if (!sessionId) throw new Error("Node operation session is required.");
          const { process_id } = request.args as { process_id: string };
          const item = this.processForOperation(user, sessionId, process_id);
          if (item.state === "finished") {
            return { state: item.state, exit_code: item.exitCode, output: item.output };
          }
          if (item.state === "terminating" && await this.processActiveInDesktopCommander(item)) {
            return {
              state: item.state,
              termination_unconfirmed: item.terminationUnconfirmed || undefined,
              output: item.output,
            };
          }
          const output = await this.observeProcess(item);
          return {
            state: item.state,
            exit_code: item.exitCode,
            termination_unconfirmed: item.terminationUnconfirmed || undefined,
            output,
          };
        });
      case "process_kill":
        return this.processLock.run(async () => {
          if (!sessionId) throw new Error("Node operation session is required.");
          const { process_id } = request.args as { process_id: string };
          const item = this.currentProcessForOperation(user, sessionId, process_id);
          let outcome: "acknowledged" | "rejected" | "timed_out";
          try {
            const output = await this.terminateProcessBackend(item);
            outcome = /Successfully initiated termination of session/i.test(output) ? "acknowledged" : "rejected";
          } catch (error) {
            outcome = typeof error === "object"
              && error !== null
              && "code" in error
              && (error as { code?: unknown }).code === -32001
              ? "timed_out"
              : "rejected";
          }
          if (outcome === "rejected") {
            await this.audit("process.kill_rejected", { processId: item.id });
            this.watchProcess(item.id);
            return { state: item.state, rejected: true };
          }
          item.state = "terminating";
          item.terminationRequested = true;
          if (outcome === "timed_out") {
            item.terminationUnconfirmed = true;
            await this.audit("process.termination_unconfirmed", { processId: item.id });
            this.watchProcess(item.id);
            return { state: item.state, termination_unconfirmed: true };
          }
          await this.audit(nodeOperationContract(request.operation).auditEvent, { processId: item.id });
          this.watchProcess(item.id);
          return { state: item.state };
        });
    }
  }
  node(nodeId?: string): string { if (nodeId && nodeId !== this.cfg.nodeId) throw new Error("Unknown or unsupported node."); return this.cfg.nodeId; }
  private root(id: string): Root { const root = this.cfg.roots.find((item) => item.id === id); if (!root) throw new Error("Unknown file root."); return root; }
  private configPath(): string { return path.join(this.cfg.dataDir, "desktop-commander-home", ".claude-server-commander", "config.json"); }
  private configIdentityManifestPath(): string { return path.join(this.cfg.dataDir, "transfers", "protected-config-identities.json"); }
  private configPinDirectory(): string { return path.join(this.cfg.dataDir, "transfers", "protected-config-pins"); }
  private identityKey(identity: FileIdentity): string { return `${identity.dev}:${identity.ino}`; }
  private identityFromStats(info: { dev: bigint; ino: bigint }): FileIdentity { return { dev: info.dev.toString(), ino: info.ino.toString() }; }
  private async identityForPath(value: string): Promise<FileIdentity> { return this.identityFromStats(await lstat(value, { bigint: true })); }
  private validExactIdentity(value: unknown): value is FileIdentity {
    return !!value && typeof value === "object" && typeof (value as FileIdentity).dev === "string" && typeof (value as FileIdentity).ino === "string" && /^(0|[1-9]\d*)$/.test((value as FileIdentity).dev) && /^(0|[1-9]\d*)$/.test((value as FileIdentity).ino);
  }
  private validLegacyIdentity(value: unknown): value is { dev: number; ino: number } {
    return !!value && typeof value === "object" && Number.isSafeInteger((value as { dev: number }).dev) && Number.isSafeInteger((value as { ino: number }).ino) && (value as { dev: number }).dev >= 0 && (value as { ino: number }).ino >= 0;
  }
  private async loadProtectedConfigIdentities(): Promise<void> {
    const text = await readFile(this.configIdentityManifestPath(), "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? "[]" : Promise.reject(error));
    let records: unknown;
    try { records = JSON.parse(text); } catch { throw new Error("Protected config identity history is invalid."); }
    if (!Array.isArray(records) || records.length > 64 || records.some((value) => !this.validExactIdentity(value) && !this.validLegacyIdentity(value))) throw new Error("Protected config identity history is invalid; inspect or recover local manifest state before restarting.");
    const pinDirectory = path.resolve(this.configPinDirectory());
    let migrated = false;
    for (const record of records as Array<ProtectedConfigIdentity | ({ dev: number; ino: number; pin?: unknown })>) {
      if (typeof record.pin !== "string") throw new Error("Protected config identity history is invalid.");
      const pin = path.resolve(record.pin);
      const validPinName = /^config-(?:\d+-\d+|[A-Za-z0-9_-]{43})\.pin$/.test(path.basename(pin));
      const info = await lstat(pin, { bigint: true }).catch(() => undefined);
      if (!inside(pinDirectory, pin) || !validPinName || !info || info.isSymbolicLink() || !info.isFile()) throw new Error("Protected config identity history is invalid.");
      const actual = this.identityFromStats(info);
      if (this.validExactIdentity(record)) {
        if (actual.dev !== record.dev || actual.ino !== record.ino) throw new Error("Protected config identity history is invalid.");
      } else {
        // A legacy number can be migrated only when it was lossless and still
        // matches the retained private pin. Unsafe records are ambiguous.
        if (!this.validLegacyIdentity(record) || actual.dev !== BigInt(record.dev).toString() || actual.ino !== BigInt(record.ino).toString()) throw new Error("Protected config identity history is invalid.");
        migrated = true;
      }
      this.protectedConfigIdentities.set(this.identityKey(actual), { ...actual, pin });
    }
    if (migrated) await this.persistProtectedConfigIdentities();
  }
  private async persistProtectedConfigIdentities(): Promise<void> {
    const manifest = this.configIdentityManifestPath();
    const pending = `${manifest}.next`;
    const records = [...this.protectedConfigIdentities.values()];
    await writeFile(pending, JSON.stringify(records), { mode: 0o600 });
    for (let attempt = 0; ; attempt += 1) {
      try { await rename(pending, manifest); return; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if ((code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") || attempt >= 19) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, 10 * 2 ** Math.min(attempt, 3))));
      }
    }
  }
  private async rememberProtectedConfigIdentity(allowMissing = false): Promise<void> { await this.configIdentityLock.run(() => this.rememberProtectedConfigIdentityLocked(allowMissing)); }
  private async rememberProtectedConfigIdentityLocked(allowMissing: boolean): Promise<void> {
    const config = this.configPath();
    const same = (left: FileIdentity, right: FileIdentity) => left.dev === right.dev && left.ino === right.ino;
    const deadline = Date.now() + 2_000;
    const maxAttempts = 20;
    const transientLinkFailure = (error: unknown) => {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      return code === "ENOENT" || code === "EPERM" || code === "EACCES" || code === "EBUSY" || code === "EEXIST";
    };
    const waitForConfigurationToSettle = async (attempt: number): Promise<boolean> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || attempt + 1 >= maxAttempts) return false;
      const delay = Math.min(100, 10 * 2 ** Math.min(attempt, 3));
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
      return true;
    };
    const pinDirectory = this.configPinDirectory();
    await mkdir(pinDirectory, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < maxAttempts && Date.now() <= deadline; attempt += 1) {
      // Retire only pins with no link outside private state before checking the
      // cap. Pins that still have an alias remain protected across retries.
      await this.pruneProtectedConfigIdentitiesLocked();
      const pin = path.join(pinDirectory, `config-${makeId()}.pin`);
      try { await this.linkProtectedConfig(config, pin); } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" && allowMissing) return;
        if (transientLinkFailure(error) && await waitForConfigurationToSettle(attempt)) continue;
        throw error;
      }
      const pinInfo = await lstat(pin, { bigint: true }).catch(() => undefined);
      if (!pinInfo || pinInfo.isSymbolicLink() || !pinInfo.isFile()) {
        await unlink(pin).catch(() => undefined);
        throw new Error("Protected config identity pin is invalid.");
      }
      const pinnedIdentity = this.identityFromStats(pinInfo);
      const key = this.identityKey(pinnedIdentity);
      const existing = this.protectedConfigIdentities.get(key);
      if (existing) {
        const existingInfo = await lstat(existing.pin, { bigint: true }).catch(() => undefined);
        if (!existingInfo || existingInfo.isSymbolicLink() || !same(this.identityFromStats(existingInfo), pinnedIdentity)) throw new Error("Protected config identity pin is invalid.");
        await unlink(pin);
      } else {
        if (this.protectedConfigIdentities.size >= 64) { await unlink(pin).catch(() => undefined); throw new Error("Protected config identity history limit reached."); }
        this.protectedConfigIdentities.set(key, { ...pinnedIdentity, pin });
        await this.persistProtectedConfigIdentities();
      }
      const after = await lstat(config, { bigint: true }).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
      if (after && same(this.identityFromStats(after), pinnedIdentity)) return;
      if (!await waitForConfigurationToSettle(attempt)) break;
    }
    throw new Error("Protected config identity changed while pinning.");
  }
  private async pruneProtectedConfigIdentities(): Promise<void> { await this.configIdentityLock.run(() => this.pruneProtectedConfigIdentitiesLocked()); }
  private async pruneProtectedConfigIdentitiesLocked(): Promise<void> {
    let changed = false;
    for (const [key, record] of this.protectedConfigIdentities) {
      const info = await lstat(record.pin, { bigint: true }).catch(() => undefined);
      const actual = info && this.identityFromStats(info);
      if (!info || info.isSymbolicLink() || !info.isFile() || !actual || actual.dev !== record.dev || actual.ino !== record.ino) throw new Error("Protected config identity pin is invalid.");
      if (info.nlink === 1n) {
        await rm(record.pin, { force: true });
        this.protectedConfigIdentities.delete(key);
        changed = true;
      }
    }
    if (changed) await this.persistProtectedConfigIdentities();
  }
  private isProtectedConfigIdentity(info: FileIdentity): boolean { return this.protectedConfigIdentities.has(this.identityKey(info)); }
  private ownershipManifestPath(): string { return path.join(this.cfg.dataDir, "transfers", "owned-uploads.json"); }
  private async writeOwnershipManifest(): Promise<void> {
    const manifest = this.ownershipManifestPath();
    const pending = `${manifest}.next`;
    const records = [...this.ownedUploads.values()];
    await writeFile(pending, JSON.stringify(records), { mode: 0o600 });
    await rename(pending, manifest);
  }
  private async isOwnedArtifactPath(entry: Pick<OwnedUploadArtifact, "rootId" | "path">): Promise<boolean> {
    if (!/^\.__rdmcp_[A-Za-z0-9_-]+\.upload$/.test(path.basename(entry.path))) return false;
    let root: Root;
    try { root = this.root(entry.rootId); } catch { return false; }
    const candidate = path.resolve(entry.path);
    if (!inside(path.resolve(root.path), candidate)) return false;
    try {
      const [actualRoot, actualParent] = await Promise.all([realpath(root.path), realpath(path.dirname(candidate))]);
      return inside(actualRoot, actualParent);
    } catch { return false; }
  }
  private async cleanupOwnedUploadArtifacts(): Promise<void> {
    const manifest = this.ownershipManifestPath();
    const text = await readFile(manifest, "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? "[]" : Promise.reject(error));
    let records: unknown;
    try { records = JSON.parse(text); } catch { throw new Error("Owned upload manifest is invalid."); }
    if (!Array.isArray(records) || records.some((value) => !value || typeof value !== "object" || typeof (value as OwnedUploadArtifact).rootId !== "string" || typeof (value as OwnedUploadArtifact).path !== "string" || (!this.validExactIdentity(value) && !this.validLegacyIdentity(value)))) throw new Error("Owned upload manifest is invalid; inspect or recover local manifest state before restarting.");
    this.ownedUploads.clear();
    for (const entry of records as Array<OwnedUploadArtifact | ({ rootId: string; path: string; dev: number; ino: number })>) {
      if (await this.isOwnedArtifactPath(entry)) {
        const info = await lstat(entry.path, { bigint: true }).catch(() => undefined);
        if (!info) continue;
        const actual = this.identityFromStats(info);
        // Unsafe legacy numbers cannot prove ownership, so preserve the file.
        // A later exact upload manifest is the only authority to delete it.
        const matches = this.validExactIdentity(entry)
          ? actual.dev === entry.dev && actual.ino === entry.ino
          : this.validLegacyIdentity(entry) && actual.dev === BigInt(entry.dev).toString() && actual.ino === BigInt(entry.ino).toString();
        if (matches) await rm(entry.path, { force: true }).catch(() => undefined);
      }
    }
    await this.writeOwnershipManifest();
  }
  private async trackOwnedUpload(rootId: string, uploadPath: string, identity: FileIdentity): Promise<void> {
    this.ownedUploads.set(uploadPath, { rootId, path: uploadPath, ...identity });
    await this.writeOwnershipManifest();
  }
  private async untrackOwnedUpload(uploadPath?: string): Promise<void> {
    if (!uploadPath || !this.ownedUploads.delete(uploadPath)) return;
    await this.writeOwnershipManifest();
  }
  private async guardSearchRoot(root: Root): Promise<void> {
    await this.rememberProtectedConfigIdentity();
    const visit = async (folder: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const candidate = path.join(folder, entry.name);
        if (entry.isSymbolicLink()) throw new Error("Search root contains a symbolic link.");
        if (/^\.__rdmcp_[A-Za-z0-9_-]+\.(upload|probe)$/.test(entry.name)) throw new Error("Protected transfer files cannot be searched.");
        if (this.isProtectedConfigIdentity(await this.identityForPath(candidate))) throw new Error("Protected service files cannot be searched.");
        if (entry.isDirectory()) await visit(candidate);
      }
    };
    await visit(root.path);
  }
  private async safePath(rootId: string, relative: string, absent = false): Promise<string> {
    this.requireCurrentOperation();
    const root = this.root(rootId);
    if (!relative || path.isAbsolute(relative) || relative.includes("\0")) throw new Error("A relative path is required.");
    const candidate = path.resolve(root.path, relative);
    if (!inside(root.path, candidate)) throw new Error("Path is outside the allowed root.");
    if (/^\.__rdmcp_[A-Za-z0-9_-]+\.(upload|probe)$/.test(path.basename(candidate))) throw new Error("Protected transfer files cannot be accessed.");
    const actualRoot = await realpath(root.path);
    const resolved = absent ? await realpath(path.dirname(candidate)) : await realpath(candidate);
    if (!inside(actualRoot, resolved)) throw new Error("Path resolves outside the allowed root.");
    if (!absent) {
      await this.rememberProtectedConfigIdentity();
      try {
        if (this.isProtectedConfigIdentity(await this.identityForPath(candidate))) throw new Error("Protected service files cannot be accessed.");
      } catch (error) { if (error instanceof Error && error.message.startsWith("Protected")) throw error; }
    }
    if (overlaps(candidate, this.cfg.dataDir)) throw new Error("Protected service files cannot be accessed.");
    return candidate;
  }
  private transfer(user: string, sessionId: string, transferId: string): Transfer { const item = this.transfers.get(transferId); if (!item || item.principalId !== user || item.sessionId !== sessionId || item.state !== "active") throw new Error("Transfer is unavailable."); item.touched = Date.now(); return item; }
  private downloadTransfer(user: string, sessionId: string, transferId: string): Transfer {
    const item = this.transfers.get(transferId);
    if (!item || item.principalId !== user || item.sessionId !== sessionId || item.direction !== "download" || (item.state !== "active" && item.state !== "complete")) {
      throw new Error("Transfer is unavailable.");
    }
    item.touched = Date.now();
    return item;
  }
  private rememberTerminal(item: Transfer): void { this.terminalTransfers.push(item.id); while (this.terminalTransfers.length > MAX_TERMINAL_TRANSFERS) { const old = this.terminalTransfers.shift(); if (old) this.transfers.delete(old); } }
  private async completeDownload(item: Transfer): Promise<void> {
    if (item.direction !== "download" || item.offset !== item.size) throw new Error("Download is incomplete.");
    item.state = "complete";
    await this.cleanup(item);
    this.rememberTerminal(item);
    await this.audit("transfer.complete", { transferId: item.id, direction: item.direction, sessionId: item.sessionId, size: item.size, sha256: item.sha256 });
  }
  private async completeUpload(item: Transfer): Promise<{ resolved_path: string; root_id: string; path_base: "root"; size: number; sha256: string }> {
    if (item.direction !== "upload" || !item.temp || !item.tempHandle || !item.tempIdentity || item.offset !== item.size) throw new Error("Upload is incomplete.");
    const pathInfo = await this.identityForPath(item.temp).catch(() => undefined);
    if (!pathInfo || pathInfo.dev !== item.tempIdentity.dev || pathInfo.ino !== item.tempIdentity.ino) { await this.fail(item, "temp_path_replaced"); throw new Error("Upload temporary file identity changed."); }
    await item.tempHandle.sync();
    await item.tempHandle.close();
    item.tempHandle = undefined;
    const bytes = await readFile(item.temp);
    if (bytes.length !== item.size || createHash("sha256").update(bytes).digest("hex") !== item.sha256) { await this.fail(item, "upload_hash_mismatch"); throw new Error("Upload integrity check failed."); }
    item.committedPreview = this.previewBytes(bytes.subarray(0, Math.min(bytes.length, 4096)), bytes.length > 4096);
    await this.safePath(item.rootId, path.relative(this.root(item.rootId).path, item.target), true);
    this.requireCurrentOperation();
    try {
      if (item.overwrite) await rename(item.temp, item.target);
      else { await this.linkNoReplace(item.temp, item.target); await unlink(item.temp); }
    } catch {
      await this.fail(item, "destination_conflict");
      throw new Error("Destination exists or atomic no-replace commit is unavailable.");
    }
    await this.untrackOwnedUpload(item.temp);
    item.state = "complete";
    this.rememberTerminal(item);
    await this.audit("transfer.complete", { transferId: item.id, direction: item.direction, sessionId: item.sessionId, size: item.size, sha256: item.sha256 });
    return { resolved_path: await realpath(item.target), root_id: item.rootId, path_base: "root", size: item.size, sha256: item.sha256 };
  }
  private async cleanup(item: Transfer): Promise<void> {
    await item.tempHandle?.close().catch(() => undefined); item.tempHandle = undefined;
    if (item.snapshot) await rm(item.snapshot, { force: true }).catch(() => undefined);
    if (item.temp && item.tempIdentity) {
      const info = await this.identityForPath(item.temp).catch(() => undefined);
      if (info && info.dev === item.tempIdentity.dev && info.ino === item.tempIdentity.ino) await rm(item.temp, { force: true }).catch(() => undefined);
    }
    await this.untrackOwnedUpload(item.temp);
  }
  private async fail(item: Transfer, reason: string): Promise<void> { item.state = reason === "expired" || reason === "session_expired" ? "expired" : "failed"; await this.cleanup(item); this.rememberTerminal(item); await this.audit("transfer.failed", { transferId: item.id, direction: item.direction, reason }); }
  private async privateSnapshot(source: string, destination: string) { await copyFile(source, destination); await protectPrivateFile(destination); const bytes = await readFile(destination); return { size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") }; }
  private async verifyNoReplaceCapability(directory: string): Promise<void> {
    const token = makeId();
    const probe = path.join(directory, `.__rdmcp_${token}.probe`);
    const linked = path.join(directory, `.__rdmcp_${token}-link.probe`);
    try {
      await writeFile(probe, "", { flag: "wx", mode: 0o600 });
      await this.linkNoReplace(probe, linked);
    } catch {
      throw new Error("Atomic no-replace commit is unavailable for this destination.");
    } finally {
      await rm(linked, { force: true }).catch(() => undefined);
      await rm(probe, { force: true }).catch(() => undefined);
    }
  }
  private async search(root: Root, pattern: string, searchType: "files" | "content"): Promise<string> {
    this.requireCurrentOperation();
    await this.guardSearchRoot(root);
    this.requireCurrentOperation();
    const started = await this.dc.call("start_search", { path: root.path, pattern, searchType, maxResults: 500, timeout_ms: 5_000, literalSearch: true });
    const session = started.match(/session:\s*([^\s]+)/i)?.[1];
    if (!session) throw new Error("Desktop Commander did not return a search session.");
    const pages = [started];
    const deadline = Date.now() + 5_500;
    let offset = 0;
    let page = 0;
    let incomplete = false;
    try {
      while (page < 5 && Date.now() < deadline) {
        this.requireCurrentOperation();
        const output = await this.dc.call("get_more_search_results", { sessionId: session, offset, length: 100 });
        pages.push(output);
        const complete = /Status:\s*COMPLETED/i.test(output);
        const next = Number(/offset:\s*(\d+)/i.exec(output)?.[1] ?? "");
        const shown = /Showing results (\d+)-(\d+)/i.exec(output);
        let advanced = false;
        // Desktop Commander 0.2.51 renders the actual inclusive range from the
        // result slice.  During a streaming search that range is the stable
        // continuation boundary; prefer it to a pagination hint emitted while
        // the result list is still growing.
        if (shown && Number(shown[2]) >= offset) {
          offset = Number(shown[2]) + 1;
          page += 1;
          advanced = true;
        } else if (next > offset) {
          offset = next;
          page += 1;
          advanced = true;
        }
        if (complete && !advanced) break;
        if (page >= 5) { incomplete = true; break; }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      if (Date.now() >= deadline) incomplete = true;
      if (incomplete) pages.push("Search result collection reached the local service limit; results may be incomplete.");
      return pages.join("\n");
    } finally { await this.dc.call("stop_search", { sessionId: session }, undefined, { allowStoppedOperation: true }).catch(() => undefined); }
  }
  private redactAuditText(value: string): { value: string; truncated: boolean } {
    const secrets = [this.cfg.tokenSecret, this.cfg.publicAuth?.googleClientSecret ?? "", ...this.cfg.users.map((configured) => configured.passwordHash)].filter(Boolean);
    const redacted = secrets.reduce((current, secret) => current.split(secret).join("[redacted]"), value)
      .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/((?:--)?(?:token|password|secret|credential|api[_-]?key|authorization)\s*(?:=|:|\s)\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1[redacted]");
    return { value: redacted.slice(0, 4000), truncated: value.length > 4000 || redacted.length > 4000 };
  }

  private operationDetailEntry(label: string, value: unknown, format: "text" | "diff" = "text", truncated = false): OperationDetailEntry {
    const protectedValue = this.redactAuditText(String(value ?? ""));
    return { label, value: protectedValue.value, format, ...(truncated || protectedValue.truncated ? { truncated: true } : {}) };
  }

  private previewBytes(bytes: Buffer, truncated = false): OperationDetailEntry {
    let textBytes = bytes;
    if (truncated && bytes.length > 0) {
      let sequenceStart = bytes.length - 1;
      while (sequenceStart >= 0 && (bytes[sequenceStart]! & 0xc0) === 0x80) sequenceStart -= 1;
      if (sequenceStart >= 0) {
        const lead = bytes[sequenceStart]!;
        const expectedLength = lead <= 0x7f ? 1
          : lead >= 0xc2 && lead <= 0xdf ? 2
          : lead >= 0xe0 && lead <= 0xef ? 3
          : lead >= 0xf0 && lead <= 0xf4 ? 4
          : 0;
        const availableLength = bytes.length - sequenceStart;
        if (expectedLength > availableLength && expectedLength > 1) textBytes = bytes.subarray(0, sequenceStart);
      }
    }
    const text = textBytes.toString("utf8");
    const hasControlCharacters = [...text].some((character) => { const code = character.charCodeAt(0); return code === 127 || code < 32 && ![9, 10, 13].includes(code); });
    const validText = Buffer.from(text, "utf8").equals(textBytes) && !hasControlCharacters;
    if (validText) return this.operationDetailEntry("内容見本", text, "text", truncated || textBytes.length < bytes.length);
    const sample = bytes.subarray(0, 64).toString("hex").replace(/(..)(?=.)/g, "$1 ");
    return this.operationDetailEntry("内容見本", `hex: ${sample}`, "text", truncated || bytes.length > 64);
  }

  private async previewFile(filePath: string, size?: number): Promise<OperationDetailEntry | undefined> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(filePath, "r");
      const limit = Math.min(size ?? 4096, 4096);
      const bytes = Buffer.alloc(limit);
      const read = limit ? await handle.read(bytes, 0, limit, 0) : { bytesRead: 0 };
      return this.previewBytes(bytes.subarray(0, read.bytesRead), typeof size === "number" && size > read.bytesRead);
    } catch {
      return undefined;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private transferTarget(item: Transfer | undefined): string | undefined {
    if (!item) return undefined;
    const root = this.cfg.roots.find((candidate) => candidate.id === item.rootId);
    if (!root) return undefined;
    const relative = path.relative(root.path, item.target).replaceAll(path.sep, "/");
    return `${item.rootId}/${relative}`;
  }

  private rejectedArgumentProjection(tool: string, raw: Record<string, unknown>): Record<string, unknown> {
    const projected: Record<string, unknown> = {};
    const text = (name: string, limit: number) => {
      const value = raw[name];
      if (typeof value === "string") projected[name] = value.slice(0, limit);
    };
    const number = (name: string) => { if (typeof raw[name] === "number") projected[name] = raw[name]; };
    const boolean = (name: string) => { if (typeof raw[name] === "boolean") projected[name] = raw[name]; };
    const session = () => { text("session_id", 128); text("node_id", 128); };
    const file = () => { session(); text("root_id", 500); text("relative_path", 500); };
    const transfer = () => { session(); text("transfer_id", 128); };

    text("comment", 500);
    switch (tool) {
      case "session_open": text("working_directory", 4096); text("purpose", 200); break;
      case "session_close": case "node_list": session(); break;
      case "file_search": case "content_search": session(); text("root_id", 500); text("query", 120); break;
      case "file_read": file(); number("offset"); number("length"); break;
      case "file_patch": file(); text("old_string", 4000); text("new_string", 4000); number("expected_replacements"); break;
      case "file_transfer_download_begin": file(); break;
      case "file_transfer_download_chunk": transfer(); number("offset"); break;
      case "file_transfer_upload_begin": file(); number("size"); text("sha256", 64); boolean("overwrite"); break;
      case "file_transfer_upload_chunk": transfer(); number("offset"); text("data", 4096); break;
      case "file_transfer_upload_commit": case "file_transfer_status": case "file_transfer_cancel": transfer(); break;
      case "process_start": session(); text("command", 4000); number("timeout_ms"); break;
      case "process_output": case "process_status": case "process_kill": session(); text("process_id", 128); break;
    }
    return projected;
  }

  private async operationDetail(tool: string, args: Record<string, unknown>, body?: unknown, error?: string): Promise<OperationDetail | undefined> {
    const output = isRecord(body) ? body : {};
    const entry = (label: string, value: unknown, format: "text" | "diff" = "text") => this.operationDetailEntry(label, value, format);
    const rootId = typeof args.root_id === "string" ? args.root_id : undefined;
    const relativePath = typeof args.relative_path === "string" ? args.relative_path : undefined;
    const directTarget = rootId && relativePath ? `${rootId}/${relativePath.replaceAll("\\", "/")}` : undefined;
    const transferId = typeof args.transfer_id === "string" ? args.transfer_id : typeof output.transfer_id === "string" ? output.transfer_id : undefined;
    const transfer = transferId ? this.transfers.get(transferId) : undefined;
    const target = directTarget ?? this.transferTarget(transfer);
    const finish = (summary: string, entries: OperationDetailEntry[]) => {
      if (error) entries.push(entry("エラー", error));
      return { version: 1 as const, summary, entries };
    };
    const transferEntries = (): OperationDetailEntry[] => {
      const entries: OperationDetailEntry[] = [];
      if (target) entries.push(entry("対象", target));
      if (transfer?.direction) entries.push(entry("方向", transfer.direction));
      if (transferId) entries.push(entry("転送 ID", transferId));
      if (transfer) {
        entries.push(entry("サイズ", transfer.size));
        entries.push(entry("ハッシュ", transfer.sha256));
      }
      return entries;
    };

    if (tool === "file_search" || tool === "content_search") {
      const entries = [entry("検索条件", `root_id=${rootId ?? "—"}\nquery=${String(args.query ?? "—")}`)];
      if (typeof output.output === "string") entries.push(entry("検索結果", output.output));
      return finish(tool === "file_search" ? "ファイル検索" : "内容検索", entries);
    }
    if (tool === "file_read") {
      const entries = [
        entry("対象", directTarget ?? "—"),
        entry("読取範囲", `offset=${args.offset ?? "省略"} length=${args.length ?? "省略"}`),
      ];
      if (typeof output.output === "string") entries.push(entry("本文", output.output));
      return finish("ファイル読取", entries);
    }
    if (tool === "file_patch") {
      const oldText = String(args.old_string ?? "");
      const newText = String(args.new_string ?? "");
      const removed = oldText.split("\n").map((line) => `-${line}`).join("\n");
      const added = newText.split("\n").map((line) => `+${line}`).join("\n");
      const entries = [
        entry("対象", directTarget ?? "—"),
        entry("期待置換数", args.expected_replacements ?? 1),
        entry("差分", `--- before\n+++ after\n${removed}\n${added}`, "diff"),
      ];
      if (typeof output.output === "string") entries.push(entry("結果", output.output));
      return finish("ファイル部分変更", entries);
    }
    if (tool === "file_transfer_download_begin" || tool === "file_transfer_upload_begin") {
      const entries = transferEntries();
      if (!entries.some((candidate) => candidate.label === "対象") && directTarget) entries.unshift(entry("対象", directTarget));
      const direction = tool.includes("_download_") ? "download" : "upload";
      if (!entries.some((candidate) => candidate.label === "方向")) entries.push(entry("方向", direction));
      if (!entries.some((candidate) => candidate.label === "サイズ") && args.size !== undefined) entries.push(entry("サイズ", args.size));
      if (!entries.some((candidate) => candidate.label === "ハッシュ") && args.sha256 !== undefined) entries.push(entry("ハッシュ", args.sha256));
      if (tool === "file_transfer_download_begin" && transfer?.snapshot) {
        const preview = await this.previewFile(transfer.snapshot, transfer.size);
        if (preview) entries.push(preview);
      }
      return finish(direction === "download" ? "ダウンロード開始" : "アップロード開始", entries);
    }
    if (tool === "file_transfer_download_chunk" || tool === "file_transfer_upload_chunk") {
      const entries = transferEntries();
      const offset = typeof args.offset === "number" ? args.offset : undefined;
      const nextOffset = typeof output.next_offset === "number" ? output.next_offset : transfer?.offset;
      if (offset !== undefined || nextOffset !== undefined) entries.push(entry("位置", `offset=${offset ?? "—"} next_offset=${nextOffset ?? "—"}`));
      if (offset !== undefined && typeof nextOffset === "number") entries.push(entry("処理バイト数", Math.max(0, nextOffset - offset)));
      if (output.complete !== undefined) entries.push(entry("完了", output.complete));
      const encoded = tool === "file_transfer_download_chunk" ? output.data : args.data;
      if (typeof encoded === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded) && encoded.length % 4 === 0) {
        const bytes = Buffer.from(encoded, "base64");
        if (bytes.length) entries.push(this.previewBytes(bytes));
      }
      return finish(tool === "file_transfer_download_chunk" ? "ダウンロードデータ" : "アップロードデータ", entries);
    }
    if (tool === "file_transfer_upload_commit") {
      const entries = transferEntries();
      if (transfer?.committedPreview && typeof output.resolved_path === "string") entries.push(transfer.committedPreview);
      return finish("アップロード確定", entries);
    }
    if (tool === "file_transfer_status" || tool === "file_transfer_cancel") {
      const entries = transferEntries();
      if (output.state !== undefined) entries.push(entry("状態", output.state));
      else if (transfer?.state) entries.push(entry("状態", transfer.state));
      if (output.next_offset !== undefined) entries.push(entry("位置", output.next_offset));
      else if (transfer?.offset !== undefined) entries.push(entry("位置", transfer.offset));
      return finish(tool === "file_transfer_status" ? "転送状態" : "転送取消し", entries);
    }
    return undefined;
  }

  private tool<T extends Record<string, z.ZodTypeAny>>(user: string, fn: (args: z.infer<z.ZodObject<T>>, operationId: string) => Promise<unknown>) {
    let toolName = "unknown";
    const handler = async (args: z.infer<z.ZodObject<T>>) => {
    const operationId = makeId();
    const receivedAt = new Date().toISOString();
    const record = args as Record<string, unknown>;
    const comment = typeof record.comment === "string" ? record.comment.trim() : "";
    const connectionId = typeof record.session_id === "string" && this.userOwnsActiveSession(user, record.session_id) ? record.session_id : `request:${operationId}`;
    const entryState = this.userExecutionState(user);
    const target = typeof record.relative_path === "string" ? record.relative_path.slice(0, 500)
      : typeof record.process_id === "string" ? `process:${record.process_id.slice(0, 128)}`
      : typeof record.transfer_id === "string" ? `transfer:${record.transfer_id.slice(0, 128)}`
      : typeof record.command === "string" ? "command execution"
      : "—";
    let started = false;
    const entryGeneration = entryState.stopGeneration;
    const executionOperation: ExecutionOperation = { user, operationId, stopGeneration: entryGeneration, comment };
    const sessionAccess = () => executionOperation.sessionAccessAt ? { sessionAccessAt: executionOperation.sessionAccessAt } : {};
    try {
      await this.audit("operation.received", { user, operationId, tool: toolName, connectionId, sessionId: connectionId, target, comment, receivedAt });
      if (entryState.stopped) throw new UserStopRequested(entryState);
      started = true;
      const startAt = new Date().toISOString();
      await this.audit("operation.started", { user, operationId, tool: toolName, connectionId, sessionId: connectionId, target, comment, startAt });
      const body = await this.operationContext.run(executionOperation, () => { this.requireCurrentOperation(); return fn(args, operationId); });
      const detail = await this.operationDetail(toolName, record, body).catch(() => undefined);
      // A stop can arrive while an unavoidable in-flight I/O operation is
      // completing. Do not present that operation as permission to continue.
      this.requireCurrentOperation();
      const openedConnection = isRecord(body) && typeof body.connection_id === "string" ? body.connection_id : isRecord(body) && typeof body.session_id === "string" ? body.session_id : undefined;
      const terminalConnection = openedConnection ?? connectionId;
      await this.audit("operation.succeeded", { user, operationId, tool: toolName, connectionId: terminalConnection, sessionId: terminalConnection, target, comment, endedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(receivedAt), status: "succeeded", ...(detail ? { detail } : {}), ...sessionAccess() });
      return result(body);
    } catch (error) {
      if (error instanceof UserStopRequested) {
        const status = started ? "cancelled" : "rejected";
        const detail = await this.operationDetail(toolName, record, undefined, "USER_STOP_REQUESTED").catch(() => undefined);
        await this.audit(`operation.${status}`, { user, operationId, tool: toolName, connectionId, sessionId: connectionId, target, comment, endedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(receivedAt), status, reason: "USER_STOP_REQUESTED", stopId: error.state.stopId, stopGeneration: error.state.stopGeneration, ...(detail ? { detail } : {}), ...sessionAccess() }).catch(() => undefined);
        return stoppedFailure(error.state);
      }
      const message = error instanceof Error ? error.message : "Operation failed.";
      const reason = message.startsWith("Protected service") ? "protected_config_identity" : message.startsWith("Desktop Commander allowedDirectories") ? "allowed_root" : message.startsWith("Desktop Commander") ? "desktop_commander" : "error";
      const publicMessage = /^(Session|Unknown|Transfer|Chunk|Only|Path|Protected|Upload|Destination|Desktop Commander|Process|Transfer limit|A relative|Snapshot|Working directory|node_id|Selected node|Remote node)/.test(message) ? message : "Operation failed.";
      const detail = await this.operationDetail(toolName, record, undefined, publicMessage).catch(() => undefined);
      await this.audit(started ? "operation.failed" : "operation.rejected", { user, operationId, tool: toolName, connectionId, sessionId: connectionId, target, comment, endedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(receivedAt), status: started ? "failed" : "rejected", reason, ...(detail ? { detail } : {}), ...sessionAccess() });
      return failure(publicMessage);
    }
    };
    Object.defineProperty(handler, "rdmcpSetToolName", { value: (name: string) => { toolName = name; } });
    return handler;
  }
  server(user: string): McpServer {
    const server = new McpServer({ name: "remote-desktop-mcp", version: "0.1.0" }, {
      instructions: "All tools require an authenticated caller and a brief comment explaining what the call is intended to accomplish. Open a session with session_open and pass its session_id to file, transfer, and process operations that require it; session IDs belong to the authenticated caller, and operations are rejected while that caller's Emergency Stop is active. File and transfer tools use root_id as their path base: every relative_path is relative to that configured root, never to the session working_directory. node_list returns each root's absolute path. Search tools use root_id and query. process_start instead runs commands in the session working_directory. Prefer the dedicated root-scoped file tools for file operations. process_start runs commands needed for the current user-authorized task with the MCP server OS user's existing permissions.",
    });
    type RequestHandler = (...args: unknown[]) => unknown;
    const underlying = server.server as unknown as { setRequestHandler: (schema: unknown, handler: RequestHandler) => unknown };
    const setRequestHandler = underlying.setRequestHandler.bind(underlying);
    underlying.setRequestHandler = (schema, handler) => setRequestHandler(schema, schema === ListToolsRequestSchema ? async (...args: unknown[]) => {
      const listed = await handler(...args) as { tools?: Array<Record<string, unknown>> };
      if (!Array.isArray(listed.tools)) return listed;
      return { ...listed, tools: listed.tools.map((tool) => ({ ...tool, securitySchemes: [{ type: "oauth2", scopes: ["mcp"] }] })) };
    } : async (...args: unknown[]) => {
      const receivedAt = new Date().toISOString();
      const response = await handler(...args);
      const request = isRecord(args[0]) ? args[0] : {};
      const params = isRecord(request.params) ? request.params : {};
      const rawRecord = isRecord(params.arguments) ? params.arguments : {};
      const errorText = isRecord(response) && response.isError === true && Array.isArray(response.content)
        ? response.content.map((item) => isRecord(item) && item.type === "text" && typeof item.text === "string" ? item.text : undefined)
          .find((value) => value?.includes("Input validation error:"))
        : undefined;
      if (!errorText) return response;
      const operationId = makeId();
      const toolName = typeof params.name === "string" ? params.name : "unknown";
      const record = this.rejectedArgumentProjection(toolName, rawRecord);
      const comment = typeof record.comment === "string" ? record.comment.trim() : "";
      const connectionId = typeof record.session_id === "string" && this.userOwnsActiveSession(user, record.session_id) ? record.session_id : `request:${operationId}`;
      const target = typeof record.relative_path === "string" ? record.relative_path.slice(0, 500)
        : typeof record.process_id === "string" ? `process:${record.process_id.slice(0, 128)}`
        : typeof record.transfer_id === "string" ? `transfer:${record.transfer_id.slice(0, 128)}`
        : typeof record.command === "string" ? "command execution"
        : "—";
      const detail = await this.operationDetail(toolName, record, undefined, errorText).catch(() => undefined);
      await this.audit("operation.received", { user, operationId, tool: toolName, connectionId, sessionId: connectionId, target, comment, receivedAt }).catch(() => undefined);
      await this.audit("operation.rejected", { user, operationId, tool: toolName, connectionId, sessionId: connectionId, target, comment, endedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(receivedAt), status: "rejected", reason: "input_validation", ...(detail ? { detail } : {}) }).catch(() => undefined);
      return response;
    });
    const intercept = server as unknown as { registerTool: (name: string, config: { description?: string; inputSchema?: Record<string, z.ZodTypeAny>; _meta?: Record<string, unknown> }, handler: unknown) => unknown };
    const originalRegisterTool = intercept.registerTool.bind(server);
    intercept.registerTool = (name, config, handler) => {
      const tagged = handler as { rdmcpSetToolName?: (tool: string) => void };
      tagged.rdmcpSetToolName?.(name);
      return originalRegisterTool(name, { ...config, description: `${config.description ?? ""} A non-empty comment explaining what this call is intended to accomplish is required and is recorded with the operation.`, inputSchema: { ...config.inputSchema, comment: z.string().trim().min(1).max(500).describe("Briefly explain what this call is intended to accomplish.") }, _meta: { ...config._meta, securitySchemes: [{ type: "oauth2", scopes: ["mcp"] }], "openai/securitySchemes": [{ type: "oauth2", scopes: ["mcp"] }] } }, handler);
    };
    const sessionId = z.string().min(16); const nodeId = z.string().optional(); const transferId = z.string().min(16);
    server.registerTool("session_open", { description: "Open a 24-hour idle-expiring operation session for the authenticated caller. Select node_id when multiple operation targets are configured, and set that node's required absolute working_directory plus a brief purpose. The session remains bound to that node for its lifetime. Commands started with process_start run in working_directory. File and transfer tools do not use this directory: their relative_path values are relative to root_id. Pass the returned session_id to file, transfer, and process operations that require it; it can be reused across HTTP connections by the same caller. Opening is rejected while the caller's Emergency Stop is active.", inputSchema: { node_id: nodeId, working_directory: z.string().trim().min(1).max(4096), purpose: z.string().trim().min(1).max(200) } }, this.tool(user, async ({ node_id, working_directory, purpose }) => {
      await this.sweepExpired();
      this.requireCurrentOperation();
      const target = this.sessionTarget(node_id);
      const workingDirectory = await this.validateSessionWorkingDirectory(user, target, working_directory);
      this.requireCurrentOperation();
      const now = Date.now();
      const session: Session = { id: makeId(), user, nodeId: target.node_id, workingDirectory, purpose: purpose.trim(), created: now, touched: now, expires: now + SESSION_TTL, state: "active" };
      this.sessions.set(session.id, session);
      await this.audit("session.open", { user, sessionId: session.id, connectionId: session.id, nodeId: session.nodeId, workingDirectory, purpose: session.purpose, stopGeneration: this.userExecutionState(user).stopGeneration });
      return { session_id: session.id, connection_id: session.id, node_id: session.nodeId, working_directory: session.workingDirectory, purpose: session.purpose, idle_ttl_seconds: SESSION_TTL / 1000, expires_at: new Date(session.expires).toISOString(), state: session.state };
    }));
    server.registerTool("session_list", { description: "List the caller's active sessions with their selected node, working directory, and purpose.", inputSchema: {} }, this.tool(user, async () => { await this.sweepExpired(); return { sessions: [...this.sessions.values()].filter((entry) => entry.user === user && entry.state === "active").map((entry) => ({ session_id: entry.id, node_id: entry.nodeId, working_directory: entry.workingDirectory, purpose: entry.purpose, created_at: new Date(entry.created).toISOString(), last_used_at: new Date(entry.touched).toISOString(), expires_at: new Date(entry.expires).toISOString(), state: entry.state })) }; }));
    server.registerTool("session_close", { description: "Close a local operation session.", inputSchema: { session_id: sessionId } }, this.tool(user, async ({ session_id }) => this.transferLock.run(async () => { await this.sweepExpiredLocked(); const session = this.session(user, session_id); session.state = "closed"; for (const item of this.transfers.values()) if (item.sessionId === session_id && item.state === "active") { item.state = "cancelled"; await this.cleanup(item); this.rememberTerminal(item); } await this.audit("session.close", { user, sessionId: session_id }); return { closed: true }; })));
    server.registerTool("node_list", { description: "List registered operation nodes, including disconnected remote nodes. It is available before session_open. An optional session_id is validated for compatibility but does not filter the node list. roots contains each root_id and its canonical absolute_path; root_ids is retained for compatibility. File and transfer relative_path values are relative to the returned root, while process_start uses the selected session working_directory.", inputSchema: { session_id: sessionId.optional() } }, this.tool(user, async ({ session_id }) => { if (session_id) this.session(user, session_id); return { nodes: this.nodeEntries() }; }));
    server.registerTool("file_search", { description: "Search file names through Desktop Commander within the configured directory identified by root_id. Requires the caller's active session_id; query is 1–120 characters. This searches names only and does not search file contents. root_id identifies the path base, not the session working_directory.", inputSchema: { session_id: sessionId, node_id: nodeId, root_id: z.string(), query: z.string().min(1).max(120) } }, this.tool(user, async ({ session_id, node_id, root_id, query }) => {
      await this.sweepExpired();
      const { session, target } = this.operationTarget(user, session_id, node_id);
      return this.dispatchNodeOperation(user, session, target, "file_search", { root_id, query });
    }));
    server.registerTool("content_search", { description: "Search file contents through Desktop Commander within the configured directory identified by root_id. Requires the caller's active session_id; query is 1–120 characters. This searches contents and does not search file names. root_id identifies the path base, not the session working_directory.", inputSchema: { session_id: sessionId, node_id: nodeId, root_id: z.string(), query: z.string().min(1).max(120) } }, this.tool(user, async ({ session_id, node_id, root_id, query }) => {
      await this.sweepExpired();
      const { session, target } = this.operationTarget(user, session_id, node_id);
      return this.dispatchNodeOperation(user, session, target, "content_search", { root_id, query });
    }));
    const fileInput = { session_id: sessionId, node_id: nodeId, root_id: z.string(), relative_path: z.string().min(1).max(500).describe("Path relative to root_id, never the session working_directory.") };
    server.registerTool("file_read", { description: "Read text from a configured file root using root_id and a root-relative relative_path. Requires the caller's active session_id and permits path checks to reject protected service files and escapes from that root. Optional offset is nonnegative; length is 1–1000.", inputSchema: { ...fileInput, offset: z.number().int().nonnegative().optional(), length: z.number().int().positive().max(1000).optional() } }, this.tool(user, async ({ session_id, node_id, root_id, relative_path, offset, length }) => {
      const { session, target } = this.operationTarget(user, session_id, node_id);
      return this.dispatchNodeOperation(user, session, target, "file_read", {
        root_id,
        relative_path,
        ...(offset === undefined ? {} : { offset }),
        ...(length === undefined ? {} : { length }),
      });
    }));
    server.registerTool("file_patch", { description: "Replace matching text in a configured file root using root_id and a root-relative relative_path. Requires the caller's active session_id; old_string must match and expected_replacements (1–100, default 1) controls the expected match count. This is a text replacement, not a general file upload.", inputSchema: { ...fileInput, old_string: z.string().min(1).max(1_000_000), new_string: z.string().max(1_000_000), expected_replacements: z.number().int().positive().max(100).default(1) } }, this.tool(user, async ({ session_id, node_id, root_id, relative_path, old_string, new_string, expected_replacements }) => {
      const { session, target } = this.operationTarget(user, session_id, node_id);
      return this.dispatchNodeOperation(user, session, target, "file_patch", {
        root_id,
        relative_path,
        old_string,
        new_string,
        expected_replacements,
      });
    }));
    server.registerTool("file_transfer_download_begin", { description: "Begin a download of a regular file up to 25 MiB from root_id/relative_path in a configured file root. relative_path is relative to root_id, not the session working_directory. Requires the caller active session_id and selected node_id. Creates a private snapshot copy and returns source path, root_id, size, and SHA-256. Set inline=true to return and complete the whole file in this call when it fits within one chunk; larger files remain active for file_transfer_download_chunk.", inputSchema: { ...fileInput, inline: z.boolean().optional() } }, this.tool(user, async ({ session_id, node_id, root_id, relative_path, inline }) => {
      const { session, target } = this.operationTarget(user, session_id, node_id);
      if (target.node_id !== this.cfg.nodeId) throw new Error("Remote download public transfer mapping is not implemented yet.");
      return this.dispatchNodeOperation(user, session, target, "file_transfer_download_begin", { root_id, relative_path, ...(inline === undefined ? {} : { inline }) });
    }));
    server.registerTool("file_transfer_download_chunk", { description: "Read the next chunk from the snapshot copy. A retry of the most recently returned offset replays the same chunk without advancing transfer state. The completed download is checked against its SHA-256.", inputSchema: { session_id: sessionId, transfer_id: transferId, offset: z.number().int().nonnegative() } }, this.tool(user, async ({ session_id, transfer_id, offset }) => {
      this.session(user, session_id);
      return this.executeLocalNodeOperation(user, session_id, "file_transfer_download_chunk", { transfer_id, offset });
    }));
    server.registerTool("file_transfer_upload_begin", { description: "Begin an upload to root_id/relative_path in a configured file root. relative_path is relative to root_id, not the session working_directory. Requires the caller active session_id and selected node_id. Declare total size, SHA-256, and overwrite policy. For files that fit within one chunk, pass base64 data to verify and atomically commit them in a single call; omit data for the existing chunked flow.", inputSchema: { ...fileInput, size: z.number().int().nonnegative().max(MAX_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/), overwrite: z.boolean(), data: z.string().max(700_000).optional() } }, this.tool(user, async ({ session_id, node_id, root_id, relative_path, size, sha256, overwrite, data }) => {
      const { session, target } = this.operationTarget(user, session_id, node_id);
      if (target.node_id !== this.cfg.nodeId) throw new Error("Remote upload public transfer mapping is not implemented yet.");
      return this.dispatchNodeOperation(user, session, target, "file_transfer_upload_begin", {
        root_id,
        relative_path,
        size,
        sha256,
        overwrite,
        ...(data === undefined ? {} : { data }),
      });
    }));
    server.registerTool("file_transfer_upload_chunk", { description: "Write the next upload chunk.", inputSchema: { session_id: sessionId, transfer_id: transferId, offset: z.number().int().nonnegative(), data: z.string().max(700_000) } }, this.tool(user, async ({ session_id, transfer_id, offset, data }) => {
      this.session(user, session_id);
      return this.executeLocalNodeOperation(user, session_id, "file_transfer_upload_chunk", { transfer_id, offset, data });
    }));
    server.registerTool("file_transfer_upload_commit", { description: "Finish the upload identified by transfer_id for the caller's active session_id. Requires all declared bytes; verifies the exact size and SHA-256 before moving the temporary file into the root-relative destination. The destination replacement is atomic when overwrite=true; when false, commit atomically fails if a destination already exists. Returns the committed resolved_path, root_id, path_base=root, size, and SHA-256.", inputSchema: { session_id: sessionId, transfer_id: transferId } }, this.tool(user, async ({ session_id, transfer_id }) => {
      this.session(user, session_id);
      return this.executeLocalNodeOperation(user, session_id, "file_transfer_upload_commit", { transfer_id });
    }));
    server.registerTool("file_transfer_status", { description: "Return transfer state and next offset.", inputSchema: { session_id: sessionId, transfer_id: transferId } }, this.tool(user, async ({ session_id, transfer_id }) => {
      this.session(user, session_id);
      return this.executeLocalNodeOperation(user, session_id, "file_transfer_status", { transfer_id });
    }));
    server.registerTool("file_transfer_cancel", { description: "Cancel and clean up a transfer.", inputSchema: { session_id: sessionId, transfer_id: transferId } }, this.tool(user, async ({ session_id, transfer_id }) => {
      this.session(user, session_id);
      return this.executeLocalNodeOperation(user, session_id, "file_transfer_cancel", { transfer_id });
    }));
    server.registerTool("process_start", { description: "Start a command for the current user-authorized task on the local node through Desktop Commander. Requires the caller's active session_id. The command starts in that session's working_directory. Prefer the dedicated root-scoped file tools for file operations. The command runs with the MCP server OS user's existing permissions. timeout_ms is 100–60000 (default 10000); returns a process_id and initial output. Use process_status, process_output, or process_kill with this same session_id.", inputSchema: { session_id: sessionId, node_id: nodeId, command: z.string().min(1).max(4000), timeout_ms: z.number().int().min(100).max(60_000).default(10_000) } }, this.tool(user, async ({ session_id, node_id, command, timeout_ms }) => {
      await this.sweepExpired();
      const { session, target } = this.operationTarget(user, session_id, node_id);
      if (target.node_id !== this.cfg.nodeId) throw new Error("Remote process public mapping is not implemented yet.");
      return this.dispatchNodeOperation(user, session, target, "process_start", {
        command,
        timeout_ms,
        working_directory: session.workingDirectory,
      });
    }));
    server.registerTool("process_output", { description: "Read the combined output for process_id started in the supplied active session_id. Requires the same session_id used for process_start; returns current state, available exit code, and combined output (stdout and stderr are not separated). Output for finished processes is returned from saved state.", inputSchema: { session_id: sessionId, node_id: nodeId, process_id: z.string() } }, this.tool(user, async ({ session_id, node_id, process_id }) => {
      const { session, target } = this.operationTarget(user, session_id, node_id);
      if (target.node_id !== this.cfg.nodeId) throw new Error("Remote process public mapping is not implemented yet.");
      return this.dispatchNodeOperation(user, session, target, "process_output", { process_id });
    }));
    server.registerTool("process_status", { description: "Refresh and return the state for process_id started in the supplied active session_id, including an available exit code and output. Requires the same session_id used for process_start; process IDs are scoped to their owner and session.", inputSchema: { session_id: sessionId, node_id: nodeId, process_id: z.string() } }, this.tool(user, async ({ session_id, node_id, process_id }) => {
      const { session, target } = this.operationTarget(user, session_id, node_id);
      if (target.node_id !== this.cfg.nodeId) throw new Error("Remote process public mapping is not implemented yet.");
      return this.dispatchNodeOperation(user, session, target, "process_status", { process_id });
    }));
    server.registerTool("process_kill", { description: "Request termination of a running process_id started in the supplied active session_id. Requires the same session_id used for process_start. This targets the tracked process; Windows managed descendants may also be stopped. If rejected=true, the termination request was not accepted. Otherwise state=terminating records a request, not a confirmed exit. Check process_status for the resulting state and termination_unconfirmed flag.", inputSchema: { session_id: sessionId, node_id: nodeId, process_id: z.string() } }, this.tool(user, async ({ session_id, node_id, process_id }) => {
      const { session, target } = this.operationTarget(user, session_id, node_id);
      if (target.node_id !== this.cfg.nodeId) throw new Error("Remote process public mapping is not implemented yet.");
      return this.dispatchNodeOperation(user, session, target, "process_kill", { process_id });
    }));
    return server;
  }
}

class RateLimit {
  private readonly buckets = new Map<string, { count: number; reset: number }>();
  allow(key: string, maximum = 10): boolean {
    const now = Date.now(); for (const [name, bucket] of this.buckets) if (bucket.reset <= now) this.buckets.delete(name);
    const existing = this.buckets.get(key); if (existing) { existing.count += 1; return existing.count <= maximum; }
    if (this.buckets.size >= 128) { const oldest = this.buckets.keys().next().value; if (oldest) this.buckets.delete(oldest); }
    this.buckets.set(key, { count: 1, reset: now + 60_000 }); return true;
  }
}
const readCookie = (header: string | undefined, name: string) => header?.split(";").map((value) => value.trim()).find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
const publicAuthorizeRequest = (service: RemoteDesktopService, req: Request) => {
  const resource = typeof req.query.resource === "string" ? req.query.resource : "";
  const clientId = typeof req.query.client_id === "string" ? req.query.client_id : "";
  const redirectUri = typeof req.query.redirect_uri === "string" ? req.query.redirect_uri : "";
  const challenge = typeof req.query.code_challenge === "string" ? req.query.code_challenge : "";
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  if (clientId !== CHATGPT_CLIENT_ID || redirectUri !== CHATGPT_REDIRECT_URI || resource !== `${service.cfg.baseUrl}/mcp` || req.query.response_type !== "code" || req.query.code_challenge_method !== "S256" || req.query.scope !== "mcp" || (state?.length ?? 0) > 2048 || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return undefined;
  return { clientId, redirectUri, resource, state, challenge };
};
export function createApp(service: RemoteDesktopService): Express {
  const app = express(); const rate = new RateLimit(); app.disable("x-powered-by"); app.use((req, res, next) => {
    // The audit EventSource is an authenticated, body-less GET that deliberately
    // keeps its response open. Only that exact body-less form avoids the generic
    // request-body deadline; malformed event-stream requests retain it.
    const bodylessEvents = req.method === "GET" && req.path === "/api/events" && (req.header("content-length") === undefined || req.header("content-length") === "0") && req.header("transfer-encoding") === undefined;
    let timer: NodeJS.Timeout | undefined = bodylessEvents ? undefined : setTimeout(() => req.destroy(), 15_000);
    const clearDeadline = () => { if (timer) { clearTimeout(timer); timer = undefined; } };
    req.once("end", clearDeadline); req.once("aborted", clearDeadline); res.once("close", clearDeadline);
    if (["/authorize", "/authorize/confirm", "/authorize/consent", "/token", "/google/callback"].includes(req.path) && Number(req.header("content-length") ?? 0) > 16 * 1024) { clearDeadline(); return res.status(413).type("text").send("Request is too large."); }
    next();
  }); app.use(express.urlencoded({ extended: false, limit: "16kb" })); app.use(["/token", "/authorize/confirm", "/authorize/consent"], express.json({ limit: "16kb" })); app.use(express.json({ limit: "1mb" }));
  mountAdmin(app, service);
  mountUserConsole(app, service);
  app.get("/health", (_req, res) => res.json({ ok: true, service: "remote-desktop-mcp", mode: service.publicAuth ? "google" : "local-development" }));
  app.get("/.well-known/oauth-protected-resource", (_req, res) => res.json({ resource: `${service.cfg.baseUrl}/mcp`, authorization_servers: [service.cfg.baseUrl], scopes_supported: ["mcp"] }));
  app.get("/.well-known/oauth-authorization-server", (_req, res) => res.json({ issuer: service.cfg.baseUrl, authorization_response_iss_parameter_supported: Boolean(service.publicAuth), authorization_endpoint: `${service.cfg.baseUrl}/authorize`, token_endpoint: `${service.cfg.baseUrl}/token`, ...(service.publicAuth ? { client_id_metadata_document_supported: true } : { registration_endpoint: `${service.cfg.baseUrl}/register` }), response_types_supported: ["code"], grant_types_supported: service.publicAuth ? ["authorization_code", "refresh_token"] : ["authorization_code"], token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"], scopes_supported: ["mcp"] }));
  app.post("/register", async (req, res) => {
    if (service.publicAuth) return res.status(404).json({ error: "not_found" });
    if (!rate.allow("register")) return res.status(429).json({ error: "rate_limited" });
    const redirect_uris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris.filter((item: unknown): item is string => typeof item === "string") : [];
    if (!redirect_uris.length || !redirect_uris.every((uri: string) => service.validRedirect(uri))) return res.status(400).json({ error: "invalid_redirect_uri" });
    const client: OAuthClient = { client_id: makeId(), client_name: typeof req.body?.client_name === "string" ? req.body.client_name.slice(0, 100) : "MCP client", redirect_uris };
    service.clients.set(client.client_id, client); await service.audit("oauth.client_registered", { clientId: client.client_id }); return res.status(201).json({ ...client, token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] });
  });
  app.get("/authorize", async (req, res) => {
    const request = service.publicAuth ? publicAuthorizeRequest(service, req) : undefined;
    if (!rate.allow(service.publicAuth ? `authorize:${request ? "chatgpt" : "invalid"}` : "authorize")) return res.status(429).send("Too many requests.");
    if (service.publicAuth) {
      if (!request) { await service.audit("oauth.rejected", { reason: "authorize" }); return res.status(400).type("html").send("Invalid OAuth authorization request."); }
      const flow = await service.publicAuth.begin(request);
      res.setHeader("Set-Cookie", `${AUTH_COOKIE}=${flow.cookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`);
      res.setHeader("Cache-Control", "no-store");
      return res.redirect(303, flow.redirect);
    }
    const clientId = typeof req.query.client_id === "string" ? req.query.client_id : "";
    const redirectUri = typeof req.query.redirect_uri === "string" ? req.query.redirect_uri : "";
    const challenge = typeof req.query.code_challenge === "string" ? req.query.code_challenge : "";
    const scope = typeof req.query.scope === "string" ? req.query.scope : "mcp";
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    const client = service.clients.get(clientId);
    const s256Challenge = /^[A-Za-z0-9_-]{43}$/;
    if (!client || !client.redirect_uris.includes(redirectUri) || req.query.response_type !== "code" || req.query.code_challenge_method !== "S256" || !s256Challenge.test(challenge)) { await service.audit("oauth.rejected", { reason: "authorize" }); return res.status(400).send("Invalid OAuth authorization request."); }
    if (scope !== "mcp") { await service.audit("oauth.rejected", { reason: "scope" }); return res.status(400).json({ error: "invalid_scope" }); }
    const transaction = makeId(); service.authorizations.set(transaction, { clientId, redirectUri, state, challenge, scope: "mcp", expires: Date.now() + 5 * 60_000 });
    return res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Remote Desktop MCP</title><form method="post" action="/authorize/confirm"><input type="hidden" name="transaction_id" value="${transaction}"><label>Email <input name="email" type="email" required></label><label>Password <input name="password" type="password" required></label><button type="submit">Authorize</button></form>`);
  });
  app.post("/authorize/confirm", async (req, res) => {
    if (service.publicAuth) return res.status(404).json({ error: "not_found" });
    if (!rate.allow("confirm")) return res.status(429).send("Too many requests.");
    const transaction = typeof req.body?.transaction_id === "string" ? req.body.transaction_id : "";
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const authorization = service.authorizations.get(transaction); service.authorizations.delete(transaction);
    const user = service.cfg.users[0];
    if (!authorization || authorization.expires < Date.now() || email !== user.email.toLowerCase() || !(await verifyPassword(password, user.passwordHash))) { await service.audit("oauth.rejected", { reason: "password" }); return res.status(403).send("Access denied."); }
    const code = makeId(); service.codes.set(code, { ...authorization, email: user.email, expires: Date.now() + 5 * 60_000 });
    const redirect = new URL(authorization.redirectUri); redirect.searchParams.set("code", code); if (authorization.state) redirect.searchParams.set("state", authorization.state);
    await service.audit("oauth.authorization_granted", { user: user.email, clientId: authorization.clientId }); return res.redirect(303, redirect.toString());
  });
  app.post("/token", async (req, res) => {
    const tokenInput = { grantType: typeof req.body?.grant_type === "string" ? req.body.grant_type : "", code: typeof req.body?.code === "string" ? req.body.code : undefined, verifier: typeof req.body?.code_verifier === "string" ? req.body.code_verifier : undefined, clientId: typeof req.body?.client_id === "string" ? req.body.client_id : "", redirectUri: typeof req.body?.redirect_uri === "string" ? req.body.redirect_uri : undefined, resource: typeof req.body?.resource === "string" ? req.body.resource : undefined, refreshToken: typeof req.body?.refresh_token === "string" ? req.body.refresh_token : undefined };
    if (!rate.allow(service.publicAuth ? `token:${service.publicAuth.tokenAdmissionKey(tokenInput) ?? "invalid"}` : "token")) { await service.audit("oauth.rate_limited", {}); return res.status(429).json({ error: "rate_limited" }); }
    if (service.publicAuth) {
      const issued = await service.publicAuth.token(tokenInput);
      res.setHeader("Cache-Control", "no-store");
      if ("error" in issued) { await service.audit("oauth.rejected", { reason: "token" }); return res.status(400).json(issued); }
      await service.audit("oauth.token_issued", { clientId: CHATGPT_CLIENT_ID }); return res.json(issued);
    }
    const code = typeof req.body?.code === "string" ? req.body.code : "";
    const verifier = typeof req.body?.code_verifier === "string" ? req.body.code_verifier : "";
    const clientId = typeof req.body?.client_id === "string" ? req.body.client_id : "";
    const redirectUri = typeof req.body?.redirect_uri === "string" ? req.body.redirect_uri : "";
    const authorization = service.codes.get(code); service.codes.delete(code);
    const verifierPattern = /^[A-Za-z0-9\-._~]{43,128}$/;
    if (req.body?.grant_type !== "authorization_code" || !authorization || authorization.expires < Date.now() || authorization.clientId !== clientId || authorization.redirectUri !== redirectUri || !authorization.email || !verifierPattern.test(verifier) || !equal(createHash("sha256").update(verifier).digest("base64url"), authorization.challenge)) { await service.audit("oauth.rejected", { reason: "token" }); return res.status(400).json({ error: "invalid_grant" }); }
    const accessToken = service.sign({ type: "access", iss: service.cfg.baseUrl, sub: authorization.email, aud: `${service.cfg.baseUrl}/mcp`, scope: "mcp", exp: Math.floor(Date.now() / 1000) + 3600 });
    await service.audit("oauth.token_issued", { user: authorization.email, clientId }); return res.json({ access_token: accessToken, token_type: "Bearer", expires_in: 3600, scope: "mcp" });
  });
  app.get("/google/callback", async (req, res) => {
    if (!service.publicAuth) return res.status(404).send("Not found.");
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const cookie = readCookie(req.header("cookie"), AUTH_COOKIE);
    const admission = service.publicAuth.googleCallbackAdmission({ state, cookie });
    if (!rate.allow(`google_callback:${admission ?? "invalid"}`, 30)) return res.status(429).send("Too many requests.");
    const outcome = await service.publicAuth.googleCallback({ state, code: typeof req.query.code === "string" ? req.query.code : undefined, error: typeof req.query.error === "string" ? req.query.error : undefined, cookie });
    res.setHeader("Cache-Control", "no-store");
    if (outcome.redirect) return res.redirect(303, outcome.redirect);
    if (outcome.transaction) return res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Remote Desktop MCP</title><p>Allow ChatGPT to read and change files only within the configured file roots, and to start arbitrary commands as this Windows user's OS account?</p><form method="post" action="/authorize/consent"><input type="hidden" name="transaction" value="${outcome.transaction}"><button name="allow" value="yes" type="submit">Allow</button><button name="allow" value="no" type="submit">Deny</button></form>`);
    return res.status(400).type("html").send("Sign-in could not be completed.");
  });
  app.post("/authorize/consent", async (req, res) => {
    const consentInput = { transaction: typeof req.body?.transaction === "string" ? req.body.transaction : "", allow: req.body?.allow === "yes", cookie: readCookie(req.header("cookie"), AUTH_COOKIE) };
    if (!service.publicAuth) return res.status(400).send("Invalid authorization request.");
    if (!rate.allow(`consent:${service.publicAuth.consentAdmissionKey(consentInput) ?? "invalid"}`)) return res.status(429).send("Too many requests.");
    const outcome = await service.publicAuth.consent(consentInput);
    res.setHeader("Cache-Control", "no-store"); res.setHeader("Set-Cookie", `${AUTH_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    if (outcome.redirect) return res.redirect(303, outcome.redirect);
    return res.status(400).type("html").send("Authorization could not be completed.");
  });
  app.all("/mcp", async (req: Request, res: Response) => { if (req.method !== "POST") return res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }); const authorization = req.header("authorization"); if (service.publicAuth && !rate.allow(`mcp:${service.publicAuth.mcpAdmissionKey(authorization) ?? "unknown"}`, 30)) return res.status(429).json({ jsonrpc: "2.0", error: { code: -32029, message: "Too many unauthenticated requests." }, id: null }); const user = service.publicAuth ? await service.publicAuth.authenticate(authorization) : service.authenticate(authorization); if (!user) { await service.audit("mcp.rejected", { reason: "authentication" }); const discoveryChallenge = `Bearer resource_metadata="${service.cfg.baseUrl}/.well-known/oauth-protected-resource"`; const renewalChallenge = `${discoveryChallenge}, error="invalid_token", error_description="Access token is invalid or expired."`; const rpc = req.body as { method?: unknown; id?: unknown } | undefined; if (authorization && rpc?.method === "tools/call") return res.status(200).json({ jsonrpc: "2.0", result: { isError: true, content: [{ type: "text", text: "Authorization expired. Reconnect to continue." }], _meta: { "mcp/www_authenticate": [renewalChallenge] } }, id: rpc.id ?? null }); res.setHeader("WWW-Authenticate", discoveryChallenge); return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Authentication required." }, id: null }); } const server = service.server(user); const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); let cleaned = false; const cleanup = () => { if (!cleaned) { cleaned = true; void transport.close(); void server.close(); } }; res.once("finish", cleanup); req.once("aborted", cleanup); try { await server.connect(transport); await transport.handleRequest(req, res, req.body); } catch { await service.audit("mcp.failed", { user }); if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error." }, id: null }); } });
  app.use((error: unknown, _req: Request, res: Response, next: unknown) => { void next; void service.audit("http.failed", { route: "authentication" }).catch(() => undefined); if (!res.headersSent) { const status = typeof error === "object" && error !== null && "status" in error && (error as { status?: unknown }).status === 413 ? 413 : 500; res.status(status).type("text").send(status === 413 ? "Request is too large." : "Request could not be completed."); } });
  return app;
}
export async function startFromEnvironment(): Promise<void> { const service = new RemoteDesktopService(configFromEnv()); await service.initialize(); createApp(service).listen(service.cfg.port, "127.0.0.1", () => console.log(`Remote Desktop MCP listening on ${service.publicAuth ? service.cfg.baseUrl : `http://127.0.0.1:${service.cfg.port}`}/mcp (${service.publicAuth ? "google" : "local-development"})`)); }
if (process.argv[1] === fileURLToPath(import.meta.url)) await startFromEnvironment();
