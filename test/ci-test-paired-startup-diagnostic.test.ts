import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BASELINE_COMMIT,
  CANDIDATE_COMMIT,
} from "../scripts/ci-test-paired-comparison.mjs";
import {
  STARTUP_DIAGNOSTIC_JOB_BUDGET_MS,
  STARTUP_DIAGNOSTIC_PREPARATION_BUDGET_MS,
  STARTUP_DIAGNOSTIC_SCRIPT_STEP_BUDGET_MS,
  STARTUP_DIAGNOSTIC_SCRIPT_BUDGET_MS,
  STARTUP_DIAGNOSTIC_CLEANUP_RESERVE_MS,
  STARTUP_DIAGNOSTIC_UPLOAD_BUDGET_MS,
  STARTUP_DIAGNOSTIC_RUNNER_SLACK_MS,
  STARTUP_DIAGNOSTIC_SAMPLE_COUNT,
  STARTUP_DIAGNOSTIC_TEST_FILE,
  createDiagnosticSummary,
  diagnosticOverlayIdentity,
  diagnosticOverlayPairMatches,
  diagnosticWorktreesMayBeMutated,
  diagnosticBudgetRemaining,
  overlaySource,
  readSafeDiagnosticEvents,
  restoreOverlayFiles,
  retainPrimaryDiagnosticFailure,
  runBoundedChild,
  safeDiagnosticError,
  validateDiagnosticRow,
} from "../scripts/ci-test-paired-startup-diagnostic.mjs";
import { diagnosticEventPath, guardFixturePreparation, importEntryWithSafeDiagnosticMarkers } from "../scripts/ci-test-paired-startup-observer.mjs";

test("startup diagnostic is bounded and separate from the 70-sample performance schedule", () => {
  assert.equal(STARTUP_DIAGNOSTIC_JOB_BUDGET_MS, 10 * 60 * 1000);
  assert.equal(STARTUP_DIAGNOSTIC_PREPARATION_BUDGET_MS + STARTUP_DIAGNOSTIC_SCRIPT_STEP_BUDGET_MS + STARTUP_DIAGNOSTIC_UPLOAD_BUDGET_MS + STARTUP_DIAGNOSTIC_RUNNER_SLACK_MS, STARTUP_DIAGNOSTIC_JOB_BUDGET_MS);
  assert.equal(STARTUP_DIAGNOSTIC_SCRIPT_BUDGET_MS + STARTUP_DIAGNOSTIC_CLEANUP_RESERVE_MS, STARTUP_DIAGNOSTIC_SCRIPT_STEP_BUDGET_MS);
  assert.equal(STARTUP_DIAGNOSTIC_SAMPLE_COUNT, 2);
  assert.equal(STARTUP_DIAGNOSTIC_TEST_FILE, "test/config-transfer-integrity.test.ts");
  assert.equal(createDiagnosticSummary("123", "1", "a".repeat(40)).overlayIdentityVerified, false);
  assert.equal(diagnosticBudgetRemaining(10_000, 9_900), 100);
  assert.equal(diagnosticBudgetRemaining(10_000, 10_001), 0);
  assert.equal(diagnosticWorktreesMayBeMutated({ preserveWorktrees: false, terminationUnverified: false }), true);
  assert.equal(diagnosticWorktreesMayBeMutated({ preserveWorktrees: false, terminationUnverified: true }), false);
  assert.equal(diagnosticWorktreesMayBeMutated({ preserveWorktrees: true, terminationUnverified: false }), false);
});

test("diagnostic errors and sidecars contain only allowlisted fields, never messages or paths", () => {
  const identity = { side: "baseline", runId: "42", sha: BASELINE_COMMIT };
  const row = { ...identity, seq: 1, event: "dc_connect_failed", phase: "transport_connect", classification: "initialize_disconnect", errorClass: "McpError", errorCode: "unknown" };
  assert.equal(validateDiagnosticRow(row, identity), true);
  assert.equal(validateDiagnosticRow({ ...row, message: "secret=do-not-write C:\\Users\\someone" }, identity), false);
  assert.equal(validateDiagnosticRow({ ...row, path: "C:\\Users\\someone\\private" }, identity), false);
  assert.equal(validateDiagnosticRow({ ...row, event: "from-stderr-marker" }, identity), false);
  const error = Object.assign(new Error("secret=hidden C:\\Users\\private\\file.mjs"), { code: "ENOENT" });
  const safe = safeDiagnosticError(error);
  assert.deepEqual(safe, { errorClass: "Error", errorCode: "ENOENT", classification: "spawn_failure" });
  assert.equal(JSON.stringify(safe).includes("hidden"), false);
  assert.equal(JSON.stringify(safe).includes("Users"), false);
});

test("producer sidecars remain independent under concurrent writes and validate each sequence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paired-startup-sidecar-test-"));
  try {
    const identity = { side: "candidate", runId: "9", sha: CANDIDATE_COMMIT };
    const driverFile = diagnosticEventPath(root, "driver");
    const observerId = randomUUID();
    const observerFile = diagnosticEventPath(root, observerId);
    assert.notEqual(driverFile, observerFile);
    assert.notEqual(diagnosticEventPath(root, randomUUID()), observerFile);
    const row = (seq: number, event: string) => `${JSON.stringify({ ...identity, seq, event, phase: "entry_import", outcome: "success" })}\n`;
    await Promise.all([
      writeFile(driverFile, `${row(1, "test_started")}${row(2, "test_completed")}`, { flag: "a" }),
      writeFile(observerFile, `${row(1, "bootstrap_entry_import_succeeded")}${row(2, "dc_ready")}`, { flag: "a" }),
    ]);
    assert.deepEqual((await readSafeDiagnosticEvents(driverFile, identity)).map(({ seq }) => seq), [1, 2]);
    assert.deepEqual((await readSafeDiagnosticEvents(observerFile, identity)).map(({ seq }) => seq), [1, 2]);

    const file = driverFile;
    await writeFile(file, `${JSON.stringify({ ...identity, seq: 1, event: "bootstrap_entry_import_succeeded", phase: "entry_import", outcome: "success", rawstderr: "unsafe-field-fixture" })}\n`);
    await assert.rejects(readSafeDiagnosticEvents(file, identity), /unsafe record/);
    assert.equal((await readFile(file, "utf8")).includes("unsafe-field-fixture"), true);
    const safe = (seq: number) => JSON.stringify({ ...identity, seq, event: "bootstrap_entry_import_succeeded", phase: "entry_import", outcome: "success" });
    await writeFile(file, `${safe(8)}\n${safe(9)}\n`);
    assert.equal((await readSafeDiagnosticEvents(file, identity)).length, 2);
    await writeFile(file, `${safe(8)}\n${safe(8)}\n`);
    await assert.rejects(readSafeDiagnosticEvents(file, identity), /unsafe record/);
    await writeFile(file, `${safe(8)}\n${safe(7)}\n`);
    await assert.rejects(readSafeDiagnosticEvents(file, identity), /unsafe record/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("overlay generation instruments checked-out sources without private SDK process fields", async () => {
  for (const file of ["src/index.ts", "scripts/desktop-commander-bootstrap.mjs", "test/fixture.ts"]) {
    const source = await readFile(file);
    const overlay = overlaySource(file, source).toString("utf8");
    assert.match(overlay, /emitStartupDiagnostic/);
    assert.doesNotMatch(overlay, /\._process\b/);
  }
  const entry = overlaySource("scripts/desktop-commander-bootstrap.mjs", await readFile("scripts/desktop-commander-bootstrap.mjs"));
  assert.match(entry.toString("utf8"), /importEntryWithSafeDiagnosticMarkers/);
  assert.match(entry.toString("utf8"), /exitCode: null, signal: "unknown"/);
  const service = overlaySource("src/index.ts", await readFile("src/index.ts"));
  assert.match(service.toString("utf8"), /dc_connect_failed.*exitCode: null, signal: "unknown"/);
  const fixture = overlaySource("test/fixture.ts", await readFile("test/fixture.ts"));
  assert.match(fixture.toString("utf8"), /guardFixturePreparation/);
  assert.match(fixture.toString("utf8"), /setPhase\("fixture_private_storage"\)/);
});

test("fixed-pair overlay identity excludes side identity but detects changed overlay content", () => {
  const baselineRoot = path.join(os.tmpdir(), "startup-baseline");
  const candidateRoot = path.join(os.tmpdir(), "startup-candidate");
  const overlays = (root: string, side: string, sourceHash = "a".repeat(64)) => [
    { path: path.join(root, "ci-artifacts", "paired-startup-diagnostic", "identity.json"), overlaySha256: side },
    { path: path.join(root, "src", "index.ts"), overlaySha256: sourceHash },
    { path: path.join(root, "scripts", "observer.mjs"), overlaySha256: "b".repeat(64) },
  ];
  assert.deepEqual(diagnosticOverlayIdentity(baselineRoot, overlays(baselineRoot, "baseline")), [
    { file: "scripts/observer.mjs", overlaySha256: "b".repeat(64) },
    { file: "src/index.ts", overlaySha256: "a".repeat(64) },
  ]);
  assert.equal(diagnosticOverlayPairMatches(baselineRoot, overlays(baselineRoot, "baseline"), candidateRoot, overlays(candidateRoot, "candidate")), true);
  assert.equal(diagnosticOverlayPairMatches(baselineRoot, overlays(baselineRoot, "baseline"), candidateRoot, overlays(candidateRoot, "candidate", "c".repeat(64))), false);
});

test("best-effort entry and fixture diagnostics preserve the primary failure and release the keep-alive timer", async () => {
  const primaryImportError = new Error("original entry import failure");
  await assert.rejects(
    importEntryWithSafeDiagnosticMarkers(async () => { throw primaryImportError; }, () => { throw new Error("marker failure"); }),
    (error: unknown) => error === primaryImportError,
  );
  assert.equal(await importEntryWithSafeDiagnosticMarkers(async () => "loaded", () => { throw new Error("success marker failure"); }), "loaded");

  const primaryFixtureError = Object.assign(new Error("fixture setup failure"), { code: "EACCES" });
  const observed: Array<{ event: string; phase?: string; errorCode?: string }> = [];
  const keepAlive = {} as ReturnType<typeof setInterval>;
  let timerReleased = false;
  let cleanupCalled = false;
  await assert.rejects(guardFixturePreparation(async (setPhase) => {
    setPhase("fixture_private_storage");
    throw primaryFixtureError;
  }, {
    keepAlive,
    clearTimer: (timer) => { assert.equal(timer, keepAlive); timerReleased = true; },
    emit: (event, fields) => { observed.push({ event, phase: fields?.phase as string, errorCode: fields?.errorCode as string }); throw new Error("observer failure"); },
    cleanup: () => { cleanupCalled = true; },
  }), (error: unknown) => error === primaryFixtureError);
  assert.equal(timerReleased, true);
  assert.equal(cleanupCalled, true);
  assert.ok(observed.some((item) => item.event === "fixture_prepare_failed" && item.phase === "fixture_private_storage" && item.errorCode === "EACCES"));
});

test("diagnostic timeout only confirms its owned direct child and never claims the process tree stopped", async () => {
  const source = await readFile(path.resolve("scripts/ci-test-paired-startup-diagnostic.mjs"), "utf8");
  assert.doesNotMatch(source, /taskkill\.exe|Win32_Process/u);
  const child = { stdout: { destroy() {} }, stderr: { destroy() {} }, unref() {} };
  const timeout = await runBoundedChild("ignored", [], {
    runProcess: async () => ({ timedOut: true, child, childClose: Promise.resolve({ kind: "closed" }) }),
    terminateChild: async () => ({ verified: true, reason: "direct_child_close_observed" }),
  });
  assert.equal(timeout.directChildTermination, "verified");
  assert.equal(timeout.treeTermination, "unknown");
  assert.equal(diagnosticWorktreesMayBeMutated({ preserveWorktrees: false, terminationUnverified: true }), false);

  const unknown = await runBoundedChild("ignored", [], {
    runProcess: async () => ({ timedOut: true, child, childClose: Promise.resolve({ kind: "closed" }) }),
    terminateChild: async () => ({ verified: false, reason: "owned_child_handle_unavailable" }),
  });
  assert.equal(unknown.directChildTermination, "unknown");
  assert.equal(unknown.treeTermination, "unknown");
});

test("restore writes originals only when the exact overlay hash still matches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paired-startup-restore-test-"));
  try {
    const file = path.join(root, "overlay.txt");
    await writeFile(file, "overlay bytes");
    const originalBytes = Buffer.from("original bytes");
    const record = {
      path: file,
      originalBytes,
      originalSha256: createHash("sha256").update(originalBytes).digest("hex"),
      overlaySha256: createHash("sha256").update("overlay bytes").digest("hex"),
      created: false,
    };
    await writeFile(file, "unexpected concurrent edit");
    assert.deepEqual(await restoreOverlayFiles([record]), { restored: false, reason: "overlay_hash_mismatch" });
    assert.equal(await readFile(file, "utf8"), "unexpected concurrent edit");
    await writeFile(file, "overlay bytes");
    assert.deepEqual(await restoreOverlayFiles([record]), { restored: true });
    assert.equal(await readFile(file, "utf8"), "original bytes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("first diagnostic failure remains primary and unknown tree termination is reported", async () => {
  const summary = createDiagnosticSummary("123", "1", "a".repeat(40));
  const first = retainPrimaryDiagnosticFailure(summary, "test", Object.assign(new Error("secret message"), { code: "unknown" }), "test_failure");
  const second = retainPrimaryDiagnosticFailure(summary, "termination", new Error("secondary failure"), "termination_unverified");
  assert.equal(second, first);
  assert.equal(summary.primaryError.stage, "test");
  assert.equal(JSON.stringify(summary).includes("secret"), false);

  const child = { stdout: { destroy() {} }, stderr: { destroy() {} }, unref() {} };
  const timeout = await runBoundedChild("ignored", [], {
    runProcess: async () => ({ timedOut: true, child }),
    terminateTree: async () => ({ verified: false, reason: "tree_members_remain_or_unknown" }),
  });
  assert.equal(timeout.treeTermination, "unknown");
});
