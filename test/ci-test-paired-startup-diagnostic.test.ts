import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  BASELINE_COMMIT,
  CANDIDATE_COMMIT,
} from "../scripts/ci-test-paired-comparison.mjs";
import {
  createNpmCiLaunchSpec,
  createNpmVersionLaunchSpec,
  STARTUP_DIAGNOSTIC_JOB_BUDGET_MS,
  STARTUP_DIAGNOSTIC_PREPARATION_BUDGET_MS,
  STARTUP_DIAGNOSTIC_SCRIPT_STEP_BUDGET_MS,
  STARTUP_DIAGNOSTIC_SCRIPT_BUDGET_MS,
  STARTUP_DIAGNOSTIC_CLEANUP_RESERVE_MS,
  STARTUP_DIAGNOSTIC_UPLOAD_BUDGET_MS,
  STARTUP_DIAGNOSTIC_RUNNER_SLACK_MS,
  STARTUP_DIAGNOSTIC_LOCK_AND_SETUP_BUDGET_MS,
  STARTUP_DIAGNOSTIC_NPM_CI_SIDE_BUDGET_MS,
  STARTUP_DIAGNOSTIC_INITIALIZE_SIDE_BUDGET_MS,
  STARTUP_DIAGNOSTIC_CHILD_TERMINATION_RESERVE_MS,
  STARTUP_DIAGNOSTIC_STAGE_BUDGETS,
  STARTUP_DIAGNOSTIC_SAMPLE_COUNT,
  STARTUP_DIAGNOSTIC_TEST_FILE,
  npmCliPathsForNodeExecutable,
  resolveBundledNpmCli,
  createChildProcessDiagnostics,
  createDiagnosticSummary,
  createDiagnosticStageBudget,
  childDeadlineWithinStage,
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
  assert.equal(STARTUP_DIAGNOSTIC_JOB_BUDGET_MS, 18 * 60 * 1000);
  assert.equal(STARTUP_DIAGNOSTIC_PREPARATION_BUDGET_MS + STARTUP_DIAGNOSTIC_SCRIPT_STEP_BUDGET_MS + STARTUP_DIAGNOSTIC_UPLOAD_BUDGET_MS + STARTUP_DIAGNOSTIC_RUNNER_SLACK_MS, STARTUP_DIAGNOSTIC_JOB_BUDGET_MS);
  assert.equal(STARTUP_DIAGNOSTIC_SCRIPT_BUDGET_MS + STARTUP_DIAGNOSTIC_CLEANUP_RESERVE_MS, STARTUP_DIAGNOSTIC_SCRIPT_STEP_BUDGET_MS);
  assert.equal(STARTUP_DIAGNOSTIC_LOCK_AND_SETUP_BUDGET_MS + (2 * STARTUP_DIAGNOSTIC_NPM_CI_SIDE_BUDGET_MS) + (2 * STARTUP_DIAGNOSTIC_INITIALIZE_SIDE_BUDGET_MS), STARTUP_DIAGNOSTIC_SCRIPT_BUDGET_MS);
  assert.equal(STARTUP_DIAGNOSTIC_CHILD_TERMINATION_RESERVE_MS, 6_000);
  assert.equal(childDeadlineWithinStage(50_000), 44_000);
  assert.deepEqual(STARTUP_DIAGNOSTIC_STAGE_BUDGETS, {
    lockAndSetup: 60_000,
    npmCiBaseline: 240_000,
    npmCiCandidate: 240_000,
    initializeBaseline: 60_000,
    initializeCandidate: 60_000,
  });
  assert.equal(STARTUP_DIAGNOSTIC_SAMPLE_COUNT, 2);
  assert.equal(STARTUP_DIAGNOSTIC_TEST_FILE, "test/config-transfer-integrity.test.ts");
  assert.equal(createDiagnosticSummary("123", "1", "a".repeat(40)).overlayIdentityVerified, false);
  const summary = createDiagnosticSummary("123", "1", "a".repeat(40));
  assert.equal(summary.npmCliResolution, "not_started");
  assert.equal(summary.npmCliSource, null);
  assert.equal(summary.npmCliVersion, null);
  assert.equal(JSON.stringify(summary).includes("npm-cli.js"), false);
  assert.equal(diagnosticBudgetRemaining(10_000, 9_900), 100);
  assert.equal(diagnosticBudgetRemaining(10_000, 10_001), 0);
  assert.equal(diagnosticWorktreesMayBeMutated({ preserveWorktrees: false, terminationUnverified: false }), true);
  assert.equal(diagnosticWorktreesMayBeMutated({ preserveWorktrees: false, terminationUnverified: true }), false);
  assert.equal(diagnosticWorktreesMayBeMutated({ preserveWorktrees: true, terminationUnverified: false }), false);
});

test("startup diagnostic phase budgets preserve cleanup and release unused reservations", () => {
  const budget = createDiagnosticStageBudget({ startedAt: 100 });
  assert.equal(budget.workDeadline, 100 + 11 * 60_000);
  assert.equal(budget.cleanupDeadline, 100 + 12 * 60_000);
  assert.equal(budget.deadlineFor("lockAndSetup", 100), 100 + 60_000);
  const baselineInitializationDeadline = budget.deadlineFor("initializeBaseline", 100);
  assert.equal(baselineInitializationDeadline, 100 + 60_000);
  assert.equal(childDeadlineWithinStage(baselineInitializationDeadline), 100 + 54_000);
  const setup = budget.recordElapsed("lockAndSetup", 100, 100 + 35_000);
  assert.equal(setup.stageBudgetExceeded, false);
  assert.equal(budget.remainingMs("lockAndSetup"), 25_000);
  budget.complete("lockAndSetup");
  assert.equal(budget.deadlineFor("npmCiBaseline", 100 + 35_000), 100 + 35_000 + 240_000);
  assert.equal(budget.deadlineFor("npmCiBaseline", 100 + 500_000), 100 + 11 * 60_000 - 6 * 60_000);
  budget.recordElapsed("npmCiBaseline", 100 + 35_000, 100 + 35_000 + 240_001);
  assert.equal(budget.remainingMs("npmCiBaseline"), 0);
  assert.equal(budget.deadlineFor("npmCiCandidate", 100 + 500_000), 100 + 11 * 60_000 - 2 * 60_000);
});

test("bundled npm CLI resolver uses one Node runtime and fails safely when no CLI exists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paired-startup-npm-cli-resolver-test-"));
  try {
    const nodeExecutable = path.join(root, "node.exe");
    const paths = npmCliPathsForNodeExecutable(nodeExecutable);
    let prefixResolverCalls = 0;
    await assert.rejects(resolveBundledNpmCli({
      nodeExecutable,
      cwd: root,
      deadline: performance.now() + 1_000,
      runPrefixResolver: async () => { prefixResolverCalls++; throw new Error("unexpected resolver launch"); },
    }), (error: Error) => {
      assert.equal(error.message, "bundled npm CLI is unavailable");
      assert.equal(error.message.includes(root), false);
      return true;
    });
    assert.equal(prefixResolverCalls, 0);

    await mkdir(path.dirname(paths.bundledCliPath), { recursive: true });
    await writeFile(paths.bundledCliPath, "// fixed runtime npm cli fixture\n");
    await writeFile(path.join(path.dirname(path.dirname(paths.bundledCliPath)), "package.json"), JSON.stringify({ version: "10.9.4" }));
    await mkdir(path.dirname(paths.prefixResolverPath), { recursive: true });
    await writeFile(paths.prefixResolverPath, "// npm prefix resolver fixture\n");
    const configuredPrefix = path.join(root, "configured-prefix");
    const configuredCli = path.join(configuredPrefix, "node_modules", "npm", "bin", "npm-cli.js");
    await mkdir(path.dirname(configuredCli), { recursive: true });
    await writeFile(configuredCli, "// configured npm cli fixture\n");
    await writeFile(path.join(path.dirname(path.dirname(configuredCli)), "package.json"), JSON.stringify({ version: "11.19.0" }));
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const resolved = await resolveBundledNpmCli({
      nodeExecutable,
      cwd: root,
      deadline: performance.now() + 1_000,
      runPrefixResolver: async (command, args, options) => {
        calls.push({ command, args, options });
        return { timedOut: false, spawnError: false, exitCode: 0, stdout: Buffer.from(`${configuredPrefix}\n`) };
      },
    });
    assert.equal(resolved.nodeExecutable, nodeExecutable);
    assert.equal(resolved.npmCliPath, configuredCli);
    assert.equal(resolved.npmCliSource, "configured_prefix");
    assert.equal(resolved.npmCliVersion, "11.19.0");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, nodeExecutable);
    assert.deepEqual(calls[0].args, [paths.prefixResolverPath]);
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.cwd, root);
    assert.equal(calls[0].options.captureStdout, "buffer");

    const deadline = performance.now() + 5_000;
    const baseline = createNpmCiLaunchSpec(resolved.nodeExecutable, resolved.npmCliPath, path.join(root, "baseline"), deadline);
    const candidate = createNpmCiLaunchSpec(resolved.nodeExecutable, resolved.npmCliPath, path.join(root, "candidate"), deadline);
    assert.equal(baseline.command, candidate.command);
    assert.deepEqual(baseline.args, candidate.args);
    assert.deepEqual(baseline.args, [configuredCli, "ci"]);
    assert.equal(baseline.options.shell, false);
    assert.equal(candidate.options.shell, false);
    assert.equal(baseline.options.deadline, candidate.options.deadline);
    assert.notEqual(baseline.options.cwd, candidate.options.cwd);
    const baselineVersion = createNpmVersionLaunchSpec(resolved.nodeExecutable, resolved.npmCliPath, path.join(root, "baseline"), deadline);
    const candidateVersion = createNpmVersionLaunchSpec(resolved.nodeExecutable, resolved.npmCliPath, path.join(root, "candidate"), deadline);
    assert.equal(baselineVersion.command, candidateVersion.command);
    assert.deepEqual(baselineVersion.args, candidateVersion.args);
    assert.deepEqual(baselineVersion.args, [configuredCli, "--version"]);
    assert.equal(baselineVersion.options.shell, false);
    assert.equal(candidateVersion.options.shell, false);
    assert.equal(baselineVersion.options.deadline, candidateVersion.options.deadline);
    assert.notEqual(baselineVersion.options.cwd, candidateVersion.options.cwd);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundled Node npm CLI runs npm ci and the root lifecycle in a dependency-free fixture", { skip: process.platform !== "win32" }, async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "paired-startup-npm-cli-fixture-"));
  try {
    const npmCli = await resolveBundledNpmCli({
      nodeExecutable: process.execPath,
      cwd: fixture,
      deadline: performance.now() + 60_000,
    });
    const name = "paired-startup-npm-cli-fixture";
    await writeFile(path.join(fixture, "package.json"), JSON.stringify({
      name,
      version: "1.0.0",
      private: true,
      scripts: { preinstall: "node -e \"require('node:fs').writeFileSync('lifecycle-marker.txt','ran')\"" },
    }, null, 2));
    await writeFile(path.join(fixture, "package-lock.json"), `${JSON.stringify({
      name,
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name, version: "1.0.0" } },
    }, null, 2)}\n`);
    const deadline = performance.now() + 60_000;
    const launch = createNpmCiLaunchSpec(npmCli.nodeExecutable, npmCli.npmCliPath, fixture, deadline);
    assert.equal(launch.command, process.execPath);
    assert.deepEqual(launch.args, [npmCli.npmCliPath, "ci"]);
    assert.equal(launch.options.shell, false);
    const install = await runBoundedChild(launch.command, launch.args, launch.options);
    assert.equal(install.timedOut, false);
    assert.equal(install.spawnError, false);
    assert.equal(install.exitCode, 0);
    assert.equal(await readFile(path.join(fixture, "lifecycle-marker.txt"), "utf8"), "ran");
    const versionLaunch = createNpmVersionLaunchSpec(npmCli.nodeExecutable, npmCli.npmCliPath, fixture, deadline);
    const version = await runBoundedChild(versionLaunch.command, versionLaunch.args, versionLaunch.options);
    assert.equal(version.timedOut, false);
    assert.equal(version.exitCode, 0);
    assert.equal(version.stdout.trim(), npmCli.npmCliVersion);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
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

test("bounded child preserves exact stdout bytes when Git content is requested as a Buffer", async () => {
  const expectedBytes = Buffer.from([0x7b, 0x0a]);
  const script = "process.stdout.write(Buffer.from([0x7b, 0x0a]))";
  const binary = await runBoundedChild(process.execPath, ["-e", script], {
    deadline: performance.now() + 10_000,
    captureStdout: "buffer",
  });
  assert.ok(Buffer.isBuffer(binary.stdout));
  assert.deepEqual(binary.stdout, expectedBytes);
  assert.equal(binary.stdout.at(-1), 0x0a, "git show lock bytes must retain the final LF");

  const text = await runBoundedChild(process.execPath, ["-e", script], {
    deadline: performance.now() + 10_000,
    captureStdout: true,
  });
  assert.equal(text.stdout, "{\n", "ordinary text capture remains UTF-8 text for identifier trimming");
});

test("bounded child diagnostics record safe spawn, exit, close, budget, and elapsed fields only", async () => {
  const privateMarker = "PRIVATE_STDOUT_STDERR_SENTINEL";
  const startedAt = new Date().toISOString();
  const timeoutMsApplied = 5_000;
  const outputScript = `process.stdout.write(Buffer.concat([Buffer.alloc(512 * 1024), Buffer.from(${JSON.stringify(privateMarker)})])); process.stderr.write(Buffer.concat([Buffer.alloc(512 * 1024), Buffer.from(${JSON.stringify(privateMarker)})]));`;
  const successful = await runBoundedChild(process.execPath, ["-e", outputScript], {
    deadline: performance.now() + 10_000,
    processStartedAt: startedAt,
    timeoutMsOverride: timeoutMsApplied,
    processDiagnostics: createChildProcessDiagnostics(startedAt, timeoutMsApplied),
  });
  assert.equal(successful.processDiagnostics.startedAt, startedAt);
  assert.equal(successful.processDiagnostics.remainingBudgetMsAtStart, timeoutMsApplied);
  assert.equal(successful.processDiagnostics.timeoutMsApplied, timeoutMsApplied);
  assert.equal(successful.processDiagnostics.spawnOutcome, "spawned");
  assert.equal(successful.processDiagnostics.commandOutcome, "completed_successfully");
  assert.equal(successful.processDiagnostics.exitObserved, true);
  assert.equal(successful.processDiagnostics.exitCode, 0);
  assert.equal(successful.processDiagnostics.closeObserved, true);
  assert.equal(successful.processDiagnostics.closeExitCode, 0);
  assert.equal(successful.processDiagnostics.treeTermination, "not_required");
  assert.ok(Number.isInteger(successful.processDiagnostics.elapsedMs));
  assert.equal(JSON.stringify(successful.processDiagnostics).includes(privateMarker), false);
  assert.equal(successful.stdout, "", "stdout remains drained, not retained");
  assert.equal(successful.processDiagnostics.timeoutOutcome, "not_timed_out");

  const nonzero = await runBoundedChild(process.execPath, ["-e", "process.exit(17)"], {
    deadline: performance.now() + 10_000,
    timeoutMsOverride: timeoutMsApplied,
  });
  assert.equal(nonzero.processDiagnostics.commandOutcome, "completed_nonzero");
  assert.equal(nonzero.processDiagnostics.exitObserved, true);
  assert.equal(nonzero.processDiagnostics.exitCode, 17);
  assert.equal(nonzero.processDiagnostics.closeObserved, true);

  const missingCommand = path.join(os.tmpdir(), `missing-startup-diagnostic-${randomUUID()}.exe`);
  const spawnFailure = await runBoundedChild(missingCommand, [], {
    deadline: performance.now() + 10_000,
    timeoutMsOverride: timeoutMsApplied,
  });
  assert.equal(spawnFailure.processDiagnostics.spawnOutcome, "spawn_error");
  assert.equal(spawnFailure.processDiagnostics.commandOutcome, "spawn_failed");
  assert.equal(spawnFailure.processDiagnostics.spawnErrorCode, "ENOENT");
  assert.equal(spawnFailure.processDiagnostics.exitObserved, false);
  assert.equal(JSON.stringify(spawnFailure.processDiagnostics).includes(missingCommand), false);
});

test("bounded child timer uses the exact recorded remaining budget", async () => {
  const timeoutMsApplied = 40;
  const timeout = await runBoundedChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    deadline: performance.now() + timeoutMsApplied,
  });
  assert.equal(timeout.processDiagnostics.remainingBudgetMsAtStart, timeout.processDiagnostics.timeoutMsApplied);
  assert.ok(timeout.processDiagnostics.timeoutMsApplied <= timeoutMsApplied);
  assert.ok(timeout.processDiagnostics.timeoutMsApplied > 0);
  assert.equal(timeout.processDiagnostics.timeoutOutcome, "deadline_expired");
  assert.equal(timeout.processDiagnostics.commandOutcome, "timed_out");
  assert.equal(timeout.processDiagnostics.directChildTermination, "verified");
  assert.equal(timeout.processDiagnostics.treeTermination, "unknown");
  assert.ok(timeout.processDiagnostics.elapsedMs >= timeout.processDiagnostics.timeoutMsApplied);
  assert.ok(timeout.processDiagnostics.elapsedMs < timeout.processDiagnostics.timeoutMsApplied + 1_000);
});

test("bounded child reports budget exhaustion before spawn as not started", async () => {
  const notStarted = await runBoundedChild(process.execPath, ["-e", "process.exit(0)"], {
    deadline: performance.now() - 1,
  });
  assert.equal(notStarted.child, null);
  assert.equal(notStarted.processDiagnostics.spawnOutcome, "not_started");
  assert.equal(notStarted.processDiagnostics.timeoutOutcome, "budget_exhausted_before_spawn");
  assert.equal(notStarted.processDiagnostics.commandOutcome, "not_started_budget_exhausted");
  assert.equal(notStarted.processDiagnostics.directChildTermination, "not_applicable");
  assert.equal(notStarted.processDiagnostics.treeTermination, "not_applicable");
});

test("bounded child timeout records fixed termination reasons without claiming tree shutdown", async () => {
  const makeTimeoutRun = async (terminationReason: string, verified: boolean, closeAfterDeadline = false) => {
    const startedAt = new Date().toISOString();
    const diagnostics = createChildProcessDiagnostics(startedAt, 25);
    diagnostics.spawnOutcome = "spawned";
    diagnostics.timeoutOutcome = "deadline_expired";
    diagnostics.commandOutcome = "timed_out";
    diagnostics.elapsedMs = 25;
    diagnostics.timeoutAt = new Date().toISOString();
    const child = { stdout: { destroy() {} }, stderr: { destroy() {} }, unref() {} };
    return runBoundedChild("ignored", [], {
      runProcess: async () => ({ timedOut: true, exitCode: null, signal: null, child, childClose: Promise.resolve({ kind: "closed" }), processDiagnostics: diagnostics }),
      terminateChild: async () => {
        if (closeAfterDeadline) {
          diagnostics.exitObserved = true;
          diagnostics.exitCode = 0;
          diagnostics.exitAt = new Date().toISOString();
          diagnostics.closeObserved = true;
          diagnostics.closeExitCode = 0;
          diagnostics.closeAt = new Date().toISOString();
        }
        return { verified, reason: terminationReason };
      },
    });
  };

  const closedAfterDeadline = await makeTimeoutRun("direct_child_close_observed", true, true);
  assert.equal(closedAfterDeadline.processDiagnostics.closeObserved, true);
  assert.equal(closedAfterDeadline.processDiagnostics.terminationReason, "direct_child_close_observed");
  assert.equal(closedAfterDeadline.processDiagnostics.treeTermination, "unknown");

  const killFailure = await makeTimeoutRun("direct_child_signal_failed", false);
  assert.equal(killFailure.processDiagnostics.terminationReason, "direct_child_signal_failed");
  assert.equal(killFailure.processDiagnostics.directChildTermination, "unknown");
  assert.equal(killFailure.processDiagnostics.treeTermination, "unknown");
  assert.equal(killFailure.treeTermination, "unknown", "a failed direct-child signal never implies tree shutdown");

  const closeUnconfirmed = await makeTimeoutRun("direct_child_close_unconfirmed", false);
  assert.equal(closeUnconfirmed.processDiagnostics.terminationReason, "direct_child_close_unconfirmed");
  assert.equal(closeUnconfirmed.processDiagnostics.treeTermination, "unknown");

  const unknownReason = await makeTimeoutRun("unsafe secret reason", false);
  assert.equal(unknownReason.processDiagnostics.terminationReason, "unknown");
  assert.equal(JSON.stringify(unknownReason.processDiagnostics).includes("unsafe secret reason"), false);
});

test("a close observed after the termination wait does not retroactively verify direct-child shutdown", async () => {
  const diagnostics = createChildProcessDiagnostics(new Date().toISOString(), 25);
  diagnostics.spawnOutcome = "spawned";
  diagnostics.timeoutOutcome = "deadline_expired";
  diagnostics.commandOutcome = "timed_out";
  diagnostics.exitObserved = true;
  diagnostics.exitSignal = "SIGTERM";
  diagnostics.exitAt = new Date().toISOString();
  let resolveClose: (value: { kind: string }) => void = () => {};
  const childClose = new Promise<{ kind: string }>((resolve) => { resolveClose = resolve; });
  const child = { stdout: { destroy() {} }, stderr: { destroy() {} }, unref() {} };
  const result = await runBoundedChild("ignored", [], {
    runProcess: async () => ({ timedOut: true, exitCode: null, signal: null, child, childClose, processDiagnostics: diagnostics }),
    terminateChild: async () => {
      setTimeout(() => {
        diagnostics.closeObserved = true;
        diagnostics.closeSignal = "SIGTERM";
        diagnostics.closeAt = new Date().toISOString();
        resolveClose({ kind: "closed" });
      }, 20);
      return { verified: false, reason: "direct_child_close_unconfirmed" };
    },
  });
  assert.equal(result.directChildTermination, "unknown");
  assert.equal(result.treeTermination, "unknown");
  assert.equal(result.processDiagnostics.exitObserved, true);
  assert.equal(result.processDiagnostics.closeObserved, false);
  await childClose;
  assert.equal(result.processDiagnostics.closeObserved, true);
  assert.equal(result.directChildTermination, "unknown");
  assert.equal(result.treeTermination, "unknown");
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
