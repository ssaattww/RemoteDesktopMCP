import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, open, readFile, realpath, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

export const SCHEDULER_ARTIFACT_VERSION = 1;
const TEST_FILE = /^test\/(?:[^/]+\/)*[^/]+\.test\.ts$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const ENVIRONMENT_KEYS = ["runnerLabel", "runnerOS", "process.platform", "process.arch", "os.release", "nodeVersion", "npmVersion", "packageLockSha256"];
const PLAN_KEYS = ["schemaVersion", "sourceCommit", "workflowRunId", "runAttempt", "shardCount", "generatedAt", "fingerprint", "mode", "manifestStatus", "assignments", "planDigest"];

const ordinal = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function assertUtc(value, name) {
  const match = typeof value === "string" ? /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,3}))?Z$/.exec(value) : null;
  const timestamp = match ? Date.parse(value) : Number.NaN;
  if (!match || !Number.isFinite(timestamp)) {
    throw new Error(`${name} must be a valid UTC ISO-8601 timestamp.`);
  }
  const date = new Date(timestamp);
  const expected = match.slice(1, 7).map(Number);
  const actual = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()];
  const expectedMilliseconds = Number((match[7] ?? "").padEnd(3, "0"));
  if (expected.some((part, index) => part !== actual[index]) || date.getUTCMilliseconds() !== expectedMilliseconds) {
    throw new Error(`${name} must be a valid UTC ISO-8601 timestamp.`);
  }
  return timestamp;
}

function safeManifestPath(file) {
  if (typeof file !== "string" || file.includes("\\") || file.includes("\0") || !TEST_FILE.test(file)) throw new Error(`Invalid manifest test path: ${String(file)}`);
  const parts = file.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`Invalid manifest test path: ${file}`);
  return file;
}

export async function normalizeTestPath(file, root) {
  if (typeof file !== "string" || !file || file.includes("\\") || file.includes("\0") || path.isAbsolute(file) || /^[a-z]:/i.test(file)) {
    throw new Error(`Test path must be a normalized repository-relative path: ${String(file)}`);
  }
  safeManifestPath(file);
  const absoluteRoot = await realpath(root);
  const parts = file.split("/");
  let current = absoluteRoot;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`Test path contains a symbolic link: ${file}`);
  }
  const actual = await realpath(current);
  const relative = path.relative(absoluteRoot, actual);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Test path escapes repository root: ${file}`);
  if (!(await lstat(actual)).isFile()) throw new Error(`Test path is not a regular file: ${file}`);
  return file;
}

export function buildAssignments(files, shardCount, mode, durations) {
  if (!Number.isInteger(shardCount) || shardCount <= 0) throw new Error("shardCount must be a positive integer.");
  const normalized = [...files].sort(ordinal);
  if (!normalized.length) throw new Error("The tracked test universe is empty.");
  if (new Set(normalized).size !== normalized.length || normalized.some((file) => !TEST_FILE.test(file))) throw new Error("The tracked test universe contains duplicate or disallowed paths.");
  if (mode !== "baseline" && mode !== "optimized") throw new Error(`Unsupported assignment mode: ${mode}`);
  const buckets = Array.from({ length: shardCount }, (_, index) => ({ shardId: index + 1, files: [], total: 0 }));
  if (mode === "baseline") {
    normalized.forEach((file, index) => buckets[index % shardCount].files.push(file));
  } else {
    const ranked = normalized.map((file) => {
      const duration = durations?.[file];
      if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Missing or invalid duration for ${file}.`);
      return { file, duration };
    }).sort((a, b) => b.duration - a.duration || ordinal(a.file, b.file));
    for (const item of ranked) {
      buckets.sort((a, b) => a.total - b.total || a.shardId - b.shardId);
      buckets[0].files.push(item.file);
      buckets[0].total += item.duration;
    }
  }
  return buckets.sort((a, b) => a.shardId - b.shardId).map(({ shardId, files: assigned, total }) => ({
    shardId, files: assigned.sort(ordinal), estimatedDurationMs: total,
  }));
}

export function validatePartition(files, assignments, shardCount) {
  if (!Array.isArray(assignments) || assignments.length !== shardCount) throw new Error("Assignment shard count is invalid.");
  const expected = new Set(files);
  const seen = new Set();
  assignments.forEach((assignment, index) => {
    if (!assignment || Object.keys(assignment).sort(ordinal).join("\0") !== ["estimatedDurationMs", "files", "shardId"].sort(ordinal).join("\0") || assignment.shardId !== index + 1 || !Array.isArray(assignment.files)) throw new Error("Assignment shard identifiers, schema, or file lists are invalid.");
    if (!Number.isFinite(assignment.estimatedDurationMs) || assignment.estimatedDurationMs < 0) throw new Error("Assignment duration is invalid.");
    if (assignment.files.some((file, i) => !safeManifestPath(file) || (i > 0 && ordinal(assignment.files[i - 1], file) >= 0))) throw new Error("Assignment file ordering or path is invalid.");
    for (const file of assignment.files) {
      if (!expected.has(file)) throw new Error(`Assignment contains an unknown file: ${file}`);
      if (seen.has(file)) throw new Error(`Assignment contains a duplicate file: ${file}`);
      seen.add(file);
    }
  });
  if (seen.size !== expected.size || [...expected].some((file) => !seen.has(file))) throw new Error("Assignment coverage does not exactly match the tracked test universe.");
  return assignments;
}

export function normalizeEnvironment(environment) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment) || Object.keys(environment).sort(ordinal).join("\0") !== [...ENVIRONMENT_KEYS].sort(ordinal).join("\0")) {
    throw new Error("Environment identity fields are invalid.");
  }
  const normalized = {};
  for (const key of ENVIRONMENT_KEYS) {
    if (typeof environment[key] !== "string" || !environment[key] || /[\r\n\0]/.test(environment[key])) throw new Error(`Environment identity ${key} is missing or invalid.`);
    normalized[key] = environment[key];
  }
  if (!SHA256.test(normalized.packageLockSha256)) throw new Error("packageLockSha256 must be a lowercase SHA-256 value.");
  return normalized;
}

export function fingerprintInputs(inventory, environment) {
  const identity = normalizeEnvironment(environment);
  const entries = [...inventory].sort((a, b) => ordinal(a.path, b.path));
  if (new Set(entries.map(({ path: file }) => file)).size !== entries.length) throw new Error("Fingerprint inventory contains duplicate paths.");
  const hash = createHash("sha256");
  for (const entry of entries) {
    if (typeof entry.path !== "string" || !entry.path || /[\0\r\n]/.test(entry.path)) throw new Error("Fingerprint inventory path is invalid.");
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content);
    hash.update(entry.path).update("\0").update(sha256(content)).update("\n");
  }
  hash.update(JSON.stringify(identity));
  return hash.digest("hex");
}

function validateManifestShape(manifest) {
  const keys = ["schemaVersion", "generatedAt", "sourceCommit", "fingerprint", "environment", "files"].sort(ordinal);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || Object.keys(manifest).sort(ordinal).join("\0") !== keys.join("\0")) throw new Error("Manifest schema fields are invalid.");
  if (manifest.schemaVersion !== 1) throw new Error("Manifest schemaVersion is unsupported.");
  assertUtc(manifest.generatedAt, "generatedAt");
  if (typeof manifest.sourceCommit !== "string" || !COMMIT.test(manifest.sourceCommit)) throw new Error("Manifest sourceCommit is invalid.");
  if (typeof manifest.fingerprint !== "string" || !SHA256.test(manifest.fingerprint)) throw new Error("Manifest fingerprint is invalid.");
  normalizeEnvironment(manifest.environment);
  if (!Array.isArray(manifest.files)) throw new Error("Manifest files must be an array.");
  if (manifest.files.length === 0) throw new Error("Manifest files must not be empty.");
  let previous = "";
  const seen = new Set();
  for (const item of manifest.files) {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).sort(ordinal).join("\0") !== ["medianDurationMs", "path"].sort(ordinal).join("\0")) throw new Error("Manifest file entry schema is invalid.");
    safeManifestPath(item.path);
    if (seen.has(item.path)) throw new Error(`Manifest contains duplicate path: ${item.path}`);
    if (previous && ordinal(previous, item.path) >= 0) throw new Error("Manifest file paths must be in ordinal ascending order.");
    if (!Number.isFinite(item.medianDurationMs) || item.medianDurationMs <= 0) throw new Error(`Manifest duration is invalid for ${item.path}.`);
    previous = item.path;
    seen.add(item.path);
  }
}

export function selectManifest(manifest, context) {
  const created = assertUtc(context.createdAt, "workflow created_at");
  const files = [...context.files].sort(ordinal);
  if (!files.length) throw new Error("The tracked test universe is empty.");
  if (manifest === null || manifest === undefined) return { mode: "baseline", manifestStatus: "missing", durations: {} };
  validateManifestShape(manifest);
  const generated = Date.parse(manifest.generatedAt);
  if (generated > created) throw new Error("Manifest generatedAt is in the future relative to the workflow created_at.");
  if (created - generated > 30 * 24 * 60 * 60 * 1000) return { mode: "baseline", manifestStatus: "stale", durations: {} };
  if (!SHA256.test(context.fingerprint ?? "")) throw new Error("Manifest content fingerprint is invalid.");
  if (manifest.fingerprint !== context.fingerprint) return { mode: "baseline", manifestStatus: "fingerprint-mismatch", durations: {} };
  if (manifest.files.length !== files.length || manifest.files.some((entry, index) => entry.path !== files[index])) throw new Error("Manifest file coverage does not exactly match the tracked test universe.");
  return { mode: "optimized", manifestStatus: "applied", durations: Object.fromEntries(manifest.files.map(({ path: file, medianDurationMs }) => [file, medianDurationMs])) };
}

function stablePlanFields(plan) {
  const result = {};
  for (const key of PLAN_KEYS.filter((item) => item !== "planDigest")) {
    result[key] = key === "assignments" && Array.isArray(plan.assignments)
      ? plan.assignments.map((assignment) => ({ shardId: assignment.shardId, files: assignment.files, estimatedDurationMs: assignment.estimatedDurationMs }))
      : plan[key];
  }
  return result;
}

export function buildPlan(input) {
  if (!COMMIT.test(input.sourceCommit) || !Number.isSafeInteger(input.workflowRunId) || input.workflowRunId <= 0 || !Number.isSafeInteger(input.runAttempt) || input.runAttempt <= 0 || !Number.isInteger(input.shardCount) || input.shardCount <= 0) throw new Error("Plan source, workflow identity, or shard count is invalid.");
  assertUtc(input.generatedAt, "generatedAt");
  if (!SHA256.test(input.fingerprint)) throw new Error("Plan fingerprint is invalid.");
  if (!(["applied", "missing", "stale", "fingerprint-mismatch"].includes(input.manifestStatus))) throw new Error("Plan manifestStatus is invalid.");
  if (input.mode !== (input.manifestStatus === "applied" ? "optimized" : "baseline")) throw new Error("Plan mode does not match manifestStatus.");
  const assignments = buildAssignments(input.files, input.shardCount, input.mode, input.durations);
  const plan = {
    schemaVersion: SCHEDULER_ARTIFACT_VERSION,
    sourceCommit: input.sourceCommit,
    workflowRunId: input.workflowRunId,
    runAttempt: input.runAttempt,
    shardCount: input.shardCount,
    generatedAt: input.generatedAt,
    fingerprint: input.fingerprint,
    mode: input.mode,
    manifestStatus: input.manifestStatus,
    assignments,
  };
  plan.planDigest = sha256(JSON.stringify(stablePlanFields(plan)));
  validatePartition([...input.files].sort(ordinal), assignments, input.shardCount);
  return plan;
}

export function validatePlan(plan, expected) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan) || Object.keys(plan).sort(ordinal).join("\0") !== [...PLAN_KEYS].sort(ordinal).join("\0")) throw new Error("Scheduler plan schema fields are invalid.");
  if (plan.schemaVersion !== SCHEDULER_ARTIFACT_VERSION) throw new Error("Scheduler plan schemaVersion is unsupported.");
  if (plan.sourceCommit !== expected.sourceCommit) throw new Error("Scheduler plan sourceCommit does not match checkout.");
  if (plan.workflowRunId !== expected.workflowRunId) throw new Error("Scheduler plan workflowRunId does not match this run.");
  if (plan.runAttempt !== expected.runAttempt) throw new Error("Scheduler plan runAttempt does not match this attempt.");
  if (plan.shardCount !== expected.shardCount) throw new Error("Scheduler plan shardCount does not match matrix size.");
  assertUtc(plan.generatedAt, "generatedAt");
  if (!SHA256.test(plan.fingerprint) || !SHA256.test(plan.planDigest)) throw new Error("Scheduler plan digest fields are invalid.");
  if (!["applied", "missing", "stale", "fingerprint-mismatch"].includes(plan.manifestStatus)) throw new Error("Scheduler plan manifestStatus is invalid.");
  if (plan.mode !== (plan.manifestStatus === "applied" ? "optimized" : "baseline")) throw new Error("Scheduler plan mode is inconsistent with manifest status.");
  const calculated = sha256(JSON.stringify(stablePlanFields(plan)));
  if (calculated !== plan.planDigest) throw new Error("Scheduler plan digest does not match its contents.");
  validatePartition(expected.files, plan.assignments, expected.shardCount);
  return plan;
}

export function validateRunMetadata(metadata, expected) {
  if (!metadata || metadata.id !== expected.runId) throw new Error("Workflow run metadata id does not match this run.");
  if (metadata.repository?.full_name !== expected.repository) throw new Error("Workflow run metadata repository does not match.");
  if (metadata.head_sha !== expected.triggerHeadSha) throw new Error("Workflow run metadata head_sha does not match the triggering commit.");
  if (metadata.run_attempt !== expected.runAttempt) throw new Error("Workflow run metadata run_attempt does not match.");
  assertUtc(metadata.created_at, "workflow run created_at");
  return metadata.created_at;
}

export function resolveTriggerHeadSha(eventName, event, sourceCommit) {
  if (!COMMIT.test(sourceCommit ?? "") || !event || typeof event !== "object") throw new Error("Workflow checkout or event identity is invalid.");
  if (eventName === "pull_request") {
    const headSha = event.pull_request?.head?.sha;
    if (!COMMIT.test(headSha ?? "")) throw new Error("Pull request event does not contain a valid head commit SHA.");
    return headSha;
  }
  if (eventName === "push") {
    const after = event.after;
    if (!COMMIT.test(after ?? "") || after !== sourceCommit) throw new Error("Push event commit does not match the workflow checkout.");
    return after;
  }
  if (eventName === "workflow_dispatch") {
    if (typeof event.ref !== "string" || !event.ref) throw new Error("Workflow dispatch event does not contain a ref.");
    return sourceCommit;
  }
  throw new Error(`Unsupported workflow event: ${String(eventName)}`);
}

export function validateWorkflowIdentity(identity, expected) {
  const baseKeys = ["schemaVersion", "repository", "runId", "runAttempt", "sourceCommit", "triggerHeadSha", "createdAt"];
  const keys = identity?.workflowJobId === undefined ? baseKeys : [...baseKeys, "workflowJobId"];
  if (!identity || typeof identity !== "object" || Array.isArray(identity) || Object.keys(identity).sort(ordinal).join("\0") !== keys.sort(ordinal).join("\0")) throw new Error("Workflow identity file schema is invalid.");
  if (identity.schemaVersion !== 1 || identity.repository !== expected.repository || identity.runId !== expected.runId || identity.runAttempt !== expected.runAttempt) throw new Error("Workflow identity repository, run id, attempt, or schema does not match this run.");
  if (!COMMIT.test(identity.sourceCommit ?? "") || identity.sourceCommit !== expected.sourceCommit || !COMMIT.test(identity.triggerHeadSha ?? "")) throw new Error("Workflow identity source or triggering commit does not match.");
  assertUtc(identity.createdAt, "workflow identity createdAt");
  if (identity.workflowJobId !== undefined && (!Number.isSafeInteger(identity.workflowJobId) || identity.workflowJobId <= 0)) throw new Error("Workflow identity job id is invalid.");
  return identity;
}

export function validateRuntimeFingerprint(plan, currentFingerprint) {
  if (plan.mode === "optimized" && currentFingerprint !== plan.fingerprint) throw new Error("Measured environment or fingerprint differs from the shared scheduler plan.");
  return true;
}

function createDispatchDiagnostic(plan, shardId) {
  return {
    schemaVersion: 1,
    planDigest: SHA256.test(plan?.planDigest ?? "") ? plan.planDigest : null,
    mode: ["baseline", "optimized"].includes(plan?.mode) ? plan.mode : null,
    shardId: Number.isSafeInteger(shardId) ? shardId : null,
    files: [],
    overallValidation: { status: "not_run", result: "shared plan validation has not run" },
    environmentCheck: { status: "not_applicable", result: "environment check has not run" },
    safeFailureReason: null,
  };
}

export function dispatchPlan(plan, expected, shardId, currentFingerprint) {
  const diagnostic = createDispatchDiagnostic(plan, shardId);
  const fail = (safeFailureReason) => ({ ok: false, files: [], diagnostic: { ...diagnostic, safeFailureReason } });
  try {
    validatePlan(plan, expected);
    diagnostic.overallValidation = { status: "success", result: "schema, run identity, digest, and exact file coverage passed" };
  } catch {
    diagnostic.overallValidation = { status: "failure", result: "shared plan validation failed" };
    return fail("shared_plan_invalid");
  }

  if (!Number.isInteger(shardId) || shardId < 1 || shardId > plan.shardCount) return fail("shard_id_invalid");
  diagnostic.files = [...plan.assignments[shardId - 1].files];

  if (plan.mode === "optimized") {
    diagnostic.environmentCheck = { status: "failure", result: "optimized environment has not been validated" };
    if (!SHA256.test(currentFingerprint ?? "")) return fail("optimized_environment_unavailable");
    try {
      validateRuntimeFingerprint(plan, currentFingerprint);
      diagnostic.environmentCheck = { status: "success", result: "shard environment and tracked content match the manifest fingerprint" };
    } catch {
      return fail("optimized_environment_mismatch");
    }
  } else {
    diagnostic.environmentCheck = { status: "not_applicable", result: "baseline assignment does not depend on manifest environment" };
  }

  return { ok: true, files: diagnostic.files, diagnostic };
}

export async function getTrackedTestFiles(root) {
  const output = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "buffer" });
  const paths = output.toString("utf8").split("\0").filter((file) => TEST_FILE.test(file));
  if (!paths.length) throw new Error("The tracked test universe is empty.");
  const normalized = await Promise.all(paths.map((file) => normalizeTestPath(file, root)));
  return [...new Set(normalized)].sort(ordinal);
}

export async function captureEnvironment(root) {
  const label = process.env.CI_RUNNER_LABEL;
  if (!label) throw new Error("CI_RUNNER_LABEL is required.");
  const lock = await readFile(path.join(root, "package-lock.json"));
  const npm = process.env.CI_NPM_VERSION;
  if (!npm || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(npm)) throw new Error("CI_NPM_VERSION must contain the exact npm version.");
  return normalizeEnvironment({
    runnerLabel: label,
    runnerOS: process.env.RUNNER_OS ?? os.platform(),
    "process.platform": process.platform,
    "process.arch": process.arch,
    "os.release": os.release(),
    nodeVersion: process.version,
    npmVersion: npm,
    packageLockSha256: sha256(lock),
  });
}

export async function computeFingerprint(root, environment) {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "buffer" }).toString("utf8").split("\0").filter(Boolean);
  const include = (file) => TEST_FILE.test(file) || /^test\/.+\.ts$/.test(file) || /^src\/.+\.ts$/.test(file) || [
    "package.json", "package-lock.json", "scripts/ci-test-scheduler.mjs", "scripts/ci-test-measurement.mjs",
    ".github/workflows/lint.yml", ".github/workflows/test-runtime-measurement.yml",
  ].includes(file);
  const inventory = [];
  for (const file of tracked.filter(include).sort(ordinal)) {
    const absolute = path.join(root, ...file.split("/"));
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Fingerprint input must be a regular tracked file: ${file}`);
    inventory.push({ path: file, content: await readFile(absolute) });
  }
  if (!inventory.some(({ path: file }) => file === "package-lock.json")) throw new Error("package-lock.json is absent from tracked fingerprint inputs.");
  return fingerprintInputs(inventory, environment);
}

async function getRunMetadata() {
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = Number(process.env.GITHUB_RUN_ID);
  const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  const sourceCommit = process.env.GITHUB_SHA;
  const token = process.env.CI_GITHUB_TOKEN;
  if (!repository || !Number.isSafeInteger(runId) || !Number.isSafeInteger(runAttempt) || !COMMIT.test(sourceCommit ?? "")) throw new Error("GitHub workflow run identity is incomplete.");
  if (!token) throw new Error("CI_GITHUB_TOKEN is required to read workflow run metadata.");
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required to validate the triggering commit.");
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const triggerHeadSha = resolveTriggerHeadSha(process.env.GITHUB_EVENT_NAME, event, sourceCommit);
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${runId}`, { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" } });
  if (!response.ok) throw new Error(`Workflow run metadata request failed with HTTP ${response.status}.`);
  const metadata = await response.json();
  const createdAt = validateRunMetadata(metadata, { repository, runId, runAttempt, sourceCommit, triggerHeadSha });
  const identity = { schemaVersion: 1, repository, runId, runAttempt, sourceCommit, triggerHeadSha, createdAt };
  const jobName = process.env.CI_JOB_NAME;
  if (jobName) {
    const jobsResponse = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${runId}/jobs?per_page=100`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!jobsResponse.ok) throw new Error(`Workflow job metadata request failed with HTTP ${jobsResponse.status}.`);
    const payload = await jobsResponse.json();
    const matches = payload.jobs?.filter((job) => job.name === jobName && job.run_id === runId) ?? [];
    if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id) || matches[0].id <= 0) throw new Error("Could not uniquely identify the workflow job.");
    identity.workflowJobId = matches[0].id;
  }
  return identity;
}

export const getWorkflowRunMetadata = getRunMetadata;

async function loadManifest(root) {
  const directory = path.join(root, ".github");
  const directoryInfo = await lstat(directory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) throw new Error("Manifest directory must be a regular directory.");
  const file = path.join(root, ".github", "test-duration-manifest.json");
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Manifest path must be a regular file, not a symbolic link or directory.");
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readWorkflowIdentity(root, file) {
  const identity = JSON.parse(await readFile(path.resolve(root, file), "utf8"));
  return validateWorkflowIdentity(identity, {
    repository: process.env.GITHUB_REPOSITORY,
    runId: Number(process.env.GITHUB_RUN_ID),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    sourceCommit: process.env.GITHUB_SHA,
  });
}

async function writeDispatchDiagnostic(root, output, diagnostic, { exclusive = false } = {}) {
  if (typeof output !== "string" || !output || path.isAbsolute(output)) throw new Error("--diagnostic-output must be a repository-relative file path.");
  const target = path.resolve(root, output);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("--diagnostic-output must remain inside the repository root.");
  const parent = path.dirname(target);
  let current = root;
  for (const segment of path.relative(root, parent).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const parentInfo = await lstat(current);
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) throw new Error("Diagnostic output directory must contain only regular directories.");
  }
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("Diagnostic output must be a regular file.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const content = `${JSON.stringify(diagnostic, null, 2)}\n`;
  if (exclusive) {
    const handle = await open(target, "wx");
    try { await handle.writeFile(content); } finally { await handle.close(); }
  } else {
    await writeFile(target, content);
  }
}

export function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith("--") || i + 1 >= args.length) throw new Error(`Invalid command argument: ${args[i]}`);
    const name = args[i].slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    result[name] = args[i + 1];
  }
  return result;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const root = path.resolve(args.root ?? process.cwd());
  if (command === "init-diagnostic") {
    const shardId = Number(args.shardId);
    if (!args.output || !Number.isSafeInteger(shardId) || shardId < 1) throw new Error("Diagnostic output and a positive shard id are required.");
    const diagnostic = createDispatchDiagnostic(null, shardId);
    diagnostic.overallValidation = { status: "not_run", result: "scheduler dispatch has not completed" };
    diagnostic.environmentCheck = { status: "not_applicable", result: "scheduler dispatch has not completed" };
    diagnostic.safeFailureReason = "scheduler_dispatch_not_completed";
    await writeDispatchDiagnostic(root, args.output, diagnostic, { exclusive: true });
    return;
  }
  if (command === "metadata") {
    if (!args.output) throw new Error("--output is required for workflow metadata.");
    const identity = await getRunMetadata();
    await writeFile(path.resolve(root, args.output), `${JSON.stringify(identity, null, 2)}\n`, { flag: "wx" });
    return;
  }
  if (command === "plan") {
    const output = args.output;
    if (!output) throw new Error("--output is required for plan generation.");
    const identity = await readWorkflowIdentity(root, args.metadata ?? "ci-artifacts/workflow-metadata.json");
    const files = await getTrackedTestFiles(root);
    const manifest = await loadManifest(root);
    if (manifest !== null) validateManifestShape(manifest);
    const fingerprintEnvironment = manifest?.environment ?? await captureEnvironment(root);
    const fingerprint = await computeFingerprint(root, fingerprintEnvironment);
    const selected = selectManifest(manifest, { files, fingerprint, createdAt: identity.createdAt });
    const plan = buildPlan({ ...identity, workflowRunId: identity.runId, shardCount: Number(args.shardCount ?? 3), generatedAt: identity.createdAt,
      fingerprint, manifestStatus: selected.manifestStatus, mode: selected.mode, files, durations: selected.durations });
    await writeFile(path.resolve(root, output), `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
    return;
  }
  if (command === "dispatch") {
    if (!args.diagnosticOutput) throw new Error("--diagnostic-output is required for shard dispatch.");
    const shardId = Number(args.shardId);
    let plan = null;
    let dispatch = null;
    let diagnostic = createDispatchDiagnostic(null, shardId);
    try {
      const input = await readFile(path.resolve(root, args.plan), "utf8");
      plan = JSON.parse(input);
      diagnostic = createDispatchDiagnostic(plan, shardId);
      const files = await getTrackedTestFiles(root);
      const expected = { sourceCommit: process.env.GITHUB_SHA, workflowRunId: Number(process.env.GITHUB_RUN_ID),
        runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT), shardCount: Number(args.shardCount ?? 3), files };
      let currentFingerprint;
      if (plan?.mode === "optimized") {
        try {
          const environment = await captureEnvironment(root);
          currentFingerprint = await computeFingerprint(root, environment);
        } catch {
          currentFingerprint = undefined;
        }
      }
      dispatch = dispatchPlan(plan, expected, shardId, currentFingerprint);
      diagnostic = dispatch.diagnostic;
    } catch {
      diagnostic.overallValidation = { status: "failure", result: "shared plan could not be read or parsed" };
      diagnostic.safeFailureReason = "shared_plan_unreadable";
    }
    await writeDispatchDiagnostic(root, args.diagnosticOutput, diagnostic);
    if (!dispatch?.ok) {
      const safeReason = diagnostic.safeFailureReason ?? "shared_plan_unreadable";
      throw new Error(safeReason);
    }
    process.stdout.write(`${JSON.stringify({ files: dispatch.files, diagnostic })}\n`);
    return;
  }
  throw new Error("Command must be plan or dispatch.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
