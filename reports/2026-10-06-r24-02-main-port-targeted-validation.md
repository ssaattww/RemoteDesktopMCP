# R24-02 current-main focused validation

## Target

- Repository: `ssaattww/RemoteDesktopMCP`
- Branch: `issue-24-r24-02-post-split-main`
- Base: `origin/main` at `5dac2528e80cba3e3ff5c855f14420075b2da717`
- Implementation commit: `f3513b2ba128f3ee258ea4e4bcf51aa3d9c9a2c3`
- Validation candidate HEAD: `7c4b8570215144c97bbd507c3a476443f605c189`

## Scope

Run tests in `test/config-transfer-integrity.test.ts` and `test/session-filesystem-lifecycle.test.ts` after the two-case fixture startup reduction. Preserve actual command, exit status, pass/fail/skip counts, stdout/stderr diagnostics, OS/Node/npm, dependency evidence, source identity, and any untested platform-specific behavior.

## Result

- Status: PASS
- Commands and outcomes: `./node_modules/.bin/tsx --test test/config-transfer-integrity.test.ts test/session-filesystem-lifecycle.test.ts` — exit code 0; 10 tests, 10 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo. Both target cases passed: DR002 unsupported atomic no-replace and NR009 symlink/Windows junction. Each uses `fixture({ initializeService: false })` and initializes its configured service after fixture setup. `git diff --check -- reports/2026-10-06-r24-02-main-port-targeted-validation.md` passed after report update.
- Diagnostic logs: stdout `/tmp/r24-02-main-port.stdout` (10 successful test lines and TAP summary; duration 31186.216845 ms); stderr `/tmp/r24-02-main-port.stderr` (empty). Runtime: Linux x86_64, `Linux 03bbdaff767c 6.18.44 #1 SMP Sat Sep 26 20:02:31 UTC 2026 x86_64 GNU/Linux`; bash; Node `v24.19.0`; npm `11.9.0`. Repository `ssaattww/RemoteDesktopMCP`, branch `issue-24-r24-02-post-split-main`, HEAD exactly `7c4b8570215144c97bbd507c3a476443f605c189`; base `origin/main` `5dac2528e80cba3e3ff5c855f14420075b2da717`. `npm ls --depth=0` succeeded; no dependencies installed. `node_modules` is an untracked worktree symlink to `/workspace/RemoteDesktopMCP-issue24/node_modules`; npm reports extraneous `@emnapi/runtime` and `@img/sharp-wasm32`, with no missing dependencies.
- Platform limits: NR009 symlink path passed on Linux. Windows junction behavior remains untested; do not infer Windows junction success from Linux.

## Merge/publication state

- This report is local preparation for a newly authorized draft PR. No push, merge, or PR exists yet.
- At test completion, only this report was modified; the pre-existing dependency symlink remained untracked. No push, merge, PR, or dependency installation was performed.
