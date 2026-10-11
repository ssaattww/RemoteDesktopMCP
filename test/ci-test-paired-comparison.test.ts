import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  BASELINE_COMMIT,
  CANDIDATE_COMMIT,
  PREDECLARED_CONTROL_FILES,
  buildPairedSchedule,
  capturePackageLockIdentity,
  classifyPackageLockDiagnostics,
  normalizePackageLockLineEndings,
  preparePinnedLockForNpmCi,
  compareRepositoryChanges,
  compareInventories,
  comparePredeclaredControlBlobs,
  cleanupWorktreesWithCheckpoints,
  formatFailureDiagnostic,
  formatSummaryError,
  runScheduledSamples,
  runNpmCiWithLockDiagnostics,
  summarizeComparison,
  writeSummaryCheckpoint,
} from "../scripts/ci-test-paired-comparison.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const targetFiles = [
  "test/config-transfer-integrity.test.ts",
  "test/session-filesystem-lifecycle.test.ts",
];

test("package lock diagnostics distinguish unchanged bytes, line endings, and content by stage", () => {
  const identity = (content: Buffer, normalizedGitBlob: string) => ({
    rawBytesSha256: createHash("sha256").update(content).digest("hex"),
    lineEndingNormalizedSha256: createHash("sha256").update(normalizePackageLockLineEndings(content)).digest("hex"),
    normalizedGitBlob,
  });
  const expected = identity(Buffer.from('{"lockfileVersion":3}\n'), "expected-blob");
  const unchanged = { ...expected };
  const lineEndingOnly = identity(Buffer.from('{"lockfileVersion":3}\r\n'), "expected-blob");
  const contentChanged = identity(Buffer.from('{"lockfileVersion":3,"changed":true}\n'), "changed-blob");

  assert.deepEqual(classifyPackageLockDiagnostics(expected, unchanged, unchanged), {
    checkout: "unchanged",
    npmCi: "unchanged",
    classification: "unchanged",
  });
  assert.deepEqual(classifyPackageLockDiagnostics(expected, lineEndingOnly, lineEndingOnly), {
    checkout: "line-ending-only",
    npmCi: "unchanged",
    classification: "line-ending-only-at-checkout",
  });
  assert.deepEqual(classifyPackageLockDiagnostics(expected, unchanged, lineEndingOnly), {
    checkout: "unchanged",
    npmCi: "line-ending-only",
    classification: "line-ending-only-during-npm-ci",
  });
  assert.deepEqual(classifyPackageLockDiagnostics(expected, unchanged, contentChanged), {
    checkout: "unchanged",
    npmCi: "content-changed",
    classification: "content-changed-during-npm-ci",
  });
  assert.deepEqual(classifyPackageLockDiagnostics(expected, contentChanged, contentChanged), {
    checkout: "content-changed",
    npmCi: "unchanged",
    classification: "content-changed-at-checkout",
  });

  const invalidUtf8Before = Buffer.from([0x80, 0x0d, 0x0a, 0x81]);
  const invalidUtf8After = Buffer.from([0x81, 0x0d, 0x0a, 0x80]);
  assert.notDeepEqual(normalizePackageLockLineEndings(invalidUtf8Before), normalizePackageLockLineEndings(invalidUtf8After));
  assert.deepEqual(classifyPackageLockDiagnostics(
    identity(invalidUtf8Before, "invalid-before"),
    identity(invalidUtf8Before, "invalid-before"),
    identity(invalidUtf8After, "invalid-after"),
  ), {
    checkout: "unchanged",
    npmCi: "content-changed",
    classification: "content-changed-during-npm-ci",
  });
});

test("pinned lock bytes are asserted before npm ci and checkout identity is retained", async () => {
  const identity = (content: Buffer, normalizedGitBlob: string) => ({
    byteLength: content.length,
    rawBytesSha256: createHash("sha256").update(content).digest("hex"),
    lineEndingNormalizedSha256: createHash("sha256").update(normalizePackageLockLineEndings(content)).digest("hex"),
    normalizedGitBlob,
  });
  const expectedBytes = Buffer.from('{"lockfileVersion":3}\n');
  const checkoutBytes = Buffer.from('{"lockfileVersion":3}\r\n');
  const expectedIdentity = identity(expectedBytes, "a".repeat(40));
  const checkoutIdentity = identity(checkoutBytes, "a".repeat(40));
  let currentBytes = checkoutBytes;
  const captureIdentity = async () => identity(currentBytes, "a".repeat(40));
  const diagnostic: Record<string, unknown> = {
    checkoutIdentity,
    preparedForNpmCiIdentity: null,
    afterNpmCiIdentity: null,
  };

  await runNpmCiWithLockDiagnostics({
    preparePinnedLock: () => preparePinnedLockForNpmCi({
      expectedBytes,
      expectedIdentity,
      writeBytes: async (bytes: Buffer) => { currentBytes = Buffer.from(bytes); },
      readBytes: async () => currentBytes,
      captureIdentity,
    }),
    install: async () => { assert.deepEqual(currentBytes, expectedBytes); },
    captureIdentity,
    expectedIdentity,
    checkoutIdentity,
    diagnostic,
  });

  assert.deepEqual(diagnostic.checkoutIdentity, checkoutIdentity);
  assert.equal(diagnostic.checkoutClassification, "line-ending-only");
  assert.deepEqual(diagnostic.preparedForNpmCiIdentity, expectedIdentity);
  assert.equal(diagnostic.preparationClassification, "line-ending-only");
  assert.deepEqual(diagnostic.afterNpmCiIdentity, expectedIdentity);
  assert.equal(diagnostic.npmCiClassification, "unchanged");
});

test("pinned lock byte mismatch blocks npm ci", async () => {
  const expectedBytes = Buffer.from('{"lockfileVersion":3}\n');
  const unexpectedBytes = Buffer.from('{"lockfileVersion":3,"extra":true}\n');
  const expectedIdentity = {
    byteLength: expectedBytes.length,
    rawBytesSha256: createHash("sha256").update(expectedBytes).digest("hex"),
    lineEndingNormalizedSha256: createHash("sha256").update(normalizePackageLockLineEndings(expectedBytes)).digest("hex"),
    normalizedGitBlob: "a".repeat(40),
  };
  let installCalled = false;
  const diagnostic: Record<string, unknown> = { checkoutIdentity: expectedIdentity };
  await assert.rejects(runNpmCiWithLockDiagnostics({
    preparePinnedLock: () => preparePinnedLockForNpmCi({
      expectedBytes,
      expectedIdentity,
      writeBytes: async () => undefined,
      readBytes: async () => unexpectedBytes,
      captureIdentity: async () => ({ ...expectedIdentity, rawBytesSha256: "unexpected-raw" }),
    }),
    install: async () => { installCalled = true; },
    captureIdentity: async () => expectedIdentity,
    expectedIdentity,
    checkoutIdentity: expectedIdentity,
    diagnostic,
  }), /pinned.*lock.*bytes|lock.*pinned.*bytes/i);
  assert.equal(installCalled, false);
  assert.deepEqual(diagnostic.checkoutIdentity, expectedIdentity);
});

test("checkout content changes and missing lock identities fail closed before preparation and npm ci", async () => {
  const expectedBytes = Buffer.from('{"lockfileVersion":3}\n');
  const changedBytes = Buffer.from('{"lockfileVersion":3,"changed":true}\n');
  const identity = (content: Buffer, blob: string) => ({
    byteLength: content.length,
    rawBytesSha256: createHash("sha256").update(content).digest("hex"),
    lineEndingNormalizedSha256: createHash("sha256").update(normalizePackageLockLineEndings(content)).digest("hex"),
    normalizedGitBlob: blob,
  });
  const expectedIdentity = identity(expectedBytes, "a".repeat(40));
  const changedIdentity = identity(changedBytes, "b".repeat(40));

  for (const [checkoutIdentity, expectedClassification] of [
    [changedIdentity, "content-changed"],
    [identity(changedBytes, "a".repeat(40)), "git-normalized-equivalent"],
    [null, "unavailable"],
  ] as const) {
    let prepareCalled = false;
    let installCalled = false;
    const diagnostic: Record<string, unknown> = { checkoutIdentity };
    await assert.rejects(runNpmCiWithLockDiagnostics({
      preparePinnedLock: async () => { prepareCalled = true; return expectedIdentity; },
      install: async () => { installCalled = true; },
      captureIdentity: async () => expectedIdentity,
      expectedIdentity,
      checkoutIdentity,
      diagnostic,
    }), expectedClassification === "unavailable" ? /missing or incomplete/ : new RegExp(expectedClassification));
    assert.equal(diagnostic.checkoutClassification, expectedClassification);
    assert.equal(prepareCalled, false, "unexpected or missing checkout identity must stop before any lock rewrite");
    assert.equal(installCalled, false, "unexpected or missing checkout identity must stop before npm ci");
    assert.equal(diagnostic.checkoutIdentity, checkoutIdentity, "the observed identity is retained for diagnosis");
  }
});

test("lock guard failure checkpoints its classification before stopping npm ci", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "paired-lock-checkpoint-"));
  const summaryPath = path.join(tempRoot, "paired-comparison-summary.json");
  const expectedBytes = Buffer.from('{"lockfileVersion":3}\n');
  const changedBytes = Buffer.from('{"lockfileVersion":3,"changed":true}\n');
  const identity = (content: Buffer, blob: string) => ({
    byteLength: content.length,
    rawBytesSha256: createHash("sha256").update(content).digest("hex"),
    lineEndingNormalizedSha256: createHash("sha256").update(normalizePackageLockLineEndings(content)).digest("hex"),
    normalizedGitBlob: blob,
  });
  const expectedIdentity = identity(expectedBytes, "a".repeat(40));
  const checkoutIdentity = identity(changedBytes, "b".repeat(40));
  const diagnostic: Record<string, unknown> = { checkoutIdentity };
  const summary = { status: "failure", packageLockDiagnostics: { baseline: diagnostic } };
  let installCalled = false;
  try {
    await writeSummaryCheckpoint(summaryPath, { status: "previous-checkpoint" });
    await assert.rejects(runNpmCiWithLockDiagnostics({
      install: async () => { installCalled = true; },
      preparePinnedLock: async () => expectedIdentity,
      captureIdentity: async () => expectedIdentity,
      expectedIdentity,
      checkoutIdentity,
      diagnostic,
      onDiagnosticUpdate: () => writeSummaryCheckpoint(summaryPath, summary),
    }), /Checkout package-lock differs from pinned content: content-changed/);

    const saved = JSON.parse(await readFile(summaryPath, "utf8")) as typeof summary;
    assert.equal(saved.packageLockDiagnostics.baseline.checkoutClassification, "content-changed");
    assert.equal(saved.packageLockDiagnostics.baseline.classification, "content-changed-at-checkout");
    assert.equal(installCalled, false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("post-npm-ci diagnostic failure does not replace the npm ci failure", async () => {
  const expectedIdentity = {
    byteLength: 0,
    rawBytesSha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
    lineEndingNormalizedSha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
    normalizedGitBlob: "c".repeat(40),
  };
  const diagnostic: Record<string, unknown> = { afterNpmCiIdentity: null };
  await assert.rejects(runNpmCiWithLockDiagnostics({
    preparePinnedLock: async () => ({}),
    install: async () => { throw new Error("npm ci failed first"); },
    captureIdentity: async () => { throw new Error("post-install lock capture failed"); },
    expectedIdentity,
    checkoutIdentity: expectedIdentity,
    diagnostic,
    onDiagnosticUpdate: async () => { throw new Error("checkpoint failed second"); },
  }), /npm ci failed first/);
  assert.equal(diagnostic.afterNpmCiCaptureError, "post-install lock capture failed");
  assert.equal(diagnostic.checkpointError, "checkpoint failed second");
  assert.equal(diagnostic.afterNpmCiIdentity, null);

  await assert.rejects(runNpmCiWithLockDiagnostics({
    preparePinnedLock: async () => ({}),
    install: async () => undefined,
    captureIdentity: async () => { throw new Error("post-install lock capture failed"); },
    expectedIdentity,
    checkoutIdentity: expectedIdentity,
    diagnostic: {},
  }), /post-install lock capture failed/);
});

test("unverified npm ci process trees skip unsafe post-install lock reads", async () => {
  const expectedIdentity = {
    byteLength: 0,
    rawBytesSha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
    lineEndingNormalizedSha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
    normalizedGitBlob: "d".repeat(40),
  };
  const primary = Object.assign(new Error("npm ci timed out"), { unsafePostInstallCapture: true });
  const diagnostic: Record<string, unknown> = { afterNpmCiIdentity: null };
  let captureCalls = 0;
  await assert.rejects(runNpmCiWithLockDiagnostics({
    preparePinnedLock: async () => expectedIdentity,
    install: async () => { throw primary; },
    captureIdentity: async () => { captureCalls += 1; return expectedIdentity; },
    expectedIdentity,
    checkoutIdentity: expectedIdentity,
    diagnostic,
    captureAfterInstallFailure: (error) => error?.unsafePostInstallCapture !== true,
  }), (error: unknown) => error === primary);
  assert.equal(captureCalls, 0);
  assert.equal(diagnostic.afterNpmCiCaptureSkipped, "install_process_tree_unverified");
  assert.equal(diagnostic.npmCiClassification, "unavailable");
});

test("package lock identity records raw bytes and Git's path-normalized blob", async () => {
  const repositoryRoot = path.resolve(here, "..");
  const lockBytes = await readFile(path.join(repositoryRoot, "package-lock.json"));
  const expectedGitBlob = execFileSync("git", ["rev-parse", "HEAD:package-lock.json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const identity = await capturePackageLockIdentity(repositoryRoot);
  assert.equal(identity.byteLength, lockBytes.length);
  assert.equal(identity.rawBytesSha256, createHash("sha256").update(lockBytes).digest("hex"));
  assert.equal(identity.normalizedGitBlob, expectedGitBlob);
  assert.match(identity.lineEndingNormalizedSha256, /^[a-f0-9]{64}$/u);
});
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

test("screening uses predeclared controls and records two separate warmups plus six balanced pairs", async () => {
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

  const executed: typeof schedule = [];
  const summary: Record<string, unknown> = {};
  const records = await runScheduledSamples({
    schedule,
    summary,
    recordPathForIndex: (index: number) => `records/${String(index).padStart(4, "0")}.json`,
    runSample: async (sample: (typeof schedule)[number]) => {
      executed.push(sample);
      return { status: "success", phase: sample.phase };
    },
  });
  assert.deepEqual(executed, schedule);
  assert.equal(records.length, 70);
  assert.equal(summary.sampleCount, 70);
  assert.equal(summary.successfulSampleCount, 70);
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

test("scheduled sample loop checkpoints a failed record and stops before later samples", async () => {
  const summary: Record<string, unknown> = { status: "in_progress" };
  let calls = 0;
  const checkpoints: Array<{ status?: string; sampleCount?: number; records?: string[] }> = [];
  const records = await runScheduledSamples({
    schedule: [
      { side: "baseline", phase: "warmup" },
      { side: "candidate", phase: "warmup" },
      { side: "baseline", phase: "measured" },
    ],
    summary,
    recordPathForIndex: (index: number) => `records/${String(index).padStart(4, "0")}.json`,
    onSampleComplete: async () => {
      checkpoints.push({ status: summary.status as string, sampleCount: summary.sampleCount as number, records: [...summary.records as string[]] });
    },
    runSample: async (sample: { phase: string }, index: number) => {
      calls += 1;
      return { status: index === 2 ? "failure" : "success", phase: sample.phase, sampleIndex: index };
    },
  });
  assert.equal(calls, 2);
  assert.equal(records.length, 2);
  assert.equal(summary.status, "failure");
  assert.equal(summary.stoppedAfterScheduleIndex, 2);
  assert.equal(summary.sampleCount, 2);
  assert.equal(summary.successfulSampleCount, 1);
  assert.equal(summary.warmupSampleCount, 2);
  assert.equal(summary.measuredSampleCount, 0);
  assert.equal("statistics" in summary, false);
  assert.deepEqual(summary.records, ["records/0001.json", "records/0002.json"]);
  assert.deepEqual(checkpoints, [
    { status: "in_progress", sampleCount: 1, records: ["records/0001.json"] },
    { status: "failure", sampleCount: 2, records: ["records/0001.json", "records/0002.json"] },
  ]);
});

test("terminal failure and success summaries are checkpointed before held cleanup begins", async () => {
  const holdCleanup = async (summary: Record<string, unknown>) => {
    const terminalState = JSON.parse(JSON.stringify(summary)) as Record<string, unknown>;
    const checkpoints: Array<Record<string, unknown>> = [];
    let markEntered!: () => void;
    let release!: () => void;
    const cleanupEntered = new Promise<void>((resolve) => { markEntered = resolve; });
    const cleanupGate = new Promise<void>((resolve) => { release = resolve; });
    const cleanup = cleanupWorktreesWithCheckpoints({
      worktrees: ["baseline"],
      summary,
      checkpoint: async () => { checkpoints.push(JSON.parse(JSON.stringify(summary)) as Record<string, unknown>); },
      removeWorktree: async () => { markEntered(); await cleanupGate; },
    });
    try {
      await cleanupEntered;
      assert.deepEqual(checkpoints[0], terminalState, "terminal state must be persisted before cleanup starts");
      return checkpoints[0];
    } finally {
      release();
      await cleanup;
    }
  };

  const failed = await holdCleanup({ status: "failure", error: "primary test failure", sampleCount: 3 });
  assert.equal(failed.status, "failure");
  assert.equal(failed.error, "primary test failure");

  const succeeded = await holdCleanup({ status: "success", statistics: { target: { medianMs: 42 } }, sampleCount: 70 });
  assert.equal(succeeded.status, "success");
  assert.deepEqual(succeeded.statistics, { target: { medianMs: 42 } });
});

test("cleanup failures are checkpointed before the next worktree attempt", async () => {
  const summary: Record<string, unknown> = { status: "failure", error: "primary test failure" };
  const checkpoints: Array<Record<string, unknown>> = [];
  await cleanupWorktreesWithCheckpoints({
    worktrees: ["first", "second"],
    summary,
    checkpoint: async () => { checkpoints.push(JSON.parse(JSON.stringify(summary)) as Record<string, unknown>); },
    removeWorktree: async (worktree: string) => {
      if (worktree === "second") throw new Error("remove second failed");
      const previous = checkpoints.at(-1)?.cleanupAttempts as Array<{ worktree: string; status: string; error?: string }> | undefined;
      assert.equal(previous?.at(-1)?.worktree, "second");
      assert.equal(previous?.at(-1)?.status, "failure");
      assert.equal(previous?.at(-1)?.error, "remove second failed");
    },
  });
  assert.equal(summary.error, "primary test failure");
  assert.equal(summary.cleanupError, "remove second failed");
  assert.deepEqual(summary.cleanupAttempts, [
    { worktree: "second", status: "failure", error: "remove second failed" },
    { worktree: "first", status: "success" },
  ]);
});

test("checkpoint failures never replace the primary run error", async () => {
  const summary: Record<string, unknown> = { status: "failure", error: "primary test failure" };
  await cleanupWorktreesWithCheckpoints({
    worktrees: ["baseline"],
    summary,
    checkpoint: async () => { throw new Error("checkpoint failed"); },
    removeWorktree: async () => { throw new Error("cleanup failed"); },
  });
  assert.equal(summary.error, "primary test failure");
  assert.equal(summary.cleanupError, "cleanup failed");
  assert.equal(summary.checkpointFailureCount, 3);
  assert.equal(summary.checkpointError, "checkpoint failed");
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
  assert.ok(workflow.on.workflow_dispatch.inputs.mode.options.includes("paired-startup-diagnostic"));
  const job = workflow.jobs.measure;
  assert.match(job["timeout-minutes"], /paired-startup-diagnostic.*18.*360/);
  assert.deepEqual(job.permissions, { contents: "read", actions: "read" });
  const steps = job.steps;
  const pairedCheckout = steps.find((step: any) => step.name === "Checkout full history for paired comparison");
  assert.equal(pairedCheckout.with["fetch-depth"], 0);
  assert.match(pairedCheckout["timeout-minutes"], /paired-startup-diagnostic.*2.*360/);
  const setupNode = steps.find((step: any) => step.name === "Set up Node.js");
  assert.match(setupNode.if, /inputs\.mode != 'paired-startup-diagnostic'/);
  const setupNodeDiagnostic = steps.find((step: any) => step.name === "Set up Node.js for startup diagnostic");
  assert.equal(setupNodeDiagnostic["timeout-minutes"], 1);
  const metadata = steps.find((step: any) => step.name === "Resolve workflow metadata");
  assert.match(metadata["timeout-minutes"], /paired-startup-diagnostic.*1.*360/);
  const pairedRunner = steps.find((step: any) => step.name === "Run fixed paired Windows comparison");
  assert.match(pairedRunner.if, /workflow_dispatch.*paired-comparison/);
  const diagnosticRunner = steps.find((step: any) => step.name === "Run bounded paired startup diagnostic");
  assert.match(diagnosticRunner.if, /workflow_dispatch.*paired-startup-diagnostic/);
  assert.match(diagnosticRunner.run, /ci-test-paired-startup-diagnostic\.mjs/);
  assert.equal(diagnosticRunner["timeout-minutes"], 12);
  const install = steps.find((step: any) => step.name === "Install dependencies");
  assert.match(install.if, /paired-startup-diagnostic/);
  assert.match(install.if, /paired-comparison/);
  const pairedUpload = steps.find((step: any) => step.name === "Upload paired comparison evidence");
  assert.match(pairedUpload.if, /always\(\)/);
  assert.match(pairedUpload.if, /paired-comparison/);
  assert.doesNotMatch(pairedUpload.if, /paired-startup-diagnostic/);
  const diagnosticUpload = steps.find((step: any) => step.name === "Upload paired startup diagnostic evidence");
  assert.match(diagnosticUpload.if, /always\(\).*paired-startup-diagnostic/);
  assert.equal(diagnosticUpload.with.path, "ci-artifacts/paired-startup-diagnostic");
  assert.equal(diagnosticUpload["timeout-minutes"], 1);
  const checkoutDiagnosticTimeout = Number(pairedCheckout["timeout-minutes"].match(/&& (\d+)/)?.[1]);
  const metadataDiagnosticTimeout = Number(metadata["timeout-minutes"].match(/&& (\d+)/)?.[1]);
  assert.equal(checkoutDiagnosticTimeout + setupNodeDiagnostic["timeout-minutes"] + metadataDiagnosticTimeout + diagnosticRunner["timeout-minutes"] + diagnosticUpload["timeout-minutes"], 17);
});
