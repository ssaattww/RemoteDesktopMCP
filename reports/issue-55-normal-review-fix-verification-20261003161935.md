# Issue #55 normal-review fix verification

## Review identity

- Mode: targeted fix verification for NR55-1 and NR55-2 from `reports/issue-55-normal-review-202610031604.md`.
- Targeted verdict: **fail / revision required**. NR55-2 is fixed. NR55-1's missing destination is fixed, but the resync path still renders the live process heading without its process ID; the final authored regression assertion detects this remaining identity-display defect. Tests were not executed in this review, as requested.
- Repository / branch: `ssaattww/RemoteDesktopMCP` / `issue-55-process-context`.
- Commit HEAD: `65a39d565b2e264b2e13e969e794723622c60ec0`; implementation remains uncommitted.
- Reviewed worktree fingerprint: tracked `git diff` SHA-256 `845748bf46f3a3ac06f7d5633f9ae158028e90c74702698ecfe820fd4db1a0ea`.
- Changed source/test SHA-256:
  - `src/user-console.ts`: `af2ac6562c6433de13fbbb5a212859403f3f119212d1f1088ee2fee55959ce18`
  - `src/user-console-client.ts`: `be5defaead170485a0f3ed9b3cb4c1bc9a401a13ff970e56fe18d0ad7f27aefd`
  - `test/user-console.test.ts`: `3a2bc26793a126eb604d92158829c221c12ccea2afba54ad619fd9e95cb7fc93`
  - `test/user-console-client.test.ts`: `0ebb0780f5dbe2764c0b3a034a5a65bbb790714e55301f0384339cf4e89acf9f`
  - Accepted design: `doc/design/long-running-process-context.md`, `7b443a4ecde20fc9a2e81ec4e9ec1d70bf0833419ab6187c949ca2a126cc7a3f`.
- Reviewer: `/root/issue55_normal_review`, independent of implementation and initial review; inspected only both findings, directly affected code, tests, and composite-identity paths. No code changes, test execution, commit, or push.
- Dispatch: user-authorized request was `gpt-6-luna`, medium, fork none; runtime profile/role is not observable here, so applied profile is `null`.
- Pre-existing unrelated worktree state remains: `tasks/tasks-status.md` modified, `node_modules/` and implementation/previous-review evidence reports untracked.

## Finding verification

### NR55-1 — Medium, fixed

- Original issue: state refresh could rebuild process details from the newest 200 audit items and drop a still-running process article whose `process.start` and recent events were outside that page, leaving its running-row anchor with no target.
- Implementation evidence:
  - `src/user-console-client.ts:102-113` snapshots each server-rendered process block's session, process, start event, and event list before reconstruction.
  - `:235-257` uses `JSON.stringify([session, process])` as the composite key and seeds a missing group from the server snapshot while available, or from the scoped `liveProcesses` key after a resync clears the baseline.
  - `:280-306` uses the same composite key for metadata fallback and creates the article plus heading destination.
  - `:474-487` fills `liveProcesses` from `/api/console-state` and redraws after initial state refresh; the API request is session-scoped through `apiPath` at `:77`.
  - `test/user-console-client.test.ts:587-637` supplies 200 unrelated initial items, a server-rendered process-start snapshot, and a running-state record. It checks that the article and matching heading/link ID exist after initial state refresh and again after log resync.
- Verification: **not fixed (partial)**. The scoped live process seeds an article in both refresh and resync paths, and its heading target uses the same encoded session/process pair as the Running operations link. However, after resync the baseline is cleared and the synthetic group's `events` array is empty (`src/user-console-client.ts:253-257`, `:361-367`). `latest` is then `{}` (`:281`), and the visible heading text reads `latest.processId ?? "—"` (`:299`), so it omits the process ID. The final regression test now asserts that the resync heading text contains the process ID (`test/user-console-client.test.ts:616-637`); by source inspection this assertion is unsatisfied. Use `group.process` as the heading's process-ID fallback and re-run the test/gates.

### NR55-2 — Low, fixed

- Original issue: the fragment ID targeted a focusable article rather than the process heading or output disclosure control required by design contract 8.
- Implementation evidence:
  - Server link uses `processAnchorId(session, process)` at `src/user-console.ts:290-291`; the rendered article has no fragment ID and the process heading at `:332` owns that ID and `tabindex=-1`.
  - Client running-row link uses the same encoding at `src/user-console-client.ts:550-552`; generated process heading at `:298-300` has the matching ID and `tabIndex=-1`.
  - `src/user-console-client.ts:325-358` captures the focused process heading/disclosure by its containing block's session/process data, then restores the matching new heading or summary with `preventScroll` after redraw.
  - `test/user-console-client.test.ts:616-633` checks same-pair link/heading ID and that heading focus survives output refresh.
  - Server regression `test/user-console.test.ts:59-61` checks that a running row resolves to the heading in its same-session process article.
- Verification: **fixed**. The href destination is now the heading and redraw focus restoration returns to the same heading for the same session/process.

## Composite identity and residual observation

- Client process grouping, baseline snapshotting, live-state seeding, disclosure state, scroll anchoring, and focus restoration consistently use `JSON.stringify([sessionId, processId])` or explicit equality checks on both attributes (`src/user-console-client.ts:108-110`, `:117-120`, `:235-257`, `:263-271`, `:351-357`). This avoids delimiter ambiguity in client composite keys.
- Server metadata maps and group/running-set matching use session plus process (`src/user-console.ts:162-170`, `:282-288`, `:306-315`). API state filters both owner and requested session (`:163`, `:177`). Existing Issue #55 server regression deliberately reuses `shared-process` in another session and confirms the selected session's metadata, link, and detail do not use the other session (`test/user-console.test.ts:28-72`).
- Fragment IDs encode each component and use the same separator consistently in server and client; the stale-page test checks an exact same-pair href/heading match (`test/user-console-client.test.ts:616-623`). The resync test also now checks the visible process ID at `:622`; this final assertion reveals the NR55-1 residual described above.
- Worktree changed during review when the test gained an `id` field/`h3` query and the visible-heading assertion. That final test hunk was re-inspected and included in the final fingerprint above; product source was unchanged during this update.

## Validation and coverage disposition

- No tests or runtime/browser checks were run by this reviewer; this was expressly prohibited for this fix-verification assignment. The focused tests were inspected, not executed by this reviewer.
- The parent reports that full gates passed on the revision. Exact command output was not provided to this review, so this is recorded as parent-reported evidence rather than an independently inspected log.
- `git diff --check` passed on the reviewed current worktree (exit 0, no output).
- NR55-1: `checked_finding` (destination seeding and fragment match fixed; visible process identity still absent after resync, with a final authored assertion that appears to fail by source inspection).
- NR55-2: `checked_no_finding` (fixed, targeted test authored/unexecuted).
- Same-session/process identity paths: `checked_no_finding`, with residual display note above.
- Test execution/current-head gates: `held` by parent integration owner.
- Windows/FA780 validation: not part of this targeted review; remains held from the initial review.
- Severity continuity: NR55-1 remains Medium; NR55-2 remains Low. No reclassification.
- Verdict rationale: `fail` because the NR55-1 resync path does not preserve visible process identity. Parent reports full gates passed, but the current test file changed during this review and its new assertion appears to fail against unchanged production source. The reviewed implementation identity is the commit plus exact uncommitted diff/source fingerprints above, not the bare commit.
- Next action: update the no-event heading fallback to render `group.process`, then rerun the resync regression and current gates.
- `reserved_report_paths`: none; normal fix verification only.
- `report_attestation_allowed`: false; independent-final-review lifecycle does not apply.
