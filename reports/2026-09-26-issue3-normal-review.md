# Issue #3 / PR #5 normal review

## Metadata

- Repository: `ssaattww/RemoteDesktopMCP`
- Issue: #3, remove file-operation and transfer folder restrictions
- Pull request: #5, `Remove file-root restrictions from file and transfer tools`
- Review mode: `initial review`
- Reviewer identity: `chatgpt-normal-review-pr5-20260926`
- Reviewer role: normal reviewer
- Reviewer continuity: no earlier normal review exists for PR #5
- Reviewed implementation HEAD: `a803cf0bfbf6d4a8abd2fc10530ea03504b95f53`
- Base: `865f6cd65763f36e0b48f39e1f3d402e696c8308`
- Commit range: `865f6cd65763f36e0b48f39e1f3d402e696c8308..a803cf0bfbf6d4a8abd2fc10530ea03504b95f53`
- Execution environment: FA780 / Windows / RemoteDesktopMCP connected-computer route
- Review worktree: `C:\Users\donabe\Project\RemoteDesktopMCP-pr5-review-20260926`
- External evidence directory: `C:\Users\donabe\Project\RemoteDesktopMCP-pr5-review-evidence-20260926`
- Verification capability: `local_execution_available`
- Report attestation: not applicable; this is a normal review

The PR current HEAD was rechecked immediately before report persistence and matched the reviewed implementation HEAD.

## Scope and inspected material

Issue #3 removes the application-specific file-root allowlist from read, search, patch, upload, and download operations. The accepted change also retains a separate file-API exclusion for `DATA_DIR` and tracked Desktop Commander configuration identities.

All 14 changed paths were inspected:

- `.env.example`
- `README.md`
- `doc/design/functional-requirements.md`
- `doc/design/multi-pc-architecture.md`
- `doc/design/tailscale-funnel-architecture.md`
- `doc/remote-setup.md`
- `reports/2026-09-26-issue3-implementation.md`
- `src/index.ts`
- `src/remote-auth-cli.ts`
- `test/fixture.ts`
- `test/independent-fixes.test.ts`
- `test/mvp.test.ts`
- `test/public-auth.test.ts`
- `test/regressions.test.ts`

The directly affected installed dependency was also inspected. Desktop Commander 0.2.51 treats `allowedDirectories.length === 0` as unrestricted filesystem access, so the PR's use of `allowedDirectories: []` matches the fixed dependency's behavior.

The existing `.github/workflows/lint.yml` already records test results, stdout, stderr, per-command results, and environment data and uploads diagnostics on both Ubuntu and Windows. No workflow change was required for this review.

## Validation and exact-head evidence

Local validation was performed against the reviewed HEAD. Outputs were stored outside the reviewed source.

| Check | Result | Evidence |
| --- | --- | --- |
| `npm ci` | pass | `npm-ci.result.txt`, stdout, stderr |
| `npm run lint` | pass | `lint.result.txt`, stdout, stderr |
| `npm run check` | pass | `check.result.txt`, stdout, stderr |
| `npm run build` | pass | `build.result.txt`, stdout, stderr |
| `npm test` | pass: 44 tests, 43 passed, 0 failed, 1 Windows-only skip | `test.result.txt` records `exit_code=0`; complete output in `test.stdout.log` |
| `git diff --check 865f6cd...a803cf0b` | fail | `test/regressions.test.ts:571: new blank line at EOF` |

Two earlier review-owned wrapper attempts incorrectly detached long-running child test processes. Those process trees were terminated and are retained only as execution diagnostics. The authoritative full-suite record is `test.result.txt` with `exit_code=0`.

Exact-head CI:

- Reviewed PR HEAD: `a803cf0bfbf6d4a8abd2fc10530ea03504b95f53`
- Pull-request workflow run: `36211648548`
- Ubuntu job `108319277722`: success
- Windows job `108319277842`: success
- Ubuntu diagnostics artifact `10895926665`
- Windows diagnostics artifact `10895871882`
- Both artifact records report `workflow_run.head_sha = a803cf0bfbf6d4a8abd2fc10530ea03504b95f53`

No run for another SHA is used as evidence.

## Findings

### RDMCP-I3-NR-001 / Medium - protected config can be read through symlink to a protected hardlink alias

- Origin: `pre_existing`; the PR retains and documents this protection contract.
- Location: `src/index.ts:219`, `src/index.ts:388-403`, `src/index.ts:494`.
- Contract: `DATA_DIR` and tracked Desktop Commander configuration identities remain excluded from file APIs.
- Cause: `safePath()` resolves the supplied pathname with `realpath()`, but the protected-identity check calls `identityForPath(candidate)`. `identityForPath()` uses `lstat()`, so a symlink is checked by the symlink inode instead of by the resolved protected target inode.
- Composition reproduction: capture a tracked protected config inode, create an external hardlink alias to it, create a symlink to that hardlink alias, then call the real MCP `file_read` with the symlink path.
- Result: `RESULT=ALLOWED`; the response returned the protected Desktop Commander configuration, including `allowedDirectories: []`.
- Evidence: `repro-symlink-protected.mts`, `repro-symlink-protected.stdout.log`, and `repro-symlink-protected.stderr.log` in the external evidence directory.
- Impact: the file API's promised protected-configuration boundary is bypassable for a tracked current or historical config inode through one additional filesystem alias. The same `safePath()` check is shared by direct file operations.
- Required action: validate protected identity against the resolved target identity, while preserving legitimate ordinary symlink access. Add a composed regression fixture for protected config inode -> hardlink alias -> symlink and verify the affected file APIs reject it.

### RDMCP-I3-NR-002 / Medium - benign symlink or junction inside a search tree rejects the whole search

- Origin: `pre_existing` behavior that conflicts with the new unrestricted absolute-path search contract.
- Location: `src/index.ts:373-386`, specifically the unconditional `entry.isSymbolicLink()` rejection.
- Contract: `file_search` and `content_search` accept an accessible absolute directory, subject to exclusion of actual protected service state.
- Cause: `guardSearchPath()` recursively walks the complete tree and rejects every symbolic link before determining whether the link resolves to a protected target.
- Composition reproduction: create a searchable ordinary file and a benign symlink to an ordinary file in the same directory, then call the real MCP `file_search` for the ordinary target.
- Result: `RESULT=BLOCKED` with `Search path contains a symbolic link.` A separate Windows junction reproduction reports the same rejection.
- Evidence: `repro-search-benign-symlink.mts`, its stdout/stderr logs, and `search-junction.result.txt` in the external evidence directory.
- Impact: ordinary accessible directories can become unsearchable merely because they contain a benign symlink, junction, or reparse entry unrelated to protected state. Existing `NR009` covers a link used as the search root, not a link inside the searched tree.
- Required action: distinguish aliases that resolve to protected targets from ordinary links instead of rejecting every link in the search tree. Add composed tests showing benign links do not block search while protected aliases remain blocked.

### RDMCP-I3-NR-003 / Low - changed diff contains an EOF whitespace error

- Origin: `introduced_by_change`.
- Location: `test/regressions.test.ts:571`.
- Evidence: `git diff --check 865f6cd65763f36e0b48f39e1f3d402e696c8308..a803cf0bfbf6d4a8abd2fc10530ea03504b95f53` reports `new blank line at EOF`.
- Impact: no product-runtime effect, but the committed diff fails Git's standard whitespace check.
- Required action: remove the extra blank line at EOF.

### RDMCP-I3-NR-004 / Medium - DATA_DIR exclusion can be bypassed through an external hardlink alias

- Origin: `pre_existing`; PR #5 retains and documents the `DATA_DIR` file-API exclusion.
- Location: `src/index.ts:388-403` (`safePath()`) and `src/index.ts:494` (`file_read`).
- Contract: files below `DATA_DIR` remain excluded from the file APIs even after the allowlist is removed.
- Cause: `safePath()` protects `DATA_DIR` by comparing the resolved pathname with the real `DATA_DIR` pathname. A hardlink created outside `DATA_DIR` has a different pathname, and unlike tracked Desktop Commander configuration identities, arbitrary `DATA_DIR` files have no file-identity check.
- Composition reproduction on the exact reviewed implementation HEAD `a803cf0bfbf6d4a8abd2fc10530ea03504b95f53`: create a hardlink outside `DATA_DIR` to `DATA_DIR/audit.jsonl`, open a real MCP session, and call `file_read` on the external hardlink.
- Result: `AUDIT_HARDLINK=ALLOWED`; the file API returned live audit records from `DATA_DIR/audit.jsonl`.
- Evidence: `hardlink-audit-a803.mjs`, `hardlink-audit-a803.stdout.log`, `hardlink-audit-a803.stderr.log`, and `hardlink-audit-a803.result.txt` in the external evidence directory. The result file records `exit_code=0`.
- Impact: the documented `DATA_DIR` exclusion is pathname-based rather than object-identity-based. Service audit data, and any other service-state file that can be hardlinked to an external path, can be read through the file API. This does not add OS-user privilege beyond the accepted `process_start` model, but it violates the explicit file-API protection contract.
- Required action: make the `DATA_DIR` exclusion resistant to hardlink aliases (or use an equivalent object-identity protection mechanism) and add a composed regression fixture that proves an external hardlink to a service-state file is rejected.

## Required coverage

| Criterion | Disposition | Evidence |
| --- | --- | --- |
| Requirement and design conformance | `checked_finding` | NR-001 violates retained protected-config exclusion; NR-002 conflicts with unrestricted absolute-path search for ordinary accessible content; NR-004 violates the retained `DATA_DIR` exclusion. |
| Correctness and edge cases | `checked_finding` | The protected-config alias, benign search-link, and `DATA_DIR` hardlink cases were reproduced against the actual MCP composition. |
| Scope discipline and unrelated changes | `checked_no_finding` | Changed paths are limited to Issue #3 implementation, tests, configuration example, documents, and implementation report. |
| Changed files and direct dependencies | `checked_finding` | All 14 changed paths plus Desktop Commander 0.2.51 filesystem semantics were inspected. |
| API, data, configuration, workflow, compatibility | `checked_finding` | Absolute-path API migration is consistent, but alias handling has the findings above. Diagnostic workflow requirements are already satisfied. |
| Error handling and failure diagnostics | `checked_no_finding` | OS/path failures remain fail-closed; review-execution failures were retained separately from product-test evidence. |
| Security and secret handling | `checked_finding` | NR-001 bypasses tracked-config protection and NR-004 bypasses the documented `DATA_DIR` file-API exclusion. |
| Tests and validation adequacy | `checked_finding` | Existing tests pass but omit the composition cases that reproduce NR-001, NR-002, and NR-004. |
| Current-HEAD CI evidence | `checked_no_finding` | Run `36211648548` matches the reviewed HEAD and both OS jobs succeed. |
| Report, tracking, documentation accuracy | `checked_no_finding` | Documents accurately state the intended unrestricted path model and retained protection; defects are in implementation coverage. |
| Regression and maintainability risk | `checked_finding` | Alias handling has three uncovered behavior classes; the changed test file also has an EOF whitespace defect. |

Held items: none.

Unexplored areas: none material to this verdict. `process_start` was not treated as a sandbox because the accepted design explicitly grants arbitrary commands the service OS user's privileges.

## Verdict

**fail** on reviewed implementation HEAD `a803cf0bfbf6d4a8abd2fc10530ea03504b95f53`.

The main allowlist-removal path, absolute-path read/patch/transfer API migration, Desktop Commander unrestricted configuration, existing full suite, and exact-head Ubuntu/Windows CI pass. The retained protected-config boundary is nevertheless bypassable through a symlink-to-hardlink alias, the `DATA_DIR` exclusion is bypassable through an external hardlink alias, and search rejects ordinary symlink-containing trees under the new unrestricted absolute-path contract. The EOF blank line is an additional low-severity diff issue.

No implementation, test, configuration, workflow, task-tracking, or product fix was performed by this reviewer. No merge was performed.

## Fix-verification handoff

Reuse this same normal-review chat for fix verification.

| Finding | Required action | Production path to verify | Actual composition fixture required | Focused evidence required |
| --- | --- | --- | --- | --- |
| RDMCP-I3-NR-001 / Medium | validate resolved target identity and reject protected aliases without breaking ordinary symlinks | `identityForPath`, `safePath`, affected `file_*` callers | protected config inode -> hardlink alias -> symlink -> real MCP file API rejection | focused test on fix HEAD plus full local suite |
| RDMCP-I3-NR-002 / Medium | stop rejecting every benign symlink/junction while still excluding protected aliases | `guardSearchPath` and search delegation | benign link in search tree succeeds; protected alias in search tree fails | focused search tests on fix HEAD plus full local suite |
| RDMCP-I3-NR-003 / Low | remove EOF whitespace error | `test/regressions.test.ts` | not applicable | `git diff --check` passes |
| RDMCP-I3-NR-004 / Medium | make `DATA_DIR` exclusion hardlink-alias resistant | `safePath` and affected direct file APIs | `DATA_DIR/audit.jsonl` -> external hardlink -> real MCP `file_read` rejection | focused alias test on fix HEAD plus full local suite |

For any fix HEAD, rerun the local equivalence gate and use only a pull-request workflow run whose `head_sha` matches the new PR current HEAD. The successful run for `a803cf0b...` must not be reused after an implementation HEAD change.

Merge remains the user's action.
