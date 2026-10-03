# R24-02 implementation report

## Target and scope

- Repository: `ssaattww/RemoteDesktopMCP`
- Issue: #24; base measurement/fix-verification work is recorded by R24-01.
- Implementation branch: `issue-24-runtime-reduction-followup` (stacked on `issue-24-ci-phase1`, PR #42).
- Baseline HEAD: `adb4e03cbd11bb47ef90d34a840e2ce6922dc572`.
- Scope: avoid starting and immediately closing an unused default service in the DR002 unsupported atomic no-replace test and the NR009 symlink/junction allowed-root test.
- Non-goals: change product behavior, alter fixture isolation/default behavior, change authentication/ACL/Commander/HTTP assertions, delete or skip tests, modify the test scheduler or measurement workflow, apply an old manifest, alter dependencies, or include the long-running ACL worker redesign.

## Requirements and design

- User instruction: perform the Issue #24 improvement through TDD, normal review, and necessary validation; preserve all assertions and test coverage; do not assume the three-minute goal is achieved; create a new measurement fingerprint after the test set changes; do not apply a manifest without review.
- Governing design: `doc/design/ci-test-runtime-reduction-design.md` specifies that fixture default initialization stays enabled, while tests that replace the default service may explicitly opt out; unique per-test paths, protected data directory, cleanup, and test isolation remain.
- Design impact: internal test setup call sites only. No API, schema, workflow, or documented behavior changes; no design document update required.
- Repository-root `AGENTS.md`: absent (previously reported to the user). The root `AGENTS.md` check was repeated on this branch and remains absent.

## TDD and implementation

- Before-change baseline: `reports/2026-10-03-issue24-fixture-init-baseline.md`; the entire `fixture-runtime` plus `regressions` files passed, 32/32, 0 failed, 0 skipped.
- Existing behavior test: `test/fixture-runtime.test.ts` already verifies the `initializeService: false` path creates no audit log while preserving the test hash checks and cleanup. No artificial benchmark threshold or source-shape test was added.
- Change: in `test/regressions.test.ts`, DR002 and NR009 now call `fixture({ initializeService: false })`; removed each immediately following `f.service.close()` because the service is no longer initialized.
- Preserved: their test bodies still initialize the actual service with the test-specific configuration and retain every existing assertion, isolated root/data paths, private data directory setup, real Commander integration, and cleanup. Fixture default remains unchanged.
- After-change validation: `reports/2026-10-03-issue24-fixture-init-postchange-validation.md`; entire same two-file suite passed 32/32, 0 failed, 0 skipped.

## Performance evidence and limits

- One local Linux/Node 24.19.0 run of the two files was 106.065 seconds before the call-site change and 97.480 seconds after. These are single-run wall-clock observations under different process load; they are not controlled repetitions and do not establish a speedup.
- The Windows measurement for the previous file set reported `regressions` median 400.579 seconds. That artifact's fingerprint is not being applied or reused. The edited test file has SHA-256 `d17852a96e879f59232954b301e673ece12811ee563adcfa069a8b167abb5245` at this point; full target fingerprint must be recomputed after final content/commit before a new measurement.
- The Windows workflow evidence and required CI validation for this new branch have not yet run. Linux results are not treated as Windows ACL/symlink validation.
- No conclusion is made about reaching the three-minute goal. New Windows per-file x3 measurement is required after normal review and push; do not apply a candidate manifest without inspection.

## Deferred candidates

- The `Promise.race` timeout in `test/regressions.test.ts` near the stderr-drain test and the long path in `test/independent-fixes.test.ts` remain outside this one selected task.
- The long-lived Windows ACL worker requires a separate design and is deferred.

## Current lifecycle state

- Implementation and focused local validation: complete.
- Normal review: pending.
- Full local equivalence gate, commit, push, Windows CI, new measurement run, and Issue #24 follow-up update: pending.
- No PR merge, manifest update, or independent-final reservation/freeze was performed.
