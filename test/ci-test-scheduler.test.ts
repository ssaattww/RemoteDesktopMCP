import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import {
  buildAssignments,
  buildPlan,
  fingerprintInputs,
  normalizeTestPath,
  selectManifest,
  validateRuntimeFingerprint,
  validatePartition,
  validatePlan,
  parseArgs,
  validateRunMetadata,
  getWorkflowRunMetadata,
} from "../scripts/ci-test-scheduler.mjs";
import { buildManifestCandidate, createMeasurementRecord, measurementChildEnvironment } from "../scripts/ci-test-measurement.mjs";
import { hasSuccessfulMeasurementRun, shouldSkipMeasurement } from "../scripts/ci-test-measurement-gate.mjs";

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
  const expected = { id: 7, repository: { full_name: "ssaattww/RemoteDesktopMCP" }, head_sha: "2".repeat(40), run_attempt: 2, created_at: "2026-10-02T12:00:00Z" };
  const identity = { repository: "ssaattww/RemoteDesktopMCP", runId: 7, runAttempt: 2, sourceCommit: "1".repeat(40), triggerHeadSha: "2".repeat(40) };
  assert.equal(validateRunMetadata(expected, identity), "2026-10-02T12:00:00Z");
  assert.throws(() => validateRunMetadata(expected, { ...identity, triggerHeadSha: "3".repeat(40) }), /head_sha/i);
  for (const bad of [{ ...expected, head_sha: "3".repeat(40) }, { ...expected, run_attempt: 1 }, { ...expected, created_at: "invalid" },
    { ...expected, created_at: "2026-02-31T12:00:00Z" }]) {
    assert.throws(() => validateRunMetadata(bad, identity));
  }
});

test("workflow metadata resolves push, pull request merge, and manual dispatch event identities", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-run-event-"));
  const names = ["GITHUB_REPOSITORY", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_SHA", "GITHUB_EVENT_NAME", "GITHUB_EVENT_PATH", "CI_GITHUB_TOKEN", "CI_JOB_NAME"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  const cases = [
    { name: "push", event: { ref: "refs/heads/main", after: "a".repeat(40) }, checkout: "a".repeat(40), apiHead: "a".repeat(40) },
    { name: "pull_request", event: { action: "synchronize", pull_request: { number: 42, head: { sha: "b".repeat(40) }, base: { sha: "c".repeat(40) } } }, checkout: "d".repeat(40), apiHead: "b".repeat(40) },
    { name: "workflow_dispatch", event: { ref: "refs/heads/issue-24-ci-phase1", inputs: {} }, checkout: "e".repeat(40), apiHead: "e".repeat(40) },
  ];
  try {
    process.env.GITHUB_REPOSITORY = "ssaattww/RemoteDesktopMCP";
    process.env.GITHUB_RUN_ID = "7";
    process.env.GITHUB_RUN_ATTEMPT = "2";
    process.env.CI_GITHUB_TOKEN = "synthetic-token-marker";
    process.env.CI_JOB_NAME = "Measure individual Windows tests";
    for (const item of cases) {
      const eventPath = path.join(root, `${item.name}.json`);
      await writeFile(eventPath, JSON.stringify(item.event));
      process.env.GITHUB_EVENT_PATH = eventPath;
      process.env.GITHUB_EVENT_NAME = item.name;
      process.env.GITHUB_SHA = item.checkout;
      globalThis.fetch = async (url, options) => {
        assert.equal(new Headers(options.headers).get("authorization"), "Bearer synthetic-token-marker");
        if (String(url).endsWith("/jobs?per_page=100")) {
          assert.match(String(url), /actions\/runs\/7\/jobs\?per_page=100$/);
          return { ok: true, json: async () => ({ jobs: [{ id: 9, run_id: 7, name: "Measure individual Windows tests" }] }) };
        }
        assert.match(String(url), /actions\/runs\/7$/);
        return { ok: true, json: async () => ({ id: 7, repository: { full_name: "ssaattww/RemoteDesktopMCP" }, head_sha: item.apiHead,
          run_attempt: 2, created_at: "2026-10-02T12:00:00Z" }) };
      };
      const identity = await getWorkflowRunMetadata();
      assert.equal(identity.sourceCommit, item.checkout);
      assert.equal(identity.triggerHeadSha, item.apiHead);
      assert.equal(identity.runId, 7);
      assert.equal(identity.runAttempt, 2);
      assert.equal(identity.workflowJobId, 9);
      assert.equal(identity.schemaVersion, 1);
      assert.equal(Object.keys(identity).some((key) => /token|secret/i.test(key)), false);
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("measurement child process cannot inherit credentials and keeps safe run metadata", () => {
  const child = measurementChildEnvironment({ CI_GITHUB_TOKEN: "synthetic-token-marker", CI_WORKFLOW_RUN_ID: "7", PATH: "safe-path" });
  assert.equal(child.CI_GITHUB_TOKEN, undefined);
  assert.equal(child.CI_WORKFLOW_RUN_ID, "7");
  assert.equal(child.PATH, "safe-path");
  const probe = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify({ hasToken: Boolean(process.env.CI_GITHUB_TOKEN), runId: process.env.CI_WORKFLOW_RUN_ID }))"], { env: child, encoding: "utf8" });
  assert.equal(probe.status, 0);
  assert.deepEqual(JSON.parse(probe.stdout), { hasToken: false, runId: "7" });
});

test("measurement gate skips only a completed run with a successful measurement step and live artifact", async () => {
  const headSha = "a".repeat(40);
  const validRun = { id: 100, run_attempt: 2, event: "pull_request", head_sha: headSha, status: "completed", conclusion: "success", pull_requests: [{ number: 42 }] };
  const validJobs = { total_count: 1, jobs: [{ name: "Measure individual Windows tests", status: "completed", conclusion: "success", steps: [
    { name: "Measure each tracked test file", status: "completed", conclusion: "success" },
    { name: "Upload measurement evidence", status: "completed", conclusion: "success" },
  ] }] };
  const validArtifacts = { total_count: 1, artifacts: [{ name: "test-runtime-measurement-100-2-merge-sha", expired: false }] };
  assert.equal(hasSuccessfulMeasurementRun(validRun, { prNumber: 42, headSha }, validJobs, validArtifacts), true);
  assert.equal(hasSuccessfulMeasurementRun(validRun, { prNumber: 41, headSha }, validJobs, validArtifacts), false);
  assert.equal(hasSuccessfulMeasurementRun({ ...validRun, event: "workflow_dispatch" }, { prNumber: 42, headSha }, validJobs, validArtifacts), false);
  assert.equal(hasSuccessfulMeasurementRun({ ...validRun, head_sha: "b".repeat(40) }, { prNumber: 42, headSha }, validJobs, validArtifacts), false);
  assert.equal(hasSuccessfulMeasurementRun({ ...validRun, status: "in_progress" }, { prNumber: 42, headSha }, validJobs, validArtifacts), false);
  assert.equal(hasSuccessfulMeasurementRun({ ...validRun, conclusion: "failure" }, { prNumber: 42, headSha }, validJobs, validArtifacts), false);

  // A successful workflow with the measurement job skipped must be measured, not deduplicated.
  const skippedMeasurement = { total_count: 1, jobs: [{ ...validJobs.jobs[0], conclusion: "success", steps: [
    { name: "Measure each tracked test file", status: "completed", conclusion: "skipped" },
    { name: "Upload measurement evidence", status: "completed", conclusion: "skipped" },
  ] }] };
  assert.equal(hasSuccessfulMeasurementRun(validRun, { prNumber: 42, headSha }, skippedMeasurement, { total_count: 0, artifacts: [] }), false);
  assert.equal(hasSuccessfulMeasurementRun(validRun, { prNumber: 42, headSha }, validJobs, { total_count: 1, artifacts: [{ ...validArtifacts.artifacts[0], expired: true }] }), false);

  const root = await mkdtemp(path.join(os.tmpdir(), "ci-measurement-gate-"));
  try {
    const eventPath = path.join(root, "event.json");
    await writeFile(eventPath, JSON.stringify({ pull_request: {
      number: 42, head: { sha: headSha, repo: { full_name: "ssaattww/RemoteDesktopMCP" } },
    } }));
    const gateEnvironment = {
      GITHUB_REPOSITORY: "ssaattww/RemoteDesktopMCP",
      GITHUB_EVENT_PATH: eventPath,
      CI_GITHUB_TOKEN: "synthetic-read-token",
    };
    const requests: Array<{ url: URL; headers: Record<string, string> }> = [];
    let requestHeaders: Record<string, string> | undefined;
    const skip = await shouldSkipMeasurement(gateEnvironment, async (input, init) => {
      const url = new URL(String(input));
      requestHeaders = init?.headers as Record<string, string>;
      requests.push({ url, headers: requestHeaders });
      if (url.pathname.endsWith("/actions/workflows/test-runtime-measurement.yml/runs")) {
        return { ok: true, json: async () => ({ total_count: 1, workflow_runs: [validRun] }) } as Response;
      }
      if (url.pathname.endsWith("/actions/runs/100/jobs")) return { ok: true, json: async () => validJobs } as Response;
      if (url.pathname.endsWith("/actions/runs/100/artifacts")) return { ok: true, json: async () => validArtifacts } as Response;
      throw new Error(`Unexpected request: ${url}`);
    });
    assert.equal(skip, true);
    assert.match(requests[0]?.url.pathname ?? "", /actions\/workflows\/test-runtime-measurement\.yml\/runs$/);
    assert.equal(requests[0]?.url.searchParams.get("event"), "pull_request");
    assert.equal(requests[0]?.url.searchParams.get("head_sha"), headSha);
    assert.equal(requestHeaders?.Authorization, "Bearer synthetic-read-token");
    assert.deepEqual(requests.map(({ url }) => url.pathname).sort(), [
      "/repos/ssaattww/RemoteDesktopMCP/actions/workflows/test-runtime-measurement.yml/runs",
      "/repos/ssaattww/RemoteDesktopMCP/actions/runs/100/jobs",
      "/repos/ssaattww/RemoteDesktopMCP/actions/runs/100/artifacts",
    ].sort());

    await assert.rejects(shouldSkipMeasurement(gateEnvironment, async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/actions/workflows/test-runtime-measurement.yml/runs")) {
        return { ok: true, json: async () => ({ total_count: 1, workflow_runs: [validRun] }) } as Response;
      }
      return { ok: false, status: 403 } as Response;
    }), /Measurement jobs request failed with HTTP 403/);

    let pageCount = 0;
    await assert.rejects(shouldSkipMeasurement(gateEnvironment, async (input) => {
      pageCount = Number(new URL(String(input)).searchParams.get("page"));
      return { ok: true, json: async () => ({ total_count: 1001, workflow_runs: Array.from({ length: 100 }, (_, index) => ({
        event: "pull_request", head_sha: "b".repeat(40), status: "completed", conclusion: "success", pull_requests: [{ number: index + 1 }],
      })) }) } as Response;
    }), /Measurement history exceeds the guarded page limit/);
    assert.equal(pageCount, 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("measurement workflow is opt-in on same-repository label events with read-only permissions", async () => {
  const workflow = parseYaml(await readFile(path.join(process.cwd(), ".github/workflows/test-runtime-measurement.yml"), "utf8"));
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  assert.deepEqual(workflow.on.pull_request.types, ["labeled"]);
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.jobs.measure.permissions.contents, "read");
  assert.equal(workflow.jobs.measure.permissions.actions, "read");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.match(workflow.concurrency.group, /pull_request\.number/);
  assert.match(workflow.concurrency.group, /pull_request\.head\.sha/);
  assert.match(workflow.jobs.measure["if"], /ci-measure-runtime/);
  assert.match(workflow.jobs.measure["if"], /head\.repo\.full_name == github\.repository/);
  assert.doesNotMatch(JSON.stringify(workflow), /pull_request_target/);

  const steps = workflow.jobs.measure.steps;
  const gate = steps.findIndex((step) => step.id === "measurement-gate");
  const install = steps.findIndex((step) => step.name === "Install dependencies");
  assert.ok(gate >= 0 && gate < install, "duplicate-success guard runs before npm ci");
  assert.deepEqual(steps[gate].env, { CI_GITHUB_TOKEN: "${{ github.token }}" });
  assert.equal(steps[gate]["if"], "github.event_name == 'pull_request'");
});

test("scheduler CLI executes its entry point and rejects unknown commands", () => {
  assert.deepEqual(parseArgs(["--shard-id", "2", "--shard-count", "3"]), { shardId: "2", shardCount: "3" });
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
  assert.equal(Object.keys(records[0]).some((key) => /token|secret/i.test(key)), false);
  assert.throws(() => buildManifestCandidate(records.slice(1), { sourceCommit: "1".repeat(40), files, environment, fingerprint: "b".repeat(64) }), /three records/i);
  assert.throws(() => buildManifestCandidate([{ ...records[0], status: "failure", exitCode: 1 }, ...records.slice(1)],
    { sourceCommit: "1".repeat(40), files, environment, fingerprint: "b".repeat(64) }), /non-success/i);
  assert.throws(() => createMeasurementRecord({ status: "success", file: files[0], startedAt: "2026-02-31T12:00:00Z", finishedAt: "2026-03-03T12:00:00Z",
    monotonicDurationMs: 100, commit: "1".repeat(40), workflowRunId: 7, workflowJobId: 9, environment, schedulerArtifactVersion: 1, exitCode: 0 }), /timestamp/i);
});
