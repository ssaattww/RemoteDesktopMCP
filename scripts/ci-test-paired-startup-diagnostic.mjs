import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  BASELINE_COMMIT,
  CANDIDATE_COMMIT,
  capturePackageLockIdentity,
  normalizePackageLockLineEndings,
  writeSummaryCheckpoint,
} from "./ci-test-paired-comparison.mjs";
import { fileURLToPath } from "node:url";
import { diagnosticEventPath } from "./ci-test-paired-startup-observer.mjs";

export const STARTUP_DIAGNOSTIC_JOB_BUDGET_MS = 10 * 60 * 1000;
export const STARTUP_DIAGNOSTIC_PREPARATION_BUDGET_MS = 4 * 60 * 1000;
export const STARTUP_DIAGNOSTIC_SCRIPT_STEP_BUDGET_MS = 4 * 60 * 1000;
export const STARTUP_DIAGNOSTIC_SCRIPT_BUDGET_MS = 3 * 60 * 1000;
export const STARTUP_DIAGNOSTIC_CLEANUP_RESERVE_MS = 1 * 60 * 1000;
export const STARTUP_DIAGNOSTIC_UPLOAD_BUDGET_MS = 1 * 60 * 1000;
export const STARTUP_DIAGNOSTIC_RUNNER_SLACK_MS = 1 * 60 * 1000;
export const STARTUP_DIAGNOSTIC_TEST_FILE = "test/config-transfer-integrity.test.ts";
export const STARTUP_DIAGNOSTIC_SAMPLE_COUNT = 2;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const thisFile = fileURLToPath(import.meta.url);
const observerModulePath = path.join(path.dirname(thisFile), "ci-test-paired-startup-observer.mjs");
const observerTypesPath = path.join(path.dirname(thisFile), "ci-test-paired-startup-observer.d.mts");
const SIDE_IDENTITIES = Object.freeze({ baseline: BASELINE_COMMIT, candidate: CANDIDATE_COMMIT });
const NODE_ERROR_CODES = new Set(["ENOENT", "EACCES", "EPERM", "EISDIR", "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_UNKNOWN_FILE_EXTENSION", "ERR_INVALID_MODULE_SPECIFIER", "ERR_UNSUPPORTED_DIR_IMPORT", "ERR_REQUIRE_ESM"]);

export function safeDiagnosticError(error) {
  const errorClass = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "McpError", "SystemError"]).has(error?.name)
    ? error.name : "unknown";
  const errorCode = typeof error?.code === "string" && NODE_ERROR_CODES.has(error.code) ? error.code : "unknown";
  const classification = ["ENOENT", "EACCES", "EPERM"].includes(errorCode) ? "spawn_failure" : errorClass === "McpError" ? "initialize_disconnect" : "other";
  return { errorClass, errorCode, classification };
}

export function retainPrimaryDiagnosticFailure(summary, stage, error, classification) {
  if (summary.primaryError) return summary.primaryError;
  const safe = safeDiagnosticError(error);
  summary.primaryError = { stage, classification: classification ?? safe.classification, errorClass: safe.errorClass, errorCode: safe.errorCode };
  summary.status = "failure";
  return summary.primaryError;
}

export function diagnosticBudgetRemaining(deadline, now = performance.now()) {
  return Math.max(0, deadline - now);
}

export function diagnosticWorktreesMayBeMutated({ preserveWorktrees, terminationUnverified }) {
  return preserveWorktrees !== true && terminationUnverified !== true;
}

export function validateDiagnosticRow(row, expectedIdentity, previousSequence = 0) {
  const allowedKeys = new Set(["side", "runId", "sha", "seq", "event", "phase", "classification", "errorClass", "errorCode", "role", "present", "outcome", "exitCode", "signal", "argsShape", "cwdRole", "envPolicy", "shell"]);
  const allowedEvents = new Set([
    "driver_started", "npm_ci_started", "npm_ci_completed", "overlay_applied", "overlay_restored", "overlay_restore_skipped",
    "fixture_prepare_started", "fixture_prepare_ready", "fixture_prepare_failed", "fixture_initialize_started", "fixture_initialize_failed", "fixture_cleanup_started", "fixture_cleanup_completed",
    "dc_transport_configured", "dc_connect_started", "dc_connect_completed", "dc_connect_failed", "dc_list_tools_started", "dc_list_tools_completed", "dc_list_tools_failed",
    "dc_roots_started", "dc_roots_completed", "dc_roots_failed", "dc_ready", "dc_transport_closed", "dc_transport_error", "bootstrap_started", "diagnostic_timeout", "tree_termination_verified", "tree_termination_unknown",
    "bootstrap_entry_import_started", "bootstrap_entry_import_succeeded", "bootstrap_entry_import_failed", "bootstrap_failed", "direct_child_termination_verified", "test_started", "test_completed",
  ]);
  if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).some((key) => !allowedKeys.has(key))) return false;
  if (row.side !== expectedIdentity.side || row.runId !== expectedIdentity.runId || row.sha !== expectedIdentity.sha
    || !Number.isSafeInteger(row.seq) || row.seq <= previousSequence || !allowedEvents.has(row.event)) return false;
  if (row.phase !== undefined && !new Set(["fixture", "fixture_workspace", "fixture_validation_directory", "fixture_validation_path_validation", "fixture_base_directory", "fixture_base_path_validation", "fixture_root_data_directories", "fixture_private_storage", "fixture_service_construction", "initialize", "transport_connect", "list_tools", "root_verification", "bootstrap", "config_manager", "ownership_bridge", "terminal_manager", "entry_import", "cleanup", "npm_ci", "test", "overlay_restore"]).has(row.phase)) return false;
  if (row.classification !== undefined && !new Set(["spawn_failure", "entry_import_failure", "initialize_disconnect", "other", "unknown"]).has(row.classification)) return false;
  if (row.errorClass !== undefined && !new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "McpError", "SystemError", "unknown"]).has(row.errorClass)) return false;
  if (row.errorCode !== undefined && row.errorCode !== "unknown" && !NODE_ERROR_CODES.has(row.errorCode)) return false;
  if (row.role !== undefined && !new Set(["node_exec_path", "bootstrap", "dc_entry", "fixture_config", "test_worktree"]).has(row.role)) return false;
  if (row.present !== undefined && typeof row.present !== "boolean") return false;
  if (row.outcome !== undefined && !new Set(["success", "failure", "timeout", "unknown"]).has(row.outcome)) return false;
  if (row.exitCode !== undefined && row.exitCode !== null && (!Number.isInteger(row.exitCode) || row.exitCode < 0 || row.exitCode > 255)) return false;
  if (row.signal !== undefined && !new Set(["SIGABRT", "SIGBREAK", "SIGFPE", "SIGILL", "SIGINT", "SIGSEGV", "SIGTERM", "SIGKILL", "unknown"]).has(row.signal)) return false;
  if (row.argsShape !== undefined && !new Set(["managed_bootstrap_entry_config_forwarded", "direct_entry_and_flags", "unknown"]).has(row.argsShape)) return false;
  if (row.cwdRole !== undefined && row.cwdRole !== "test_worktree") return false;
  if (row.envPolicy !== undefined && row.envPolicy !== "process_env_minus_credential_blocklist") return false;
  if (row.shell !== undefined && typeof row.shell !== "boolean") return false;
  return true;
}

function normalizeSource(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return { eol, text: text.replaceAll("\r\n", "\n") };
}

function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`Diagnostic overlay anchor unavailable: ${label}.`);
  return source.replace(before, after);
}

export function overlaySource(file, original) {
  let text = normalizeSource(original.toString("utf8")).text;
  if (file === "src/index.ts") {
    text = replaceOnce(text,
      'import { verifyPassword } from "./hash-password.js";\n',
      'import { verifyPassword } from "./hash-password.js";\nimport { emitStartupDiagnostic, safeStartupError } from "../scripts/ci-test-paired-startup-observer.mjs";\n',
      "service observer import");
    text = replaceOnce(text,
      '    this.transport = new StdioClientTransport({ command: this.cfg.dcCommand, args, env, stderr: "pipe", cwd: process.cwd() });\n',
      '    const observer = (event: Parameters<typeof emitStartupDiagnostic>[0], fields: Record<string, unknown> = {}) => { try { emitStartupDiagnostic(event, fields); } catch { /* observer errors never replace service errors */ } };\n'
      + '    const bootstrapPath = fileURLToPath(new URL("../scripts/desktop-commander-bootstrap.mjs", import.meta.url));\n'
      + '    const entryPath = args[this.cfg.dcManagedConfig ? 1 : 0];\n'
      + '    observer("dc_transport_configured", { phase: "transport_connect", role: "node_exec_path", present: this.cfg.dcCommand === process.execPath, argsShape: this.cfg.dcManagedConfig ? "managed_bootstrap_entry_config_forwarded" : "direct_entry_and_flags", cwdRole: "test_worktree", envPolicy: "process_env_minus_credential_blocklist", shell: false });\n'
      + '    observer("dc_transport_configured", { phase: "transport_connect", role: "bootstrap", present: await access(bootstrapPath).then(() => true, () => false) });\n'
      + '    observer("dc_transport_configured", { phase: "transport_connect", role: "dc_entry", present: typeof entryPath === "string" && await access(entryPath).then(() => true, () => false) });\n'
      + '    observer("dc_transport_configured", { phase: "transport_connect", role: "fixture_config", present: await access(config).then(() => true, () => false) });\n'
      + '    this.transport = new StdioClientTransport({ command: this.cfg.dcCommand, args, env, stderr: "pipe", cwd: process.cwd() });\n',
      "transport selection");
    text = replaceOnce(text,
      '    await this.client.connect(this.transport);\n    this.generation = randomBytes(16).toString("base64url");\n    const available = await this.client.listTools(); this.tools = new Set(available.tools.map((tool) => tool.name));\n',
      '    let diagnosticPhase: "transport_connect" | "list_tools" | "root_verification" = "transport_connect";\n'
      + '    observer("dc_connect_started", { phase: diagnosticPhase });\n'
      + '    try { await this.client.connect(this.transport); } catch (error) { observer("dc_connect_failed", { phase: diagnosticPhase, ...safeStartupError(error), exitCode: null, signal: "unknown" }); throw error; }\n'
      + '    observer("dc_connect_completed", { phase: diagnosticPhase, outcome: "success" });\n'
      + '    const originalClose = this.transport.onclose;\n'
      + '    this.transport.onclose = () => { observer("dc_transport_closed", { phase: diagnosticPhase, classification: "unknown", outcome: "unknown", exitCode: null, signal: "unknown" }); originalClose?.(); };\n'
      + '    const originalError = this.transport.onerror;\n'
      + '    this.transport.onerror = (error) => { observer("dc_transport_error", { phase: diagnosticPhase, ...safeStartupError(error), exitCode: null, signal: "unknown" }); originalError?.(error); };\n'
      + '    this.generation = randomBytes(16).toString("base64url");\n'
      + '    diagnosticPhase = "list_tools"; observer("dc_list_tools_started", { phase: diagnosticPhase });\n'
      + '    let available; try { available = await this.client.listTools(); } catch (error) { observer("dc_list_tools_failed", { phase: diagnosticPhase, ...safeStartupError(error), exitCode: null, signal: "unknown" }); throw error; }\n'
      + '    observer("dc_list_tools_completed", { phase: diagnosticPhase, outcome: "success" }); this.tools = new Set(available.tools.map((tool) => tool.name));\n',
      "MCP connect and list tools");
    text = replaceOnce(text,
      '    try { await this.verifyAllowedRoots(); } catch (error) { await this.close(); throw error; }\n    await this.audit("desktop_commander.ready", { toolCount: this.tools.size });\n',
      '    diagnosticPhase = "root_verification"; observer("dc_roots_started", { phase: diagnosticPhase });\n'
      + '    try { await this.verifyAllowedRoots(); observer("dc_roots_completed", { phase: diagnosticPhase, outcome: "success" }); } catch (error) { observer("dc_roots_failed", { phase: diagnosticPhase, ...safeStartupError(error), exitCode: null, signal: "unknown" }); await this.close(); throw error; }\n'
      + '    await this.audit("desktop_commander.ready", { toolCount: this.tools.size });\n'
      + '    observer("dc_ready", { phase: "initialize", outcome: "success" });\n',
      "root verification and ready");
  } else if (file === "scripts/desktop-commander-bootstrap.mjs") {
    text = replaceOnce(text,
      'import { prepareWindowsJobLauncher } from "./windows-job-launcher.mjs";\n',
      'import { prepareWindowsJobLauncher } from "./windows-job-launcher.mjs";\nimport { emitStartupDiagnostic, importEntryWithSafeDiagnosticMarkers, safeStartupError } from "./ci-test-paired-startup-observer.mjs";\n',
      "bootstrap observer import");
    text = replaceOnce(text,
      'try {\n  const configModule =',
      'let bootstrapPhase = "config_manager";\n'
      + 'try { emitStartupDiagnostic("bootstrap_started", { phase: "bootstrap" }); } catch { /* safe diagnostic is best effort */ }\n'
      + 'try {\n  const configModule =',
      "bootstrap start");
    text = replaceOnce(text,
      '  if (process.platform === "win32") {\n    // terminal-manager imports `spawn` by name.',
      '  bootstrapPhase = "ownership_bridge";\n  if (process.platform === "win32") {\n    // terminal-manager imports `spawn` by name.',
      "bootstrap ownership phase");
    text = replaceOnce(text,
      '  if (process.platform === "win32") {\n    const terminalModule = await import',
      '  bootstrapPhase = "terminal_manager";\n  if (process.platform === "win32") {\n    const terminalModule = await import',
      "bootstrap terminal phase");
    text = replaceOnce(text,
      '  process.argv = [process.argv[0], entry, ...forwardedArguments];\n  await import(pathToFileURL(entry).href);\n} finally {',
      '  bootstrapPhase = "entry_import";\n'
      + '  try { emitStartupDiagnostic("bootstrap_entry_import_started", { phase: "entry_import" }); } catch { /* safe diagnostic is best effort */ }\n'
      + '  process.argv = [process.argv[0], entry, ...forwardedArguments];\n'
      + '  await importEntryWithSafeDiagnosticMarkers(() => import(pathToFileURL(entry).href));\n'
      + '} catch (error) { const safe = safeStartupError(error); try { emitStartupDiagnostic("bootstrap_failed", { phase: bootstrapPhase === "entry_import" ? "entry_import" : bootstrapPhase, classification: bootstrapPhase === "entry_import" ? "entry_import_failure" : safe.classification, errorClass: safe.errorClass, errorCode: safe.errorCode, outcome: "failure", exitCode: null, signal: "unknown" }); } catch { /* preserve bootstrap error */ } throw error;\n} finally {',
      "bootstrap entry import and failure");
  } else if (file === "test/fixture.ts") {
    text = replaceOnce(text,
      'import { protectPrivateDirectory } from "../src/private-storage.js";\n',
      'import { protectPrivateDirectory } from "../src/private-storage.js";\nimport { emitStartupDiagnostic, guardFixturePreparation } from "../scripts/ci-test-paired-startup-observer.mjs";\n',
      "fixture observer import");
    text = replaceOnce(text,
      'export async function fixture(options: { initializeService?: boolean } = {}): Promise<Fixture> {\n  // Node 22 does not keep the test process alive for an in-memory MCP handshake.\n  // This referenced timer belongs to the fixture and is always cleared by cleanup.\n  const keepAlive = setInterval(() => undefined, 1_000);\n  const workspace = path.resolve(process.cwd());\n',
      'export async function fixture(options: { initializeService?: boolean } = {}): Promise<Fixture> {\n  const diagnostic = (event: Parameters<typeof emitStartupDiagnostic>[0], fields: Record<string, unknown> = {}) => { try { emitStartupDiagnostic(event, fields); } catch { /* diagnostic failures do not change fixture behavior */ } };\n  const keepAlive = setInterval(() => undefined, 1_000);\n  diagnostic("fixture_prepare_started", { phase: "fixture" });\n  let baseDirectory: string | undefined;\n  let serviceForCleanup: RemoteDesktopService | undefined;\n  return guardFixturePreparation(async (setPhase) => {\n    setPhase("fixture_workspace");\n    const workspace = path.resolve(process.cwd());\n',
      "fixture preparation start");
    text = replaceOnce(text,
      '  const relativeValidation = path.relative(workspace, validation);\n  if (!relativeValidation',
      '  const relativeValidation = path.relative(workspace, validation);\n  setPhase("fixture_validation_path_validation");\n  if (!relativeValidation',
      "fixture validation path stage");
    text = replaceOnce(text,
      '  await mkdir(validation, { recursive: true });\n  const base = await mkdtemp(path.join(validation, "rdmcp-regression-"));\n',
      '  setPhase("fixture_validation_directory");\n  await mkdir(validation, { recursive: true });\n  setPhase("fixture_base_directory");\n  const base = await mkdtemp(path.join(validation, "rdmcp-regression-"));\n  baseDirectory = base;\n',
      "fixture directories stage");
    text = replaceOnce(text,
      '  const relativeBase = path.relative(validation, base);\n  if (!relativeBase',
      '  const relativeBase = path.relative(validation, base);\n  setPhase("fixture_base_path_validation");\n  if (!relativeBase',
      "fixture base path stage");
    text = replaceOnce(text,
      '  const data = path.join(base, "data");\n  await Promise.all([mkdir(root), mkdir(data)]);\n  await protectPrivateDirectory(data);\n',
      '  const data = path.join(base, "data");\n  setPhase("fixture_root_data_directories");\n  await Promise.all([mkdir(root), mkdir(data)]);\n  setPhase("fixture_private_storage");\n  await protectPrivateDirectory(data);\n',
      "fixture storage stages");
    text = replaceOnce(text,
      '  const service = new RemoteDesktopService(cfg);\n  if (options.initializeService !== false) {\n',
      '  setPhase("fixture_service_construction");\n  const service = new RemoteDesktopService(cfg);\n  serviceForCleanup = service;\n  if (options.initializeService !== false) {\n',
      "fixture service construction stage");
    text = replaceOnce(text,
      '    try { await service.initialize(); }\n    catch (error) {\n      await service.close().catch(() => undefined);\n      await rm(base, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);\n      clearInterval(keepAlive);\n      throw error;\n    }\n  }\n  return { service, root, data, base, cleanup: async () => { try { await service.close(); await rm(base, { recursive: true, force: true, maxRetries: 3 }); } finally { clearInterval(keepAlive); } } };\n',
      '    setPhase("initialize");\n    diagnostic("fixture_initialize_started", { phase: "initialize" });\n    await service.initialize();\n  }\n  return { service, root, data, base, cleanup: async () => { diagnostic("fixture_cleanup_started", { phase: "cleanup" }); try { await service.close(); await rm(base, { recursive: true, force: true, maxRetries: 3 }); diagnostic("fixture_cleanup_completed", { phase: "cleanup", outcome: "success" }); } finally { clearInterval(keepAlive); } } };\n'
      + '  }, { keepAlive, emit: diagnostic, cleanup: async () => { if (serviceForCleanup) await serviceForCleanup.close().catch(() => undefined); if (baseDirectory) await rm(baseDirectory, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined); } });\n',
      "fixture cleanup and completion");
  } else {
    throw new Error("Unsupported diagnostic overlay target.");
  }
  return Buffer.from(text.replaceAll("\n", normalizeSource(original.toString("utf8")).eol));
}

export async function restoreOverlayFiles(overlays, { read = readFile, write = writeFile, remove = unlink } = {}) {
  const currentHashes = [];
  for (const item of overlays) {
    try { currentHashes.push(await read(item.path).then(sha256)); }
    catch (error) {
      if (item.created && error?.code === "ENOENT") currentHashes.push(null);
      else return { restored: false, reason: "overlay_read_failed" };
    }
  }
  if (currentHashes.some((hash, index) => hash !== null && hash !== overlays[index].overlaySha256)) {
    return { restored: false, reason: "overlay_hash_mismatch" };
  }
  for (let index = 0; index < overlays.length; index++) {
    const item = overlays[index];
    if (currentHashes[index] === null) continue;
    if (item.created) await remove(item.path);
    else await write(item.path, item.originalBytes);
  }
  const verified = await Promise.all(overlays.map(async (item) => {
    if (item.created) {
      try { await lstat(item.path); return false; }
      catch (error) { return error?.code === "ENOENT"; }
    }
    return sha256(await read(item.path)) === item.originalSha256;
  }));
  return verified.every(Boolean) ? { restored: true } : { restored: false, reason: "restore_verification_failed" };
}

export async function readSafeDiagnosticEvents(file, identity) {
  const text = await readFile(file, "utf8");
  let previousSequence = 0;
  const rows = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  for (const row of rows) {
    if (!validateDiagnosticRow(row, identity, previousSequence)) throw new Error("Diagnostic sidecar contains an unknown or unsafe record.");
    previousSequence = row.seq;
  }
  return rows;
}

async function appendSafeDriverEvent(file, identity, event, fields = {}) {
  let seq = 1;
  try {
    const rows = await readSafeDiagnosticEvents(file, identity);
    seq = (rows.at(-1)?.seq ?? 0) + 1;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const row = { side: identity.side, runId: identity.runId, sha: identity.sha, seq, event, ...fields };
  if (!validateDiagnosticRow(row, identity, seq - 1)) throw new Error("Driver diagnostic event is outside the safe schema.");
  await writeFile(file, `${JSON.stringify(row)}\n`, { flag: "a" });
}

const spawnedDiagnosticChildren = new WeakSet();

async function childProcess(command, args, { cwd, env = process.env, shell = false, deadline, captureStdout = false, allowPostDeadline = false } = {}) {
  const remaining = diagnosticBudgetRemaining(deadline);
  if (!allowPostDeadline && remaining <= 0) return { timedOut: true, exitCode: null, signal: null, errorCode: "unknown", child: null };
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, shell, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    spawnedDiagnosticChildren.add(child);
    let resolveClosed;
    const childClose = new Promise((resolveClose) => { resolveClosed = resolveClose; });
    const chunks = [];
    let done = false;
    let timer;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ...result, stdout: captureStdout ? Buffer.concat(chunks).toString("utf8") : "", child, childClose });
    };
    if (captureStdout) child.stdout?.on("data", (chunk) => chunks.push(chunk));
    else child.stdout?.on("data", () => undefined);
    child.stderr?.on("data", () => undefined);
    child.once("error", (error) => { resolveClosed({ kind: "spawn_error" }); finish({ spawnError: true, errorCode: NODE_ERROR_CODES.has(error.code) ? error.code : "unknown", exitCode: null, signal: null, timedOut: false }); });
    child.once("close", (exitCode, signal) => { resolveClosed({ kind: "closed", exitCode, signal }); finish({ spawnError: false, errorCode: "unknown", exitCode, signal, timedOut: false }); });
    if (!allowPostDeadline) timer = setTimeout(() => {
      finish({ spawnError: false, errorCode: "unknown", exitCode: null, signal: null, timedOut: true });
    }, remaining);
  });
}

async function terminateOwnedChild(child, childClose, { waitMs = 5_000 } = {}) {
  // Target only this runner's live ChildProcess handle; process-tree termination remains unverified.
  if (!child || !spawnedDiagnosticChildren.has(child) || !Number.isInteger(child.pid) || child.pid <= 0 || typeof child.kill !== "function") {
    return { verified: false, reason: "owned_child_handle_unavailable" };
  }
  if (child.exitCode !== null || child.signalCode !== null) return { verified: true, reason: "direct_child_already_closed" };
  try { child.kill(); }
  catch { return { verified: false, reason: "direct_child_signal_failed" }; }
  let timeout;
  const closed = await Promise.race([
    childClose.then((result) => result.kind === "closed"),
    new Promise((resolve) => { timeout = setTimeout(() => resolve(false), waitMs); }),
  ]);
  clearTimeout(timeout);
  return closed
    ? { verified: true, reason: "direct_child_close_observed" }
    : { verified: false, reason: "direct_child_close_unconfirmed" };
}

export async function runBoundedChild(command, args, options) {
  const result = await (options?.runProcess ?? childProcess)(command, args, options);
  if (!result.timedOut) return { ...result, treeTermination: "not_required", directChildTermination: "not_required" };
  if (!result.child) return { ...result, treeTermination: "verified", directChildTermination: "not_applicable" };
  const termination = await (options?.terminateChild ?? terminateOwnedChild)(result.child, result.childClose, options?.terminationOptions);
  if (!termination.verified) {
    result.child.stdout?.destroy();
    result.child.stderr?.destroy();
    result.child.unref();
  }
  return { ...result, treeTermination: "unknown", directChildTermination: termination.verified ? "verified" : "unknown", terminationReason: termination.reason };
}

async function git(root, args, deadline, captureStdout = false) {
  const result = await runBoundedChild("git", args, { cwd: root, shell: false, deadline, captureStdout });
  if (result.timedOut || result.spawnError || result.exitCode !== 0 || result.treeTermination === "unknown") throw Object.assign(new Error("Git diagnostic command failed."), { diagnosticClass: "setup_failure" });
  return result.stdout.trim();
}

function expectedIdentity(bytes, blob) {
  return {
    byteLength: bytes.length,
    rawBytesSha256: sha256(bytes),
    lineEndingNormalizedSha256: sha256(normalizePackageLockLineEndings(bytes)),
    normalizedGitBlob: blob,
  };
}

function installOverlayText(file, original) {
  return overlaySource(file, original);
}

async function applyOverlay(target, side, runId, register) {
  const helperTarget = path.join(target, "scripts", path.basename(observerModulePath));
  const declarationTarget = path.join(target, "scripts", path.basename(observerTypesPath));
  const identityDirectory = path.join(target, "ci-artifacts", "paired-startup-diagnostic");
  await mkdir(identityDirectory, { recursive: true });
  const identityPath = path.join(identityDirectory, "identity.json");
  const identityBytes = Buffer.from(`${JSON.stringify({ side, runId, sha: SIDE_IDENTITIES[side] })}\n`);
  const overlays = [];
  overlays.push({ path: identityPath, originalBytes: null, originalSha256: null, overlaySha256: sha256(identityBytes), created: true });
  register(overlays);
  await writeFile(identityPath, identityBytes, { flag: "wx" });
  const files = ["src/index.ts", "scripts/desktop-commander-bootstrap.mjs", "test/fixture.ts"];
  for (const relative of files) {
    const file = path.join(target, relative);
    const originalBytes = await readFile(file);
    const overlayBytes = installOverlayText(relative, originalBytes);
    overlays.push({ path: file, originalBytes, originalSha256: sha256(originalBytes), overlaySha256: sha256(overlayBytes), created: false });
    register(overlays);
    await writeFile(file, overlayBytes);
  }
  for (const [source, destination] of [[observerModulePath, helperTarget], [observerTypesPath, declarationTarget]]) {
    const bytes = await readFile(source);
    overlays.push({ path: destination, originalBytes: null, originalSha256: null, overlaySha256: sha256(bytes), created: true });
    register(overlays);
    await writeFile(destination, bytes, { flag: "wx" });
  }
  return overlays;
}

async function restoreSidecars(target, artifactRoot, side, identity) {
  const sourceDirectory = path.join(target, "ci-artifacts", "paired-startup-diagnostic");
  const names = (await readdir(sourceDirectory)).filter((name) => /^events-(?:driver|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u.test(name)).sort();
  let eventCount = 0;
  for (const name of names) {
    const from = path.join(sourceDirectory, name);
    const rows = await readSafeDiagnosticEvents(from, identity);
    const producerId = name.slice("events-".length, -".jsonl".length);
    const to = path.join(artifactRoot, `events-${side}-${producerId}.jsonl`);
    await copyFile(from, to, { errorOnExist: true, force: false });
    const copied = await readSafeDiagnosticEvents(to, identity);
    if (copied.length !== rows.length) throw new Error("Copied diagnostic sidecar failed verification.");
    eventCount += rows.length;
  }
  return { eventCount, producerCount: names.length };
}

export function diagnosticOverlayIdentity(worktree, overlays) {
  return overlays
    .filter((item) => path.relative(worktree, item.path).split(path.sep).join("/") !== "ci-artifacts/paired-startup-diagnostic/identity.json")
    .map((item) => ({ file: path.relative(worktree, item.path).split(path.sep).join("/"), overlaySha256: item.overlaySha256 }))
    .sort((left, right) => left.file.localeCompare(right.file));
}

export function diagnosticOverlayPairMatches(baselineWorktree, baselineOverlays, candidateWorktree, candidateOverlays) {
  return JSON.stringify(diagnosticOverlayIdentity(baselineWorktree, baselineOverlays))
    === JSON.stringify(diagnosticOverlayIdentity(candidateWorktree, candidateOverlays));
}

export function createDiagnosticSummary(runId, attempt, driverSha) {
  return {
    schemaVersion: 1, mode: "startup_diagnostic_only", status: "in_progress", startedAt: new Date().toISOString(),
    runId, runAttempt: attempt, driverSha, baselineCommit: BASELINE_COMMIT, candidateCommit: CANDIDATE_COMMIT,
    budgetMs: STARTUP_DIAGNOSTIC_JOB_BUDGET_MS,
    budgetPlan: {
      origin: "script_entry_after_timeout_capped_checkout_node_setup_and_metadata",
      preparationMaxMs: STARTUP_DIAGNOSTIC_PREPARATION_BUDGET_MS,
      scriptStepMaxMs: STARTUP_DIAGNOSTIC_SCRIPT_STEP_BUDGET_MS,
      scriptWorkMaxMs: STARTUP_DIAGNOSTIC_SCRIPT_BUDGET_MS,
      checkpointCleanupReserveMs: STARTUP_DIAGNOSTIC_CLEANUP_RESERVE_MS,
      artifactUploadMaxMs: STARTUP_DIAGNOSTIC_UPLOAD_BUDGET_MS,
      runnerTransitionReserveMs: STARTUP_DIAGNOSTIC_RUNNER_SLACK_MS,
    },
    sampleLimit: STARTUP_DIAGNOSTIC_SAMPLE_COUNT,
    testFile: STARTUP_DIAGNOSTIC_TEST_FILE, sides: { baseline: { npmCi: "not_started", test: "not_started", overlay: "not_applied" }, candidate: { npmCi: "not_started", test: "not_started", overlay: "not_applied" } },
    primaryError: null, checkpointFailureCount: 0, worktreeDisposition: "owned_temporary_worktrees", overlayIdentityVerified: false,
  };
}

async function runStartupDiagnostic() {
  const startedMono = performance.now();
  const deadline = startedMono + STARTUP_DIAGNOSTIC_SCRIPT_BUDGET_MS;
  const finalizationDeadline = deadline + STARTUP_DIAGNOSTIC_CLEANUP_RESERVE_MS;
  const root = process.cwd();
  const artifactRoot = path.join(root, "ci-artifacts", "paired-startup-diagnostic");
  await mkdir(artifactRoot, { recursive: true });
  const runId = process.env.GITHUB_RUN_ID ?? "0";
  const attempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
  const driverSha = process.env.GITHUB_SHA ?? "0000000000000000000000000000000000000000";
  const summaryPath = path.join(artifactRoot, "summary.json");
  const summary = createDiagnosticSummary(runId, attempt, driverSha);
  const checkpoint = async () => {
    try { await writeSummaryCheckpoint(summaryPath, summary); }
    catch { summary.checkpointFailureCount += 1; }
  };
  const worktrees = [];
  const overlaysBySide = new Map();
  const sidecarsCollected = new Set();
  let tempRoot;
  let allOwnedProcessesClosed = true;
  let terminationUnverified = false;
  let preserveWorktrees = false;
  const recordFailure = (stage, error, classification) => {
    retainPrimaryDiagnosticFailure(summary, stage, error, classification);
  };
  await checkpoint();
  try {
    if (process.platform !== "win32" || process.env.RUNNER_OS !== "Windows") throw Object.assign(new Error("unsupported platform"), { diagnosticClass: "precondition_failure" });
    if (!/^v22\./u.test(process.version) || !/^\d+$/.test(runId) || !/^\d+$/.test(attempt) || !/^[a-f0-9]{40}$/u.test(driverSha)) {
      throw Object.assign(new Error("invalid diagnostic identity"), { diagnosticClass: "precondition_failure" });
    }
    const metadata = JSON.parse(await readFile(path.join(root, "ci-artifacts", "workflow-metadata.json"), "utf8"));
    if (metadata.sourceCommit !== driverSha || Number(metadata.runId) !== Number(runId) || Number(metadata.runAttempt) !== Number(attempt)) {
      throw Object.assign(new Error("workflow metadata mismatch"), { diagnosticClass: "precondition_failure" });
    }
    const expectedBytes = await Promise.all([BASELINE_COMMIT, CANDIDATE_COMMIT].map(async (commit) => Buffer.from(await git(root, ["show", `${commit}:package-lock.json`], deadline, true))));
    const lockBlobs = await Promise.all([BASELINE_COMMIT, CANDIDATE_COMMIT].map((commit) => git(root, ["rev-parse", `${commit}:package-lock.json`], deadline, true)));
    if (!expectedBytes[0].equals(expectedBytes[1]) || lockBlobs[0] !== lockBlobs[1]) throw Object.assign(new Error("pinned lock mismatch"), { diagnosticClass: "lock_guard_failure" });
    const identity = expectedIdentity(expectedBytes[0], lockBlobs[0]);
    summary.packageLockSha256 = identity.rawBytesSha256;
    summary.nodeVersion = process.version;
    summary.testLaunch = { commandRole: "process.execPath", args: ["--import", "tsx", "--test", STARTUP_DIAGNOSTIC_TEST_FILE], cwdRole: "test_worktree", envPolicy: "process_env_minus_CI_GITHUB_TOKEN_and_GITHUB_TOKEN" };
    summary.sides.baseline.commit = BASELINE_COMMIT;
    summary.sides.candidate.commit = CANDIDATE_COMMIT;
    summary.sides.baseline.lockBlob = lockBlobs[0];
    summary.sides.candidate.lockBlob = lockBlobs[1];
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "rdmcp-r24-02-startup-diag-"));
    const targets = { baseline: path.join(tempRoot, "baseline"), candidate: path.join(tempRoot, "candidate") };
    for (const side of ["baseline", "candidate"]) {
      worktrees.push({ side, path: targets[side] });
      const result = await runBoundedChild("git", ["worktree", "add", "--detach", "--quiet", targets[side], SIDE_IDENTITIES[side]], { cwd: root, shell: false, deadline });
      if (result.timedOut || result.treeTermination === "unknown" || result.spawnError || result.exitCode !== 0) {
      if (result.timedOut && result.treeTermination === "unknown") { terminationUnverified = true; preserveWorktrees = true; }
        else preserveWorktrees = true;
        throw Object.assign(new Error("worktree setup failed"), { diagnosticClass: "setup_failure" });
      }
      const status = await git(root, ["-C", targets[side], "status", "--porcelain=v1"], deadline, true);
      if (status) throw Object.assign(new Error("pinned worktree is not clean"), { diagnosticClass: "setup_failure" });
    }
    for (const side of ["baseline", "candidate"]) {
      const target = targets[side];
      const checkout = await capturePackageLockIdentity(target);
      if (checkout.rawBytesSha256 !== identity.rawBytesSha256) {
        const lf = checkout.lineEndingNormalizedSha256 === identity.lineEndingNormalizedSha256;
        const blob = checkout.normalizedGitBlob === identity.normalizedGitBlob;
        if (!lf || !blob) throw Object.assign(new Error("checkout lock guard failed"), { diagnosticClass: "lock_guard_failure" });
        await writeFile(path.join(target, "package-lock.json"), expectedBytes[0]);
      }
      const prepared = await capturePackageLockIdentity(target);
      if (prepared.rawBytesSha256 !== identity.rawBytesSha256 || prepared.normalizedGitBlob !== identity.normalizedGitBlob) throw Object.assign(new Error("prepared lock guard failed"), { diagnosticClass: "lock_guard_failure" });
      summary.sides[side].npmCi = "running";
      await checkpoint();
      const install = await runBoundedChild("npm.cmd", ["ci"], { cwd: target, shell: true, deadline });
      if (install.timedOut) {
        allOwnedProcessesClosed &&= install.treeTermination === "verified";
        if (install.treeTermination !== "verified") { terminationUnverified = true; preserveWorktrees = true; }
        summary.sides[side].directChildTermination = install.directChildTermination;
        summary.sides[side].npmCi = install.treeTermination === "verified" ? "timeout_tree_stopped" : "timeout_tree_unknown";
        throw Object.assign(new Error("npm ci timed out"), { diagnosticClass: install.treeTermination === "verified" ? "timeout" : "termination_unverified" });
      }
      if (install.spawnError || install.exitCode !== 0) {
        summary.sides[side].npmCi = "failure";
        summary.sides[side].npmErrorCode = install.errorCode ?? "unknown";
        throw Object.assign(new Error("npm ci failed"), { diagnosticClass: "dependency_install_failure" });
      }
      const after = await capturePackageLockIdentity(target);
      if (after.rawBytesSha256 !== identity.rawBytesSha256 || after.normalizedGitBlob !== identity.normalizedGitBlob) {
        summary.sides[side].npmCi = "lock_changed";
        throw Object.assign(new Error("post-install lock guard failed"), { diagnosticClass: "lock_guard_failure" });
      }
      summary.sides[side].npmCi = "success";
      const npmVersionRun = await runBoundedChild("npm.cmd", ["--version"], { cwd: target, shell: true, deadline, captureStdout: true });
      if (npmVersionRun.timedOut || npmVersionRun.treeTermination === "unknown" || npmVersionRun.spawnError
        || npmVersionRun.exitCode !== 0 || !/^\d+\.\d+\.\d+(?:[-+].*)?\s*$/u.test(npmVersionRun.stdout)) {
        if (npmVersionRun.timedOut && npmVersionRun.treeTermination !== "verified") { terminationUnverified = true; preserveWorktrees = true; }
        throw Object.assign(new Error("npm version could not be safely recorded"), { diagnosticClass: "environment_mismatch" });
      }
      summary.sides[side].npmVersion = npmVersionRun.stdout.trim();
      const installed = await Promise.all([
        readFile(path.join(target, "node_modules", "@wonderwhy-er", "desktop-commander", "package.json"), "utf8").then((text) => JSON.parse(text).version),
        readFile(path.join(target, "node_modules", "@modelcontextprotocol", "sdk", "package.json"), "utf8").then((text) => JSON.parse(text).version),
      ]);
      summary.sides[side].desktopCommanderVersion = typeof installed[0] === "string" ? installed[0] : "unknown";
      summary.sides[side].mcpSdkVersion = typeof installed[1] === "string" ? installed[1] : "unknown";
      if (summary.sides[side].desktopCommanderVersion !== "0.2.51" || summary.sides[side].mcpSdkVersion !== "1.30.0") {
        throw Object.assign(new Error("installed diagnostic dependencies differ from pinned inputs"), { diagnosticClass: "dependency_identity_mismatch" });
      }
      await checkpoint();
    }
    if (summary.sides.baseline.npmVersion !== summary.sides.candidate.npmVersion) throw Object.assign(new Error("npm versions differ between diagnostic sides"), { diagnosticClass: "environment_mismatch" });
    let baselineOverlayRecords;
    for (const side of ["baseline", "candidate"]) {
      const target = targets[side];
      const identityForSide = { side, runId, sha: SIDE_IDENTITIES[side] };
      const sidecar = diagnosticEventPath(path.join(target, "ci-artifacts", "paired-startup-diagnostic"), "driver");
      await applyOverlay(target, side, runId, (files) => overlaysBySide.set(side, files));
      const applied = overlaysBySide.get(side);
      if (side === "baseline") baselineOverlayRecords = applied;
      else if (!diagnosticOverlayPairMatches(targets.baseline, baselineOverlayRecords, target, applied)) {
        throw Object.assign(new Error("fixed-pair startup diagnostic overlays differ"), { diagnosticClass: "overlay_mismatch" });
      }
      await appendSafeDriverEvent(sidecar, identityForSide, "overlay_applied", { phase: "overlay_restore", outcome: "success" });
      summary.sides[side].overlay = "applied";
      if (side === "candidate") summary.overlayIdentityVerified = true;
      await checkpoint();
    }
    for (const side of ["baseline", "candidate"]) {
      const target = targets[side];
      summary.sides[side].test = "running";
      await checkpoint();
      const env = { ...process.env };
      delete env.CI_GITHUB_TOKEN;
      delete env.GITHUB_TOKEN;
      const sidecar = diagnosticEventPath(path.join(target, "ci-artifacts", "paired-startup-diagnostic"), "driver");
      const identityForSide = { side, runId, sha: SIDE_IDENTITIES[side] };
      await appendSafeDriverEvent(sidecar, identityForSide, "test_started", { phase: "test", role: "test_worktree" });
      const result = await runBoundedChild(process.execPath, ["--import", "tsx", "--test", STARTUP_DIAGNOSTIC_TEST_FILE], { cwd: target, env, shell: false, deadline });
      if (result.timedOut) {
        allOwnedProcessesClosed &&= result.treeTermination === "verified";
        if (result.treeTermination !== "verified") { terminationUnverified = true; preserveWorktrees = true; }
        summary.sides[side].test = result.treeTermination === "verified" ? "timeout_tree_stopped" : "timeout_tree_unknown";
        summary.sides[side].testExitCode = null;
        await appendSafeDriverEvent(sidecar, identityForSide, "diagnostic_timeout", { phase: "test", outcome: "timeout" });
        if (result.directChildTermination === "verified") {
          await appendSafeDriverEvent(sidecar, identityForSide, "direct_child_termination_verified", { phase: "test", outcome: "success" });
        }
        await appendSafeDriverEvent(sidecar, identityForSide, result.treeTermination === "verified" ? "tree_termination_verified" : "tree_termination_unknown", { phase: "test", outcome: result.treeTermination === "verified" ? "success" : "unknown" });
        summary.sides[side].directChildTermination = result.directChildTermination;
        recordFailure("test", new Error("test sample timed out"), result.treeTermination === "verified" ? "timeout" : "termination_unverified");
        await checkpoint();
        if (result.treeTermination !== "verified") break;
        continue;
      }
      if (result.spawnError || result.exitCode !== 0) {
        summary.sides[side].test = "failure";
        summary.sides[side].testExitCode = result.exitCode;
        await appendSafeDriverEvent(sidecar, identityForSide, "test_completed", { phase: "test", outcome: "failure", exitCode: result.exitCode });
        recordFailure("test", new Error("startup diagnostic test failed"), "test_failure");
        await checkpoint();
        continue;
      }
      summary.sides[side].test = "success";
      summary.sides[side].testExitCode = result.exitCode;
      await appendSafeDriverEvent(sidecar, identityForSide, "test_completed", { phase: "test", outcome: "success", exitCode: result.exitCode });
      await checkpoint();
    }
  } catch (error) {
    recordFailure(error?.diagnosticStage ?? "diagnostic", error, error?.diagnosticClass);
  } finally {
    if (diagnosticWorktreesMayBeMutated({ preserveWorktrees, terminationUnverified })) {
      for (const { side, path: worktree } of [...worktrees].reverse()) {
        const overlays = overlaysBySide.get(side);
        if (overlays) {
          const restored = await restoreOverlayFiles(overlays).catch(() => ({ restored: false, reason: "restore_error" }));
          summary.sides[side].overlay = restored.restored ? "restored" : "preserved_unverified";
          if (!restored.restored) {
            preserveWorktrees = true;
            recordFailure("overlay_restore", new Error("overlay restore verification failed"), "overlay_restore_unverified");
          } else {
            const sidecar = diagnosticEventPath(path.join(worktree, "ci-artifacts", "paired-startup-diagnostic"), "driver");
            try { await appendSafeDriverEvent(sidecar, { side, runId, sha: SIDE_IDENTITIES[side] }, "overlay_restored", { phase: "overlay_restore", outcome: "success" }); }
            catch { recordFailure("sidecar", new Error("safe sidecar update failed"), "sidecar_invalid"); }
          }
        }
      }
    }
    if (diagnosticWorktreesMayBeMutated({ preserveWorktrees, terminationUnverified })) {
      for (const { side, path: worktree } of worktrees) {
        if (sidecarsCollected.has(side) || !overlaysBySide.has(side)) continue;
        try {
          const collected = await restoreSidecars(worktree, artifactRoot, side, { side, runId, sha: SIDE_IDENTITIES[side] });
          summary.sides[side].eventCount = collected.eventCount;
          summary.sides[side].eventProducerCount = collected.producerCount;
          sidecarsCollected.add(side);
        } catch {
          recordFailure("sidecar", new Error("safe sidecar unavailable"), "sidecar_invalid");
        }
      }
    }
    if (diagnosticWorktreesMayBeMutated({ preserveWorktrees, terminationUnverified }) && allOwnedProcessesClosed) {
      for (const { path: worktree } of [...worktrees].reverse()) {
        const removed = await runBoundedChild("git", ["worktree", "remove", "--force", worktree], { cwd: root, shell: false, deadline: finalizationDeadline });
        if (removed.timedOut || removed.spawnError || removed.exitCode !== 0 || removed.treeTermination === "unknown") {
          preserveWorktrees = true;
          recordFailure("worktree_cleanup", new Error("owned worktree cleanup unverified"), "cleanup_unverified");
          break;
        }
      }
      if (!preserveWorktrees && tempRoot && path.dirname(path.resolve(tempRoot)) === path.resolve(os.tmpdir())
        && path.basename(tempRoot).startsWith("rdmcp-r24-02-startup-diag-")) {
        await rm(tempRoot, { recursive: true, force: false }).catch(() => { preserveWorktrees = true; recordFailure("worktree_cleanup", new Error("temporary directory cleanup unverified"), "cleanup_unverified"); });
      }
    }
    summary.worktreeDisposition = preserveWorktrees ? "preserved_for_manual_review" : "owned_worktrees_removed";
    summary.finishedAt = new Date().toISOString();
    if (!summary.primaryError) summary.status = "success";
    await checkpoint();
    process.stdout.write(`Paired startup diagnostic ${summary.status}; mode=${summary.mode}; samples=${STARTUP_DIAGNOSTIC_SAMPLE_COUNT}\n`);
  }
  return summary.status === "success" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  runStartupDiagnostic().then((code) => { process.exitCode = code; }).catch(() => {
    process.stderr.write("Paired startup diagnostic failed; inspect the safe summary artifact.\n");
    process.exitCode = 1;
  });
}
