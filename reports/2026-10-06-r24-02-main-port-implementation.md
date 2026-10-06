# Issue #24 R24-02 current-main implementation

## Target identity

- Repository: `ssaattww/RemoteDesktopMCP`
- Branch: `issue-24-r24-02-post-split-main`
- Base: `origin/main` at `5dac2528e80cba3e3ff5c855f14420075b2da717`
- Implementation commit: `f3513b2ba128f3ee258ea4e4bcf51aa3d9c9a2c3`
- PR: not created yet; local authorized preparation only.

## Scope

After test cases moved out of `test/regressions.test.ts`, reapply the same two fixture-startup reductions to the current semantic-group files:

- DR002 unsupported atomic no-replace case in `test/config-transfer-integrity.test.ts`.
- NR009 canonical allowed-root symlink/junction case in `test/session-filesystem-lifecycle.test.ts`.

For both, pass `{ initializeService: false }` to the existing fixture and remove only the immediately following close of the uninitialized default service. Keep the test-specific service initialization, assertions, symlink/junction skip behavior, isolation, and cleanup. No product behavior, fixture defaults, dependencies, workflow, manifest, or unrelated test content changes.

## Design and prior evidence

The fixture preparation section of `doc/design/ci-test-runtime-reduction-design.md` permits skipping the first initialization when a test replaces that service with one using a different explicit configuration, while preserving fixture defaults, per-test storage isolation, protected data storage, and cleanup. The same behavior was previously implemented and reviewed on the pre-split layout; this port applies it to the current semantic-group files. That prior review does not substitute for review of this current-main candidate.

## Implementation

- Change is limited to two test call sites: `fixture({ initializeService: false })`, with one redundant `f.service.close()` removed from each case.
- Existing test bodies and assertions are unchanged.
- The test fixture implementation and defaults are unchanged.

## Validation and review

- Current-main focused validation: 10/10 pass, 0 fail, 0 skip on `7c4b8570215144c97bbd507c3a476443f605c189`; see `reports/2026-10-06-r24-02-main-port-targeted-validation.md`.
- Full local equivalence gate: pending.
- Normal review on current-main candidate: pending.
- Independent final review: pending.
- Exact-head required PR CI: pending after publication.

## Risks and non-goals

- The Linux runtime does not prove Windows junction behavior; Windows CI evidence must remain separate.
- No claim of causal runtime reduction or 3-minute goal attainment is made from this code-only port.
- This work does not close Issue #24. No merge is authorized.
