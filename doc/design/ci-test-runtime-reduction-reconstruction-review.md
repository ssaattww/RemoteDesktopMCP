# CI test runtime reduction reconstruction review

## Verdict

held: changes required before implementation.

## Findings

### CI-REBUILD-001

- Severity: Medium
- Location: scheduler and manifest contract
- Evidence: design defines union/disjoint/exactly-once and path rules, but does not define the concrete scheduler output schema consumed by dispatch. Existing workflow currently discovers tests inline.
- Impact: implementation boundary between assignment and CI execution remains ambiguous.
- Required fix: define scheduler artifact schema, dispatch mapping, path normalization and validation point.

### CI-REBUILD-002

- Severity: Medium
- Location: measurement completion criteria
- Evidence: all test files x3 success is required, but run status/environment drift recording is not defined.
- Impact: runtime comparison evidence may not be reproducible.
- Required fix: define measurement record status and artifact format.

### CI-REBUILD-003

- Severity: Low
- Location: fixture isolation plan
- Evidence: fixture boundary checks are named without concrete audit targets.
- Impact: shared-state regression risk remains.
- Required fix: list fixture audit scope.

## Coverage

- Read: target design, lint workflow, package.json.
- Not executed: test, CI, lint, dependency change, workflow change.

## Fix verification

Verified against current design revision after CI-REBUILD-001/002/003 fix update.

### CI-REBUILD-001 — Original finding

- Severity: Medium
- Status: fixed
- Evidence: \`doc/design/ci-test-runtime-reduction-design.md\` defines scheduler output artifact schema with \`version\`, \`sourceCommit\`, \`shardCount\`, \`generatedAt\`, and \`assignments\`. \`assignments\` defines \`shardId\`, \`files\`, and \`estimatedDurationMs\`. Dispatch input is constrained to artifact \`files\` only. Path normalization, allowed directory/extension validation, duplicate validation, and union=U validation are defined at artifact generation and dispatch input boundaries.

### CI-REBUILD-002 — Original finding

- Severity: Medium
- Status: fixed
- Evidence: \`doc/design/ci-test-runtime-reduction-design.md\` defines one measurement record per execution with status, timestamps, monotonic duration, commit, workflow run/job id, runner OS, Node, dependency version, scheduler artifact version, and exit code. It defines environment mismatch handling, artifact evidence retention, and excludes failure/timeout/cancel records from manifest update candidates.

### CI-REBUILD-003 — Original finding

- Severity: Low
- Status: fixed
- Evidence: \`doc/design/ci-test-runtime-reduction-design.md\` defines fixture audit scope: fixture generation, temporary file locations, environment variable mutation, process lifecycle, filesystem shared state, and global/module state. Regression cases cover parallel fixture use, cleanup failure, process residue, environment contamination, and generated file conflicts.

## Follow-up contract decisions

Correction to the CI-REBUILD-001 evidence: the scheduler artifact's literal schema field is `schemaVersion`; the earlier evidence used `version` as shorthand and did not quote the actual key.

The implementation contract now names the measured environment values explicitly. `nodeVersion` is the exact Node version, `npmVersion` is the exact npm version, and `packageLockSha256` is the SHA-256 of the raw bytes of the tracked `package-lock.json`. `schedulerArtifactVersion` is a positive integer beginning at 1 and references the scheduler artifact's `schemaVersion`; measurement records retain their own `schemaVersion`.

One Windows preparation job creates the assignment artifact once. All Windows shards download and validate that same artifact; a shard does not calculate a replacement plan. With an optimized assignment, a shard whose current fingerprint differs fails before running tests. Missing, stale, or fingerprint-mismatched manifests select baseline only during preparation. These decisions are contract clarifications, not independent runtime or CI verification.

## Verification coverage

- Read: current design path and previous review report.
- Confirmed: findings are addressed with implementation contracts, not keyword-only additions.
- Not executed: test, CI, lint, dependency change, workflow change, implementation.
- Unexplored: actual runtime behavior and CI measurement remain implementation phase scope.

## Verdict: Design readiness

no findings for design readiness. Implementation, CI execution, and performance achievement are not verified by this review.
