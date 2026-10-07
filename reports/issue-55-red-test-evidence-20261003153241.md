# Issue #55 TDD Red test evidence

## Task and identity

- Repository: `ssaattww/RemoteDesktopMCP`
- Issue / Draft PR: #55 / #60
- Branch / base: `issue-55-process-context` / `main`
- Base HEAD: `c0c786a3d696724d780291aed9c8b89cbe2d531e`
- Source HEAD before test authoring: `65a39d565b2e264b2e13e969e794723622c60ec0`
- Scope: add only focused tests for the accepted Issue #55 display and ownership contract; run them to capture Red before product edits.

## Dispatch profile

- selection source: explicit user override.
- task kind: test authoring and test execution (TDD Red phase).
- signals: bounded technical; uncertainty medium; change radius cross-module; criticality high; repetition single; decomposability sequential_dependencies; decomposition policy allowed, one child owns the test-first slice.
- requested profile: `gpt-6-luna`, `medium`, fork `none`.
- role/default-role plan: role selection is not exposed by the available spawn tool; effective role and role effect unknown.
- planned runtime profile: requested values, role adjustment unknown.
- applied profile: null.
- application status: spawn_succeeded_profile_unverified.
- profile observability: final profile hidden; no role query is available in this runtime. Requested model and reasoning effort were supplied to the spawn tool, but effective role and runtime application cannot be verified; recorded applied profile remains null.
- constraints: edit only the named test files; no product implementation, package/dependency, whitelist, PR, or merge changes.

## Governing TDD requirement

- User's explicit Issue #55 delegation instruction requires TDD.
- `doc/design/long-running-process-context.md` defines the test-first cases.

## Cases and Red execution

- Cases added (no duplicate setup beyond existing coverage):
  - `test/user-console.test.ts`: uses two `service.processes` entries in `running` state, one `finished` entry, and the same process ID in a second owner session. It checks session-filtered `/api/console-state` IDs, purpose/command fields for redraw, the two running rows' purpose/command/fallback and ordering, a link that resolves to a detail article carrying the same session and process IDs, detail ordering when finished has a newer timestamp, empty metadata fallback/no borrowing, and no leakage from the other session. Owner authentication/hiding behavior remains covered by existing tests.
  - `test/user-console-client.test.ts`: retains open-disclosure state across output refresh; asserts `document.activeElement` is the replacement `summary` for the same session/process, has `preventScroll`, and does not change scroll position. A resync case replaces the focused process with another and asserts focus is not transferred. Existing tests cover process grouping under session+process key and process-output refresh. The current Red stops at the first active-element identity assertion, so later element-kind/session/process, scroll, and vanished-target assertions are authored but have not yet been reached in this Red run.
- Environment: runtime-local Linux container, bash, `/workspace/rdmcp-issue55`; branch `issue-55-process-context`; HEAD `65a39d565b2e264b2e13e969e794723622c60ec0` (same as recorded source HEAD; no product edits).
- Full two-file Red command: `npx tsx --test test/user-console.test.ts test/user-console-client.test.ts`; exit status `1`, 22 passed, 2 failed, 24 total, duration 38.8 seconds. Stdout showed both added tests failing; existing 22 tests passed. Client diagnostic: `activeElement is the replacement disclosure, not the detached prior element` (`false !== true`). Server's aggregated assertion reported: `/api/console-state` omitted purpose/command; both Running operations rows omitted purpose/command/fallback (their process IDs and session IDs were present); no process-specific in-page link; detail order was `completed-process`, `shared-process`, `running-no-metadata` instead of running first; empty metadata lacked `未記録`. Same-session process IDs were correct and the cross-session duplicate was excluded from the API; no other-session metadata leaked, and populated process purpose/command stayed associated with their own details.
- Focused Red command: `npx tsx --test --test-name-pattern='Issue 55|process output refresh restores focus' test/user-console.test.ts test/user-console-client.test.ts`; exit status `1`, 0 passed, 2 failed, 2 selected. Stdout showed the same active-element failure and server aggregated failure above. Stderr for both commands contained only npm's update notice: `npm notice New major version of npm available! 11.9.0 -> 12.2.0` and its standard update instructions. No package changes were made.
- Changed test source fingerprints (SHA-256): `test/user-console.test.ts` `2717521b538d1da81a5d66264588a524b647c564c0d4991b131e1c9947349a36`; `test/user-console-client.test.ts` `8013917650a4bbe6bcc8920dc787e62ea7cb38374dc5332dd15f68e54ce209f7`.
- Scope check: test source edits were confined to the two named test files; this designated parent-owned Red report was also updated, with its Dispatch section preserved. Product code, docs, package/lock files, lint configuration/dictionaries/exclusions, PR/Issue, and other reports were not edited. Pre-existing/unowned untracked `node_modules/` remains. No commit was made; test edits are pending parent integration.

## Changed files

- `test/user-console.test.ts`: focused Issue #55 fixture-backed server/API regression for live process rows, metadata, navigation, composite session/process identity, running-first order, and empty-value fallback.
- `test/user-console-client.test.ts`: focused process-output redraw regression for disclosure-open state, matching element focus restoration with `preventScroll`, and avoiding focus transfer when the target disappears.

## Next action

- Parent reviews the two-file diff and Red evidence, then decides whether to proceed to product implementation. No Green run was performed; this task stops at Red.
