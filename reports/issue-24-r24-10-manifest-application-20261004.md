# R24-10 manifest適用と基準再実行の確認

## 対象

- repository: `ssaattww/RemoteDesktopMCP`
- PR: #73（draft/open/unmerged、mergeなし）
- branch: `issue-24-r24-10-profile-user-console`
- base: `f20c75e1ecd409f0e8573720c0f74b39d8178f93`
- manifest登録前のHEAD: `f01940217de6e1dc60833de7617298b1187d62ca`
- mode: implementation / manifest application
- commit state: pending
- push state: pending
- applied-version CI: pending

## 承認範囲

ユーザーはPR #73のWindows test-duration manifest適用、PR branchへのcommit/push、同じapplied HEADにおけるrequired CI 3回を承認した。今回の範囲は計測run `37206964800` が生成した検証済み時間表の登録、設計とtrackingの同期、関連するローカル検証、manifest適用後required CIの初回run確認まで。merge、PRコメント、依存版・lockfileの変更は行わない。

## 基準runと順序逸脱

同一HEAD `f01940217de6e1dc60833de7617298b1187d62ca` のrequired run `37206614291` はattempt 1/2/3の全10 jobがsuccessで、3回とも30 test filesをWindows 8 shardに全件・無重複で割り当てた。割当artifact `11305265805`、`11311521283`、`11312010635` のdigestを確認し、公式planDigestを再計算して一致を確認した。

主指標はattempt別APIの `created_at` から同attemptの全jobsの最大 `completed_at` まで、副指標はattempt別 `run_started_at` から同じ完了時刻まで。workflow run全体の初回 `created_at` を後続attemptに再利用しない。

| Attempt | created_at | run_started_at | 最終job完了 | 主指標 | 副指標 | 最大Windows Test |
| ---: | --- | --- | --- | ---: | ---: | ---: |
| 1 | 13:43:09Z | 13:43:09Z | 13:48:11Z | 302秒 | 302秒 | 219秒 |
| 2 | 18:22:29Z | 18:22:28Z | 18:27:51Z | 322秒 | 323秒 | 232秒 |
| 3 | 18:32:34Z | 18:32:33Z | 18:37:59Z | 325秒 | 326秒 | 228秒 |

候補required CIを3回成功させる前にmeasurement run `37206964800` が開始された順序逸脱は残る。measurement完了後に同一baseline HEADでattempt 2/3を実行し、結果としてbaselineの3回成功を満たした。成功回数は揃ったが、時系列上の逸脱を遡って解消したものではない。ユーザーはこの事実を保持したうえで、計測時間表の適用へ進むことを承認した。

## 計測artifactとmanifest候補

- Measurement run: `37206964800`, attempt 1, success.
- Artifact: `11306340866`; ZIP SHA-256: `7e1ac1f5f3de9fa0ac324f6eb2e5fea9c6bf3991c5e2927619a60dafde63c1c2`.
- 90/90 records succeeded, exit code 0; 30 tracked test files × 3 records; consistent run/job/head/environment identity.
- Environment: Windows Server 2025, 10.0.26100, x64, Node `v22.23.3`, npm `10.9.9`; package-lock SHA-256 `f153a51e7f8b4592fcea9b9c6ecfaa4fd3fc9912bcf7d410a54c7fb39829067d`.
- Candidate fingerprint: `fafc5c8bd7075164a5f9693edf7505b03706cb6e896d4cbf4652a9f26e095d4b`, independently recomputed from the Windows CRLF representation and matched the same-head baseline assignment artifact.
- Candidate rebuilt from all records matched the supplied candidate JSON.
- File medians for the four moved semantic groups: 57.3, 11.8, 19.3, and 50.6 seconds. These are serial per-file measurements, not a workflow duration or causal improvement claim.
- The preexisting manifest described a different tracked file set. It is replaced with the 30-file candidate from the verified measurement artifact.

## Changed files

- `.github/test-duration-manifest.json`: replace the stale 24-file timing table with the measured 30-file candidate.
- `doc/design/ci-test-runtime-reduction-design.md`: retain the required three-run sequence, record the actual ordering deviation and baseline attempt-specific timing evidence, and keep the 180-second completion condition unchanged.
- `tasks/tasks-status.md` and `tasks/phases-status.md`: record the three baseline successes, measurement ordering deviation, verified artifacts, and remaining applied-CI gate.
- This report: record the change and evidence for normal review.

## Local validation

Execution environment: Linux runtime, `/tmp/issue24-r24-10-profile-user-console`, Node `v24.19.0`, npm `11.9.0`. No dependency installation or lockfile change was made. A temporary `node_modules` symlink referenced an existing checkout with the identical package-lock SHA and was removed after commands completed.

- `npm run check`: exit 0.
- `npm run build`: exit 0.
- `npm run lint`: exit 0; includes TypeScript lint, Markdown lint (146 files / 0 issues), and design whitelist lint.
- `node --import tsx --test test/ci-test-scheduler.test.ts`: 19 passed, 0 failed.
- Manifest JSON/coverage check: 30 paths, sorted and exactly equal to tracked test files; all medians positive.
- `git diff --check`: exit 0.

An initial design-whitelist run flagged several unquoted English identifiers in the newly added paragraph. The wording was adjusted to Japanese/inline identifiers and the final design whitelist and full lint runs passed.

## Remaining gates

- Commit and push the reviewed change to PR #73.
- Verify the first automatic applied-version required CI run against the resulting exact HEAD, including `mode=optimized`, `manifestStatus=applied`, fingerprint, complete 30-file assignment, and all required jobs.
- Keep that exact HEAD fixed for the other two successful required CI attempts. Do not create a report-only commit or alter the measured HEAD between attempts.
- The three-minute goal is not demonstrated by the baseline or per-file measurement. Issue #24 remains open until three applied-version primary metrics are each at most 180 seconds.
