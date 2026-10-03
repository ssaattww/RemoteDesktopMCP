# Sub-agent実行レポート

## タスク

- 目的: R24-02の変更後Windows測定と、PR #62のNode 22 Ubuntu/Windows必須CIを現headに結び付け、前回16ファイル測定と比較する。
- タスク種別: verification / CI and measurement evidence
- branch: `issue-24-runtime-reduction-followup`
- current implementation candidate: `f661db1c4136ef86ab4a64662144b006801f2949`
- PR: [#62](https://github.com/ssaattww/RemoteDesktopMCP/pull/62), base `issue-24-ci-phase1`, draft/open
- Issue update: [Issue #24 measurement comparison](https://github.com/ssaattww/RemoteDesktopMCP/issues/24#issuecomment-5971795281)

## sub-agentを使う理由

- 理由: GitHub CI/artifactを読み取り専用に確認する境界付き検証作業。書込みはIssue #24への結果コメントに限られ、測定run自体は既に存在していた。

## 対象範囲

- exact-head PR CI run `37138712212` のUbuntuとWindows 3 shard。
- PR #62 measurement run `37138740545`、48記録、candidate manifest、16ファイルの3-run median、source/environment/fingerprint identity。
- 前回の同一16ファイル測定run `37131069186` との比較と制約。

## 対象外

- 新しいCI/measurement run、manifest適用、test/code編集、PR merge。
- 約3分目標の達成宣言。今回の2ケース改善だけの因果的な短縮認定。
- `regressions.test.ts` の大規模分割実装。分割案はbranch外 `/tmp/issue24-regressions-split-design.md` に保持。

## 実行コマンドと証拠

- GitHub read: `gh run view`, `gh pr view`, `gh api` のみでrun、job、PR、source commitのidentityを確認。
- Artifact list/download: workflow artifact `11280895030` をGitHub connectorから取得し、downloaded file `/workspace/attachments/0c07f2dd-441d-42b8-9e27-7da063666f3f/issue24-r24-02-measurement.zip` を展開して検査。
- ZIP SHA-256: `5d5a04e92c83be9117ff3472688231909abe5ffb03239cc3a983fc273b4277da`。
- Validation: 48 record files、全件 `success` / `exitCode: 0`、16 unique files、各3回。全記録が同じ run `37138740545`、job `111248575921`、sourceCommit `0a0fac86d2a9c7b701c4c9cc39fb5d46829ac5f7`、environmentを保持。
- `buildManifestCandidate` で全記録からcandidateを再構築し、downloaded candidateと一致することを確認。
- Source: measurement sourceCommit `0a0fac86d2a9c7b701c4c9cc39fb5d46829ac5f7` は `f661db1…` をbase/head SHA `adb4e03…` に重ねたGitHub merge commit。PR #62 head SHAは `f661db1c4136ef86ab4a64662144b006801f2949`。
- Fingerprint: `1ad64c541c44ebb8be62362388b91447a4b0ed7a5a11190b599c99305bd70e63`。Windows checkoutのCRLF byte形態に正規化した全35 fingerprint inputから再計算して一致。候補ファイル集合は同じ16 tracked test files。
- Environment: `windows-latest`, Windows `10.0.26100`, `win32 x64`, Node `v22.23.3`, npm `10.9.9`, `package-lock.json` raw Windows working-tree SHA-256 `f153a51e7f8b4592fcea9b9c6ecfaa4fd3fc9912bcf7d410a54c7fb39829067d`。前回測定と一致。Linux checkoutのLF file hashとは異なるため、Windows CRLF bytesを使ってfingerprintを照合した。
- No manifest file was updated or applied.

## exact-head PR CI

- Run [37138712212](https://github.com/ssaattww/RemoteDesktopMCP/actions/runs/37138712212) — conclusion `success`, `head_sha` `f661db1c4136ef86ab4a64662144b006801f2949`.
- Ubuntu job `111248492256`: lint, type check, build, all tests, diagnostics upload success; duration 1m14s.
- Windows assignment job `111248492378`: success.
- Windows shard 1/3 job `111248550727`: success; duration 2m43s.
- Windows shard 2/3 job `111248550695`: success; duration 5m25s.
- Windows shard 3/3 job `111248550735`: success; completed `2026-10-03T17:07:47Z`.

## 計測

- Run [37138740545](https://github.com/ssaattww/RemoteDesktopMCP/actions/runs/37138740545), attempt 1; started `2026-10-03T16:57:18Z`, completed `2026-10-03T17:38:13Z`, duration 40m55s.
- Measurement job `111248575921`; artifact [11280895030](https://github.com/ssaattww/RemoteDesktopMCP/actions/runs/37138740545/artifacts/11280895030).
- Comparison baseline: [run 37131069186](https://github.com/ssaattww/RemoteDesktopMCP/actions/runs/37131069186), same 16 test files, three successful runs per file, same Windows/Node/npm/package-lock environment. Baseline sourceCommit `76a12d0bab68d7a3664cb120abf3868450549550` differs because it is PR #42's merge source; current source contains the R24-02 test callsite change.

| Test file | Previous median (s) | Current median (s) | Delta (s) |
| --- | ---: | ---: | ---: |
| `regressions` | 400.579 | 334.475 | -66.104 |
| `independent-fixes` | 155.495 | 134.507 | -20.988 |
| `public-auth` | 88.908 | 79.890 | -9.018 |
| `user-console` | 85.033 | 75.255 | -9.778 |
| `emergency-stop` | 60.808 | 51.836 | -8.972 |
| `admin` | 59.620 | 49.294 | -10.326 |
| `mvp` | 26.589 | 22.632 | -3.957 |
| `private-storage` | 21.931 | 17.906 | -4.025 |
| `emergency-stop-windows` | 20.872 | 18.460 | -2.412 |
| `emergency-stop-backend` | 9.956 | 8.591 | -1.365 |
| `windows-job` | 3.722 | 3.181 | -0.541 |
| `fixture-runtime` | 1.286 | 1.024 | -0.262 |
| `user-console-client` | 0.694 | 0.572 | -0.122 |
| `ci-test-scheduler` | 0.484 | 0.386 | -0.098 |
| `desktop-commander-ownership` | 0.481 | 0.429 | -0.052 |
| `session-time` | 0.216 | 0.170 | -0.046 |

- `regressions.test.ts` individual current durations were `334.475`, `353.516`, and `324.251` seconds; median `334.475` seconds.
- Individual-file medians must not be summed as parallel wall-clock time.

## 結果と制約

- Measurement records and candidate manifest are internally consistent and exact-head-bound; this is a successful data collection.
- Required PR CI overlapped the measurement run from `16:57:18Z` until `17:07:47Z`. The first `regressions.test.ts` sample ran `17:04:44Z`–`17:10:19Z` and overlapped the final Windows CI shard for part of its duration.
- The design says to avoid measurements concurrent with required checks because of queue/runtime interference. Also, unchanged files measured about 10–21% faster than the previous run. Therefore the median differences are exploratory only; they do not establish that the R24-02 callsite change caused the observed reduction or satisfy a clean performance acceptance comparison.
- The user explicitly declined another ~49-minute measurement at this point; no rerun was started. No manifest was applied and no Issue #24 completion was declared.
- Prior normal review remains historically `pass_with_held` with no required code finding. Windows CI/measurement collection has since completed; the measurement comparability caveat remains visible.
- TDD evidence for the implementation remains the pre-change and post-change complete 32-test Linux runs in the two existing reports. No tests were removed or skipped manually.
- Skill-gap/feedback decision: no CodexSkill update or new feedback issue for this task. The one overlap is recorded here and in the Issue comment; the repository design already states not to run measurement alongside required CI. It is not a repeated process pattern. The semantic regression split remains a separate future task and is not part of PR #62.
- PR #62 remains draft/open and unmerged. This report does not reserve or materialize the independent-final report path.
