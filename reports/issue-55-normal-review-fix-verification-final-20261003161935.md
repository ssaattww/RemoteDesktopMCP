# Issue #55 final normal-review fix verification addendum

This addendum supersedes the interim NR55-1 status in `reports/issue-55-normal-review-fix-verification-20261003161935.md`. It records the final implementation delta inspected after the parent reported the remaining resync issue fixed. The initial finding identities and severities are preserved.

## Reviewed identity

- Mode: targeted fix verification for NR55-1 (Medium) and NR55-2 (Low).
- Final targeted verdict: **pass_with_held**. Both findings are fixed in the final reviewed source snapshot. The parent reports focused Green 3/3; I did not execute tests, as instructed, and did not receive raw command output.
- Commit HEAD: `65a39d565b2e264b2e13e969e794723622c60ec0`; reviewed product/test changes remain uncommitted.
- Final tracked worktree diff SHA-256: `ad1f46bc13957d1cfc22a1a4dddf1f4dc4aa51079f0bff2c2cf05d3b80ee4823`.
- Final source/test fingerprints:
  - `src/user-console.ts`: `af2ac6562c6433de13fbbb5a212859403f3f119212d1f1088ee2fee55959ce18`
  - `src/user-console-client.ts`: `71e7a172cbc80fde017bdc3faecf948abdacbeb5787e3450d3bbee96ab0b85be`
  - `test/user-console.test.ts`: `3a2bc26793a126eb604d92158829c221c12ccea2afba54ad619fd9e95cb7fc93`
  - `test/user-console-client.test.ts`: `b1c452e99365803620ec5583e438b937de1575a43d142719cc4be32c59b4adc9`
  - Accepted design: `doc/design/long-running-process-context.md`, `7b443a4ecde20fc9a2e81ec4e9ec1d70bf0833419ab6187c949ca2a126cc7a3f`.
- Reviewer: `/root/issue55_normal_review`, independent of implementation. User-authorized requested profile was `gpt-6-luna`, medium, fork none; runtime profile and role remain unobservable, applied profile `null`.
- No code changes, tests, commits, pushes, or merges were made by this reviewer. `git diff --check` passed on the final inspected worktree.

## Finding closure

### NR55-1 — Medium, fixed

The final delta moves live-process seeding after the event-window flatten/rebuild (`src/user-console-client.ts:253-267`). Thus a running process missing from the newest 200 log items is added after the 1,000-event retention pass and is not immediately discarded. On a log resync, where `baselineCleared` has removed its prior snapshot, the synthetic group identity is recovered from the JSON tuple key and live metadata remains available (`:263-267`, `:280-285`, `:483-486`). Its heading now uses `latest.processId ?? group.process` (`:298-300`), so it visibly retains the process ID even when the synthetic group has no audit events.

The focused regression constructs 200 unrelated initial items and one active process (`test/user-console-client.test.ts:587-637`). It verifies the destination after initial state refresh and after resync, exact href/heading ID equality, and visible process ID after resync (`:616-637`). The parent reports this test in focused Green 3/3.

### NR55-2 — Low, fixed

The process heading, rather than its article, owns the fragment ID and is programmatically focusable (`src/user-console.ts:290-291`, `:332`; client `src/user-console-client.ts:298-300`). Client-created running links use the same per-component encoding (`:545-547`). Redraw focus capture and restoration match both session and process attributes and restore the heading or output summary with `preventScroll` (`:325-358`). The test exercises same-pair heading focus after output refresh (`test/user-console-client.test.ts:627-634`); the server test checks that the selected-session row resolves to that session/process heading (`test/user-console.test.ts:59-61`).

## Identity and held evidence

- Client grouping, baseline snapshots, open-state retention, live-state seeding, sort membership, scroll anchors, and focus restoration all use `JSON.stringify([session, process])` or explicit equality on both `data-session-id` and `data-process-id` (`src/user-console-client.ts:108-110`, `:117-120`, `:235`, `:245-267`, `:268-271`, `:351-357`).
- Server process metadata/group/running membership is keyed by the session/process pair; API state filters by owner and selected session (`src/user-console.ts:162-177`, `:282-315`). The server regression reuses one process ID across two sessions and checks the selected session's data and link (`test/user-console.test.ts:28-72`). No identity mismatch was found in the targeted paths.
- Parent-reported evidence: focused Green 3/3 after the final source and assertion change. Held: exact execution output was not supplied for independent inspection; full browser/FA780 validation remains outside this targeted fix verification.
- Coverage dispositions: NR55-1 `checked_no_finding`; NR55-2 `checked_no_finding`; composite session/process matching `checked_no_finding`; final test execution evidence `held` by parent; unexplored areas within the requested findings: none.
- The final verdict applies to the commit plus the exact uncommitted worktree fingerprints above, not the bare commit. No severity changes or reclassifications.
- `reserved_report_paths`: none. `report_attestation_allowed`: false; this is normal fix verification, not independent final review.
