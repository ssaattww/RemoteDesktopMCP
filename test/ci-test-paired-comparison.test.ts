import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  BASELINE_COMMIT,
  CANDIDATE_COMMIT,
  PREDECLARED_CONTROL_FILES,
  buildPairedSchedule,
  compareRepositoryChanges,
  compareInventories,
  comparePredeclaredControlBlobs,
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

test("screening uses predeclared controls and records two separate warmups plus six balanced pairs", () => {
  assert.deepEqual(PREDECLARED_CONTROL_FILES, [
    "test/independent-transfer-lifecycle.test.ts",
    "test/tool-root-contracts.test.ts",
    "test/independent-process-ownership.test.ts",
  ]);
  const screeningFiles = [...targetFiles, ...PREDECLARED_CONTROL_FILES];
  const schedule = buildPairedSchedule(screeningFiles);
  assert.equal(schedule.length, 70);
  for (const file of screeningFiles) assert.equal(schedule.filter((sample) => sample.file === file).length, 14);
  const firstFile = schedule.filter((sample) => sample.file === [...screeningFiles].sort()[0]);
  assert.deepEqual(firstFile.map(({ phase, side }) => `${phase}:${side}`), [
    "warmup:baseline", "warmup:candidate",
    "measured:baseline", "measured:candidate",
    "measured:candidate", "measured:baseline",
    "measured:baseline", "measured:candidate",
    "measured:candidate", "measured:baseline",
    "measured:baseline", "measured:candidate",
    "measured:candidate", "measured:baseline",
  ]);
  assert.deepEqual(firstFile.slice(2).map(({ pairIndex }) => pairIndex), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6]);
  assert.deepEqual(firstFile.slice(2).map(({ orderInPair }) => orderInPair), [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2]);
  assert.equal(schedule.filter(({ phase }) => phase === "warmup").length, 10);
  assert.equal(schedule.filter(({ phase }) => phase === "measured").length, 60);
});

test("predeclared controls must have identical tracked blob identities on both sides", () => {
  const baseline = new Map(PREDECLARED_CONTROL_FILES.map((file, index) => [file, { object: `blob-${index}` }]));
  const candidate = new Map(PREDECLARED_CONTROL_FILES.map((file, index) => [file, { object: `blob-${index}` }]));
  assert.deepEqual(comparePredeclaredControlBlobs(baseline, candidate), PREDECLARED_CONTROL_FILES.map((file, index) => ({
    file, baselineObject: `blob-${index}`, candidateObject: `blob-${index}`, identical: true,
  })));
  candidate.set(PREDECLARED_CONTROL_FILES[1], { object: "changed-control-blob" });
  assert.throws(() => comparePredeclaredControlBlobs(baseline, candidate), /predeclared control.*changed|changed.*control/i);
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

test("screening statistics exclude warmups and report six pairs plus first-side-stratified effects", () => {
  const measured = (file: string, baseline: number[], candidate: number[]) => [
    ...Array.from({ length: 6 }, (_unused, index) => ({ file, side: "baseline", phase: "measured", pairIndex: index + 1, orderInPair: index % 2 === 0 ? 1 : 2, status: "success", exitCode: 0, durationMs: baseline[index] })),
    ...Array.from({ length: 6 }, (_unused, index) => ({ file, side: "candidate", phase: "measured", pairIndex: index + 1, orderInPair: index % 2 === 0 ? 2 : 1, status: "success", exitCode: 0, durationMs: candidate[index] })),
    { file, side: "baseline", phase: "warmup", pairIndex: null, orderInPair: 1, status: "success", exitCode: 0, durationMs: 9999 },
    { file, side: "candidate", phase: "warmup", pairIndex: null, orderInPair: 2, status: "success", exitCode: 0, durationMs: 8888 },
  ];
  const records = [
    ...measured("target.test.ts", [100, 120, 100, 120, 100, 120], [80, 110, 90, 100, 80, 100]),
    ...measured("control.test.ts", [100, 100, 100, 100, 100, 100], [90, 90, 90, 90, 90, 90]),
  ];
  const result = summarizeComparison(records, { targets: ["target.test.ts"], controls: ["control.test.ts"] });
  assert.deepEqual(result.files["target.test.ts"].baseline, { meanMs: 110, medianMs: 110, minMs: 100, maxMs: 120, rangeMs: 20 });
  assert.deepEqual(result.files["target.test.ts"].candidate, { meanMs: 93.33333333333333, medianMs: 95, minMs: 80, maxMs: 110, rangeMs: 30 });
  assert.equal(result.files["target.test.ts"].pairedDeltas.length, 6);
  assert.equal(result.files["target.test.ts"].pairedDeltas[1].deltaMs, 10);
  assert.equal(result.files["target.test.ts"].pairedDeltas[0].improvementPercent, 20);
  assert.equal(result.files["target.test.ts"].pairedDeltaMeanMs, 100 / 6);
  assert.equal(result.files["target.test.ts"].pairedDeltaMedianMs, 20);
  assert.ok(Math.abs(result.files["target.test.ts"].meanPairedImprovementPercent - 15.277777777777779) < 1e-10);
  assert.ok(Math.abs(result.files["target.test.ts"].medianPairedImprovementPercent - (50 / 3)) < 1e-10);
  assert.equal(result.files["target.test.ts"].orderStratifiedEffects.baselineFirst.pairCount, 3);
  assert.equal(result.files["target.test.ts"].orderStratifiedEffects.candidateFirst.pairCount, 3);
  assert.equal(result.files["target.test.ts"].orderStratifiedEffects.baselineFirst.meanPairedDeltaMs, 50 / 3);
  assert.equal(result.files["target.test.ts"].orderStratifiedEffects.candidateFirst.meanPairedDeltaMs, 50 / 3);
  assert.equal(result.files["target.test.ts"].orderStratifiedEffects.baselineFirst.meanImprovementPercent, 50 / 3);
  assert.ok(Math.abs(result.files["target.test.ts"].orderStratifiedEffects.candidateFirst.meanImprovementPercent - (125 / 9)) < 1e-10);
  assert.equal(result.controlDistribution.length, 1);
  assert.equal(result.files["control.test.ts"].baseline.meanMs, 100);
  assert.equal(result.controlsMedianImprovementPercent, 10);
  assert.equal(result.targets["target.test.ts"].controlAdjustedMedianImprovementPercentagePoints, result.files["target.test.ts"].medianPairedImprovementPercent - 10);
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
