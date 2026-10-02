# Issue24 CI Phase1 Design

Status: D3/D3.1 design approved by independent review. Implementation and measurement are not completed.

Findings: F24-D1-001/002 High and F24-D1-003/004/005 Medium resolved. F24-D1-001-b, F24-D1-002-a, F24-D1-004-a fixed clarifications.

Modes: optimized uses deterministic LPT file assignment. baseline uses normalized tracked test paths round-robin. Both validate union=U, pairwise disjointness, exactly-once assignment. Both pass selected files by argv and do not use --test-shard.

Performance: three-minute CI is a goal only. Queue, startup, checkout, install, fixture, test execution, critical path, cleanup and upload are measured separately.

Manifest: malformed data, duplicate, invalid path, non-finite or non-positive duration fail. Missing or stale optimization data uses baseline without skipping tests.

Measurement: dedicated approved measurement job only. One file at a time, three successful runs, median cost. Failed measurement never replaces manifest.

Fixture: only immutable preparation can be shared. Service, filesystem, session, user, audit, transfer, process, timer and cleanup remain isolated.

Phase2 local separation is not included. OS boundary tests remain in CI.
