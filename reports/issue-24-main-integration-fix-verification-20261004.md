# Issue #24 main integration fix verification

## Target identity

- Repository: `ssaattww/RemoteDesktopMCP`
- Pull request: #69, draft and open; base `main` at `8d9c77a49d342e15f7ce63802d3a1550eb158930`.
- Branch: `issue-24-main-integration`.
- Implementation base: `ecbb9f8e231f9bd5b728c4dce0792673daa8bbdd` (the current public PR head at review start).
- Fix-verification review target: working-tree content based on the implementation base above; that content was committed without code changes as `a9b928cfa5e2b835d0927bf9c262ff65ae115436`.
- Review mode: bounded normal-review fix verification by the same reviewer as the R24-08 latest-main review.
- Verification capability: `local_execution_available`; local source at `/tmp/issue24-main-integration`, Linux, Bash, Node.js 22 / npm 11.9.0. No dependency or lockfile change.
- Scope: findings `KERO-R24-08-001` and `KERO-R24-08-002`, plus the historical 12-case correction in the previous report.
- No merge, public comment, or measurement run was performed.

## Findings and disposition

### KERO-R24-08-001 — Medium — prepare and shard environment validation

**Required behavior:** a prepare runner environment difference alone must not invalidate a matching measurement manifest. The prepare step verifies tracked content with the environment recorded in the manifest. Each optimized shard independently fingerprints its current content and actual environment and fails before tests if it differs from the shared plan. Baseline shards mark environment comparison `not_applicable`.

**Changes:** `selectManifest` validates manifest shape and compares the manifest fingerprint to content hashed with `manifest.environment`. Manifest-backed plan generation no longer needs to capture the prepare runner environment. `dispatchPlan` validates optimized fingerprints for each shard; mismatch returns a stable safe code and no test files. The design document records these semantics.

**Evidence:** scheduler unit coverage simulates a prepare-only environment difference and matching/mismatched tracked content. Shard tests show one matching shard succeeds, a single mismatched shard fails before execution, and baseline diagnostics say `not_applicable`. Same reviewer returned `checked_no_finding` for this finding after the other fix.

**Disposition:** closed / pass; source identity and severity retained.

### KERO-R24-08-002 — Medium — structured per-shard diagnostics

**Required behavior:** each shard persists structured validation and environment status, plan identity/mode, shard ID and file list, and a safe fixed failure code. Diagnostics must be initialized before dispatch and uploaded on success and failure.

**Changes:** dispatch persists `shard-diagnostic.json` with `planDigest`, `mode`, `shardId`, `files`, `overallValidation`, `environmentCheck`, and `safeFailureReason`. The workflow initializes this file before dependency setup by invoking the scheduler. Initialization validates the repository-relative path and all parent directories, rejects symlinks, and opens the target exclusively (`wx`) so an existing path cannot be followed or replaced. Dispatch keeps updating the same regular file. The diagnostics artifact uploads under `if: always()`.

**Review evidence:** initial bounded review found that PowerShell `Set-Content` could follow an existing symlink before scheduler checks. The finding was retained as P2. After moving initialization to the scheduler, adding exclusive creation, and adding symlink regression coverage, the same reviewer returned **pass** for that issue. A subsequent bounded verification of commit `45a6dece708e6c67f68c8a153b593b886d1b38a2` reopened this finding: environment-unavailable/mismatch returns occurred before copying the validated shard assignment into `diagnostic.files`, so failure diagnostics reported an empty list. The implementation is being corrected to preserve the validated assignment while still returning no executable files.

**Disposition:** reopened / fix in progress; source severity retained.

### Historical test-count correction — report accuracy

The previous latest-main review report contained an incorrect count of 13 cases for main `test/independent-fixes.test.ts`. Parent verification and the normal reviewer confirmed 12 cases total (the original eight plus four service-close cases), preserved 12/12 as 8+2+2 across the split files. The earlier count remains documented in a dated correction note; prior review history is not removed.

## TDD and validation evidence

- TDD red for the symlink-safe initialization change: focused scheduler suite exited 1 before implementation because `init-diagnostic` was not supported, the workflow still initialized through PowerShell, and the symlink-output contract failed.
- Focused green on the current implementation: `./node_modules/.bin/tsx --test test/ci-test-scheduler.test.ts` — 19 tests, 19 passed, 0 skipped, 0 failed. Includes outside-root output rejection and both symlink targets.
- Final current-candidate local validation: `npm test` — 226 tests, 215 passed, 11 skipped, 0 failed; `npm run check`, `npm run build`, `npm run lint`, and `git diff --check` all exited 0. Markdown lint reported 143 files and 0 issues; design terminology lint passed.
- Exact-HEAD PR workflow `37197042561` on `a9b928cfa5e2b835d0927bf9c262ff65ae115436` completed successfully. Ubuntu lint/check/build/test, Windows assignment preparation, and Windows shards 1–8 all succeeded; every shard uploaded diagnostics. This is the required workflow result for the implementation commit.
- TDD red for the reopened diagnostic-list finding: the focused environment dispatch test failed because the mismatch diagnostic had `files: []` instead of the validated shard assignment. After moving assignment recording before environment checks, the same focused test passed; the failure result still returns `files: []` for execution.
- The documentation/progress synchronization commit `45a6dece708e6c67f68c8a153b593b886d1b38a2` triggered workflow `37197555750`, which completed successfully: Ubuntu lint/check/build/test, Windows assignment preparation, and Windows shards 1–8 all succeeded. This run does not include the diagnostic-list correction now in the worktree.
- After the diagnostic-list correction, full local validation passed: `npm test` — 226 tests, 215 passed, 11 skipped, 0 failed; `npm run check`, `npm run build`, `npm run lint`, and `git diff --check` all exited 0. Markdown lint reported 143 files and 0 issues; design terminology lint passed.
- An earlier full run on the intermediate 225-test candidate passed 214/225 (11 skipped), but scheduler/workflow/test content changed afterward. It is retained as historical evidence only and is superseded by the final successful run above.
- The final commands ran against the tracked tree based on `ecbb9f8e231f9bd5b728c4dce0792673daa8bbdd` with the seven modified tracked paths and the new fix-verification report. Command output contained the recorded test and lint results plus standard npm update notices.

## Remaining held items and next action

- The diagnostic-list correction is not yet committed or pushed and has not received normal-review verification or exact-head CI. The next commit's workflow must confirm it on Windows as well as Ubuntu.
- Workflow `37197555750` for the documentation/progress commit completed successfully, but it predates the diagnostic-list correction and does not verify it.
- Issue #24 remains open; the 180-second goal has not been established by these fixes.
- The implementation through `a9b928c` is pushed to PR #69 and its exact-head workflow passed. PR #69 remains draft/open/unmerged. Do not merge or post the previously approval-pending comment.
