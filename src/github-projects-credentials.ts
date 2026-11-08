import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertPrivateFile, createPrivateTemporaryFile, ensurePrivateDirectory } from "./private-storage.js";
import type { GitHubProjectsCredentialProvider } from "./github-projects-api.js";

const SERVICE = "rdmcp-github-projects";
const MAX_TOKEN_LENGTH = 16_384;
const MAX_RESPONSE_BYTES = 64 * 1024;
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($null -eq $request -or $request.operation -notin @('protect','unprotect') -or [string]::IsNullOrWhiteSpace($request.data) -or [string]::IsNullOrWhiteSpace($request.entropy)) { throw 'invalid request' }
  Add-Type -AssemblyName System.Security
  $data = [Convert]::FromBase64String($request.data)
  $entropy = [Convert]::FromBase64String($request.entropy)
  if ($request.operation -eq 'protect') { $result = [Security.Cryptography.ProtectedData]::Protect($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser) }
  else { $result = [Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser) }
  [Console]::Out.Write([Convert]::ToBase64String($result))
} catch {
  [Console]::Error.WriteLine('credential protection failed')
  exit 1
}
`;

type CredentialRecord = { version: 1; principalHash: string; githubUserId: number; login: string; token: string };
type StoredMetadata = Pick<CredentialRecord, "version" | "principalHash" | "githubUserId" | "login">;
type SecretStore = { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> };

/** Stores a GitHub PAT in the current OS user's protected secret store.
 * No token is read from environment variables, MCP inputs, or command-line arguments. */
export class GitHubProjectsCredentialStore implements GitHubProjectsCredentialProvider {
  private readonly secretStore: SecretStore;
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(private readonly dataDir: string, options: { platform?: NodeJS.Platform; secretStore?: SecretStore } = {}) {
    const platform = options.platform ?? process.platform;
    this.secretStore = options.secretStore ?? (platform === "win32" ? new WindowsDpapiStore(dataDir) : platform === "linux" ? new LinuxSecretServiceStore() : new UnsupportedSecretStore());
  }

  async getToken(principal: string): Promise<string | undefined> {
    const hash = principalDigest(principal);
    const raw = await this.secretStore.get(hash);
    if (raw === undefined) return undefined;
    const record = parseRecord(raw);
    if (record.principalHash !== hash) throw new Error("The GitHub Projects credential is bound to a different user.");
    return record.token;
  }

  async getMetadata(principal: string): Promise<StoredMetadata | undefined> {
    const hash = principalDigest(principal);
    const raw = await this.secretStore.get(hash);
    if (raw === undefined) return undefined;
    const record = parseRecord(raw);
    return { version: record.version, principalHash: record.principalHash, githubUserId: record.githubUserId, login: record.login };
  }

  /** Registration is intended for a local administrator workflow; it is not an MCP tool.
   * The caller supplies a hidden local prompt and invokes this only after the user asks. */
  async register(principal: string, expectedLogin: string, token: string, request: typeof fetch = fetch): Promise<StoredMetadata> {
    const hash = principalDigest(principal);
    const login = requireLogin(expectedLogin);
    if (typeof token !== "string" || !token || token.length > MAX_TOKEN_LENGTH || /[\r\n]/.test(token)) throw new Error("A valid GitHub credential is required.");
    return this.#serialize(hash, async () => {
      const identity = await verifyGitHubIdentity(token, request);
      if (identity.login.toLowerCase() !== login.toLowerCase()) throw new Error("The GitHub credential belongs to a different account.");
      const current = await this.getMetadata(principal);
      if (current && current.githubUserId !== identity.id) throw new Error("Replacing this credential would change the linked GitHub account.");
      const record: CredentialRecord = { version: 1, principalHash: hash, githubUserId: identity.id, login: identity.login, token };
      await this.secretStore.set(hash, JSON.stringify(record));
      return { version: record.version, principalHash: record.principalHash, githubUserId: record.githubUserId, login: record.login };
    });
  }

  async remove(principal: string): Promise<void> {
    const hash = principalDigest(principal);
    await this.#serialize(hash, () => this.secretStore.remove(hash));
  }

  async #serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    this.pending.set(key, next);
    await previous;
    try { return await work(); } finally { release(); if (this.pending.get(key) === next) this.pending.delete(key); }
  }
}

class WindowsDpapiStore implements SecretStore {
  constructor(private readonly dataDir: string) {}
  async get(key: string): Promise<string | undefined> {
    const file = this.file(key);
    try {
      await assertPrivateFile(file);
      const ciphertext = (await readFile(file, "utf8")).trim();
      return await windowsDpapi("unprotect", ciphertext, key);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw new Error("The Windows protected GitHub Projects credential is unavailable.", { cause: error });
    }
  }
  async set(key: string, value: string): Promise<void> {
    const directory = path.join(this.dataDir, "github-projects-credentials");
    await ensurePrivateDirectory(directory);
    const encrypted = await windowsDpapi("protect", Buffer.from(value, "utf8").toString("base64"), key);
    const target = this.file(key);
    const temporary = await createPrivateTemporaryFile(directory, "github-projects-credential");
    try { await writeFile(temporary, `${encrypted}\n`, "utf8"); await assertPrivateFile(temporary); await rename(temporary, target); await assertPrivateFile(target); }
    catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  }
  async remove(key: string): Promise<void> { await unlink(this.file(key)).catch((error: unknown) => { if (!isMissing(error)) throw error; }); }
  private file(key: string): string { return path.join(this.dataDir, "github-projects-credentials", `${key}.dpapi`); }
}

class LinuxSecretServiceStore implements SecretStore {
  async get(key: string): Promise<string | undefined> {
    const result = await secretTool(["lookup", "service", SERVICE, "principal", key], "");
    if (result.code === 1 && !result.stdout) return undefined;
    if (result.code !== 0) throw new Error("The Linux Secret Service is unavailable or locked.");
    return result.stdout.trimEnd();
  }
  async set(key: string, value: string): Promise<void> {
    const result = await secretTool(["store", `--label=RemoteDesktopMCP GitHub Projects ${key.slice(0, 10)}`, "service", SERVICE, "principal", key], value);
    if (result.code !== 0) throw new Error("The Linux Secret Service is unavailable or locked.");
  }
  async remove(key: string): Promise<void> {
    const result = await secretTool(["clear", "service", SERVICE, "principal", key], "");
    if (result.code !== 0 && result.code !== 1) throw new Error("The Linux Secret Service is unavailable or locked.");
  }
}

class UnsupportedSecretStore implements SecretStore {
  async get(): Promise<undefined> { throw new Error("No supported OS credential store is available."); }
  async set(): Promise<void> { throw new Error("No supported OS credential store is available."); }
  async remove(): Promise<void> { throw new Error("No supported OS credential store is available."); }
}

async function windowsDpapi(operation: "protect" | "unprotect", data: string, key: string): Promise<string> {
  const windows = process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows";
  const executable = path.join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const entropy = Buffer.from(key, "hex").toString("base64");
  const response = await run(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_SCRIPT], JSON.stringify({ operation, data, entropy }), ["WINDIR", "SystemRoot", "TEMP", "TMP", "PATH"]);
  if (response.code !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(response.stdout)) throw new Error("DPAPI operation failed.");
  const bytes = Buffer.from(response.stdout, "base64");
  return operation === "protect" ? response.stdout : bytes.toString("utf8");
}

async function secretTool(args: string[], input: string): Promise<{ code: number; stdout: string }> {
  return run("secret-tool", args, input, ["PATH", "HOME", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "XDG_DATA_HOME"]);
}

function run(executable: string, args: string[], input: string, envNames: string[]): Promise<{ code: number; stdout: string }> {
  const env = Object.fromEntries(envNames.flatMap((name) => process.env[name] ? [[name, process.env[name]!]] : []));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true, shell: false });
    const output: Buffer[] = []; let size = 0; let settled = false;
    const timeout = setTimeout(() => child.kill(), 10_000);
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > MAX_RESPONSE_BYTES) { child.kill(); if (!settled) { settled = true; reject(new Error("OS credential provider response was too large.")); } return; } output.push(chunk); });
    child.stdin.on("error", () => undefined);
    child.once("error", () => { clearTimeout(timeout); if (!settled) { settled = true; reject(new Error("OS credential provider is unavailable.")); } });
    child.once("close", (code) => { clearTimeout(timeout); if (!settled) { settled = true; resolve({ code: code ?? 1, stdout: Buffer.concat(output).toString("utf8") }); } });
    child.stdin.end(input);
  });
}

async function verifyGitHubIdentity(token: string, request: typeof fetch): Promise<{ id: number; login: string }> {
  let response: Response;
  try { response = await request("https://api.github.com/user", { method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000), headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "RemoteDesktopMCP-GitHub-Projects" } }); }
  catch { throw new Error("GitHub credential verification could not be completed."); }
  if (!response.ok || !response.body) throw new Error("GitHub rejected the credential or account verification failed.");
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_RESPONSE_BYTES) throw new Error("GitHub returned an invalid account response.");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("GitHub returned an invalid account response."); } chunks.push(part.value); }
  let data: unknown;
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("GitHub returned an invalid account response."); }
  if (typeof data !== "object" || data === null || !Number.isSafeInteger((data as { id?: unknown }).id) || typeof (data as { login?: unknown }).login !== "string") throw new Error("GitHub returned an invalid account response.");
  return { id: (data as { id: number }).id, login: requireLogin((data as { login: string }).login) };
}

function parseRecord(raw: string): CredentialRecord {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("The protected GitHub Projects credential is invalid."); }
  if (typeof value !== "object" || value === null) throw new Error("The protected GitHub Projects credential is invalid.");
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || typeof item.principalHash !== "string" || !Number.isSafeInteger(item.githubUserId) || typeof item.login !== "string" || typeof item.token !== "string" || !item.token || item.token.length > MAX_TOKEN_LENGTH) throw new Error("The protected GitHub Projects credential is invalid.");
  return item as CredentialRecord;
}

function principalDigest(principal: string): string {
  if (typeof principal !== "string" || !/^google:(?:https:\/\/accounts\.google\.com|accounts\.google\.com):[\x21-\x7e]{1,255}$/.test(principal)) throw new Error("A verified Google account is required.");
  return createHash("sha256").update(principal, "utf8").digest("hex");
}

function requireLogin(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value)) throw new Error("A valid GitHub login is required.");
  return value;
}

function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"; }
