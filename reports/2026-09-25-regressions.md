# レビュー指摘の回帰試験

## Dispatch

Requested: gpt-5.6-terra / high, explicit user implementation override. Fresh bounded technical test implementation, high criticality, cross-module composition, independent write scope test/**. No role override; planned requested profile, applied null, final profile hidden. Parent owns integration; source implementation owner edits src/** concurrently.

## Fixtures and findings matrix

`test/fixture.ts` creates a uniquely named, bounded temporary root and DATA_DIR for every composition fixture. It closes the MCP client, service, and Desktop Commander process before removing that exact directory. A referenced fixture timer remains alive until `service.close()` resolves; Node 22 otherwise treats the SDK close promise as pending after its unreferenced fallback timer is the only remaining handle.

| Finding | Regression coverage |
| --- | --- |
| RDMCP-DR-001 | Multi-chunk snapshot is read after same-size/same-mtime replacement; aggregate digest equals begin digest. Snapshot deletion fails terminally and leaves no snapshot artifact. |
| RDMCP-DR-002 | A racing destination survives no-replace commit and losing temp is removed. An injected `ENOTSUP` no-replace primitive makes upload begin fail before map state or probe artifacts exist. |
| RDMCP-DR-003 | Config hard-link aliases are rejected by direct read and content search; a swapped upload-temp pathname cannot alter the protected config. Traversal and resolved DATA_DIR overlap are rejected. |
| RDMCP-NR-001 | The Node 22 suite is exercised with the actual `node@22.23.3` runtime and no test is skipped or relaxed for cancellation. |
| RDMCP-NR-002 / NR-006 | Deterministic aged transfer and session metadata passed to public `sweepExpired()` terminalize transfers, remove artifacts, prevent revival, and expose `expires_at`/state. Cancellation and owned restart-orphan cleanup are covered; `session_list` excludes both closed and expired sessions. |
| RDMCP-NR-003 | Filename and content searches return all 115 distinct `needle-0` through `needle-114` hits across pages, rather than merely a result count; `[term]` is sent as literal content search. |
| RDMCP-NR-004 / NR-007 | Portable actual-Node scripts replace Windows `for /L` and `ping` commands. A process with 1,005 lines returns its final line without printing it during the test. A natural exit is audited without a prior status/output poll. The live ready-signalling bounded child is killed only after a running-state check; audit matching requires one JSONL row with both its process id and `process.exit`. Pinned Desktop Commander may report an observed `null` exit code, which is asserted as null rather than invented as a numeric status. |
| RDMCP-NR-005 | Real HTTP registration, valid 64-character S256 PKCE, redirect binding, one-use code, bad PKCE/scope/redirect/replay, tampered/audience/scope/issuer tokens, and authenticated streamable-HTTP file read/patch/search are covered. |
| RDMCP-NR-008 | Startup deletes only a manifest-owned, inode-matched upload orphan. A user file with the lookalike `.__rdmcp_*.upload` name remains intact. |

## Commands and results

Initial focused Node 22 run reproduced the review's cancellation: `Promise resolution is still pending but the event loop has already resolved`. The cause was fixture teardown clearing its last referenced timer before `service.close()` waited on the SDK's close lifecycle. The fixture now clears that timer only after close; this is not a skipped or masked cancellation.

Initial focused runs exposed the intended finite findings: search stopped at the first 100-result page, expired sessions remained listable, and broad startup-name cleanup could remove a legitimate lookalike. The portable process fixture also exposed Windows command quoting before it was replaced with Node scripts. These cases now pass without loosening assertions. TypeScript check passed.

Final frozen-suite command:

`npx.cmd --yes --package=node@22.23.3 node node_modules/tsx/dist/cli.mjs --test test/**/*.test.ts`

It was awaited through its shell session to completion and exited 0: 12 tests passed; 0 failed, cancelled, skipped, or todo; duration 51.944 seconds. The command covered the existing MVP checks and all fixtures in this matrix.

Windows is `local_execution_available`. Read-only discovery found `wsl.exe` but no installed Linux distribution, and Docker is unavailable, so Ubuntu is `remote_ci_only`: the portable NR-007 fixture needs targeted Ubuntu CI after publication. This report makes no local Linux-pass claim.

## Limitations

The unsupported no-replace path is tested through the injected narrow `linkNoReplace` capability seam because this Windows volume supports hard links. The test verifies the observable contract—upload begin refuses the destination and removes the probe—without claiming that the host filesystem lacks hard-link support.
