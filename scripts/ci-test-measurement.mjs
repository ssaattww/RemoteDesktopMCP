import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCHEDULER_ARTIFACT_VERSION,
  assertUtc,
  captureEnvironment,
  computeFingerprint,
  getTrackedTestFiles,
  getWorkflowRunMetadata,
  normalizeEnvironment,
} from "./ci-test-scheduler.mjs";

const RECORD_SCHEMA = 1;
const COMMIT = /^[a-f0-9]{40}$/;
const ENVIRONMENT_KEYS = ["runnerLabel", "runnerOS", "process.platform", "process.arch", "os.release", "nodeVersion", "npmVersion", "packageLockSha256"];
let activeChild;
let cancelled = false;

const sameEnvironment = (left, right) => ENVIRONMENT_KEYS.every((key) => left[key] === right[key]);

export function createMeasurementRecord(input) {
  if (!new Set(["success", "failure", "timeout", "cancel"]).has(input.status)) throw new Error("Measurement status is invalid.");
  if (typeof input.file !== "string" || !/^test\/(?:[^/]+\/)*[^/]+\.test\.ts$/.test(input.file)) throw new Error("Measurement file path is invalid.");
  if (!COMMIT.test(input.commit) || !Number.isSafeInteger(input.workflowRunId) || input.workflowRunId <= 0 || !Number.isSafeInteger(input.workflowJobId) || input.workflowJobId <= 0) throw new Error("Measurement workflow identity is invalid.");
  if (!Number.isFinite(input.monotonicDurationMs) || input.monotonicDurationMs <= 0) throw new Error("Measurement monotonic duration is invalid.");
  const started = assertUtc(input.startedAt, "Measurement startedAt");
  const finished = assertUtc(input.finishedAt, "Measurement finishedAt");
  if (finished < started) throw new Error("Measurement wall timestamps are invalid.");
  if (input.status === "success" && input.exitCode !== 0) throw new Error("Successful measurement must have exit code 0.");
  if (input.status === "failure" && (!Number.isInteger(input.exitCode) || input.exitCode === 0)) throw new Error("Failed measurement must have a nonzero exit code.");
  if ((input.status === "timeout" || input.status === "cancel") && input.exitCode !== null) throw new Error("Timeout and cancellation records must have a null exit code.");
  if (!Number.isSafeInteger(input.schedulerArtifactVersion) || input.schedulerArtifactVersion !== SCHEDULER_ARTIFACT_VERSION) throw new Error("schedulerArtifactVersion must reference the scheduler artifact schemaVersion.");
  const environment = normalizeEnvironment(input.environment);
  return {
    schemaVersion: RECORD_SCHEMA,
    status: input.status,
    file: input.file,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    monotonicDurationMs: input.monotonicDurationMs,
    commit: input.commit,
    workflowRunId: input.workflowRunId,
    workflowJobId: input.workflowJobId,
    runnerOS: environment.runnerOS,
    runnerLabel: environment.runnerLabel,
    "process.platform": environment["process.platform"],
    "process.arch": environment["process.arch"],
    "os.release": environment["os.release"],
    nodeVersion: environment.nodeVersion,
    npmVersion: environment.npmVersion,
    packageLockSha256: environment.packageLockSha256,
    schedulerArtifactVersion: input.schedulerArtifactVersion,
    exitCode: input.exitCode,
  };
}

export function buildManifestCandidate(records, expected) {
  if (!COMMIT.test(expected.sourceCommit) || !Array.isArray(expected.files) || !expected.files.length) throw new Error("Candidate source or file inventory is invalid.");
  if (!/^[a-f0-9]{64}$/.test(expected.fingerprint)) throw new Error("Candidate fingerprint must be a SHA-256 value.");
  const generatedAt = expected.generatedAt ?? new Date().toISOString();
  assertUtc(generatedAt, "Candidate generatedAt");
  const files = [...expected.files].sort();
  if (new Set(files).size !== files.length) throw new Error("Candidate file inventory contains duplicates.");
  const referenceEnvironment = normalizeEnvironment(expected.environment);
  if (!Array.isArray(records) || records.length !== files.length * 3) throw new Error("Candidate requires exactly three records for every tracked test file.");
  const byFile = new Map(files.map((file) => [file, []]));
  let runId;
  let jobId;
  for (const record of records) {
    if (record.schemaVersion !== RECORD_SCHEMA || record.schedulerArtifactVersion !== SCHEDULER_ARTIFACT_VERSION) throw new Error("Measurement record or scheduler artifact version is invalid.");
    if (record.status !== "success" || record.exitCode !== 0) throw new Error(`Non-success measurement cannot create a candidate: ${record.file}`);
    if (record.commit !== expected.sourceCommit) throw new Error("Measurement records have different source commits.");
    if (runId === undefined) { runId = record.workflowRunId; jobId = record.workflowJobId; }
    if (record.workflowRunId !== runId || record.workflowJobId !== jobId) throw new Error("Measurement records came from different workflow jobs.");
    const environment = Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, record[key]]));
    if (!sameEnvironment(environment, referenceEnvironment)) throw new Error("Measurement records do not share the candidate environment.");
    const durations = byFile.get(record.file);
    if (!durations) throw new Error(`Measurement record contains an unknown test file: ${record.file}`);
    if (!Number.isFinite(record.monotonicDurationMs) || record.monotonicDurationMs <= 0) throw new Error("Measurement duration is invalid.");
    durations.push(record.monotonicDurationMs);
  }
  const candidateFiles = files.map((file) => {
    const durations = byFile.get(file);
    if (durations.length !== 3) throw new Error(`Measurement candidate lacks three successful runs for ${file}.`);
    durations.sort((a, b) => a - b);
    return { path: file, medianDurationMs: durations[1] };
  });
  return {
    schemaVersion: 1,
    generatedAt,
    sourceCommit: expected.sourceCommit,
    fingerprint: expected.fingerprint,
    environment: Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, referenceEnvironment[key]])),
    files: candidateFiles,
  };
}

function waitForChild(file, timeoutMs = 30 * 60 * 1000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--test", file], { cwd: process.cwd(), windowsHide: true, stdio: "ignore" });
    activeChild = child;
    let settled = false;
    let timedOut = false;
    const finish = (status, exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChild = undefined;
      resolve({ status, exitCode });
    };
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once("error", () => finish("failure", 1));
    child.once("close", (code) => {
      if (cancelled) finish("cancel", null);
      else if (timedOut) finish("timeout", null);
      else if (code === 0) finish("success", 0);
      else if (code === null) finish("timeout", null);
      else finish("failure", code);
    });
  });
}

async function getWorkflowJobId(identity) {
  const response = await fetch(`https://api.github.com/repos/${identity.repository}/actions/runs/${identity.runId}/jobs?per_page=100`, {
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!response.ok) throw new Error(`Workflow job metadata request failed with HTTP ${response.status}.`);
  const payload = await response.json();
  const matches = payload.jobs?.filter((job) => job.name === process.env.CI_JOB_NAME && job.run_id === identity.runId) ?? [];
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id) || matches[0].id <= 0) throw new Error("Could not uniquely identify the measurement workflow job.");
  return matches[0].id;
}

async function main() {
  const root = process.cwd();
  const recordsDir = path.join(root, "ci-artifacts", "test-measurement-records");
  await mkdir(recordsDir, { recursive: true });
  const identity = await getWorkflowRunMetadata();
  const workflowJobId = await getWorkflowJobId(identity);
  const files = await getTrackedTestFiles(root);
  const environment = await captureEnvironment(root);
  const fingerprint = await computeFingerprint(root, environment);
  let recordIndex = 0;
  process.once("SIGINT", () => { cancelled = true; activeChild?.kill(); });
  process.once("SIGTERM", () => { cancelled = true; activeChild?.kill(); });
  for (let repeat = 0; repeat < 3 && !cancelled; repeat++) {
    const rotated = [...files.slice(repeat % files.length), ...files.slice(0, repeat % files.length)];
    for (const file of rotated) {
      const startedAt = new Date().toISOString();
      const start = performance.now();
      const result = await waitForChild(file);
      const finishedAt = new Date().toISOString();
      const record = createMeasurementRecord({
        ...result, file, startedAt, finishedAt, monotonicDurationMs: Math.max(1, performance.now() - start),
        commit: identity.sourceCommit, workflowRunId: identity.runId, workflowJobId,
        environment, schedulerArtifactVersion: SCHEDULER_ARTIFACT_VERSION,
      });
      recordIndex += 1;
      await writeFile(path.join(recordsDir, `${String(recordIndex).padStart(4, "0")}.json`), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
      process.stdout.write(`${record.status} ${file} ${Math.round(record.monotonicDurationMs)}ms\n`);
      if (cancelled) break;
    }
  }
  const names = await readdir(recordsDir);
  const records = [];
  for (const name of names.sort()) records.push(JSON.parse(await readFile(path.join(recordsDir, name), "utf8")));
  if (cancelled || records.length !== files.length * 3 || records.some((record) => record.status !== "success")) {
    process.exitCode = 1;
    return;
  }
  const candidate = buildManifestCandidate(records, { sourceCommit: identity.sourceCommit, files, environment, fingerprint });
  await writeFile(path.join(root, "ci-artifacts", "test-duration-manifest.candidate.json"), `${JSON.stringify(candidate, null, 2)}\n`, { flag: "wx" });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
