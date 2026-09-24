import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFile, copyFile, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type Request, type Response } from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { verifyPassword } from "./hash-password.js";

type User = { email: string; passwordHash: string };
type Root = { id: string; path: string };
type OAuthClient = { client_id: string; client_name: string; redirect_uris: string[] };
type Authorization = { clientId: string; redirectUri: string; state?: string; challenge: string; email?: string; expires: number; scope: "mcp" };
type Session = { id: string; user: string; created: number; touched: number; expires: number; state: "active" | "expired" | "closed" };
type FileIdentity = { dev: number; ino: number };
type OwnedUploadArtifact = FileIdentity & { rootId: string; path: string };
type ProtectedConfigIdentity = FileIdentity & { pin: string };
type Transfer = { id: string; direction: "download" | "upload"; sessionId: string; nodeId: string; rootId: string; target: string; snapshot?: string; temp?: string; tempHandle?: FileHandle; tempIdentity?: FileIdentity; size: number; sha256: string; offset: number; touched: number; state: "active" | "complete" | "cancelled" | "failed" | "expired"; overwrite?: boolean; sent?: ReturnType<typeof createHash> };
type Process = { id: string; sessionId: string; pid: number; state: "running" | "terminating" | "stale" | "finished"; output: string; cursor: number; exitCode?: number; exitAudited?: boolean; terminationRequested?: boolean; terminationUnconfirmed?: boolean };

const SESSION_TTL = 24 * 60 * 60_000;
const TRANSFER_TTL = 30 * 60_000;
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_TRANSFERS = 20;
const MAX_TERMINAL_TRANSFERS = 100;
const MAX_PROCESS_OUTPUT_CHARS = 2 * 1024 * 1024;
const REQUIRED_TOOLS = ["get_config", "start_search", "get_more_search_results", "stop_search", "read_file", "edit_block", "start_process", "read_process_output", "force_terminate", "list_sessions"];

export type RuntimeConfig = { baseUrl: string; tokenSecret: string; users: User[]; roots: Root[]; dataDir: string; port: number; chunkBytes: number; nodeId: string; nodeLabel: string; dcCommand: string; dcArgs: string[]; allowedRedirectOrigins: Set<string>; linkNoReplace?: (existingPath: string, newPath: string) => Promise<void>; linkProtectedConfig?: (existingPath: string, newPath: string) => Promise<void> };
const get = (env: NodeJS.ProcessEnv, name: string) => { const value = env[name]; if (!value) throw new Error(`${name} is required. See .env.example.`); return value; };
const parse = <T>(env: NodeJS.ProcessEnv, name: string): T => { try { return JSON.parse(get(env, name)) as T; } catch { throw new Error(`${name} must contain valid JSON.`); } };
const makeId = () => randomBytes(32).toString("base64url");
const inside = (parent: string, candidate: string) => { const relative = path.relative(parent, candidate); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); };
const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a);
const result = (body: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] });
const failure = (message: string) => ({ isError: true as const, content: [{ type: "text" as const, text: message }] });
const equal = (left: string, right: string) => { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); };

export function configFromEnv(env = process.env): RuntimeConfig {
  const baseUrl = get(env, "BASE_URL").replace(/\/$/, "");
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("BASE_URL must use HTTPS except for loopback local development.");
  const tokenSecret = get(env, "TOKEN_SECRET");
  if (tokenSecret.length < 32) throw new Error("TOKEN_SECRET must contain at least 32 characters.");
  const users = parse<User[]>(env, "AUTHORIZED_USERS_JSON");
  const roots = parse<Root[]>(env, "FILE_ROOTS_JSON").map((root) => ({ ...root, path: path.resolve(root.path) }));
  if (users.length !== 1 || !users[0]?.email || !users[0]?.passwordHash) throw new Error("AUTHORIZED_USERS_JSON must contain exactly one complete local-development user.");
  if (!roots.length || roots.some((root) => !root.id || !root.path) || new Set(roots.map((root) => root.id)).size !== roots.length) throw new Error("FILE_ROOTS_JSON must contain unique complete roots.");
  if (env.REMOTE_NODES_JSON || env.NODE_ROLE && env.NODE_ROLE !== "local") throw new Error("This MVP supports one local node only; remote roles are rejected.");
  const chunkBytes = Number(env.TRANSFER_CHUNK_BYTES ?? 128 * 1024);
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1024 || chunkBytes > 512 * 1024) throw new Error("TRANSFER_CHUNK_BYTES must be between 1024 and 524288.");
  const bundled = fileURLToPath(new URL("../node_modules/@wonderwhy-er/desktop-commander/dist/index.js", import.meta.url));
  const allowedRedirectOrigins = new Set((env.ALLOWED_REDIRECT_ORIGINS ?? "https://chatgpt.com").split(",").map((value) => value.trim()).filter(Boolean));
  return { baseUrl, tokenSecret, users, roots, dataDir: path.resolve(env.DATA_DIR ?? "data"), port: Number(env.PORT ?? 3000), chunkBytes, nodeId: env.LOCAL_NODE_ID ?? "local", nodeLabel: env.LOCAL_NODE_LABEL ?? "This PC", dcCommand: env.DESKTOP_COMMANDER_COMMAND ?? process.execPath, dcArgs: env.DESKTOP_COMMANDER_COMMAND ? (env.DESKTOP_COMMANDER_ARGS ?? "").split(" ").filter(Boolean) : [bundled, "--no-onboarding"], allowedRedirectOrigins };
}

class Mutex {
  private tail = Promise.resolve();
  async run<T>(work: () => Promise<T>): Promise<T> { let release!: () => void; const next = new Promise<void>((resolve) => { release = resolve; }); const previous = this.tail; this.tail = next; await previous; try { return await work(); } finally { release(); } }
}

class DesktopCommander {
  private client?: Client;
  private transport?: StdioClientTransport;
  private tools = new Set<string>();
  private allowedDirectories: string[] = [];
  constructor(private readonly cfg: RuntimeConfig, private readonly audit: (name: string, data: Record<string, unknown>) => Promise<void>, private readonly configPrepared: () => Promise<void>) {}
  async start(): Promise<void> {
    const home = path.join(this.cfg.dataDir, "desktop-commander-home");
    const config = path.join(home, ".claude-server-commander", "config.json");
    const expected = path.resolve(home, ".claude-server-commander", "config.json");
    if (path.resolve(config) !== expected || !inside(this.cfg.dataDir, expected)) throw new Error("Desktop Commander config path did not resolve inside DATA_DIR.");
    await mkdir(path.dirname(config), { recursive: true, mode: 0o700 });
    this.allowedDirectories = await Promise.all(this.cfg.roots.map((root) => realpath(root.path)));
    await writeFile(config, JSON.stringify({ allowedDirectories: this.allowedDirectories, telemetryEnabled: false, welcomeOnboardingEligible: false, pendingWelcomeOnboarding: false }), { mode: 0o600 });
    await this.configPrepared();
    const drive = path.parse(home).root;
    const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"), HOMEDRIVE: drive, HOMEPATH: home.slice(drive.length) } as Record<string, string>;
    this.transport = new StdioClientTransport({ command: this.cfg.dcCommand, args: this.cfg.dcArgs, env, stderr: "pipe", cwd: process.cwd() });
    this.client = new Client({ name: "remote-desktop-mcp", version: "0.1.0" });
    await this.client.connect(this.transport);
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
  async call(name: string, args: Record<string, unknown>, timeout?: number): Promise<string> {
    if (!this.client || !this.tools.has(name)) throw new Error("Desktop Commander is unavailable for this operation.");
    if (name !== "get_config") await this.verifyAllowedRoots();
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
  private expiryTimer?: NodeJS.Timeout;
  constructor(readonly cfg: RuntimeConfig) { this.dc = new DesktopCommander(cfg, this.audit.bind(this), () => this.rememberProtectedConfigIdentity()); this.linkNoReplace = cfg.linkNoReplace ?? link; this.linkProtectedConfig = cfg.linkProtectedConfig ?? link; }
  async initialize(): Promise<void> {
    await mkdir(this.cfg.dataDir, { recursive: true, mode: 0o700 });
    const protectedParent = path.join(this.cfg.dataDir, "desktop-commander-home", ".claude-server-commander");
    const actualData = await realpath(this.cfg.dataDir);
    for (const root of this.cfg.roots) {
      const actualRoot = await realpath(root.path);
      if (overlaps(actualRoot, actualData) || overlaps(actualRoot, protectedParent)) throw new Error("FILE_ROOTS_JSON must not overlap DATA_DIR or Desktop Commander config parent.");
      root.path = actualRoot;
    }
    const transferDirectory = path.join(this.cfg.dataDir, "transfers");
    await mkdir(transferDirectory, { recursive: true, mode: 0o700 });
    await this.loadProtectedConfigIdentities();
    await this.rememberProtectedConfigIdentity(true);
    for (const entry of await readdir(transferDirectory, { withFileTypes: true })) if (entry.isFile() && entry.name.endsWith(".snapshot")) await rm(path.join(transferDirectory, entry.name), { force: true });
    await this.cleanupOwnedUploadArtifacts();
    await this.dc.start();
    await this.rememberProtectedConfigIdentity();
    await this.pruneProtectedConfigIdentities();
    this.expiryTimer = setInterval(() => { void this.sweepExpired(); }, 60_000);
    this.expiryTimer.unref();
  }
  async close(): Promise<void> { if (this.expiryTimer) clearInterval(this.expiryTimer); for (const watcher of this.processWatchers.values()) clearInterval(watcher); this.processWatchers.clear(); await this.transferLock.run(async () => { for (const item of this.transfers.values()) await this.cleanup(item); }); await this.dc.close(); }
  async audit(event: string, fields: Record<string, unknown>): Promise<void> { await mkdir(this.cfg.dataDir, { recursive: true, mode: 0o700 }); await appendFile(path.join(this.cfg.dataDir, "audit.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`, { mode: 0o600 }); }
  sign(body: object): string { const encoded = Buffer.from(JSON.stringify(body)).toString("base64url"); return `${encoded}.${createHmac("sha256", this.cfg.tokenSecret).update(encoded).digest("base64url")}`; }
  validRedirect(uri: string): boolean { try { return this.cfg.allowedRedirectOrigins.has(new URL(uri).origin); } catch { return false; } }
  authenticate(header?: string): string | undefined {
    if (!header?.startsWith("Bearer ")) return undefined;
    const [encoded, signature] = header.slice(7).split(".");
    if (!encoded || !signature || !equal(createHmac("sha256", this.cfg.tokenSecret).update(encoded).digest("base64url"), signature)) return undefined;
    try { const body = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>; const user = this.cfg.users[0]; return body.type === "access" && body.sub === user.email && body.iss === this.cfg.baseUrl && body.aud === `${this.cfg.baseUrl}/mcp` && body.scope === "mcp" && typeof body.exp === "number" && body.exp > Math.floor(Date.now() / 1000) ? user.email : undefined; } catch { return undefined; }
  }
  private async sweepExpiredLocked(now = Date.now()): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.state === "active" && session.expires <= now) {
        session.state = "expired";
        for (const transfer of this.transfers.values()) if (transfer.sessionId === session.id && transfer.state === "active") await this.fail(transfer, "session_expired");
      }
    }
    for (const transfer of this.transfers.values()) if (transfer.state === "active" && now - transfer.touched > TRANSFER_TTL) await this.fail(transfer, "expired");
    for (const [id, session] of this.sessions) if (session.state !== "active" && now - session.expires > SESSION_TTL) this.sessions.delete(id);
  }
  async sweepExpired(): Promise<void> { await this.transferLock.run(() => this.sweepExpiredLocked()); }
  session(user: string, sessionId: string): Session { const value = this.sessions.get(sessionId); if (!value || value.user !== user || value.state !== "active" || value.expires <= Date.now()) throw new Error("Session is invalid, expired, or belongs to another user."); value.touched = Date.now(); value.expires = value.touched + SESSION_TTL; return value; }
  node(nodeId?: string): string { if (nodeId && nodeId !== this.cfg.nodeId) throw new Error("Unknown or unsupported node."); return this.cfg.nodeId; }
  private root(id: string): Root { const root = this.cfg.roots.find((item) => item.id === id); if (!root) throw new Error("Unknown file root."); return root; }
  private configPath(): string { return path.join(this.cfg.dataDir, "desktop-commander-home", ".claude-server-commander", "config.json"); }
  private configIdentityManifestPath(): string { return path.join(this.cfg.dataDir, "transfers", "protected-config-identities.json"); }
  private configPinDirectory(): string { return path.join(this.cfg.dataDir, "transfers", "protected-config-pins"); }
  private identityKey(identity: FileIdentity): string { return `${identity.dev}:${identity.ino}`; }
  private async loadProtectedConfigIdentities(): Promise<void> {
    const text = await readFile(this.configIdentityManifestPath(), "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? "[]" : Promise.reject(error));
    let records: unknown;
    try { records = JSON.parse(text); } catch { throw new Error("Protected config identity history is invalid."); }
    if (!Array.isArray(records) || records.length > 64 || records.some((value) => !value || typeof value !== "object" || !Number.isInteger((value as ProtectedConfigIdentity).dev) || !Number.isInteger((value as ProtectedConfigIdentity).ino))) throw new Error("Protected config identity history is invalid.");
    const pinDirectory = path.resolve(this.configPinDirectory());
    for (const record of records as ProtectedConfigIdentity[]) {
      if (typeof record.pin !== "string") continue;
      const pin = path.resolve(record.pin);
      const validPinName = /^config-(?:\d+-\d+|[A-Za-z0-9_-]{43})\.pin$/.test(path.basename(pin));
      const info = await lstat(pin).catch(() => undefined);
      if (!inside(pinDirectory, pin) || !validPinName || !info || info.isSymbolicLink() || info.dev !== record.dev || info.ino !== record.ino) throw new Error("Protected config identity history is invalid.");
      this.protectedConfigIdentities.set(this.identityKey(record), { ...record, pin });
    }
  }
  private async persistProtectedConfigIdentities(): Promise<void> {
    const manifest = this.configIdentityManifestPath();
    const pending = `${manifest}.next`;
    const records = [...this.protectedConfigIdentities.values()];
    await writeFile(pending, JSON.stringify(records), { mode: 0o600 });
    await rename(pending, manifest);
  }
  private async rememberProtectedConfigIdentity(allowMissing = false): Promise<void> { await this.configIdentityLock.run(() => this.rememberProtectedConfigIdentityLocked(allowMissing)); }
  private async rememberProtectedConfigIdentityLocked(allowMissing: boolean): Promise<void> {
    const config = this.configPath();
    const same = (left: FileIdentity, right: FileIdentity) => left.dev === right.dev && left.ino === right.ino;
    const transientLinkFailure = (error: unknown) => {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      return code === "ENOENT" || code === "EPERM" || code === "EACCES" || code === "EBUSY" || code === "EEXIST";
    };
    const pinDirectory = this.configPinDirectory();
    await mkdir(pinDirectory, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const pin = path.join(pinDirectory, `config-${makeId()}.pin`);
      try { await this.linkProtectedConfig(config, pin); } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" && allowMissing) return;
        if (transientLinkFailure(error)) continue;
        throw error;
      }
      const pinInfo = await lstat(pin).catch(() => undefined);
      if (!pinInfo || pinInfo.isSymbolicLink() || !pinInfo.isFile()) {
        await unlink(pin).catch(() => undefined);
        throw new Error("Protected config identity pin is invalid.");
      }
      const key = this.identityKey(pinInfo);
      const existing = this.protectedConfigIdentities.get(key);
      if (existing) {
        const existingInfo = await lstat(existing.pin).catch(() => undefined);
        if (!existingInfo || existingInfo.isSymbolicLink() || !same(existingInfo, pinInfo)) throw new Error("Protected config identity pin is invalid.");
        await unlink(pin);
      } else {
        if (this.protectedConfigIdentities.size >= 64) { await unlink(pin).catch(() => undefined); throw new Error("Protected config identity history limit reached."); }
        this.protectedConfigIdentities.set(key, { dev: pinInfo.dev, ino: pinInfo.ino, pin });
        await this.persistProtectedConfigIdentities();
      }
      const after = await lstat(config).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
      if (!after || same(after, pinInfo)) return;
    }
    throw new Error("Protected config identity changed while pinning.");
  }
  private async pruneProtectedConfigIdentities(): Promise<void> {
    let changed = false;
    for (const [key, record] of this.protectedConfigIdentities) {
      const info = await lstat(record.pin).catch(() => undefined);
      if (!info || info.isSymbolicLink() || info.dev !== record.dev || info.ino !== record.ino) throw new Error("Protected config identity pin is invalid.");
      if (info.nlink === 1) {
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
  private async isOwnedArtifactPath(entry: OwnedUploadArtifact): Promise<boolean> {
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
    if (!Array.isArray(records) || records.some((value) => !value || typeof value !== "object" || typeof (value as OwnedUploadArtifact).rootId !== "string" || typeof (value as OwnedUploadArtifact).path !== "string" || !Number.isInteger((value as OwnedUploadArtifact).dev) || !Number.isInteger((value as OwnedUploadArtifact).ino))) throw new Error("Owned upload manifest is invalid.");
    this.ownedUploads.clear();
    for (const entry of records as OwnedUploadArtifact[]) {
      if (await this.isOwnedArtifactPath(entry)) {
        const info = await lstat(entry.path).catch(() => undefined);
        if (info && info.dev === entry.dev && info.ino === entry.ino) await rm(entry.path, { force: true }).catch(() => undefined);
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
        if (this.isProtectedConfigIdentity(await lstat(candidate))) throw new Error("Protected service files cannot be searched.");
        if (entry.isDirectory()) await visit(candidate);
      }
    };
    await visit(root.path);
  }
  private async safePath(rootId: string, relative: string, absent = false): Promise<string> {
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
        if (this.isProtectedConfigIdentity(await lstat(candidate))) throw new Error("Protected service files cannot be accessed.");
      } catch (error) { if (error instanceof Error && error.message.startsWith("Protected")) throw error; }
    }
    if (overlaps(candidate, this.cfg.dataDir)) throw new Error("Protected service files cannot be accessed.");
    return candidate;
  }
  private transfer(user: string, sessionId: string, transferId: string): Transfer { this.session(user, sessionId); const item = this.transfers.get(transferId); if (!item || item.sessionId !== sessionId || item.state !== "active") throw new Error("Transfer is unavailable."); item.touched = Date.now(); return item; }
  private rememberTerminal(item: Transfer): void { this.terminalTransfers.push(item.id); while (this.terminalTransfers.length > MAX_TERMINAL_TRANSFERS) { const old = this.terminalTransfers.shift(); if (old) this.transfers.delete(old); } }
  private async cleanup(item: Transfer): Promise<void> {
    await item.tempHandle?.close().catch(() => undefined); item.tempHandle = undefined;
    if (item.snapshot) await rm(item.snapshot, { force: true }).catch(() => undefined);
    if (item.temp && item.tempIdentity) {
      const info = await lstat(item.temp).catch(() => undefined);
      if (info && info.dev === item.tempIdentity.dev && info.ino === item.tempIdentity.ino) await rm(item.temp, { force: true }).catch(() => undefined);
    }
    await this.untrackOwnedUpload(item.temp);
  }
  private async fail(item: Transfer, reason: string): Promise<void> { item.state = reason === "expired" || reason === "session_expired" ? "expired" : "failed"; await this.cleanup(item); this.rememberTerminal(item); await this.audit("transfer.failed", { transferId: item.id, direction: item.direction, reason }); }
  private async privateSnapshot(source: string, destination: string) { await copyFile(source, destination); const bytes = await readFile(destination); return { size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") }; }
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
    await this.guardSearchRoot(root);
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
        const output = await this.dc.call("get_more_search_results", { sessionId: session, offset, length: 100 });
        pages.push(output);
        const complete = /Status:\s*COMPLETED/i.test(output);
        const next = Number(/offset:\s*(\d+)/i.exec(output)?.[1] ?? "");
        const shown = /Showing results (\d+)-(\d+)/i.exec(output);
        let advanced = false;
        if (next > offset) {
          offset = next;
          page += 1;
          advanced = true;
        } else if (!complete && shown && Number(shown[2]) >= offset) {
          offset = Number(shown[2]) + 1;
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
    } finally { await this.dc.call("stop_search", { sessionId: session }).catch(() => undefined); }
  }
  private tool<T extends Record<string, z.ZodTypeAny>>(user: string, fn: (args: z.infer<z.ZodObject<T>>) => Promise<unknown>) { return async (args: z.infer<z.ZodObject<T>>) => { try { return result(await fn(args)); } catch (error) { const message = error instanceof Error ? error.message : "Operation failed."; const reason = message.startsWith("Protected service") ? "protected_config_identity" : message.startsWith("Desktop Commander allowedDirectories") ? "allowed_root" : message.startsWith("Desktop Commander") ? "desktop_commander" : "error"; await this.audit("operation.rejected", { user, reason }); const publicMessage = /^(Session|Unknown|Transfer|Chunk|Only|Path|Protected|Upload|Destination|Desktop Commander|Process|Transfer limit|A relative|Snapshot)/.test(message) ? message : "Operation failed."; return failure(publicMessage); } }; }
  server(user: string): McpServer {
    const server = new McpServer({ name: "remote-desktop-mcp", version: "0.1.0" });
    const sessionId = z.string().min(16); const nodeId = z.string().optional(); const transferId = z.string().min(16);
    server.registerTool("session_open", { description: "Open a local operation session.", inputSchema: {} }, this.tool(user, async () => { await this.sweepExpired(); const now = Date.now(); const session: Session = { id: makeId(), user, created: now, touched: now, expires: now + SESSION_TTL, state: "active" }; this.sessions.set(session.id, session); await this.audit("session.open", { user, sessionId: session.id }); return { session_id: session.id, idle_ttl_seconds: SESSION_TTL / 1000, expires_at: new Date(session.expires).toISOString(), state: session.state }; }));
    server.registerTool("session_list", { description: "List the caller's active sessions.", inputSchema: {} }, this.tool(user, async () => { await this.sweepExpired(); return { sessions: [...this.sessions.values()].filter((entry) => entry.user === user && entry.state === "active").map((entry) => ({ session_id: entry.id, created_at: new Date(entry.created).toISOString(), last_used_at: new Date(entry.touched).toISOString(), expires_at: new Date(entry.expires).toISOString(), state: entry.state })) }; }));
    server.registerTool("session_close", { description: "Close a local operation session.", inputSchema: { session_id: sessionId } }, this.tool(user, async ({ session_id }) => this.transferLock.run(async () => { await this.sweepExpiredLocked(); const session = this.session(user, session_id); session.state = "closed"; for (const item of this.transfers.values()) if (item.sessionId === session_id && item.state === "active") { item.state = "cancelled"; await this.cleanup(item); this.rememberTerminal(item); } await this.audit("session.close", { user, sessionId: session_id }); return { closed: true }; })));
    server.registerTool("node_list", { description: "List the single supported local node.", inputSchema: { session_id: sessionId } }, this.tool(user, async ({ session_id }) => { this.session(user, session_id); return { nodes: [{ node_id: this.cfg.nodeId, label: this.cfg.nodeLabel, connected: true, coordinator: true, operations: ["file", "process", "transfer"] }] }; }));
    server.registerTool("file_search", { description: "Search permitted file names through Desktop Commander.", inputSchema: { session_id: sessionId, node_id: nodeId, root_id: z.string(), query: z.string().min(1).max(120) } }, this.tool(user, async ({ session_id, node_id, root_id, query }) => { await this.sweepExpired(); this.session(user, session_id); const node = this.node(node_id); const output = await this.search(this.root(root_id), query, "files"); await this.audit("file.search", { user, sessionId: session_id, nodeId: node, rootId: root_id }); return { output }; }));
    server.registerTool("content_search", { description: "Search permitted file content through Desktop Commander.", inputSchema: { session_id: sessionId, node_id: nodeId, root_id: z.string(), query: z.string().min(1).max(120) } }, this.tool(user, async ({ session_id, node_id, root_id, query }) => { await this.sweepExpired(); this.session(user, session_id); const node = this.node(node_id); const output = await this.search(this.root(root_id), query, "content"); await this.audit("file.content_search", { user, sessionId: session_id, nodeId: node, rootId: root_id }); return { output }; }));
    const fileInput = { session_id: sessionId, node_id: nodeId, root_id: z.string(), relative_path: z.string().min(1).max(500) };
    server.registerTool("file_read", { description: "Read a permitted text file through Desktop Commander.", inputSchema: { ...fileInput, offset: z.number().int().nonnegative().optional(), length: z.number().int().positive().max(1000).optional() } }, this.tool(user, async ({ session_id, node_id, root_id, relative_path, offset, length }) => { this.session(user, session_id); const node = this.node(node_id); const output = await this.dc.call("read_file", { path: await this.safePath(root_id, relative_path), offset, length }); await this.audit("file.read", { user, sessionId: session_id, nodeId: node, rootId: root_id, relativePath: relative_path }); return { output }; }));
    server.registerTool("file_patch", { description: "Apply an exact text replacement through Desktop Commander.", inputSchema: { ...fileInput, old_string: z.string().min(1).max(1_000_000), new_string: z.string().max(1_000_000), expected_replacements: z.number().int().positive().max(100).default(1) } }, this.tool(user, async ({ session_id, node_id, root_id, relative_path, old_string, new_string, expected_replacements }) => { this.session(user, session_id); const node = this.node(node_id); const output = await this.dc.call("edit_block", { file_path: await this.safePath(root_id, relative_path), old_string, new_string, expected_replacements }); await this.audit("file.patch", { user, sessionId: session_id, nodeId: node, rootId: root_id, relativePath: relative_path }); return { output }; }));
    server.registerTool("file_transfer_download_begin", { description: "Create an immutable private snapshot for chunk download.", inputSchema: fileInput }, this.tool(user, async ({ session_id, node_id, root_id, relative_path }) => this.transferLock.run(async () => { await this.sweepExpiredLocked(); this.session(user, session_id); const node = this.node(node_id); if ([...this.transfers.values()].filter((item) => item.state === "active").length >= MAX_TRANSFERS) throw new Error("Transfer limit reached."); const source = await this.safePath(root_id, relative_path); const info = await lstat(source); if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw new Error("Only regular files within the transfer limit are allowed."); const directory = path.join(this.cfg.dataDir, "transfers"); await mkdir(directory, { recursive: true, mode: 0o700 }); const snapshot = path.join(directory, `${makeId()}.snapshot`); try { const metadata = await this.privateSnapshot(source, snapshot); const item: Transfer = { id: makeId(), direction: "download", sessionId: session_id, nodeId: node, rootId: root_id, target: source, snapshot, ...metadata, offset: 0, touched: Date.now(), state: "active", sent: createHash("sha256") }; this.transfers.set(item.id, item); await this.audit("transfer.begin", { transferId: item.id, direction: item.direction, sessionId: session_id, nodeId: node, size: item.size, sha256: item.sha256 }); return { transfer_id: item.id, filename: path.basename(source), size: item.size, sha256: item.sha256, chunk_bytes: this.cfg.chunkBytes }; } catch (error) { await rm(snapshot, { force: true }).catch(() => undefined); throw error; } })));
    server.registerTool("file_transfer_download_chunk", { description: "Read the next immutable chunk.", inputSchema: { session_id: sessionId, transfer_id: transferId, offset: z.number().int().nonnegative() } }, this.tool(user, async ({ session_id, transfer_id, offset }) => this.transferLock.run(async () => { await this.sweepExpiredLocked(); const item = this.transfer(user, session_id, transfer_id); if (item.direction !== "download" || item.offset !== offset || !item.snapshot) throw new Error("Chunk offset or direction is invalid."); let handle: FileHandle | undefined; try { handle = await open(item.snapshot, "r"); const length = Math.min(this.cfg.chunkBytes, item.size - item.offset); const bytes = Buffer.alloc(length); const read = await handle.read(bytes, 0, length, item.offset); if (read.bytesRead !== length) throw new Error("Snapshot read failed."); const data = bytes.subarray(0, read.bytesRead); item.sent?.update(data); item.offset += read.bytesRead; const complete = item.offset === item.size; if (complete && item.sent?.digest("hex") !== item.sha256) throw new Error("Snapshot integrity check failed."); if (complete) { item.state = "complete"; await this.cleanup(item); this.rememberTerminal(item); } return { data: data.toString("base64"), next_offset: item.offset, complete }; } catch (error) { await this.fail(item, "snapshot_read_failed"); throw error; } finally { await handle?.close().catch(() => undefined); } })));
    server.registerTool("file_transfer_upload_begin", { description: "Start a serialized chunk upload.", inputSchema: { ...fileInput, size: z.number().int().nonnegative().max(MAX_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/), overwrite: z.boolean() } }, this.tool(user, async ({ session_id, node_id, root_id, relative_path, size, sha256, overwrite }) => this.transferLock.run(async () => { await this.sweepExpiredLocked(); this.session(user, session_id); const node = this.node(node_id); const target = await this.safePath(root_id, relative_path, true); if (!overwrite) await this.verifyNoReplaceCapability(path.dirname(target)); const temp = path.join(path.dirname(target), `.__rdmcp_${makeId()}.upload`); let handle: FileHandle | undefined; try { handle = await open(temp, "wx", 0o600); const info = await handle.stat(); const identity = { dev: info.dev, ino: info.ino }; await this.trackOwnedUpload(root_id, temp, identity); const item: Transfer = { id: makeId(), direction: "upload", sessionId: session_id, nodeId: node, rootId: root_id, target, temp, tempHandle: handle, tempIdentity: identity, size, sha256, offset: 0, touched: Date.now(), state: "active", overwrite }; this.transfers.set(item.id, item); await this.audit("transfer.begin", { transferId: item.id, direction: item.direction, sessionId: session_id, nodeId: node, size, sha256 }); return { transfer_id: item.id, chunk_bytes: this.cfg.chunkBytes }; } catch (error) { await handle?.close().catch(() => undefined); await rm(temp, { force: true }).catch(() => undefined); await this.untrackOwnedUpload(temp).catch(() => undefined); throw error; } })));
    server.registerTool("file_transfer_upload_chunk", { description: "Write the next upload chunk.", inputSchema: { session_id: sessionId, transfer_id: transferId, offset: z.number().int().nonnegative(), data: z.string().max(700_000) } }, this.tool(user, async ({ session_id, transfer_id, offset, data }) => this.transferLock.run(async () => { await this.sweepExpiredLocked(); const item = this.transfer(user, session_id, transfer_id); if (item.direction !== "upload" || item.offset !== offset || !item.temp || !item.tempHandle || !item.tempIdentity) throw new Error("Chunk offset or direction is invalid."); const pathInfo = await lstat(item.temp).catch(() => undefined); if (!pathInfo || pathInfo.dev !== item.tempIdentity.dev || pathInfo.ino !== item.tempIdentity.ino) { await this.fail(item, "temp_path_replaced"); throw new Error("Upload temporary file identity changed."); } if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4) throw new Error("Chunk must be valid base64."); const bytes = Buffer.from(data, "base64"); if (!bytes.length || bytes.length > this.cfg.chunkBytes || item.offset + bytes.length > item.size) throw new Error("Chunk exceeds declared upload size."); await item.tempHandle.write(bytes, 0, bytes.length, item.offset); item.offset += bytes.length; return { next_offset: item.offset }; })));
    server.registerTool("file_transfer_upload_commit", { description: "Verify and atomically commit an upload.", inputSchema: { session_id: sessionId, transfer_id: transferId } }, this.tool(user, async ({ session_id, transfer_id }) => this.transferLock.run(async () => { await this.sweepExpiredLocked(); const item = this.transfer(user, session_id, transfer_id); if (item.direction !== "upload" || !item.temp || !item.tempHandle || !item.tempIdentity || item.offset !== item.size) throw new Error("Upload is incomplete."); const pathInfo = await lstat(item.temp).catch(() => undefined); if (!pathInfo || pathInfo.dev !== item.tempIdentity.dev || pathInfo.ino !== item.tempIdentity.ino) { await this.fail(item, "temp_path_replaced"); throw new Error("Upload temporary file identity changed."); } await item.tempHandle.sync(); await item.tempHandle.close(); item.tempHandle = undefined; const bytes = await readFile(item.temp); if (bytes.length !== item.size || createHash("sha256").update(bytes).digest("hex") !== item.sha256) { await this.fail(item, "upload_hash_mismatch"); throw new Error("Upload integrity check failed."); } await this.safePath(item.rootId, path.relative(this.root(item.rootId).path, item.target), true); try { if (item.overwrite) await rename(item.temp, item.target); else { await this.linkNoReplace(item.temp, item.target); await unlink(item.temp); } } catch { await this.fail(item, "destination_conflict"); throw new Error("Destination exists or atomic no-replace commit is unavailable."); } await this.untrackOwnedUpload(item.temp); item.state = "complete"; this.rememberTerminal(item); await this.audit("transfer.complete", { transferId: item.id, direction: item.direction, sessionId: item.sessionId, size: item.size, sha256: item.sha256 }); return { size: item.size, sha256: item.sha256 }; })));
    server.registerTool("file_transfer_status", { description: "Return transfer state and next offset.", inputSchema: { session_id: sessionId, transfer_id: transferId } }, this.tool(user, async ({ session_id, transfer_id }) => this.transferLock.run(async () => {
      await this.sweepExpiredLocked();
      this.session(user, session_id);
      const item = this.transfers.get(transfer_id);
      if (!item || item.sessionId !== session_id) throw new Error("Transfer is unavailable.");
      return { state: item.state, next_offset: item.offset, transferred_bytes: item.offset };
    })));
    server.registerTool("file_transfer_cancel", { description: "Cancel and clean up a transfer.", inputSchema: { session_id: sessionId, transfer_id: transferId } }, this.tool(user, async ({ session_id, transfer_id }) => this.transferLock.run(async () => {
      await this.sweepExpiredLocked();
      const item = this.transfer(user, session_id, transfer_id);
      item.state = "cancelled";
      await this.cleanup(item);
      this.rememberTerminal(item);
      await this.audit("transfer.cancel", { transferId: item.id, sessionId });
      return { cancelled: true };
    })));
    const auditExit = async (item: Process) => {
      if (item.exitAudited) return;
      item.exitAudited = true;
      await this.audit("process.exit", { processId: item.id, result: item.terminationRequested ? "exit_after_termination_request" : "natural", exitCode: item.exitCode ?? null });
    };
    const finishWhenRootIsGone = async (item: Process) => {
      if (item.state === "finished") return;
      item.state = "finished";
      await auditExit(item);
    };
    const activeInDesktopCommander = async (item: Process): Promise<boolean> => {
      const output = await this.dc.call("list_sessions", {}, 1_000);
      return new RegExp(`PID:\\s*${item.pid}(?:\\D|$)`, "i").test(output);
    };
    const watchProcess = (processId: string) => {
      let checking = false;
      const watcher = setInterval(() => { if (checking) return; checking = true; void this.processLock.run(async () => {
        const item = this.processes.get(processId);
        if (!item || item.state === "finished" || item.state === "stale") { clearInterval(watcher); this.processWatchers.delete(processId); return; }
        try {
          const active = await activeInDesktopCommander(item);
          await observe(item).catch(async () => { await this.audit("process.output_unavailable", { processId }); });
          if (!active) await finishWhenRootIsGone(item);
        } catch { await this.audit("process.observe_failed", { processId }); clearInterval(watcher); this.processWatchers.delete(processId); return; }
        if (this.processes.get(processId)?.state === "finished") { clearInterval(watcher); this.processWatchers.delete(processId); }
      }).finally(() => { checking = false; }); }, 250);
      watcher.unref();
      this.processWatchers.set(processId, watcher);
    };
    server.registerTool("process_start", { description: "Start an arbitrary command as the same OS user through Desktop Commander.", inputSchema: { session_id: sessionId, node_id: nodeId, command: z.string().min(1).max(4000), timeout_ms: z.number().int().min(100).max(60_000).default(10_000) } }, this.tool(user, async ({ session_id, node_id, command, timeout_ms }) => this.processLock.run(async () => { await this.sweepExpired(); this.session(user, session_id); const node = this.node(node_id); const output = await this.dc.call("start_process", { command, timeout_ms }); const match = output.match(/PID\s+(-?\d+)/i); if (!match) throw new Error("Desktop Commander did not return a process id."); const initialCompletion = /Process completed with exit code\s+(?:(-?\d+)|null|undefined)/i.exec(output); const item: Process = { id: makeId(), sessionId: session_id, pid: Number(match[1]), state: initialCompletion ? "finished" : "running", output, cursor: 0, exitCode: initialCompletion?.[1] === undefined ? undefined : Number(initialCompletion[1]) }; this.processes.set(item.id, item); if (item.state === "running") watchProcess(item.id); await this.audit("process.start", { user, sessionId: session_id, nodeId: node, processId: item.id }); if (item.state === "finished") await auditExit(item); return { process_id: item.id, output }; })));
    const getProcess = (sid: string, pid: string) => { this.session(user, sid); const item = this.processes.get(pid); if (!item || item.state === "stale") throw new Error("Process id is stale or finished."); return item; };
    const current = (sid: string, pid: string) => { const item = getProcess(sid, pid); if (item.state !== "running") throw new Error("Process id is stale or finished."); return item; };
    const observe = async (item: Process) => { const pages: string[] = []; for (let page = 0; page < 100; page += 1) { const output = await this.dc.call("read_process_output", { pid: item.pid, offset: item.cursor, length: 1000, timeout_ms: 100 }, 1_000); pages.push(output); const read = /Reading (\d+) (?:new )?lines(?: from line (\d+))?/i.exec(output); const remaining = /, (\d+) remaining\)/i.exec(output); if (read) item.cursor = Number(read[2] ?? item.cursor) + Number(read[1]); const completion = /Process completed with exit code\s+(?:(-?\d+)|null|undefined)/i.exec(output); if (completion) { item.state = "finished"; item.exitCode = completion[1] === undefined ? undefined : Number(completion[1]); } if (!remaining || Number(remaining[1]) === 0) break; } item.output = `${item.output}\n${pages.join("\n")}`.slice(-MAX_PROCESS_OUTPUT_CHARS); if (item.state === "finished") await auditExit(item); return pages.join("\n"); };
    server.registerTool("process_output", { description: "Read combined process output through Desktop Commander.", inputSchema: { session_id: sessionId, node_id: nodeId, process_id: z.string() } }, this.tool(user, async ({ session_id, node_id, process_id }) => this.processLock.run(async () => { this.node(node_id); const item = getProcess(session_id, process_id); if (item.state === "finished") return { state: item.state, exit_code: item.exitCode, output: item.output }; if (item.terminationUnconfirmed) return { state: item.state, termination_unconfirmed: true, output: item.output }; const output = await observe(item); return { state: item.state, exit_code: item.exitCode, output }; })));
    server.registerTool("process_status", { description: "Get process status through Desktop Commander.", inputSchema: { session_id: sessionId, node_id: nodeId, process_id: z.string() } }, this.tool(user, async ({ session_id, node_id, process_id }) => this.processLock.run(async () => { this.node(node_id); const item = getProcess(session_id, process_id); if (item.state === "finished") return { state: item.state, exit_code: item.exitCode, output: item.output }; if (item.terminationUnconfirmed) return { state: item.state, termination_unconfirmed: true, output: item.output }; if (item.state === "terminating" && await activeInDesktopCommander(item)) return { state: item.state, output: item.output }; const output = await observe(item); return { state: item.state, exit_code: item.exitCode, output }; })));
    server.registerTool("process_kill", { description: "Terminate a current process through Desktop Commander.", inputSchema: { session_id: sessionId, node_id: nodeId, process_id: z.string() } }, this.tool(user, async ({ session_id, node_id, process_id }) => this.processLock.run(async () => {
      this.node(node_id);
      const item = current(session_id, process_id);
      const watcher = this.processWatchers.get(item.id);
      if (watcher) clearInterval(watcher);
      this.processWatchers.delete(item.id);
      let outcome: "acknowledged" | "rejected" | "timed_out";
      try {
        const output = await this.dc.call("force_terminate", { pid: item.pid }, 2_000);
        outcome = /Successfully initiated termination of session/i.test(output) ? "acknowledged" : "rejected";
      } catch (error) {
        outcome = typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === -32001 ? "timed_out" : "rejected";
      }
      if (outcome === "rejected") {
        await this.audit("process.kill_rejected", { processId: item.id });
        watchProcess(item.id);
        return { state: item.state, rejected: true };
      }
      item.state = "terminating";
      item.terminationRequested = true;
      if (outcome === "timed_out") {
        item.terminationUnconfirmed = true;
        await this.audit("process.termination_unconfirmed", { processId: item.id });
        return { state: item.state, termination_unconfirmed: true };
      }
      await this.audit("process.kill_requested", { processId: item.id });
      watchProcess(item.id);
      return { state: item.state };
    })));
    return server;
  }
}

class RateLimit { private hits = new Map<string, number[]>(); allow(key: string): boolean { const now = Date.now(); const values = (this.hits.get(key) ?? []).filter((value) => now - value < 60_000); values.push(now); this.hits.set(key, values); return values.length <= 10; } }
export function createApp(service: RemoteDesktopService): Express {
  const app = express(); const rate = new RateLimit(); app.disable("x-powered-by"); app.use(express.urlencoded({ extended: false })); app.use(express.json({ limit: "1mb" }));
  app.get("/health", (_req, res) => res.json({ ok: true, service: "remote-desktop-mcp", mode: "local-development" }));
  app.get("/.well-known/oauth-protected-resource", (_req, res) => res.json({ resource: `${service.cfg.baseUrl}/mcp`, authorization_servers: [service.cfg.baseUrl], scopes_supported: ["mcp"] }));
  app.get("/.well-known/oauth-authorization-server", (_req, res) => res.json({ issuer: service.cfg.baseUrl, authorization_endpoint: `${service.cfg.baseUrl}/authorize`, token_endpoint: `${service.cfg.baseUrl}/token`, registration_endpoint: `${service.cfg.baseUrl}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code"], token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"], scopes_supported: ["mcp"] }));
  app.post("/register", async (req, res) => {
    if (!rate.allow("register")) return res.status(429).json({ error: "rate_limited" });
    const redirect_uris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris.filter((item: unknown): item is string => typeof item === "string") : [];
    if (!redirect_uris.length || !redirect_uris.every((uri: string) => service.validRedirect(uri))) return res.status(400).json({ error: "invalid_redirect_uri" });
    const client: OAuthClient = { client_id: makeId(), client_name: typeof req.body?.client_name === "string" ? req.body.client_name.slice(0, 100) : "MCP client", redirect_uris };
    service.clients.set(client.client_id, client); await service.audit("oauth.client_registered", { clientId: client.client_id }); return res.status(201).json({ ...client, token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] });
  });
  app.get("/authorize", async (req, res) => {
    if (!rate.allow("authorize")) return res.status(429).send("Too many requests.");
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
    if (!rate.allow("token")) { await service.audit("oauth.rate_limited", {}); return res.status(429).json({ error: "rate_limited" }); }
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
  app.all("/mcp", async (req: Request, res: Response) => { if (req.method !== "POST") return res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }); const user = service.authenticate(req.header("authorization")); if (!user) { await service.audit("mcp.rejected", { reason: "authentication" }); res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${service.cfg.baseUrl}/.well-known/oauth-protected-resource"`); return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Authentication required." }, id: null }); } const server = service.server(user); const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); let cleaned = false; const cleanup = () => { if (!cleaned) { cleaned = true; void transport.close(); void server.close(); } }; res.once("finish", cleanup); req.once("aborted", cleanup); try { await server.connect(transport); await transport.handleRequest(req, res, req.body); } catch { await service.audit("mcp.failed", { user }); if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error." }, id: null }); } });
  return app;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) { const service = new RemoteDesktopService(configFromEnv()); await service.initialize(); createApp(service).listen(service.cfg.port, "127.0.0.1", () => console.log(`Remote Desktop MCP listening on http://127.0.0.1:${service.cfg.port}/mcp (local development)`)); }
