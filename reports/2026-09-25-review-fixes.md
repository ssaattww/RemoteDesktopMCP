# 通常レビュー指摘修正

## Dispatch

Implementation owner: implementation; reused gpt-5.6-terra / high user-requested profile, applied null (final runtime profile hidden). Review target: 4eee364a4a72175f6197473ace2e55737115a098. High-criticality boundary fixes and public contracts; source and tests are independent write scopes behind the existing MCP API. Source owner edits src/package/README; regression owner edits test only. Parent owns integration and task status.

## Changes and finding matrix

| Finding | Production action and path | Composition fixture | Evidence and current disposition |
| --- | --- | --- | --- |
| RDMCP-DR-001 | `src/index.ts` creates one private snapshot, hashes those bytes, streams sequential chunks and marks a missing or short snapshot read as failed after cleanup. | `DR001: downloads use one immutable multi-chunk snapshot and clean failed snapshots`. | Passed in the final Node 22 suite. |
| RDMCP-DR-002 | Upload retains an exclusive temp handle and inode identity, checks both before write and commit, validates size/hash, and uses `link` then `unlink` for no-replace commit. Before an `overwrite=false` upload exists, it probes that destination directory with unique same-root files and the same `linkNoReplace` operation. | `DR002: no-replace commit preserves a winner and removes the losing temp`; `DR002: upload begin fails safely when the destination lacks atomic no-replace support`. | Both real-race and injected `ENOTSUP` cases passed in the final Node 22 suite. |
| RDMCP-DR-003 | `guardSearchRoot` walks before `start_search` and rejects symlink or protected-config inode aliases. `safePath` rejects direct config aliases. Upload temp writes use the pinned handle and identity; ready audit omits the config path. | `DR003: protected config aliases cannot be read, searched, or reached by a swapped upload temp`. | Passed in the final Node 22 suite. |
| RDMCP-NR-001 | `DesktopCommander.close` makes one SDK client close call and holds a referenced, bounded five-second service timer while the SDK's unreferenced child-shutdown fallbacks run. It emits only a generic timeout audit event. | Eleven live fixture teardowns exercise `service.close` after Desktop Commander use. | Regression worker confirmed service-close lifecycle as the failure stage; final Node 22 suite had no cancellation. |
| RDMCP-NR-002 | `sweepExpired` is public and serializes session/transfer expiry before status/cancel refresh. A minute timer runs it, session expiry fails owned active transfers, terminal records are capped, and recognized snapshot/upload restart artifacts are removed. | `NR002 and NR006: expiry sweeps cancel transfers, clean files, and list session state`; `NR002: startup removes only owned orphan transfer artifacts`. | Passed in the final Node 22 suite. |
| RDMCP-NR-003 | Search preflights the root, requests `literalSearch`, polls asynchronous results until completion or a five-page/five-and-a-half-second bound, and always stops the Desktop Commander search session. | `NR003 and NR004: search pages literal text and process output/audit retain completion`. | Passed in the final Node 22 suite. |
| RDMCP-NR-004 | Process output uses the Desktop Commander zero-based absolute cursor, handles both `new lines` and absolute headers, keeps bounded combined output, and records only observed exit results. Kill reports `terminating` while it awaits a bounded actual exit observation. | `NR003 and NR004: search pages literal text and process output/audit retain completion`. | Passed in the final Node 22 suite, including natural and kill audit paths. |
| RDMCP-NR-005 | `/authorize` requires an S256 base64url challenge of exactly 43 characters. `/token` requires a 43–128 character unreserved verifier, scope `mcp`, and a redirect URI equal to the authorization URI; access claims carry and validate the configured issuer. | `NR005: real HTTP OAuth validates PKCE, scope, redirect, replay, claims, and MCP file operations`. | Passed in the final Node 22 suite. |
| RDMCP-NR-006 | Sessions retain `expires` and state; `session_open` and `session_list` expose them. | `NR002 and NR006: expiry sweeps cancel transfers, clean files, and list session state`. | Passed in the final Node 22 suite. |

## Validation and limitations

Source-only validation run after the final process/shutdown changes: `npm.cmd run check`, `npm.cmd run build`, `npm.cmd run lint:ts`, and `npm.cmd run lint` passed. The regression worker reports that `npx.cmd --yes node@22.23.3 node_modules/tsx/dist/cli.mjs --test test/**/*.test.ts` passed 12/12 with 0 fail, cancellation or skip in 50.981 seconds.

The service remains a local single-PC MVP. Google OIDC, CIMD, refresh token, multi-PC routing, and Funnel publication remain outside this change. The same OS user process_start trust model is unchanged.

## Wording self-check

The implementation owner reviewed this report against `skills/document-wording-review/SKILL.md` and its decision examples. The matrix names the actual paths, commands and evidence boundary without changing identifiers or claiming the concurrently owned test result. Result: pass.
