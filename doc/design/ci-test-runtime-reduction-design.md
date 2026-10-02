# CI Test Runtime Reduction Design

Status: D3/D3.1 design approved by independent review. Implementation and measurement are not completed.

Findings resolved: F24-D1-001/002 High, F24-D1-003/004/005 Medium. Additional clarifications: F24-D1-001-b Medium, F24-D1-002-a Medium, F24-D1-004-a Low.

## Scheduler modes

optimized mode uses deterministic LPT file assignment. Files are ordered by duration descending and path ascending for ties. Assignment chooses the minimum accumulated cost shard and shard number for equal cost.

baseline mode uses normalized tracked test paths sorted ascending and assigns index mod 3. Baseline is a safe fallback and is not claimed to match historical CI distribution.

Both modes validate union=U, pairwise disjointness, and exactly-once assignment before execution. Both pass assigned files only as argv arguments to node --import tsx --test. --test-shard is not used.

An empty U is a failure. An empty shard is accepted only after aggregate coverage validation and does not start automatic test discovery.

## Manifest and measurement

Malformed schema, duplicate entries, invalid paths, non-finite duration, and duration <= 0 are hard failures.

Missing manifest, file set mismatch, hash/environment mismatch, or 30-day stale optimization data makes optimization unavailable and selects baseline without skipping tests.

sourceCommit is provenance. Applicability uses fingerprints from tests, fixture, product source, lockfile, runner measurement settings, OS, Node, and existing dependencies. Manifest files and docs-only changes are excluded to avoid self-reference.

Dedicated approved measurement job measures one file at a time under fixed commit/environment. Each file requires three successful runs and median process wall time becomes candidate cost. Failed, timeout, or cancelled measurements never replace the manifest.

## Performance

Queue, startup, checkout, install, fixture, test execution, critical path, cleanup and upload are measured separately. The three-minute CI target is a goal only and is not a correctness gate. File cost is an estimate and does not guarantee critical path.

## Fixture isolation

Only immutable preparation may be shared. Service, filesystem, session, user, audit, transfer, process, timer and cleanup state remain isolated. Isolation behavior is verified before performance evaluation.

## Phase2

Local separation is not included. OS boundary tests remain in CI.
