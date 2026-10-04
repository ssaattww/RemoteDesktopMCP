# Issue #24 latest-main integration normal review

## Review identity

- Review mode: fresh exhaustive initial normal review.
- Reviewed candidate HEAD: `959c544ca18c3171018d8aec809f681e9c4f3c55`.
- Latest-main base: `8d9c77a49d342e15f7ce63802d3a1550eb158930` (PR #54 squash merge).
- Integration merge: `2f36392d85932e84b02f4006091b349d40fa72a8`, parents `d9de86f9a93cbea85272663d60c5ea28482a25d0` and latest main `8d9c77a49d342e15f7ce63802d3a1550eb158930`.
- Cumulative source: PR #68 head `3a6eac7f6d2968256458f2018305f80666ebd125`, ancestor of the candidate.
- PR #62 head `48013a76839523dafc52997ac33b4fa6350f5cde` is not an ancestor. No PR, push, CI or merge operation was performed.
- Scope reviewed: complete `git diff 8d9c77a49d342e15f7ce63802d3a1550eb158930...HEAD` (53 changed paths), merge semantics and retained main-side content, R24 source changes and their previous review/validation evidence, reports and task tracking.
- Independence: assigned reviewer did not implement the changes or fixes. Candidate HEAD was `959c544ca18c3171018d8aec809f681e9c4f3c55` at both start and end of review; no instability observed.

## Coverage dispositions

| Criterion | Disposition | Evidence |
| --- | --- | --- |
| Requirement and design conformance | checked_no_finding | R24-01–06 retains its recorded 8-shard adoption and explicitly keeps Issue #24 open until the 180-second objective is met. R24-07 is marked paused; R24-08 is the main integration work item. |
| Correctness and edge cases | checked_no_finding | Reviewed the scheduler/measurement and gate implementation, manifest selection fallback, test split, the latest-main merge resolution, and the four process-close cases ported into the process-ownership suite. Existing R24 review evidence covers preservation of moved cases. |
| Scope discipline / contamination | checked_no_finding | Merge parents are the pre-integration candidate and latest main; PR #68 source is an ancestor. PR #62 is not an ancestor. PR #62-exclusive changes to the old `test/regressions.test.ts` are absent; that file is removed by the PR #68 semantic split, while its moved R24 tests are represented in split files. Shared pre-divergence fixture/ACL commits are not PR #62-exclusive. |
| Changed files and direct dependency impact | checked_no_finding | Reviewed all 53 changed paths and direct configuration/test/workflow dependencies. `package-lock.json` is unchanged; no package version change. |
| API, data, configuration, workflow and compatibility | checked_no_finding | Workflow retains Ubuntu full test execution and uses shared validated Windows assignments. Manifest and plan schemas enforce file coverage, digest and run identity; mismatch selects baseline. Main PR #54 session link/edit/Todo source and tests are retained. |
| Error handling / diagnostics | checked_no_finding | Invalid manifests/plans, API metadata errors, failed measurements and invalid partitions fail with diagnostics. Workflow test artifacts record dispatch and test exit outcomes, including empty shards. |
| Security / secret handling | checked_no_finding | Measurement token has read-only workflow permissions and is removed from child test environments. Scheduler rejects symbolic-link and traversal test paths. The label-trigger measurement workflow is restricted to same-repository pull requests. |
| Tests and validation adequacy | checked_no_finding | Latest-main validation record reports 222 tests, 211 pass / 11 Linux skips / 0 fail; check/build/lint and diff-check pass. Four PR #54 service-close test names are all present in the semantic process-ownership test file; all 13 cases previously in main `test/independent-fixes.test.ts` are represented across the three split candidate files. No tests were rerun during review. |
| Current-HEAD CI evidence | held | No exact-candidate GitHub CI evidence exists. Linux validation does not exercise Windows-specific paths. The local full suite ran on merge tree `2f36392`; final HEAD adds its validation report and removes one blank line in task tracking, while lint and diff-check are recorded after that documentation/tracking-only adjustment. |
| Reports, tracking and documentation accuracy | checked_finding (closed by bounded verification) | Initial review found stale top-level pending placeholders in the old report; finding-limited closure verified they now summarize the historical first-pass `fail` and d9 `incomplete` closure without erasing either result. See NREV-R24-LATEST-001 and closure below. |
| Regression / maintainability risks | checked_no_finding | Latest-main source files for session metadata, external links, Todo and user console compare identical by blob to the main parent. Main's 13 independent-fixes cases are preserved across the split suite; moved regressions and ownership tests are separated by behavior. |

## Integration checks

- `src/index.ts`, `src/session-links.ts`, `src/user-console-client.ts`, `src/user-console.ts`, `test/user-console-client.test.ts`, `test/user-console.test.ts`, `test/session-links.test.ts`, `test/session-links.integration.test.ts`, and `test/issue-56-shared-todo.test.ts` are byte-identical to latest main. The merge tree therefore retains PR #54 session metadata editing, external links, User Console behavior and Issue #56 Todo work.
- Latest main's `test/independent-fixes.test.ts` contained 13 cases. Candidate split files `test/independent-process-ownership.test.ts`, `test/independent-config-history.test.ts`, and `test/independent-transfer-lifecycle.test.ts` contain all 13 names. The four process-close cases were ported into the ownership file and remain ahead of the four R24 process-ownership cases.
- `test/search-process-lifecycle.test.ts` preserves the autonomous watcher wait increased for loaded Windows CI: up to 200 reads with 50 ms delay, with no status/output polling fallback in that assertion.
- `package.json` retains main's session-metadata and external-links design lint entries and adds the R24 runtime design. `tools/lint/markdown-whitelist.yaml` supplies its terms; reported lint passed.
- All R24-01 through R24-08 task rows use phase `R24`; the phase registry defines R24 as an independent workstream and keeps P5/T10 and P6/T11 intact. R24-07 explicitly records its paused state and future reselection after R24-08.
- The manifest contains 24 measured test paths while the integrated tree tracks 27 test files. Its old source/fingerprint therefore cannot be treated as current timing evidence; the scheduler's documented fingerprint-mismatch path falls back to baseline assignment. This is safe and consistent with the design, but exact-candidate Windows timing remains unverified and the 3-minute target remains open.

## Findings

1. **NREV-R24-LATEST-001 — Low — origin: report reconciliation.** Location: `reports/issue-24-main-integration-normal-review-202610040918.md:51-63` at the initial latest-main review. The top-level finding/result fields then said `review pending`, while the child-owned sections recorded first-pass `fail` and d9 closure `incomplete`. That was a conflicting review state. Required action: label the report-level status with the preserved historical results without erasing either. Bounded closure verified the fields now identify both reviewed HEADs, both outcomes, and that the record is superseded by the latest-main report. No severity reclassification.

| Finding | Required action | Disposition | Evidence needed for closure |
| --- | --- | --- | --- |
| NREV-R24-LATEST-001 | Reconcile stale top-level review placeholders with the completed child-owned sections. | closed / pass | Historical report names first-pass HEAD `75d51a6` / `fail` and closure HEAD `d9de86f` / `incomplete`, and marks itself superseded by the separate latest-main report. |

## Held / unexplored

- Held: matching exact-HEAD required GitHub CI, including Windows shards, has not run.
- Held: the 24-file measured manifest does not cover the current 27-file test universe; scheduler fallback is by design, but this candidate has no new optimized-timing evidence.
- Unexplored: no live GitHub API/artifact inspection and no Windows execution. No fresh test/check/build/lint was run under the review instructions.

## Verdict and next action

- Initial exhaustive-review verdict: `fail` for NREV-R24-LATEST-001. After bounded closure verification, current review disposition: `pass_with_held`; the finding is closed, with exact-HEAD CI and Windows behavior still held.
- Remaining risks: current test inventory forces manifest fallback, so runtime gains for this 27-file integration are unmeasured; Windows-specific paths lack candidate-specific evidence.
- Next action: obtain main-targeted exact-HEAD required CI including all Windows shards and confirm the scheduler's baseline assignment covers every tracked file once. Return for parent cumulative final review. Keep Issue #24 open until its 180-second completion target is met. Do not merge based on this normal review alone.
- reserved_report_paths: `reports/issue-24-main-integration-latest-main-normal-review-20261004.md` (created for this review; not an attestation path).
- report_attestation_allowed: false.

## Finding-limited closure verification (child-owned)

- Reviewer continuity: same normal reviewer as the exhaustive review above.
- Reviewed implementation HEAD remains `959c544ca18c3171018d8aec809f681e9c4f3c55`; it was unchanged during this closure review.
- Scope: NREV-R24-LATEST-001 only. Verified the updated historical report wording; no implementation, task, phase, or validation files were edited in this closure.
- Finding identity/severity continuity: NREV-R24-LATEST-001 / Low, unchanged; no reclassification.

The historical report now identifies the exact old reviewed HEADs: first-pass `fail` at `75d51a6febea2f6942fdda5061f9c84f266c7efc` and bounded closure `incomplete` at `d9de86f9a93cbea85272663d60c5ea28482a25d0`. Its top-level finding/result fields summarize those outcomes and say the record is superseded by the separate latest-main report. The detailed child-owned initial finding and incomplete-closure evidence remain present and unchanged. This resolves the contradiction without erasing either historical outcome or implying that the old verdict applies to `959c544`.

- Required action disposition: `checked_no_finding` (closed for the historical report accuracy issue).
- Closure verdict for this finding: `pass`. The exhaustive first-pass verdict `fail` is retained as historical evidence. After this finding-limited closure, the current review disposition is `pass_with_held`: the report finding is closed, while exact-head CI, Windows verification, and candidate timing coverage remain held as stated above.
- Current next action: obtain main-targeted exact-head required CI including Windows shards, confirm one-time baseline assignment coverage for all 27 tracked test files, and return for parent cumulative final review. After this append, the working tree has an uncommitted change to this latest-main review report only; implementation HEAD remains `959c544ca18c3171018d8aec809f681e9c4f3c55`. If the report is committed, record that report commit/new HEAD separately; this closure disposition applies only to the unchanged implementation HEAD.
