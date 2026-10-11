import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const EVENTS = new Set([
  "driver_started", "npm_ci_started", "npm_ci_completed", "overlay_applied", "overlay_restored",
  "overlay_restore_skipped", "fixture_prepare_started", "fixture_prepare_ready", "fixture_prepare_failed", "fixture_initialize_started",
  "fixture_initialize_failed", "fixture_cleanup_started", "fixture_cleanup_completed", "dc_transport_configured",
  "dc_connect_started", "dc_connect_completed", "dc_connect_failed", "dc_list_tools_started",
  "dc_list_tools_completed", "dc_list_tools_failed", "dc_roots_started", "dc_roots_completed",
  "dc_roots_failed", "dc_ready", "dc_transport_closed", "dc_transport_error", "bootstrap_started",
  "bootstrap_entry_import_started", "bootstrap_entry_import_succeeded", "bootstrap_entry_import_failed",
  "bootstrap_failed", "test_started", "test_completed", "diagnostic_timeout", "tree_termination_verified",
  "tree_termination_unknown", "direct_child_termination_verified", "test_case_result", "test_results_collection",
]);
const FIELD_NAMES = new Set(["phase", "classification", "errorClass", "errorCode", "role", "present", "outcome", "exitCode", "signal", "argsShape", "cwdRole", "envPolicy", "shell", "caseId", "collectionStatus"]);
const TEST_CASES = Object.freeze([
  ["DR001: downloads use one immutable multi-chunk snapshot and clean failed snapshots", "DR001_DOWNLOAD_SNAPSHOT"],
  ["DR002: no-replace commit preserves a winner and removes the losing temp", "DR002_NOREPLACE_LOSER_TEMP"],
  ["DR002: upload begin fails safely when the destination lacks atomic no-replace support", "DR002_NO_ATOMIC_REPLACE"],
  ["DR003: protected config aliases cannot be read, searched, or reached by a swapped upload temp", "DR003_PROTECTED_CONFIG_ALIASES"],
  ["DR003: a config replacement during pin linking preserves known history and the final config", "DR003_PIN_LINK_REPLACEMENT_RACE"],
  ["DR003: exact bigint identity keys distinguish adjacent unsafe ids while preserving ordinary reads", "DR003_EXACT_BIGINT_IDENTITY"],
  ["DR003: protected identity manifests accept safe legacy values and fail closed on unsafe numeric values", "DR003_IDENTITY_MANIFEST_RANGE"],
]);
export const STARTUP_DIAGNOSTIC_TEST_CASE_IDS = Object.freeze(TEST_CASES.map(([, caseId]) => caseId));
const TEST_CASE_IDS = new Set(TEST_CASES.map(([, caseId]) => caseId));
const TEST_CASES_BY_NAME = new Map(TEST_CASES);
const SAFE_STARTUP_ERROR_CLASSES = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "McpError", "SystemError", "unknown"]);
const SAFE_TEST_ERROR_CLASSES = new Set([...SAFE_STARTUP_ERROR_CLASSES, "AssertionError"]);
const SAFE_STARTUP_ERROR_CODES = new Set(["ENOENT", "EACCES", "EPERM", "EISDIR", "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_UNKNOWN_FILE_EXTENSION", "ERR_INVALID_MODULE_SPECIFIER", "ERR_UNSUPPORTED_DIR_IMPORT", "ERR_REQUIRE_ESM", "unknown"]);
const SAFE_TEST_ERROR_CODES = new Set([...SAFE_STARTUP_ERROR_CODES, "EBUSY", "EEXIST", "EXDEV", "ENOTSUP", "ERR_ASSERTION", "ERR_INVALID_ARG_TYPE", "ERR_OUT_OF_RANGE", "ABORT_ERR"]);
const ENUMS = {
  phase: new Set(["fixture", "fixture_workspace", "fixture_validation_directory", "fixture_validation_path_validation", "fixture_base_directory", "fixture_base_path_validation", "fixture_root_data_directories", "fixture_private_storage", "fixture_service_construction", "initialize", "transport_connect", "list_tools", "root_verification", "bootstrap", "config_manager", "ownership_bridge", "terminal_manager", "entry_import", "cleanup", "npm_ci", "test", "overlay_restore"]),
  classification: new Set(["spawn_failure", "entry_import_failure", "initialize_disconnect", "other", "unknown"]),
  errorClass: SAFE_TEST_ERROR_CLASSES,
  errorCode: SAFE_TEST_ERROR_CODES,
  role: new Set(["node_exec_path", "bootstrap", "dc_entry", "fixture_config", "test_worktree"]),
  argsShape: new Set(["managed_bootstrap_entry_config_forwarded", "direct_entry_and_flags", "unknown"]),
  cwdRole: new Set(["test_worktree"]),
  envPolicy: new Set(["process_env_minus_credential_blocklist"]),
  outcome: new Set(["success", "failure", "timeout", "unknown"]),
  caseId: TEST_CASE_IDS,
  collectionStatus: new Set(["running", "complete", "incomplete", "invalid", "failed", "unavailable"]),
  signal: new Set(["SIGABRT", "SIGBREAK", "SIGFPE", "SIGILL", "SIGINT", "SIGSEGV", "SIGTERM", "SIGKILL", "unknown"]),
};

const identityPath = path.join(process.cwd(), "ci-artifacts", "paired-startup-diagnostic", "identity.json");
export function diagnosticEventPath(directory, producerId) {
  if (producerId !== "driver" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(producerId)) {
    throw new Error("Paired startup diagnostic producer id is invalid.");
  }
  return path.join(directory, `events-${producerId}.jsonl`);
}
const eventsPath = diagnosticEventPath(path.dirname(identityPath), randomUUID());
let identity;

function loadIdentity() {
  if (identity) return identity;
  const parsed = JSON.parse(readFileSync(identityPath, "utf8"));
  if (!parsed || !["baseline", "candidate"].includes(parsed.side)
    || !/^\d+$/.test(parsed.runId ?? "") || !/^[a-f0-9]{40}$/.test(parsed.sha ?? "")) {
    throw new Error("Paired startup diagnostic identity is invalid.");
  }
  identity = parsed;
  return identity;
}

function safeFields(fields, event) {
  const result = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (!FIELD_NAMES.has(key)) throw new Error("Paired startup diagnostic field is not allowlisted.");
    if (key === "present") {
      if (typeof value !== "boolean") throw new Error("Paired startup diagnostic presence must be boolean.");
      result[key] = value;
    } else if (key === "shell") {
      if (typeof value !== "boolean") throw new Error("Paired startup diagnostic shell flag must be boolean.");
      result[key] = value;
    } else if (key === "exitCode") {
      if (value !== null && (!Number.isInteger(value) || value < 0 || value > 255)) throw new Error("Paired startup diagnostic exit code is invalid.");
      result[key] = value;
    } else if (value !== undefined) {
      const allowed = key === "errorClass" && event !== "test_case_result" ? SAFE_STARTUP_ERROR_CLASSES
        : key === "errorCode" && event !== "test_case_result" ? SAFE_STARTUP_ERROR_CODES : ENUMS[key];
      if (typeof value !== "string" || !allowed?.has(value)) throw new Error("Paired startup diagnostic value is not allowlisted.");
      result[key] = value;
    }
  }
  if (event === "test_case_result") {
    const keys = new Set(["phase", "caseId", "outcome", "errorClass", "errorCode"]);
    if (Object.keys(result).some((key) => !keys.has(key)) || result.phase !== "test" || !TEST_CASE_IDS.has(result.caseId)
      || !["success", "failure"].includes(result.outcome)) throw new Error("Paired test result is outside the safe schema.");
    if (result.outcome === "success" && (result.errorClass !== undefined || result.errorCode !== undefined)) throw new Error("Successful test result cannot include error identity.");
    if (result.outcome === "failure" && (!SAFE_TEST_ERROR_CLASSES.has(result.errorClass) || !SAFE_TEST_ERROR_CODES.has(result.errorCode))) {
      throw new Error("Failed test result must include safe error identity.");
    }
  }
  if (event === "test_results_collection") {
    const keys = new Set(["phase", "collectionStatus"]);
    if (Object.keys(result).some((key) => !keys.has(key)) || result.phase !== "test"
      || !ENUMS.collectionStatus.has(result.collectionStatus)) throw new Error("Paired test collection state is outside the safe schema.");
  }
  return result;
}

export function emitStartupDiagnostic(event, fields = {}) {
  if (!EVENTS.has(event)) throw new Error("Paired startup diagnostic event is not allowlisted.");
  const current = loadIdentity();
  let seq = 1;
  try {
    const prior = readFileSync(eventsPath, "utf8");
    const rows = prior.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    seq = (rows.at(-1)?.seq ?? 0) + 1;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const row = { side: current.side, runId: current.runId, sha: current.sha, seq, event, ...safeFields(fields, event) };
  appendFileSync(eventsPath, `${JSON.stringify(row)}\n`, { flag: "a" });
}

function emitBestEffort(emit, event, fields) {
  try { emit(event, fields); } catch { /* diagnostics must never change startup behavior */ }
}

export async function importEntryWithSafeDiagnosticMarkers(importEntry, emit = emitStartupDiagnostic) {
  let result;
  try { result = await importEntry(); }
  catch (error) {
    const safe = safeStartupError(error);
    emitBestEffort(emit, "bootstrap_entry_import_failed", {
      phase: "entry_import", classification: "entry_import_failure", errorClass: safe.errorClass,
      errorCode: safe.errorCode, outcome: "failure", exitCode: null, signal: "unknown",
    });
    throw error;
  }
  emitBestEffort(emit, "bootstrap_entry_import_succeeded", { phase: "entry_import", outcome: "success" });
  return result;
}

export async function guardFixturePreparation(prepare, { keepAlive, clearTimer = clearInterval, emit = emitStartupDiagnostic, cleanup = async () => undefined } = {}) {
  let phase = "fixture_workspace";
  try {
    const fixture = await prepare((nextPhase) => { phase = nextPhase; });
    emitBestEffort(emit, "fixture_prepare_ready", { phase: "fixture", outcome: "success" });
    return fixture;
  } catch (error) {
    try { clearTimer(keepAlive); } catch { /* preserve the preparation error */ }
    const safe = safeStartupError(error);
    const fields = { phase, classification: safe.classification, errorClass: safe.errorClass, errorCode: safe.errorCode };
    emitBestEffort(emit, "fixture_prepare_failed", fields);
    if (phase === "initialize") emitBestEffort(emit, "fixture_initialize_failed", fields);
    try { await cleanup(); } catch { /* preserve the preparation error */ }
    throw error;
  }
}

export function safeStartupError(error) {
  const names = SAFE_STARTUP_ERROR_CLASSES;
  const codes = SAFE_STARTUP_ERROR_CODES;
  const errorClass = error && typeof error.name === "string" && names.has(error.name) ? error.name : "unknown";
  const errorCode = error && typeof error.code === "string" && codes.has(error.code) ? error.code : "unknown";
  const classification = errorCode === "ENOENT" || errorCode === "EACCES" || errorCode === "EPERM"
    ? "spawn_failure"
    : errorClass === "McpError" ? "initialize_disconnect" : "other";
  return { errorClass, errorCode, classification };
}

function safeTestReporterError(error) {
  let current = error;
  let errorClass = "unknown";
  let genericErrorClass = "unknown";
  let errorCode = "unknown";
  const safeCodes = SAFE_TEST_ERROR_CODES;
  for (let depth = 0; current && typeof current === "object" && depth < 4; depth++) {
    let name;
    let code;
    let cause;
    try { name = current.name; code = current.code; cause = current.cause; } catch { break; }
    if (typeof name === "string" && SAFE_TEST_ERROR_CLASSES.has(name)) {
      if (name === "Error") {
        if (code !== "ERR_TEST_FAILURE") genericErrorClass = "Error";
      } else errorClass = name;
    }
    if (errorCode === "unknown" && typeof code === "string" && code !== "ERR_TEST_FAILURE" && safeCodes.has(code)) errorCode = code;
    current = cause;
  }
  return { errorClass: errorClass === "unknown" ? genericErrorClass : errorClass, errorCode };
}

export default async function* startupDiagnosticTestReporter(source) {
  const observed = new Set();
  let summaryObserved = false;
  let invalid = false;
  for await (const event of source) {
    if (event?.type === "test:summary") summaryObserved = true;
    if (event?.type !== "test:pass" && event?.type !== "test:fail") continue;
    const data = event.data;
    if (!data || typeof data !== "object" || typeof data.nesting !== "number" || typeof data.name !== "string"
      || !data.details || typeof data.details !== "object" || typeof data.details.type !== "string") {
      invalid = true;
      continue;
    }
    if (data.details.type !== "test") continue;
    const caseId = TEST_CASES_BY_NAME.get(data.name);
    if (data.nesting !== 0) {
      invalid = true;
      continue;
    }
    if (!caseId || observed.has(caseId)) {
      invalid = true;
      continue;
    }
    observed.add(caseId);
    const outcome = event.type === "test:pass" ? "success" : "failure";
    const result = { kind: "case", caseId, outcome };
    if (outcome === "failure") Object.assign(result, safeTestReporterError(data.details?.error));
    yield `${JSON.stringify(result)}\n`;
  }
  const collectionStatus = invalid ? "invalid" : summaryObserved && observed.size === TEST_CASES.length ? "complete" : "incomplete";
  yield `${JSON.stringify({ kind: "collection", collectionStatus })}\n`;
}
