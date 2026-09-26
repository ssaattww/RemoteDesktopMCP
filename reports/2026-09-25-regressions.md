# レビュー指摘の回帰試験

## Dispatch

Requested: gpt-5.6-terra / high, explicit user implementation override. Fresh bounded technical test implementation, high criticality, cross-module composition, independent write scope test/**. No role override; planned requested profile, applied null, final profile hidden. Parent owns integration; source implementation owner edits src/** concurrently.

## Fixtures and findings matrix

`test/fixture.ts` creates a uniquely named, bounded temporary root and DATA_DIR for every composition fixture. It closes the MCP client, service, and Desktop Commander process before removing that exact directory. A referenced fixture timer remains alive until `service.close()` resolves; Node 22 otherwise treats the SDK close promise as pending after its unreferenced fallback timer is the only remaining handle. Its shared protected-config helper serializes `rememberProtectedConfigIdentity()` before selecting a private pin, verifies that pin is present in the protected map with bigint device/inode identity, and verifies any created alias has that exact identity. This avoids assuming startup retains a sole-link pin after Commander legitimately rewrites and final-prunes config history.

| Finding | Regression coverage |
| --- | --- |
| RDMCP-DR-001 | Multi-chunk snapshot is read after same-size/same-mtime replacement; aggregate digest equals begin digest. Snapshot deletion fails terminally and leaves no snapshot artifact. |
| RDMCP-DR-002 | A racing destination survives no-replace commit and losing temp is removed. An injected `ENOTSUP` no-replace primitive makes upload begin fail before map state or probe artifacts exist. |
| RDMCP-DR-003 | A and B aliases derive from actual retained private pins and assert their exact device/inode mappings before rejection. After an atomic non-secret A-to-B `config.json` replacement, both aliases remain rejected. The replacement uses a bounded Windows-only sharing-violation retry (six attempts for `EPERM`, `EACCES`, or `EBUSY`) without weakening either alias assertion. The service is restarted to prove persisted protected identities still reject both aliases. A deterministic `linkProtectedConfig` seam replaces B with C between pin operations, retains an alias to the exact C inode linked to the private pin, and requires known A and that captured C alias to reject. Adjacent identities above `2^53` remain distinct through bigint-derived keys; a real pinned alias remains denied while an ordinary file remains readable. Exact decimal identities persist in new manifests, safe legacy numeric entries are characterized as migratable, and unsafe legacy numeric manifests fail closed without deleting their manifest or pin. After 128 bounded create/delete churn operations, ordinary files remain readable. Content search and a swapped upload-temp pathname cannot reach protected config identities; the swapped-temp assertion hashes a retained hard link to the exact target inode before and after rejection, so later Commander config rewrites cannot mask or manufacture a write. Traversal and resolved DATA_DIR overlap are rejected. |
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

## Independent-fix regression matrix

| Finding | Regression coverage |
| --- | --- |
| RDMCP-MVP-IFR-001 / High | A narrow process-only Desktop Commander adapter returns the same PID for successive logical processes. Both process-lock orderings prove stale logical IDs reject before output, status, or termination delegation can reach their successor. |
| RDMCP-MVP-IFR-002 / High | A live service observes 70 atomically replaced config versions through its serialized protected-identity capture. A known alias derives from a verified retained private pin; it remains denied while an ordinary file works before and after churn and after restart. A second real-link fixture replaces config after each of the first five successful pin links and then stabilizes: initialization succeeds and retained A/B aliases remain denied. Replacing config after every real link exhausts the bounded retry budget, fails initialization without a ready Commander generation or ready audit, and does not provide a ready service. |
| RDMCP-MVP-IFR-003 / Medium | Ten uploads and ten downloads fill the one shared active-transfer cap. An overflow upload leaves no transfer, temp file, or owned-upload manifest record. |
| RDMCP-MVP-IFR-004 / Medium | A process-only adapter injects a terminate timeout, then provides a later completed output. The watcher reaches actual finished state and writes exactly one exit audit event without a post-timeout status/output poll; a later status query returns the observed exit code. |
| RDMCP-MVP-IFR-005 / Medium | Process-start audit binds the logical id, caller session and PID to a redacted command representation. It rejects configured token/hash literals plus labeled password, token and Bearer values while retaining the ordinary command label. |
| RDMCP-MVP-IFR-006 / Medium | Real MCP multi-chunk uploads cover `overwrite:false` to a new destination and `overwrite:true` to an existing destination, with exact bytes/hash, terminal status, temp removal and owned-manifest cleanup. |
| RDMCP-MVP-IFR-007 / Low | Documentation/version handling is owned by the Luna documentation pass; no product fixture is needed. |

The initial focused independent Node 22.23.3 run passed IFR002–IFR006 6/6 in 38.039 seconds. The strengthened IFR005 configured-literal and labeled/Bearer redaction check passed 1/1 in 7.161 seconds. On the frozen source, the strengthened independent suite passed 6/6 in 37.939 seconds. The late-completion tail fixture then added a seventh independent case: with `sessions()` inactive, 100 pages advertise a remaining tail without a completion marker, and only page 101 completes; ownership and the exit audit remain absent until that final page drains.

## Bigint identity follow-up

The initial full run after exact identity migration passed 22/23 and exposed one fixture contract update: NR-008 wrote an owned-upload manifest with lossy numeric `stat` fields. The fixture now writes decimal fields from `stat(..., { bigint: true })`; its focused rerun passed 1/1 in 7.138 seconds. This preserves the owned-orphan assertion while exercising the production exact-identity format.

Final frozen local command:

`npx.cmd --yes --package=node@22.23.3 node node_modules/tsx/dist/cli.mjs --test test/**/*.test.ts`

It was awaited through its shell session to completion and exited 0: 23 passed; 0 failed, cancelled, skipped, or todo; duration 73.234 seconds. This is local Windows evidence only. Matching remote CI evidence remains required for any CI-scoped review closure.

## Retry and immutable-target follow-up

Ubuntu CI run `36045163545` had 21/23 passing tests. IFR-002 failed because four immediate config-pin attempts could be exhausted by Commander’s asynchronous config replacement. DR-003’s swapped-temp digest compared the mutable `config.json` pathname, so later Commander updates could change the comparison file. These were fixture and behavior findings; neither assertion was relaxed.

The retry fixture uses the production `linkProtectedConfig` path and real hard links: it replaces configuration after five successful links and proves later stabilization initializes with known aliases protected; a separate every-link replacement run fails closed within the bounded retry window before a service can become ready. The swapped-temp test now retains a hard link to the exact protected target inode and hashes that stable alias before and after the rejected chunk write. All private-pin identity comparisons in the aliases use bigint `stat` values.

Final frozen local command:

`npx.cmd --yes --package=node@22.23.3 node node_modules/tsx/dist/cli.mjs --test test/**/*.test.ts`

It was awaited through its shell session to completion and exited 0: 24 passed; 0 failed, cancelled, skipped, or todo; duration 75.635 seconds. This is local Windows evidence only; remote CI is still the required evidence for CI-scoped closure.

## Captured-pin fixture lifecycle correction

CI run `36046213583` passed all 24 Ubuntu tests. The matching Windows job passed 23/24 and failed only the bigint identity fixture because it selected `readdir(protected-config-pins)[0]` after initialization. On that host, Commander had rewritten config and the final prune correctly removed all sole-link pins. This was a fixture lifecycle assumption, not a product regression.

Every fixture that needs a private config pin now calls the shared serialized capture helper before selecting or linking a pin. The helper requires a map-backed pin to exist and checks bigint identity equality for every alias; no rejection assertion was skipped or relaxed.

Final frozen local command:

`npx.cmd --yes --package=node@22.23.3 node node_modules/tsx/dist/cli.mjs --test test/**/*.test.ts`

It was awaited through its shell session to completion and exited 0: 24 passed; 0 failed, cancelled, skipped, or todo; duration 79.391 seconds. This is local Windows evidence; CI closure still depends on the matching remote evidence.
