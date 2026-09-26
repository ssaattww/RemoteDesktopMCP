# Audit rejection logging implementation report

## Metadata

- Repository: `ssaattww/RemoteDesktopMCP`
- Branch: `fix/audit-rejection-context`
- Base: `865f6cd65763f36e0b48f39e1f3d402e696c8308` (`origin/main`)
- Technical implementation HEAD: `ef39dfbd67eb2e99a812a363b19cc2857e265c38`
- Execution environment: connected Windows PC `FA780` through RemoteDesktopMCP
- Report persistence: repository file; report commit is administrative and is not part of the technical implementation HEAD above.

## Purpose and scope

The live audit log contained repeated `operation.rejected` records with only `user` and `reason`, which was insufficient to identify the failed MCP tool or the underlying error class. This change adds diagnostic context to that existing audit event without changing the public MCP error response.

Scope:

- identify the rejected MCP tool;
- record the existing reason plus error name/code;
- record a bounded, sanitized error detail;
- add regression coverage.

Non-goals:

- no live service restart or deployment;
- no auth, transfer, process lifecycle, workflow, task-tracking, or API behavior change;
- no change to the existing `desktop_commander.rejected` event semantics.

## Implementation

`src/index.ts` now passes each registered MCP tool name into the common tool wrapper. On rejection, `operation.rejected` records:

- `tool`
- `reason`
- `errorName`
- `errorCode` when available
- `detail`

`detail` is limited to 240 characters and sanitizes filesystem paths, Bearer values, credential-like key/value arguments, long opaque identifiers, and control whitespace before writing the private audit log.

`test/independent-fixes.test.ts` adds a regression case using a failing `ProcessAdapter`. It verifies the tool name, reason, error name/code, sanitized detail, and absence of the raw private path and secret.

## Validation

The CI workflow was inspected before implementation. `.github/workflows/lint.yml` already stores command results, stdout, stderr, test results, and environment diagnostics as artifacts on both Ubuntu and Windows, so no workflow change was required.

TDD evidence:

- RED: focused test failed because `operation.rejected.tool` was absent (`actual: undefined`, expected `process_start`).
- GREEN: integrated focused regression passed.

Final local checks on the technical candidate:

- `git diff --check`: passed.
- `npm run lint`: passed.
- `npm run check`: passed.
- `npm run build`: passed.
- focused rejection-audit regression: passed.

Full `npm test` did not complete cleanly under the parallel local runner. Two pre-existing timing-sensitive tests failed:

- `REMOTE-NR-002: startup, CLI, and state loading reject broad existing secret files`
- `NR003 and NR004: searches return every page and portable Node processes retain output/audit`

Both failing cases passed when rerun individually against the same candidate. No code in their production paths was changed by this task. The parallel-suite instability remains an unresolved verification item and is not reported as a passing full-suite result.

Local diagnostic files are under `reference/validation/audit-logging/` and are intentionally not committed.

## Intentionally untouched

- `.github/workflows/*`
- `tasks/tasks-status.md`
- live `C:\Users\donabe\RemoteDesktopMCP-data\audit.jsonl`
- running RemoteDesktopMCP service/processes

## Remaining risk and next action

The audit detail sanitizer is intentionally conservative and bounded; it may remove useful path/token content by design. Exact-head pull-request CI must be checked after the final report commit is pushed. A CI run for another SHA must not be used as evidence.

The worker must not merge the PR.
