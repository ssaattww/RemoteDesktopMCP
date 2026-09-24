# 通常レビュー指摘修正

## Dispatch

Implementation owner: implementation. Regression owner: regressions. This is the bounded repair after normal review target `23bd136`; the public MCP API and the single-PC local MVP boundary remain unchanged. Parent owns integration, commit, and final review.

## Changes and finding matrix

| Finding | Production action and path | Composition fixture | Evidence and disposition |
| --- | --- | --- | --- |
| RDMCP-DR-001 | `src/index.ts` copies source bytes once into a private snapshot, hashes those bytes, streams sequential chunks, and terminalizes a missing or short snapshot read after cleanup. | `DR001: downloads use one immutable multi-chunk snapshot and clean failed snapshots`. | The Node 22 full suite passed this fixture. |
| RDMCP-DR-002 | Upload retains an exclusive temp handle and inode identity, checks both before write and commit, validates size/hash, probes no-replace support, and commits `overwrite=false` with `link` then `unlink`. | `DR002: no-replace commit preserves a winner and removes the losing temp`; `DR002: upload begin fails safely when the destination lacks atomic no-replace support`. | The Node 22 full suite passed the real race and injected `ENOTSUP` cases. |
| RDMCP-DR-003 | `guardSearchRoot` rejects protected inode aliases before Desktop Commander search; direct paths and pinned upload temps reject aliases; ready audit omits the config path. | `DR003: protected config aliases cannot be read, searched, or reached by a swapped upload temp`. | The Node 22 full suite passed. |
| RDMCP-NR-001 | `DesktopCommander.close` holds a referenced, bounded shutdown timer while the SDK closes its child transport. | HTTP/MCP and live Desktop Commander fixture teardown. | The Node 22 full suite completed without cancellations. |
| RDMCP-NR-002 | `sweepExpired` serializes expiry before transfer use, runs periodically, expires session-owned transfers, caps terminal records, and cleans recognized restart artifacts. | `NR002 and NR006: expiry sweeps cancel transfers, clean files, and list session state`. | The Node 22 full suite passed. |
| RDMCP-NR-003 | Search uses literal semantics, follows every advertised next offset even after a `COMPLETED` page, bounds collection, labels a bound result incomplete, and stops the search session. | `NR003 and NR004: searches return every page and portable Node processes retain output/audit` checks all 115 distinct file and content matches. | Focused Node 22 fixture passed in 7.258 seconds; the full suite passed. |
| RDMCP-NR-004 | A non-overlapping 250 ms watcher reads bounded Desktop Commander output for every live logical process and records observed completion. It recognizes Desktop Commander's numeric, `null`, and `undefined` exit-code forms. `force_terminate` is session-scoped, parses acknowledgment separately from rejection, and uses the SDK request timeout rather than leaving a raced request in flight. | The NR003/NR004 fixture starts a ready, live portable Node child with a 200 ms start timeout, verifies it is running, then exercises `force_terminate`, natural exit, output beyond 1,000 lines, and the exit audit. | Focused Node 22 fixture passed in 7.258 seconds; the full suite passed. The prior missing audit was a parser bug: Desktop Commander reported `Process completed with exit code null`. The fixture also corrected its wait to require `process.exit` and the target ID on one audit row. |
| RDMCP-NR-005 | OAuth validates S256 PKCE syntax, scope, exact token redirect URI, replay, and issuer/audience/scope claims. | `NR005: real HTTP OAuth validates PKCE, scope, redirect, replay, claims, and MCP file operations`. | The Node 22 full suite passed. |
| RDMCP-NR-006 | `session_list` sweeps then returns only active caller sessions, including expiry/state metadata. | `NR002 and NR006: expiry sweeps cancel transfers, clean files, and list session state`. | The Node 22 full suite passed closed and expired absence checks. |
| RDMCP-NR-007 | `test/regressions.test.ts` runs portable Node scripts with platform-appropriate quoting instead of Windows-only shell loops and ping options. | The same live process fixture runs in both configured Node 22 CI jobs. | Windows Node 22 passed; Ubuntu is `remote_ci_only`, awaiting matching candidate CI before closure. |
| RDMCP-NR-008 | Startup cleanup reads `DATA_DIR/transfers/owned-uploads.json` and removes only a same-inode, manifest-owned temp beneath its declared root. It no longer recursively deletes lookalike names in user roots. | `NR008: startup preserves unowned lookalikes and removes only manifest-owned orphan artifacts`. | The Node 22 full suite passed the owned artifact and unowned lookalike cases. |

## Validation and limitations

Current source validation passed: `npm.cmd run check`, `npm.cmd run build`, and `npm.cmd run lint:ts`. The final regression command, `npx.cmd --yes --package=node@22.23.3 node node_modules/tsx/dist/cli.mjs --test test/**/*.test.ts`, exited 0 with 12 passing tests, 0 failed, cancelled, skipped, or todo, in 51.944 seconds.

The service remains a local single-PC MVP. Google OIDC, CIMD, refresh token, multi-PC routing, and Funnel publication remain outside this change. `process_start` retains the same-OS-user arbitrary-command trust boundary. `process_kill` delegates only the Desktop Commander session root PID through `force_terminate`; Desktop Commander 0.2.51 does not provide safe descendant identity, so stopping an entire child process tree is not guaranteed. A rejected request remains running and is audited as rejected. A timed-out request becomes `terminating` with `termination_unconfirmed`; it does not start overlapping process operations or restart the Desktop Commander connection. Completion is audited only when Desktop Commander reports it, including an unknown (`null`) exit code.

## Wording self-check

The implementation owner reviewed this report against `skills/document-wording-review/SKILL.md` and its decision examples. The finding identifiers, commands, evidence state, and Desktop Commander limitation are stated without overstating the root-PID behavior. Result: pass.
