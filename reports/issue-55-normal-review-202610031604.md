# Issue #55 normal review

## Review identity

- Mode: initial normal review of the current uncommitted implementation.
- Verdict: **fail / revision required**. Two required findings remain.
- Repository: `ssaattww/RemoteDesktopMCP`; branch: `issue-55-process-context`.
- Commit HEAD: `65a39d565b2e264b2e13e969e794723622c60ec0` (base and reviewed commit range are the same; implementation changes are uncommitted).
- Reviewed worktree fingerprint: `git diff` SHA-256 `c56828335c96b00e23567c4571c40b9a04e5f024e4254b6dcef980b0fdd318b8`; changed product/test source fingerprints below identify the implementation snapshot reviewed.
- Accepted design: `doc/design/long-running-process-context.md` (SHA-256 `7b443a4ecde20fc9a2e81ec4e9ec1d70bf0833419ab6187c949ca2a126cc7a3f`).
- Reviewer: `/root/issue55_normal_review`, independent of implementation and prior design review; inspected the accepted design, design fix verification, implementation diff, focused Red evidence, and implementation validation evidence. No code or test changes were made.
- Dispatch: user-authorized request was `gpt-6-luna`, medium, fork none; this runtime does not expose final model/profile or role observability, so applied profile is `null`.
- Pre-existing unrelated worktree state: `tasks/tasks-status.md` is modified; `node_modules/` and the two implementation evidence reports are untracked. No commit or repository mutation was performed by this reviewer other than this report.

## Findings

### NR55-1 — Medium, required: refresh can remove the destination for a running-process link

- Origin: accepted design contract 2 (same-session/process in-page destination) and Issue #55 navigation requirement.
- Location: `src/user-console-client.ts:53-59`, `:260-267`, `:322-357`, `:472-485`; server source `src/user-console.ts:248`, `:303-315`, `:317-333`.
- Evidence: the page bootstraps `items` from the newest 200 audit records (`src/user-console.ts:248`, client `:53-59`). Initial `refreshState()` runs at `:711`; for a selected session, `apiPath` scopes state to that session (`:77`), but `refreshState` then calls `renderEvents()` (`:481-485`). `renderProcesses()` reconstructs articles only from the current `items` groups (`:260-273`) and replaces the existing process-detail children. If a still-running process has no event in the latest 200 records (for example, a long-running silent process whose `process.start` is older than that window), the server-rendered article produced from full `session.events` (`src/user-console.ts:303-315`, `:317-333`) is discarded. The running row/link remains, but its `href` target has no article; `liveProcesses` supplies metadata only to groups which already exist and cannot create the missing group/article.
- Impact: the new “詳細へ” action fails precisely for a valid long-running-process state once its start/output events fall outside the client page window. Refresh/resync can also remove the target.
- Required action: preserve/create a detail article for every running process returned by the scoped state response, using its same-session/process metadata, or otherwise obtain its event group before replacing server-rendered articles. Add a focused test where the process start is outside the newest page and no matching recent event exists; assert its anchor resolves both on first state refresh and resync.

### NR55-2 — Low, required: fragment destination is the article rather than the promised heading or disclosure control

- Origin: accepted design contract 8, which says navigation from a running row places the standard keyboard position on the corresponding process heading or output disclosure control.
- Location: `src/user-console.ts:290-291`, `:332`; `src/user-console-client.ts:288-296`, `:327-355`, `:543-545`.
- Evidence: both server and client assign the fragment ID to the `article.process-block`, and make that article `tabindex=-1`; the process heading is a separate `h3` with no fragment ID. The redraw path explicitly captures/restores `ARTICLE` focus (`:327`, `:354-355`). The regression test verifies refresh restoration when a `summary` was already focused, but does not click the Running operations link or assert the post-navigation focus target (`test/user-console-client.test.ts:535-588`).
- Impact: the implemented navigation/focus contract is the article rather than the heading/output toggle specified by the accepted design; the test suite does not exercise that user path.
- Required action: target the process heading or the output disclosure control as specified, and add a client/browser-level navigation assertion that the destination and post-refresh focus remain on the corresponding same-session/process control.

## Required coverage

| Criterion | Disposition | Evidence / note |
| --- | --- | --- |
| Accepted requirements and design conformance | checked_finding | NR55-1 and NR55-2. |
| Correctness and edge cases | checked_finding | New 200-event-window/link path is untested and can drop the target; navigation target differs from contract. |
| Scope discipline and unrelated changes | checked_no_finding | Product/test changes limited to `src/user-console.ts`, `src/user-console-client.ts`, `test/user-console.test.ts`, `test/user-console-client.test.ts`; task status update is separately owned. Untracked `node_modules/` and evidence reports were not reviewed as product changes. |
| Changed files and direct dependency impact | checked_no_finding | Reviewed both changed product files and both focused test files; no dependency or package changes. |
| API/data/config/workflow/compatibility effects | checked_no_finding | `/api/console-state` additions derive purpose/command from owner-filtered session audit records and running process IDs; no storage/config/API permission changes found. |
| Error handling and failure diagnostics | checked_no_finding | New state refresh retains previous display on failed request via existing catch; no new error path identified. |
| Authentication, authorization, owner boundary | checked_no_finding | `apiSession` validates owner audit-session access (`src/user-console.ts:120-123`); console state filters session logs and live processes by principal (`:141-143`, `:163`, `:177`); page selection and live process filter are owner/session-scoped (`:241-253`). Existing owner/auth tests remain. |
| Secret handling and masking | checked_no_finding | New values come from existing process-start audit records; process command is redacted at its source (`src/index.ts:1170`; existing mask regression `test/independent-fixes.test.ts:320-344`). Rendering escapes server values (`src/user-console.ts:11`, `:291`, `:332`) and client uses `textContent`/DOM attributes (`src/user-console-client.ts:296-310`, `:540-545`). No new unmasked source found. |
| Composite session/process identity and anchors | checked_finding | Session/process pairs are used in matching and attributes. NR55-1 shows a valid running pair can still have no corresponding article after refresh; NR55-2 covers target semantics. |
| API metadata and fallback | checked_no_finding | Metadata maps are scoped to owner/session audit entries (`src/user-console.ts:162-170`, `:282-289`); empty/missing values become `未記録` (`:330-332`, client `:302-303`, `:540-541`). |
| Escaping and HTML safety | checked_no_finding | Server HTML fields use `escape`; client renders process metadata through `textContent` and link attributes rather than HTML parsing. |
| Sort behavior; PR #19/#50/#54 constraints | checked_no_finding | Server/client process details put live processes first and use newest-record ordering within status (`src/user-console.ts:310-315`, client `:263-267`); session/process identity is used. Changes preserve per-process event groups, disclosure state, date UI paths, and do not alter session editing, persistence, or dependencies. |
| Client redraw, disclosure, focus, scroll | checked_finding | Focus/disclosure redraw case has focused test evidence; link-to-destination path remains incorrect/inadequately tested (NR55-1/2). |
| Test coverage and regression adequacy | checked_finding | Red report records the original focused failures; Green evidence records two focused tests and 24 affected-file tests passing. No test covers a running process absent from latest 200 events or focus after activating the running-row link. |
| Current-HEAD validation evidence | held | `reports/issue-55-implementation-evidence-20261003153241.md` records focused tests 2/2, both affected files 24/24, `npm run check`, and `git diff --check` passing on the same commit HEAD and final uncommitted source fingerprints. No CI commit exists. Parent reports full gates are complete, but no additional gate log was supplied to this review. |
| Windows/FA780 interactive validation | held | Not performed in the implementation environment; design assigns this to a separate owner. No Windows screenshot or run log supplied. |
| Report/tracking accuracy | checked_no_finding | Red and implementation reports identify same repository/HEAD and describe uncommitted state; task status accurately says Green implementation in progress. |
| Regression and maintainability risks | checked_finding | NR55-1 and NR55-2; browser/Windows behavior remains unverified. |

## Validation assessment

- Red evidence: `reports/issue-55-red-test-evidence-20261003153241.md` reports focused command exit 1 with 22 passing and the two new tests failing before product edits. Red source hashes match the current test snapshot where unchanged.
- Green evidence: `reports/issue-55-implementation-evidence-20261003153241.md` reports focused test 2/2, two affected files 24/24, `npm run check`, and `git diff --check` passed at `65a39d565b2e264b2e13e969e794723622c60ec0` plus current uncommitted edits. Recorded source/test hashes match this review snapshot.
- Reviewer ran `git diff --check` (exit 0) and inspected the documented evidence; did not rerun tests or claim Windows/browser validation.
- Worktree identity was checked before and after review; product/test fingerprints remained stable. There is no immutable committed implementation HEAD containing these changes, so this verdict applies to the commit plus the exact uncommitted source snapshot/fingerprints above, not the bare commit.

## Coverage summary and next action

- Dispositions: 10 `checked_no_finding`, 6 `checked_finding`, 2 `held`; no `unexplored` required criteria.
- Findings: NR55-1 Medium and NR55-2 Low; no severity reclassification.
- Held: Windows/FA780 evidence (owner is the implementation/integration lead); CI gate evidence (owner is parent integration lead).
- Unexplored: none within this review's scope.
- Next action: fix NR55-1 and NR55-2, add the stated focused tests, then request targeted fix verification against the updated worktree/HEAD.
- `reserved_report_paths`: none; this is a normal review report, not an independent-final-review report.
- `report_attestation_allowed`: false; independent-final-review attestation lifecycle does not apply.
