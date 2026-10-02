import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildAssignments,
  buildPlan,
  fingerprintInputs,
  normalizeTestPath,
  selectManifest,
  validateRuntimeFingerprint,
  validatePartition,
  validatePlan,
  validateRunMetadata,
} from "../scripts/ci-test-scheduler.mjs";
import { buildManifestCandidate, createMeasurementRecord } from "../scripts/ci-test-measurement.mjs";

const files = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/d.test.ts"];
const environment = {
  runnerLabel: "windows-latest",
  runnerOS: "Windows",
  "process.platform": "win32",
  "process.arch": "x64",
  "os.release": "10.0.26100",
  nodeVersion: "v22.20.0",
  npmVersion: "10.9.3",
  packageLockSha256: "a".repeat(64),
};

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-02T12:00:00Z",
    sourceCommit: "1".repeat(40),
    fingerprint: "b".repeat(64),
    environment,
    files: files.map((file, index) => ({ path: file, medianDurationMs: index + 1 })),
    ...overrides,
  };
}

test("baseline round robin and optimized LPT are deterministic", () => {
  assert.deepEqual(buildAssignments(files, 3, "baseline", {}), [
    { shardId: 1, files: [files[0], files[3]], estimatedDurationMs: 0 },
    { shardId: 2, files: [files[1]], estimatedDurationMs: 0 },
    { shardId: 3, files: [files[2]], estimatedDurationMs: 0 },
  ]);
  const first = buildAssignments(files, 2, "optimized", Object.fromEntries(files.map((file) => [file, 10])));
  const second = buildAssignments([...files].reverse(), 2, "optimized", Object.fromEntries(files.map((file) => [file, 10])));
  assert.deepEqual(first, second);
  assert.deepEqual(first, [
    { shardId: 1, files: [files[0], files[2]], estimatedDurationMs: 20 },
    { shardId: 2, files: [files[1], files[3]], estimatedDurationMs: 20 },
  ]);
  assert.deepEqual(buildAssignments([files[0]], 3, "baseline", {})[2].files, []);
});

test("fingerprints sort inventory paths and bind raw file bytes plus every environment identity value", () => {
  const inventory = [{ path: "package-lock.json", content: Buffer.from("raw\r\nbytes") }, { path: "test/a.test.ts", content: Buffer.from("test") }];
  const first = fingerprintInputs(inventory, environment);
  assert.equal(fingerprintInputs([...inventory].reverse(), environment), first);
  assert.notEqual(fingerprintInputs([{ ...inventory[0], content: Buffer.from("raw\nbytes") }, inventory[1]], environment), first);
  assert.notEqual(fingerprintInputs(inventory, { ...environment, nodeVersion: "v23.0.0" }), first);
});

test("assignment rejects an empty universe and proves disjoint exact coverage", () => {
  assert.throws(() => buildAssignments([], 3, "baseline", {}), /test universe is empty/i);
  const plan = buildPlan({ sourceCommit: "1".repeat(40), workflowRunId: 7, runAttempt: 1, shardCount: 3, generatedAt: "2026-10-02T12:00:00Z",
    fingerprint: "b".repeat(64), mode: "baseline", manifestStatus: "missing", files, durations: {} });
  assert.deepEqual(validatePlan(plan, { files, sourceCommit: "1".repeat(40), workflowRunId: 7, runAttempt: 1, shardCount: 3 }).assignments, plan.assignments);
  assert.throws(() => validatePartition(files, [{ shardId: 1, files: [files[0], files[0]], estimatedDurationMs: 0 }], 1), /duplicate|ordering|path/i);
  assert.throws(() => validatePartition(files, [{ shardId: 1, files: [files[0]], estimatedDurationMs: 0 }], 1), /coverage|missing/i);
});

test("test paths are normalized and reject traversal, foreign roots, and symlinks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-scheduler-path-"));
  try {
    await mkdir(path.join(root, "test"), { recursive: true });
    await writeFile(path.join(root, "test", "safe.test.ts"), "export {};\n");
    assert.equal(await normalizeTestPath("test/safe.test.ts", root), "test/safe.test.ts");
    for (const bad of ["../outside.test.ts", "src/no.test.ts", "test\\bad.test.ts", path.resolve(root, "test/safe.test.ts"), "test/../safe.test.ts"]) {
      await assert.rejects(normalizeTestPath(bad, root));
    }
    const outside = await mkdtemp(path.join(os.tmpdir(), "ci-scheduler-outside-"));
    await writeFile(path.join(outside, "linked.test.ts"), "export {};\n");
    try {
      await symlink(outside, path.join(root, "test", "linked"), process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(normalizeTestPath("test/linked/linked.test.ts", root), /symbolic link/i);
    } finally { await rm(outside, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing, expired, and fingerprint-mismatched manifests safely choose baseline", () => {
  const context = { files, fingerprint: "b".repeat(64), environment, createdAt: "2026-10-02T12:00:00Z" };
  assert.equal(selectManifest(null, context).manifestStatus, "missing");
  assert.equal(selectManifest(manifest({ generatedAt: "2026-08-31T11:59:59Z" }), context).manifestStatus, "stale");
  assert.equal(selectManifest(manifest({ fingerprint: "c".repeat(64) }), context).manifestStatus, "fingerprint-mismatch");
  assert.equal(selectManifest(manifest({ environment: { ...environment, "os.release": "changed" } }), context).manifestStatus, "fingerprint-mismatch");
  assert.equal(selectManifest(manifest(), context).mode, "optimized");
  assert.equal(selectManifest(manifest({ generatedAt: "2026-09-02T12:00:00Z" }), context).mode, "optimized", "exactly 30 days remains applicable");
});

test("malformed or unsafe manifests hard-fail even when stale; matching manifests must cover U", () => {
  const context = { files, fingerprint: "b".repeat(64), environment, createdAt: "2026-10-02T12:00:00Z" };
  assert.throws(() => selectManifest(manifest({ generatedAt: "not-a-date" }), context), /generatedAt/i);
  assert.throws(() => selectManifest(manifest({ files: [{ path: "../escape.test.ts", medianDurationMs: 2 }] }), context), /path/i);
  assert.throws(() => selectManifest(manifest({ files: [{ path: files[0], medianDurationMs: 0 }] }), context), /duration/i);
  assert.throws(() => selectManifest(manifest({ generatedAt: "2026-10-02T12:00:01Z" }), context), /future/i);
  assert.throws(() => selectManifest(manifest({ files: [{ path: files[0], medianDurationMs: 5 }] }), context), /coverage|missing/i);
  assert.throws(() => selectManifest(manifest({ generatedAt: "2026-08-31T11:59:59Z", files: [] }), context), /files.*empty|empty.*files/i);
});

test("plan digest and common plan validation bind every shard to the same source and run", () => {
  const selected = selectManifest(null, { files, fingerprint: "b".repeat(64), environment, createdAt: "2026-10-02T12:00:00Z" });
  const input = { sourceCommit: "1".repeat(40), workflowRunId: 7, runAttempt: 1, shardCount: 3, generatedAt: "2026-10-02T12:00:00Z",
    fingerprint: "b".repeat(64), manifestStatus: selected.manifestStatus, mode: selected.mode, files, durations: selected.durations };
  const plan = buildPlan(input);
  for (let shardId = 1; shardId <= 3; shardId++) {
    assert.equal(validatePlan(JSON.parse(JSON.stringify(plan)), { files, sourceCommit: input.sourceCommit, workflowRunId: 7, runAttempt: 1, shardCount: 3 }).planDigest, plan.planDigest);
  }
  const corrupt = { ...plan, assignments: [...plan.assignments].reverse() };
  assert.throws(() => validatePlan(corrupt, { files, sourceCommit: input.sourceCommit, workflowRunId: 7, runAttempt: 1, shardCount: 3 }), /digest|assignment|order/i);
  assert.throws(() => validatePlan(plan, { files, sourceCommit: input.sourceCommit, workflowRunId: 8, runAttempt: 1, shardCount: 3 }), /run/i);
  const optimizedPlan = buildPlan({ ...input, mode: "optimized", manifestStatus: "applied", durations: Object.fromEntries(files.map((file) => [file, 10])) });
  assert.throws(() => validateRuntimeFingerprint(optimizedPlan, "c".repeat(64)), /fingerprint/i);
  assert.equal(validateRuntimeFingerprint(plan, "c".repeat(64)), true);
});

test("common run metadata requires the exact public workflow identity and UTC creation time", () => {
  const expected = { id: 7, repository: { full_name: "ssaattww/RemoteDesktopMCP" }, head_sha: "1".repeat(40), run_attempt: 2, created_at: "2026-10-02T12:00:00Z" };
  assert.equal(validateRunMetadata(expected, { repository: "ssaattww/RemoteDesktopMCP", runId: 7, runAttempt: 2, sourceCommit: "1".repeat(40) }), "2026-10-02T12:00:00Z");
  for (const bad of [{ ...expected, head_sha: "2".repeat(40) }, { ...expected, run_attempt: 1 }, { ...expected, created_at: "invalid" },
    { ...expected, created_at: "2026-02-31T12:00:00Z" }]) {
    assert.throws(() => validateRunMetadata(bad, { repository: "ssaattww/RemoteDesktopMCP", runId: 7, runAttempt: 2, sourceCommit: "1".repeat(40) }));
  }
});

test("scheduler CLI executes its entry point and rejects unknown commands", () => {
  const script = fileURLToPath(new URL("../scripts/ci-test-scheduler.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "unknown"], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Command must be plan or dispatch/i);
});

test("measurement records bind the scheduler schema version and candidates require three successes per file", () => {
  const records = files.flatMap((file, fileIndex) => [100, 110, 120].map((duration, repeat) => createMeasurementRecord({
    status: "success", file, startedAt: `2026-10-02T12:00:0${repeat}Z`, finishedAt: `2026-10-02T12:00:0${repeat + 1}Z`,
    monotonicDurationMs: duration + fileIndex, commit: "1".repeat(40), workflowRunId: 7, workflowJobId: 9,
    environment, schedulerArtifactVersion: 1, exitCode: 0,
  })));
  const candidate = buildManifestCandidate(records, { sourceCommit: "1".repeat(40), files, environment, fingerprint: "b".repeat(64), generatedAt: "2026-10-02T12:00:00Z" });
  assert.equal(candidate.schemaVersion, 1);
  assert.equal(candidate.files[0].medianDurationMs, 110);
  assert.equal(candidate.environment.packageLockSha256, environment.packageLockSha256);
  assert.equal(records[0].schedulerArtifactVersion, 1);
  assert.throws(() => buildManifestCandidate(records.slice(1), { sourceCommit: "1".repeat(40), files, environment, fingerprint: "b".repeat(64) }), /three records/i);
  assert.throws(() => buildManifestCandidate([{ ...records[0], status: "failure", exitCode: 1 }, ...records.slice(1)],
    { sourceCommit: "1".repeat(40), files, environment, fingerprint: "b".repeat(64) }), /non-success/i);
  assert.throws(() => createMeasurementRecord({ status: "success", file: files[0], startedAt: "2026-02-31T12:00:00Z", finishedAt: "2026-03-03T12:00:00Z",
    monotonicDurationMs: 100, commit: "1".repeat(40), workflowRunId: 7, workflowJobId: 9, environment, schedulerArtifactVersion: 1, exitCode: 0 }), /timestamp/i);
});
