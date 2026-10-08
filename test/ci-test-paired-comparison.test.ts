import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  BASELINE_COMMIT,
  CANDIDATE_COMMIT,
  buildPairedSchedule,
  compareRepositoryChanges,
  compareInventories,
  formatFailureDiagnostic,
  formatSummaryError,
  runScheduledSamples,
  summarizeComparison,
} from "../scripts/ci-test-paired-comparison.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const targetFiles = [
  "test/config-transfer-integrity.test.ts",
  "test/session-filesystem-lifecycle.test.ts",
];
test("paired source identities use the PR creation base and fixed candidate", () => {
  assert.equal(BASELINE_COMMIT, "5dac2528e80cba3e3ff5c855f14420075b2da717");
  assert.equal(CANDIDATE_COMMIT, "6ea1ca5636d909b32fad6199c034b9b1894fef34");
});

test("paired comparison requires exact inventory and only target test paths changed", () => {
  const baseline = ["test/a.test.ts", ...targetFiles].sort();
  const candidate = [...baseline];
  const comparison = compareInventories(baseline, candidate, {
    targetFiles,
    excludedFiles: [],
    changedFiles: targetFiles,
    expectedCommonCount: 3,
    expectedControlCount: 1,
  });
  assert.deepEqual(comparison.targets, targetFiles);
  assert.deepEqual(comparison.controls, ["test/a.test.ts"]);
  assert.deepEqual(comparison.excluded, []);
  assert.throws(() => compareInventories(baseline, [...candidate, "test/new.test.ts"], {
    targetFiles, excludedFiles: [], changedFiles: targetFiles, expectedCommonCount: 3, expectedControlCount: 1,
  }), /inventory|common|expected/i);
  assert.throws(() => compareInventories(baseline, candidate, {
    targetFiles, excludedFiles: [], changedFiles: ["test/a.test.ts", ...targetFiles], expectedCommonCount: 3, expectedControlCount: 1,
  }), /changed|excluded|expected/i);
});

test("repository diff rejects runtime/source drift and permits documented metadata changes", () => {
  assert.deepEqual(compareRepositoryChanges([...targetFiles, "reports/example.md", "tasks/tasks-status.md"]), targetFiles);
  assert.throws(() => compareRepositoryChanges([...targetFiles, "src/index.ts"]), /execution|runtime|outside/i);
  assert.throws(() => compareRepositoryChanges([...targetFiles, "scripts/ci-test-measurement.mjs"]), /execution|runtime|outside/i);
});

test("failure summary output keeps the command label but redacts credentials and absolute paths", () => {
  const error = "npm-ci-candidate failed Authorization: Basic dXNlcjpwYXNz-secret-marker at C:\\runner\\_temp\\worktree and /tmp/private/worktree; github_pat_abcdefghijklmnopqrstuvwxyz0123456789 token=local-secret-marker";
  const message = formatFailureDiagnostic({ status: "failure", error });
  assert.match(message, /^Paired comparison error:/);
  assert.match(message, /npm-ci-candidate failed/);
  assert.match(message, /\[path\]/);
  assert.doesNotMatch(message, /C:\\runner|\/tmp\/private|github_pat_|local-secret-marker|dXNlcjpwYXNz/);
  assert.doesNotMatch(message, /Authorization:\s*Basic/);
  assert.match(formatSummaryError('cmd "C:\\Users\\alice smith\\secret.txt#private-fragment" after'), /^cmd \[path\] after$/);
  assert.match(formatSummaryError("cmd C:\\Users\\alice smith\\secret.txt#private-fragment"), /^cmd \[path\]$/);
  assert.match(formatSummaryError('cmd "/home/alice smith/private dir/secret.txt#private-fragment" after'), /^cmd \[path\] after$/);
  assert.match(formatSummaryError("cmd /home/alice smith/private dir/secret.txt#private-fragment"), /^cmd \[path\]$/);
  assert.equal(formatSummaryError("x".repeat(700)).length, 500);
  assert.equal(formatFailureDiagnostic({ status: "success", error: undefined }), "");
});

test("each file runs B→C, C→B, B→C with six samples and stable pair identities", () => {
  const schedule = buildPairedSchedule(["test/a.test.ts"]);
  assert.deepEqual(schedule.map(({ side }) => side), ["baseline", "candidate", "candidate", "baseline", "baseline", "candidate"]);
  assert.deepEqual(schedule.map(({ pairIndex }) => pairIndex), [1, 1, 2, 2, 3, 3]);
  assert.deepEqual(schedule.map(({ orderInPair }) => orderInPair), [1, 2, 1, 2, 1, 2]);
  assert.ok(schedule.every(({ file }) => file === "test/a.test.ts"));
});

test("scheduled sample loop retains completed records and counts when a later sample throws", async () => {
  const summary: Record<string, unknown> = {};
  let calls = 0;
  await assert.rejects(runScheduledSamples({
    schedule: [{ side: "baseline" }, { side: "candidate" }],
    summary,
    recordPathForIndex: (index: number) => `records/${String(index).padStart(4, "0")}.json`,
    runSample: async (_sample: unknown, index: number) => {
      calls += 1;
      if (index === 2) throw new Error("second sample failed");
      return { status: "success", sampleIndex: index };
    },
  }), /second sample failed/);
  assert.equal(calls, 2);
  assert.equal(summary.sampleCount, 1);
  assert.equal(summary.successfulSampleCount, 1);
  assert.deepEqual(summary.records, ["records/0001.json"]);
});

test("comparison reports per-side descriptive statistics and control-adjusted target improvement", () => {
  const records = [
    ["target.test.ts", "baseline", 100], ["target.test.ts", "candidate", 80],
    ["target.test.ts", "candidate", 90], ["target.test.ts", "baseline", 100],
    ["target.test.ts", "baseline", 120], ["target.test.ts", "candidate", 100],
    ["control.test.ts", "baseline", 100], ["control.test.ts", "candidate", 90],
    ["control.test.ts", "candidate", 100], ["control.test.ts", "baseline", 100],
    ["control.test.ts", "baseline", 100], ["control.test.ts", "candidate", 110],
  ].map(([file, side, durationMs], index) => ({
    file, side, pairIndex: Math.floor((index % 6) / 2) + 1, status: "success", exitCode: 0, durationMs,
  }));
  const result = summarizeComparison(records, { targets: ["target.test.ts"], controls: ["control.test.ts"] });
  assert.deepEqual(result.files["target.test.ts"].baseline, { meanMs: 106.66666666666667, medianMs: 100, minMs: 100, maxMs: 120, rangeMs: 20 });
  assert.deepEqual(result.files["target.test.ts"].candidate, { meanMs: 90, medianMs: 90, minMs: 80, maxMs: 100, rangeMs: 20 });
  assert.equal(result.files["target.test.ts"].pairedDeltas.length, 3);
  assert.ok(Math.abs(result.files["target.test.ts"].pairedDeltaMeanMs - 50 / 3) < 1e-10);
  assert.equal(result.files["target.test.ts"].pairedDeltaMedianMs, 20);
  assert.ok(Math.abs(result.files["target.test.ts"].meanPairedImprovementPercent - (20 + 10 + (100 / 6)) / 3) < 1e-10);
  assert.ok(Math.abs(result.files["target.test.ts"].medianPairedImprovementPercent - 50 / 3) < 1e-10);
  assert.equal(result.controlDistribution.length, 1);
  assert.equal(result.controlStatistics.medianMs, 0);
  assert.equal(result.controlsMedianImprovementPercent, 0);
  assert.ok(Math.abs(result.targets["target.test.ts"].controlAdjustedMedianImprovementPercentagePoints - 50 / 3) < 1e-10);
  assert.throws(() => summarizeComparison(records.map((record, index) => index === 0 ? { ...record, status: "failure" } : record), {
    targets: ["target.test.ts"], controls: ["control.test.ts"],
  }), /succeed/i);
});

test("manual paired mode is opt-in and existing manual measurement remains the default", async () => {
  const workflow = parse(await readFile(path.resolve(here, "../.github/workflows/test-runtime-measurement.yml"), "utf8")) as any;
  assert.equal(workflow.on.workflow_dispatch.inputs.mode.default, "individual");
  assert.ok(workflow.on.workflow_dispatch.inputs.mode.options.includes("paired-comparison"));
  const job = workflow.jobs.measure;
  assert.equal(job["timeout-minutes"], 360);
  assert.deepEqual(job.permissions, { contents: "read", actions: "read" });
  const steps = job.steps;
  const pairedCheckout = steps.find((step: any) => step.name === "Checkout full history for paired comparison");
  assert.equal(pairedCheckout.with["fetch-depth"], 0);
  const pairedRunner = steps.find((step: any) => step.name === "Run fixed paired Windows comparison");
  assert.match(pairedRunner.if, /workflow_dispatch.*paired-comparison/);
  const pairedUpload = steps.find((step: any) => step.name === "Upload paired comparison evidence");
  assert.match(pairedUpload.if, /always\(\)/);
  assert.match(pairedUpload.if, /paired-comparison/);
});
