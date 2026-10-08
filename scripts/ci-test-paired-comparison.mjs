import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

export const BASELINE_COMMIT = "5dac2528e80cba3e3ff5c855f14420075b2da717";
export const CANDIDATE_COMMIT = "6ea1ca5636d909b32fad6199c034b9b1894fef34";
export const TARGET_FILES = [
  "test/config-transfer-integrity.test.ts",
  "test/session-filesystem-lifecycle.test.ts",
];
export const PREDECLARED_CONTROL_FILES = [
  "test/independent-transfer-lifecycle.test.ts",
  "test/tool-root-contracts.test.ts",
  "test/independent-process-ownership.test.ts",
];
export const EXCLUDED_FILES = [];
export const EXPECTED_COMMON_TEST_FILE_COUNT = 31;
export const EXPECTED_CONTROL_FILE_COUNT = 29;
export const SAMPLE_TIMEOUT_MS = 30 * 60 * 1000;

const HEX_40 = /^[a-f0-9]{40}$/;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const ordinal = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const DOCUMENTATION_ROOTS = ["doc/", "reports/", "tasks/"];

export function formatSummaryError(value) {
  return String(value ?? "")
    .replace(/\u001b\[[0-9;]*m/gu, "")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/giu, "[redacted]")
    .replace(/\bAuthorization\s*:\s*(?:Basic|Bearer)\s+\S+/giu, "Authorization: [redacted]")
    .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/\b(token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/giu, (_match, label) => `${label}=[redacted]`)
    .replace(/(["'])(?:(?:[A-Za-z]:[\\/])|(?:\\\\)|\/)[^\r\n]*?\1/gu, "[path]")
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/)[^;\r\n]*/gu, "[path]")
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\s"'<>]+/gu, "[path]")
    .replace(/\/(?:[^/\s]+\/)+[^/\s,;]*/gu, "[path]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500);
}

export function formatFailureDiagnostic(summary) {
  if (summary?.status !== "failure" || typeof summary.error !== "string" || !summary.error) return "";
  return `Paired comparison error: ${formatSummaryError(summary.error)}\n`;
}

function assertUniqueSorted(files, label) {
  if (!Array.isArray(files) || files.some((file) => typeof file !== "string" || !/^test\/(?:[^/]+\/)*[^/]+\.test\.ts$/.test(file))) {
    throw new Error(`${label} test inventory contains an invalid path.`);
  }
  if (new Set(files).size !== files.length) throw new Error(`${label} test inventory contains duplicates.`);
  const sorted = [...files].sort(ordinal);
  if (files.some((file, index) => file !== sorted[index])) throw new Error(`${label} test inventory is not sorted.`);
}

export function compareInventories(baselineFiles, candidateFiles, {
  targetFiles = TARGET_FILES,
  excludedFiles = EXCLUDED_FILES,
  changedFiles,
  expectedCommonCount = EXPECTED_COMMON_TEST_FILE_COUNT,
  expectedControlCount = EXPECTED_CONTROL_FILE_COUNT,
} = {}) {
  assertUniqueSorted(baselineFiles, "Baseline");
  assertUniqueSorted(candidateFiles, "Candidate");
  const expectedTargets = [...targetFiles].sort(ordinal);
  const expectedExcluded = [...excludedFiles].sort(ordinal);
  const expectedChanged = [...new Set([...expectedTargets, ...expectedExcluded])].sort(ordinal);
  if (!Array.isArray(changedFiles)) throw new Error("Expected changed test paths are required.");
  const sortedChanged = [...changedFiles].sort(ordinal);
  if (new Set(changedFiles).size !== changedFiles.length || sortedChanged.length !== expectedChanged.length
    || sortedChanged.some((file, index) => file !== expectedChanged[index])) {
    throw new Error("Changed test paths do not match the exact target and excluded path set.");
  }
  if (baselineFiles.length !== expectedCommonCount || candidateFiles.length !== expectedCommonCount
    || baselineFiles.length !== candidateFiles.length
    || baselineFiles.some((file, index) => file !== candidateFiles[index])) {
    throw new Error("Baseline and candidate test inventories differ from the expected common inventory.");
  }
  const inventory = new Set(baselineFiles);
  for (const file of [...expectedTargets, ...expectedExcluded]) {
    if (!inventory.has(file)) throw new Error(`Expected changed test file is absent: ${file}`);
  }
  const controls = baselineFiles.filter((file) => !expectedTargets.includes(file) && !expectedExcluded.includes(file));
  if (controls.length !== expectedControlCount) throw new Error("Control test inventory count is unexpected.");
  return { targets: expectedTargets, controls, excluded: expectedExcluded, commonTestFileCount: baselineFiles.length };
}

export function compareRepositoryChanges(changedPaths, { targetFiles = TARGET_FILES } = {}) {
  if (!Array.isArray(changedPaths) || changedPaths.some((file) => typeof file !== "string" || !file || file.startsWith("/") || file.includes("\\") || file.split("/").includes(".."))) {
    throw new Error("Repository diff contains an invalid path.");
  }
  if (new Set(changedPaths).size !== changedPaths.length) throw new Error("Repository diff contains duplicate paths.");
  const targets = [...targetFiles].sort(ordinal);
  const changed = [...changedPaths].sort(ordinal);
  for (const target of targets) if (!changed.includes(target)) throw new Error(`Expected runtime target is missing from repository diff: ${target}`);
  const unexpected = changed.filter((file) => !targets.includes(file) && !DOCUMENTATION_ROOTS.some((root) => file.startsWith(root)));
  if (unexpected.length) throw new Error(`Unexpected execution/runtime path outside approved targets: ${unexpected.join(", ")}`);
  const runtimeChanges = changed.filter((file) => !DOCUMENTATION_ROOTS.some((root) => file.startsWith(root)));
  if (runtimeChanges.length !== targets.length || runtimeChanges.some((file, index) => file !== targets[index])) {
    throw new Error("Runtime/execution changes do not equal the exact target fixture test path set.");
  }
  return targets;
}

export function comparePredeclaredControlBlobs(baselineBlobs, candidateBlobs) {
  return PREDECLARED_CONTROL_FILES.map((file) => {
    const baselineObject = baselineBlobs.get(file)?.object;
    const candidateObject = candidateBlobs.get(file)?.object;
    if (!baselineObject || !candidateObject || baselineObject !== candidateObject) {
      throw new Error(`Predeclared control test content changed or is missing: ${file}`);
    }
    return { file, baselineObject, candidateObject, identical: true };
  });
}

export function buildPairedSchedule(files) {
  if (!Array.isArray(files) || !files.length) throw new Error("Paired comparison requires at least one file.");
  const sorted = [...files].sort(ordinal);
  if (new Set(sorted).size !== sorted.length || sorted.some((file) => !/^test\/(?:[^/]+\/)*[^/]+\.test\.ts$/.test(file))) {
    throw new Error("Paired schedule contains an invalid or duplicate file.");
  }
  const pairOrder = ["baseline", "candidate", "candidate", "baseline", "baseline", "candidate", "candidate", "baseline", "baseline", "candidate", "candidate", "baseline"];
  const schedule = [];
  for (const file of sorted) {
    for (const [index, side] of ["baseline", "candidate"].entries()) {
      schedule.push({ file, side, phase: "warmup", pairIndex: null, orderInPair: index + 1 });
    }
    for (let index = 0; index < pairOrder.length; index++) {
      schedule.push({ file, side: pairOrder[index], phase: "measured", pairIndex: Math.floor(index / 2) + 1, orderInPair: index % 2 + 1 });
    }
  }
  return schedule;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function describe(values, { positiveOnly = true } = {}) {
  if (!values.length || values.some((value) => !Number.isFinite(value) || (positiveOnly && value <= 0))) {
    throw new Error(positiveOnly ? "Statistics require positive successful durations." : "Statistics require finite values.");
  }
  const minMs = Math.min(...values);
  const maxMs = Math.max(...values);
  return { meanMs: values.reduce((sum, value) => sum + value, 0) / values.length, medianMs: median(values), minMs, maxMs, rangeMs: maxMs - minMs };
}

export function summarizeComparison(records, { targets, controls }) {
  if (!Array.isArray(records)) throw new Error("Sample records are required.");
  const requested = [...targets, ...controls];
  const files = {};
  for (const file of requested) {
    const samples = records.filter((record) => record.file === file);
    const measured = samples.filter((record) => record.phase === "measured");
    const warmups = samples.filter((record) => record.phase === "warmup");
    if (samples.length !== 14 || measured.length !== 12 || warmups.length !== 2
      || ["baseline", "candidate"].some((side) => warmups.filter((record) => record.side === side).length !== 1)
      || samples.some((record) => record.status !== "success" || record.exitCode !== 0)) {
      throw new Error(`Both warmups and all twelve measured samples for ${file} must succeed.`);
    }
    const perSide = Object.fromEntries(["baseline", "candidate"].map((side) => {
      const values = measured.filter((record) => record.side === side).map((record) => record.durationMs);
      if (values.length !== 6) throw new Error(`Six measured ${side} samples are required for ${file}.`);
      return [side, describe(values)];
    }));
    const pairedDeltas = [1, 2, 3, 4, 5, 6].map((pairIndex) => {
      const pair = measured.filter((record) => record.pairIndex === pairIndex);
      const baseline = pair.find((record) => record.side === "baseline");
      const candidate = pair.find((record) => record.side === "candidate");
      if (pair.length !== 2 || !baseline || !candidate || baseline.durationMs <= 0 || candidate.durationMs <= 0
        || ![1, 2].includes(baseline.orderInPair) || ![1, 2].includes(candidate.orderInPair)
        || baseline.orderInPair === candidate.orderInPair
        || (pairIndex % 2 === 1 ? baseline.orderInPair !== 1 : candidate.orderInPair !== 1)) {
        throw new Error(`Paired sample ${pairIndex} is incomplete for ${file}.`);
      }
      return {
        pairIndex,
        firstSide: baseline.orderInPair === 1 ? "baseline" : "candidate",
        baselineMs: baseline.durationMs,
        candidateMs: candidate.durationMs,
        deltaMs: baseline.durationMs - candidate.durationMs,
        improvementPercent: ((baseline.durationMs - candidate.durationMs) / baseline.durationMs) * 100,
      };
    });
    const pairedImprovementValues = pairedDeltas.map(({ improvementPercent }) => improvementPercent);
    const pairedDeltaValues = pairedDeltas.map(({ deltaMs }) => deltaMs);
    const orderStratifiedEffects = Object.fromEntries(["baseline", "candidate"].map((firstSide) => {
      const pairs = pairedDeltas.filter((pair) => pair.firstSide === firstSide);
      if (pairs.length !== 3) throw new Error(`Three ${firstSide}-first measured pairs are required for ${file}.`);
      const deltas = pairs.map(({ deltaMs }) => deltaMs);
      const improvements = pairs.map(({ improvementPercent }) => improvementPercent);
      return [firstSide === "baseline" ? "baselineFirst" : "candidateFirst", {
        pairCount: pairs.length,
        meanPairedDeltaMs: describe(deltas, { positiveOnly: false }).meanMs,
        medianPairedDeltaMs: median(deltas),
        meanImprovementPercent: describe(improvements, { positiveOnly: false }).meanMs,
        medianImprovementPercent: median(improvements),
      }];
    }));
    files[file] = {
      ...perSide,
      pairedDeltas,
      pairedDeltaMeanMs: describe(pairedDeltaValues, { positiveOnly: false }).meanMs,
      pairedDeltaMedianMs: median(pairedDeltaValues),
      meanPairedImprovementPercent: pairedImprovementValues.reduce((sum, value) => sum + value, 0) / pairedImprovementValues.length,
      medianPairedImprovementPercent: median(pairedImprovementValues),
      orderStratifiedEffects,
    };
  }
  const controlDistribution = controls.map((file) => ({ file, medianImprovementPercent: files[file].medianPairedImprovementPercent }));
  const controlsMedianImprovementPercent = median(controlDistribution.map(({ medianImprovementPercent }) => medianImprovementPercent));
  const controlStatistics = describe(controlDistribution.map(({ medianImprovementPercent }) => medianImprovementPercent), { positiveOnly: false });
  const targetSummary = Object.fromEntries(targets.map((file) => [file, {
    meanPairedImprovementPercent: files[file].meanPairedImprovementPercent,
    medianPairedImprovementPercent: files[file].medianPairedImprovementPercent,
    controlAdjustedMedianImprovementPercentagePoints: files[file].medianPairedImprovementPercent - controlsMedianImprovementPercent,
  }]));
  return {
    screeningOnly: true,
    warmupsExcluded: true,
    claimsNotEstablished: ["all_test_files_effect", "full_workflow_duration", "180_second_target"],
    files, controlDistribution, controlStatistics, controlsMedianImprovementPercent, targets: targetSummary,
  };
}

function execute(command, args, { cwd, env = process.env, shell = false, stdoutPath, stderrPath, timeoutMs } = {}) {
  return new Promise((resolve) => {
    let stdoutStream;
    let stderrStream;
    if (stdoutPath) stdoutStream = createWriteStream(stdoutPath, { flags: "w" });
    if (stderrPath) stderrStream = createWriteStream(stderrPath, { flags: "w" });
    const child = spawn(command, args, { cwd, env, shell, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    let timedOut = false;
    const finish = (error, exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      Promise.all([new Promise((done) => stdoutStream ? stdoutStream.end(done) : done()), new Promise((done) => stderrStream ? stderrStream.end(done) : done())])
        .then(() => resolve({ error: error?.message, exitCode, timedOut }));
    };
    child.stdout?.on("data", (chunk) => { stdoutStream?.write(chunk); process.stdout.write(chunk); });
    child.stderr?.on("data", (chunk) => { stderrStream?.write(chunk); process.stderr.write(chunk); });
    child.once("error", (error) => finish(error, null));
    child.once("close", (code) => finish(undefined, code));
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs ?? SAMPLE_TIMEOUT_MS);
  });
}

async function runLogged(command, args, options, label) {
  const logs = path.join(options.artifactRoot, "diagnostics");
  await mkdir(logs, { recursive: true });
  const safeLabel = label.replace(/[^a-zA-Z0-9._-]/g, "_");
  const result = await execute(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: options.shell,
    timeoutMs: options.timeoutMs,
    stdoutPath: path.join(logs, `${safeLabel}.stdout.log`),
    stderrPath: path.join(logs, `${safeLabel}.stderr.log`),
  });
  if (result.error || result.exitCode !== 0 || result.timedOut) {
    throw new Error(`${label} failed: exit=${result.exitCode ?? "null"}, timeout=${result.timedOut}, error=${result.error ?? "none"}`);
  }
  return result;
}

async function git(root, args, label, artifactRoot) {
  return runLogged("git", args, { cwd: root, artifactRoot }, label);
}

async function gitText(root, args) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`)));
  });
  return result;
}

async function trackedTests(root, commit) {
  const output = await gitText(root, ["ls-tree", "-r", "--name-only", commit, "--", "test"]);
  return output.split(/\r?\n/u).filter((file) => file.endsWith(".test.ts")).sort(ordinal);
}

async function treeBlobs(root, commit) {
  const output = await gitText(root, ["ls-tree", "-r", "-z", commit, "--", "test"]);
  return new Map(output.split("\0").filter(Boolean).map((entry) => {
    const [metadata, file] = entry.split("\t");
    const [, type, object] = metadata.split(" ");
    return [file, { type, object }];
  }));
}

async function hashAt(root, commit, file) {
  const content = await new Promise((resolve, reject) => {
    const child = spawn("git", ["show", `${commit}:${file}`], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`git show ${commit}:${file} failed (${code}): ${stderr}`)));
  });
  return content;
}

async function npmVersion(cwd, artifactRoot) {
  const isWindows = process.platform === "win32";
  const result = await runLogged(isWindows ? "npm.cmd" : "npm", ["--version"], {
    cwd, artifactRoot, shell: isWindows,
  }, `npm-version-${path.basename(cwd)}`);
  const text = await readFile(path.join(artifactRoot, "diagnostics", `npm-version-${path.basename(cwd)}.stdout.log`), "utf8");
  if (!/^\d+\.\d+\.\d+(?:[-+].*)?\s*$/u.test(text)) throw new Error("npm version output is invalid.");
  return text.trim();
}

async function environmentFor(cwd, artifactRoot) {
  const lock = await readFile(path.join(cwd, "package-lock.json"));
  return {
    runnerOS: process.env.RUNNER_OS ?? "unknown",
    runnerLabel: process.env.CI_RUNNER_LABEL ?? "windows-latest",
    platform: process.platform,
    architecture: process.arch,
    osRelease: os.release(),
    nodeVersion: process.version,
    npmVersion: await npmVersion(cwd, artifactRoot),
    packageLockSha256: sha256(lock),
  };
}

function sameEnvironment(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

export async function runScheduledSamples({ schedule, summary, recordPathForIndex, runSample }) {
  const records = [];
  summary.sampleCount = 0;
  summary.successfulSampleCount = 0;
  summary.warmupSampleCount = 0;
  summary.measuredSampleCount = 0;
  summary.records = [];
  for (let index = 0; index < schedule.length; index++) {
    const record = await runSample(schedule[index], index + 1);
    records.push(record);
    summary.sampleCount = records.length;
    summary.successfulSampleCount = records.filter((sample) => sample.status === "success").length;
    summary.warmupSampleCount = records.filter((sample) => sample.phase === "warmup").length;
    summary.measuredSampleCount = records.filter((sample) => sample.phase === "measured").length;
    summary.records = records.map((_sample, recordIndex) => recordPathForIndex(recordIndex + 1));
  }
  return records;
}

async function runTestSample({ sample, cwd, runId, attempt, jobId, environment, recordDirectory, diagnosticsDirectory, index }) {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const stdoutPath = path.join(diagnosticsDirectory, `${String(index).padStart(4, "0")}.stdout.log`);
  const stderrPath = path.join(diagnosticsDirectory, `${String(index).padStart(4, "0")}.stderr.log`);
  const env = { ...process.env };
  delete env.CI_GITHUB_TOKEN;
  delete env.GITHUB_TOKEN;
  const result = await execute(process.execPath, ["--import", "tsx", "--test", sample.file], {
    cwd, env, stdoutPath, stderrPath, timeoutMs: SAMPLE_TIMEOUT_MS,
  });
  const durationMs = Math.max(1, performance.now() - start);
  const finishedAt = new Date().toISOString();
  const status = result.timedOut ? "timeout" : result.error || result.exitCode !== 0 ? "failure" : "success";
  const record = {
    schemaVersion: 1,
    status,
    file: sample.file,
    side: sample.side,
    phase: sample.phase,
    commit: sample.commit,
    scheduleIndex: index,
    pairIndex: sample.pairIndex,
    orderInPair: sample.orderInPair,
    startedAt,
    finishedAt,
    monotonicDurationMs: durationMs,
    durationMs,
    workflowRunId: runId,
    workflowRunAttempt: attempt,
    workflowJobId: jobId,
    runnerOS: environment.runnerOS,
    runnerLabel: environment.runnerLabel,
    platform: environment.platform,
    architecture: environment.architecture,
    osRelease: environment.osRelease,
    nodeVersion: environment.nodeVersion,
    npmVersion: environment.npmVersion,
    packageLockSha256: environment.packageLockSha256,
    exitCode: result.error || result.timedOut ? null : result.exitCode,
    processError: result.error ?? null,
    stdoutFile: path.relative(recordDirectory, stdoutPath).replaceAll("\\", "/"),
    stderrFile: path.relative(recordDirectory, stderrPath).replaceAll("\\", "/"),
  };
  await writeFile(path.join(recordDirectory, `${String(index).padStart(4, "0")}.json`), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${sample.phase} ${status} ${sample.file} ${sample.side} ${Math.round(durationMs)}ms\n`);
  return record;
}

async function runPairedComparison() {
  const root = process.cwd();
  const artifactRoot = path.join(root, "ci-artifacts", "paired-comparison");
  const recordDirectory = path.join(artifactRoot, "records");
  const diagnosticsDirectory = path.join(artifactRoot, "diagnostics");
  await mkdir(recordDirectory, { recursive: true });
  await mkdir(diagnosticsDirectory, { recursive: true });
  const summaryPath = path.join(artifactRoot, "paired-comparison-summary.json");
  const summary = {
    schemaVersion: 1,
    status: "failure",
    startedAt: new Date().toISOString(),
    baselineCommit: BASELINE_COMMIT,
    candidateCommit: CANDIDATE_COMMIT,
    driverCommit: process.env.GITHUB_SHA ?? null,
    targets: TARGET_FILES,
    excludedTestDifferences: EXCLUDED_FILES,
    recordsDirectory: "records",
  };
  const worktrees = [];
  try {
    if (process.platform !== "win32" || process.env.RUNNER_OS !== "Windows") throw new Error("Paired comparison must run on the Windows GitHub runner.");
    if (!/^v22\./u.test(process.version)) throw new Error(`Paired comparison requires Node 22, got ${process.version}.`);
    if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch") throw new Error("Paired comparison is available only for manual workflow_dispatch runs.");
    if (!/^[a-f0-9]{40}$/u.test(process.env.GITHUB_SHA ?? "")) throw new Error("Workflow driver commit identity is invalid.");
    if (!process.env.GITHUB_REPOSITORY || !/^\d+$/u.test(process.env.GITHUB_RUN_ID ?? "") || !/^\d+$/u.test(process.env.GITHUB_RUN_ATTEMPT ?? "")) {
      throw new Error("GitHub workflow run identity is incomplete.");
    }
    const metadata = JSON.parse(await readFile(path.join(root, "ci-artifacts", "workflow-metadata.json"), "utf8"));
    if (metadata.repository !== process.env.GITHUB_REPOSITORY || metadata.sourceCommit !== process.env.GITHUB_SHA
      || Number(metadata.runId) !== Number(process.env.GITHUB_RUN_ID) || Number(metadata.runAttempt) !== Number(process.env.GITHUB_RUN_ATTEMPT)
      || !Number.isSafeInteger(metadata.workflowJobId) || metadata.workflowJobId <= 0) throw new Error("Workflow metadata does not match the paired run identity.");
    summary.workflow = { repository: metadata.repository, runId: metadata.runId, runAttempt: metadata.runAttempt, jobId: metadata.workflowJobId };
    const gitVersion = (await gitText(root, ["--version"])).trim();
    summary.gitVersion = gitVersion;
    const changedRepositoryPaths = (await gitText(root, ["diff", "--no-renames", "--name-only", BASELINE_COMMIT, CANDIDATE_COMMIT]))
      .split(/\r?\n/u).filter(Boolean).sort(ordinal);
    const runtimeChangedPaths = compareRepositoryChanges(changedRepositoryPaths);
    const baseTests = await trackedTests(root, BASELINE_COMMIT);
    const candidateTests = await trackedTests(root, CANDIDATE_COMMIT);
    const changed = (await gitText(root, ["diff", "--no-renames", "--name-only", BASELINE_COMMIT, CANDIDATE_COMMIT, "--", "test"])).split(/\r?\n/u).filter(Boolean).sort(ordinal);
    const inventory = compareInventories(baseTests, candidateTests, { changedFiles: changed, excludedFiles: [] });
    for (const file of PREDECLARED_CONTROL_FILES) {
      if (!inventory.controls.includes(file)) throw new Error(`Predeclared screening control is absent from the common inventory: ${file}`);
    }
    const baseBlobs = await treeBlobs(root, BASELINE_COMMIT);
    const candidateBlobs = await treeBlobs(root, CANDIDATE_COMMIT);
    for (const file of inventory.controls) if (baseBlobs.get(file)?.object !== candidateBlobs.get(file)?.object) throw new Error(`Control test content changed unexpectedly: ${file}`);
    const predeclaredControlBlobIdentities = comparePredeclaredControlBlobs(baseBlobs, candidateBlobs);
    for (const file of inventory.targets) if (baseBlobs.get(file)?.object === candidateBlobs.get(file)?.object) throw new Error(`Expected target test did not change: ${file}`);
    for (const file of inventory.excluded) if (baseBlobs.get(file)?.object === candidateBlobs.get(file)?.object) throw new Error(`Expected excluded difference is absent: ${file}`);
    const baseLock = await hashAt(root, BASELINE_COMMIT, "package-lock.json");
    const candidateLock = await hashAt(root, CANDIDATE_COMMIT, "package-lock.json");
    if (!Buffer.from(baseLock).equals(Buffer.from(candidateLock))) throw new Error("Pinned commits have different package-lock.json bytes.");
    summary.inventory = inventory;
    summary.screening = {
      mode: "screening_only",
      targets: TARGET_FILES,
      predeclaredControls: PREDECLARED_CONTROL_FILES,
      predeclaredControlBlobIdentities,
      warmupsPerSidePerFile: 1,
      measuredPairsPerFile: 6,
      expectedProcessRuns: 70,
      claimsNotEstablished: ["all_test_files_effect", "full_workflow_duration", "180_second_target"],
      manifestApplied: false,
    };
    summary.packageLockSha256 = sha256(baseLock);
    summary.changedRepositoryPaths = changedRepositoryPaths;
    summary.runtimeChangedPaths = runtimeChangedPaths;
    summary.changedTestPaths = changed;
    summary.testBlobIdentityVerified = true;

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "rdmcp-r24-02-paired-"));
    summary.worktreeRoot = tempRoot;
    const baselinePath = path.join(tempRoot, "baseline");
    const candidatePath = path.join(tempRoot, "candidate");
    for (const [label, commit, target] of [["baseline", BASELINE_COMMIT, baselinePath], ["candidate", CANDIDATE_COMMIT, candidatePath]]) {
      await git(root, ["worktree", "add", "--detach", target, commit], `worktree-add-${label}`, artifactRoot);
      worktrees.push(target);
    }
    const runId = Number(metadata.runId);
    const attempt = Number(metadata.runAttempt);
    const jobId = Number(metadata.workflowJobId);
    for (const [label, target] of [["baseline", baselinePath], ["candidate", candidatePath]]) {
      await runLogged("npm.cmd", ["ci"], { cwd: target, artifactRoot, shell: true, timeoutMs: 90 * 60 * 1000 }, `npm-ci-${label}`);
    }
    const baselineEnvironment = await environmentFor(baselinePath, artifactRoot);
    const candidateEnvironment = await environmentFor(candidatePath, artifactRoot);
    summary.environments = { baseline: baselineEnvironment, candidate: candidateEnvironment };
    if (baselineEnvironment.runnerOS !== "Windows" || baselineEnvironment.platform !== "win32"
      || !sameEnvironment(baselineEnvironment, candidateEnvironment)) throw new Error("Baseline/candidate execution environments differ or are not Windows.");
    if (baselineEnvironment.packageLockSha256 !== summary.packageLockSha256) throw new Error("Installed worktree lock bytes differ from the pinned commit lock.");
    summary.environment = baselineEnvironment;
    const driverFile = await readFile(fileURLToPath(import.meta.url));
    summary.driverSha256 = sha256(driverFile);
    const recordEnvironment = { ...baselineEnvironment };
    const screeningInventory = { ...inventory, controls: PREDECLARED_CONTROL_FILES };
    const schedule = buildPairedSchedule([...inventory.targets, ...screeningInventory.controls]);
    summary.scheduleSampleCount = schedule.length;
    summary.warmupScheduleSampleCount = schedule.filter((sample) => sample.phase === "warmup").length;
    summary.measuredScheduleSampleCount = schedule.filter((sample) => sample.phase === "measured").length;
    if (schedule.length !== 70 || summary.warmupScheduleSampleCount !== 10 || summary.measuredScheduleSampleCount !== 60) {
      throw new Error("Screening schedule must contain 10 warmups and 60 measured samples.");
    }
    const records = await runScheduledSamples({
      schedule,
      summary,
      recordPathForIndex: (index) => path.relative(artifactRoot, path.join(recordDirectory, `${String(index).padStart(4, "0")}.json`)).replaceAll("\\", "/"),
      runSample: (sample, index) => {
      const commit = sample.side === "baseline" ? BASELINE_COMMIT : CANDIDATE_COMMIT;
      const cwd = sample.side === "baseline" ? baselinePath : candidatePath;
      return runTestSample({ sample: { ...sample, commit }, cwd, runId, attempt, jobId, environment: recordEnvironment, recordDirectory, diagnosticsDirectory, index });
      },
    });
    if (summary.successfulSampleCount !== schedule.length) throw new Error("One or more paired test samples failed; comparison statistics are not valid.");
    summary.statistics = summarizeComparison(records.map((record) => ({ ...record, durationMs: record.monotonicDurationMs })), screeningInventory);
    summary.status = "success";
  } catch (error) {
    summary.error = formatSummaryError(error instanceof Error ? error.message : String(error));
    summary.sampleCount = summary.sampleCount ?? 0;
  } finally {
    for (const worktree of worktrees.reverse()) {
      try { await git(root, ["worktree", "remove", "--force", worktree], `worktree-remove-${path.basename(worktree)}`, artifactRoot); }
      catch (error) { summary.cleanupError = formatSummaryError(error instanceof Error ? error.message : String(error)); }
    }
    summary.finishedAt = new Date().toISOString();
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`Paired comparison ${summary.status}; summary: ${summaryPath}\n`);
    process.stderr.write(formatFailureDiagnostic(summary));
  }
  return summary.status === "success" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPairedComparison().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
