# レビュー指摘の回帰試験

## Dispatch

Requested: gpt-5.6-terra / high, explicit user implementation override. Fresh bounded technical test implementation, high criticality, cross-module composition, independent write scope test/**. No role override; planned requested profile, applied null, final profile hidden. Parent owns integration; source implementation owner edits src/** concurrently.

## Fixtures and findings matrix

`test/fixture.ts` creates a uniquely named, bounded temporary root and DATA_DIR for every composition fixture. It closes the MCP client, service, and Desktop Commander process before removing that exact directory. A referenced fixture timer remains alive until `service.close()` resolves; Node 22 otherwise treats the SDK close promise as pending after its unreferenced fallback timer is the only remaining handle.

| Finding | Regression coverage |
| --- | --- |
| RDMCP-DR-001 | Multi-chunk snapshot is read after same-size/same-mtime replacement; aggregate digest equals begin digest. Snapshot deletion fails terminally and leaves no snapshot artifact. |
| RDMCP-DR-002 | A racing destination survives no-replace commit and losing temp is removed. An injected `ENOTSUP` no-replace primitive makes upload begin fail before map state or probe artifacts exist. |
| RDMCP-DR-003 | A hard link to known current config A is rejected before any manual replacement. After an atomic non-secret A-to-B `config.json` replacement, both A and B aliases remain rejected. The replacement uses a bounded Windows-only sharing-violation retry (six attempts for `EPERM`, `EACCES`, or `EBUSY`) without weakening either alias assertion. The service is restarted to prove persisted protected identities still reject both aliases. A deterministic `linkProtectedConfig` seam replaces B with C between pin stat and link, retains an alias to the exact C inode linked to the private pin, and requires known A and that captured C alias to reject. After 128 bounded create/delete churn operations, ordinary files remain readable. Content search and a swapped upload-temp pathname cannot reach protected config identities; traversal and resolved DATA_DIR overlap are rejected. |
| RDMCP-NR-001 | The Node 22 suite is exercised with the actual `node@22.23.3` runtime and no test is skipped or relaxed for cancellation. |
| RDMCP-NR-002 / NR-006 | Deterministic aged transfer and session metadata passed to public `sweepExpired()` terminalize transfers, remove artifacts, prevent revival, and expose `expires_at`/state. Cancellation and owned restart-orphan cleanup are covered; `session_list` excludes both closed and expired sessions. |
| RDMCP-NR-003 | Filename and content searches return all 115 distinct `needle-0` through `needle-114` hits across pages, rather than merely a result count; `[term]` is sent as literal content search. |
| RDMCP-NR-004 / NR-007 | Portable actual-Node scripts replace Windows `for /L` and `ping` commands. A process with 1,005 lines returns its final line without printing it during the test. A natural exit is audited without a prior status/output poll. The live ready-signalling bounded child is killed only after a running-state check; audit matching requires one JSONL row with both its process id and `process.exit`. Pinned Desktop Commander may report an observed `null` exit code, which is asserted as null rather than invented as a numeric status. |
| RDMCP-NR-005 | Real HTTP registration, valid 64-character S256 PKCE, redirect binding, one-use code, bad PKCE/scope/redirect/replay, tampered/audience/scope/issuer tokens, and authenticated streamable-HTTP file read/patch/search are covered. |
| RDMCP-NR-008 | Startup deletes only a manifest-owned, inode-matched upload orphan. A user file with the lookalike `.__rdmcp_*.upload` name remains intact. |
| RDMCP-NR-009 | An allowed root configured through a directory symlink or Windows junction must support ordinary delegated `file_read` and `file_search`. The test skips only when the host denies directory-link creation. On tool failure it reports only the current config device/inode, protected identity key count and device/inode keys, and the last eight sanitized audit event/tool/reason/category labels. A Desktop Commander rejection also includes its independently re-redacted, 240-character-max detail. It never prints config data, file data, passwords, or tokens. |

## Commands and results

Initial focused Node 22 run reproduced the review's cancellation: `Promise resolution is still pending but the event loop has already resolved`. The cause was fixture teardown clearing its last referenced timer before `service.close()` waited on the SDK's close lifecycle. The fixture now clears that timer only after close; this is not a skipped or masked cancellation.

Initial focused runs exposed the intended finite findings: search stopped at the first 100-result page, expired sessions remained listable, and broad startup-name cleanup could remove a legitimate lookalike. The portable process fixture also exposed Windows command quoting before it was replaced with Node scripts. These cases now pass without loosening assertions. TypeScript check passed.

Prior local frozen-suite command:

`npx.cmd --yes --package=node@22.23.3 node node_modules/tsx/dist/cli.mjs --test test/**/*.test.ts`

It was awaited through its shell session to completion and exited 0: 12 tests passed; 0 failed, cancelled, skipped, or todo; duration 51.944 seconds. The command covered the then-current MVP checks and fixtures.

Windows is `local_execution_available`. Read-only discovery found `wsl.exe` but no installed Linux distribution, and Docker is unavailable, so Ubuntu is `remote_ci_only`: the portable NR-007 fixture needs targeted Ubuntu CI after publication. This report makes no local Linux-pass claim.

## CI follow-up: DR-003 and NR-009

Matching CI on `e66229e` reopened DR-003 after an Ubuntu job allowed a second config-alias read, and introduced NR-009 after the Windows job rejected ordinary allowed-root `file_search` and returned an MCP tool error for authenticated `file_read`. These remain open until a matching green Windows and Ubuntu Node 22 run is available.

The fixture roots have moved from operating-system temporary storage to unique, validated directories under the ignored workspace `reference/validation` directory. Cleanup removes only the exact generated directory after service shutdown; it does not clean historic OS temporary paths. The DR-003 replacement test and the allowed-root symlink/junction test are local focused checks while source work is in progress, not CI closure evidence.

After the source freeze, the required local command was awaited to completion again:

`npx.cmd --yes --package=node@22.23.3 node node_modules/tsx/dist/cli.mjs --test test/**/*.test.ts`

It exited 0 with 13 passed, 0 failed, cancelled, skipped, or todo in 57.574 seconds. This includes the deterministic DR-003 replacement check and the Windows-junction/symlink NR-009 check. It is local Windows evidence only; matching green Ubuntu and Windows CI remains the acceptance requirement for the reopened findings.

After private config pins, persisted history validation, and sanitized rejection categories were added, the same command was awaited again. It exited 0 with 13 passed, 0 failed, cancelled, skipped, or todo in 62.771 seconds. This is still local Windows evidence only; DR-003 and NR-009 remain open until the matching CI evidence is green.

Matching CI on `e5823a2` passed all 13 Windows tests and passed the Ubuntu DR-003 aliases plus ordinary HTTP file read/patch, but failed all three live `start_search` paths: the aliased-root search, 115-result file search, and authenticated content search. The fixtures remain strict. Their failure-only diagnostics now preserve a bounded safe Desktop Commander detail so the next Ubuntu run can distinguish the rejection category without exposing data.

The first local full-suite execution against the later four-attempt pin protocol exposed the intended retained-alias race: 12 passed and DR-003 failed because the historical alias read succeeded. Its failure-only trace contained the current config device/inode, two protected identity keys, and audit labels, with no config contents. Desktop Commander queues atomic usage-tracker config writes after tool calls, so the regular fixture now proves A was successfully pinned before replacing it. The separate seam begins from that known pinned A and races only the later B-to-C link. The strengthened focused DR-003 suite passed 2/2 in 14.111 seconds; this is local evidence only.

The first awaited 14-test full run with that seam initially failed an alias created from a later, unobserved Desktop Commander usage-tracker config version. The seam now retains the exact inode linked to the private pin instead of assuming a later on-disk version is observed. After the source's pre-creation `allowMissing` correction, focused DR-003 passed 2/2 in 13.955 seconds and the awaited full Node 22.23.3 command passed 14/14, with 0 failed, cancelled, skipped, or todo, in 69.338 seconds. This is local Windows evidence only; DR-003 and NR-009 remain open pending matching green CI.

## Limitations

The unsupported no-replace path is tested through the injected narrow `linkNoReplace` capability seam because this Windows volume supports hard links. The test verifies the observable contract—upload begin refuses the destination and removes the probe—without claiming that the host filesystem lacks hard-link support.
