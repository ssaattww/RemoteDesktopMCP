# Phase 一覧

更新規則: このファイルは `task-breakdown-planner`、`task-consistency-manager`、`progress-sync-manager` を通してのみ更新する。

| Phase | 内容 | 対象 | 完了条件 | 状態 |
| --- | --- | --- | --- | --- |
| P1 | 指摘修正と実装前準備 | T01,T02 | 3設計修正、skills リンク、task 一覧 | 設計レビュー合格・準備完了 |
| P2 | 単一PCの最小動作版 | T03〜T06a | 設定と起動、認証、委譲、転送の回帰・結合試験と依存監査を確認 | 完了 |
| P3 | レビューと提出 | T07,T07a〜T07e,T08,T08a〜T08d | 通常・独立レビュー、ローカル検証、PR 更新 | 通常工程完了。最終独立判定・提出は独立レビュー報告と PR #1 を参照 |
| P4 | 単一 PC の公開接続、後続の複数PC | F01〜F04 | 先に Google 認証・Funnel・ChatGPT から1台への実接続と公開用レビューを確認。複数PCはその後 | 実 Google 本人登録・公開起動・通常レビュー・全体検証済み。ChatGPT実操作未確認。独立指摘3件をF01dで修正・全体検証成功、解消確認待ち |
| P5 | Issue #24 Windows CI実行時間の改善 | R24-01〜R24-05 | 必須テスト集合・各ケースの意味・実Commander/ACL/隔離/cleanupを保ち、設計レビュー、TDD実装、通常レビュー、両OS CI、比較可能な実測で所要時間の変化を確認。約3分目標を実測し未達ならIssueを閉じない | R24-01〜R24-03の測定・レビュー・exact-head CIを記録済み。R24-03候補PR #63はworkflow中央値6分04秒、最大Windows Test step中央値4分32秒で未達。R24-04はPR #64の同一HEAD CI attempt 1/2/3すべて成功、測定run `37165502429` 実行中。PR #64のrun `37162238897` attempt 1はWindows Test 260/218/195秒、workflow約345秒、時間表missingで基準割当。R24-05設計は通常review D1修正確認pass。直接設計reviewの中央値/最大値規則とactive-run待機条件を反映し限定通常review pass。5-shard wire-upはTDD実装（focused Red 14/15、Green 15/15）、通常レビューNR-01を修正してfinding-limited closure pass、全体verdict `pass_with_held`、ローカル未commit。PR #64測定run `37165502429` はなお進行中のためR24-05必須CI・測定は未開始。TDDは実装者レポートに基づき、コードレビューはread-only。設計レポート `reports/issue-24-r24-05-design-review-20261004010000.md`、実装レポート `reports/issue-24-r24-05-five-shard-implementation-20261004030000.md`、通常レビュー `reports/issue-24-r24-05-five-shard-normal-review-20261004040000.md`。PR #63/#64はdraft/open、PR #62変更は別保持。Issue全体は進行中 |

現在の位置: P1〜P3 の最小動作版とP4の公開接続工程を記録済み。P5ではR24-03（29ケース分割・CI/Windows個別測定）を結果記録まで完了。R24-04（independent-fixes 8ケースの意味単位分割）はPR #64でnormal review済み、exact-head CI attempt 1/2/3成功。測定run `37165502429` はGitHub上で実行中。測定中には別製品PR #52/#54の必須CIも別runnerで並行したと利用者報告あり。設計文書の非並行条件はPR範囲を明記していないため、集計時に全体非並行と主張せず比較限界を記録する。R24-05設計の中央値・最大値規則とPR #64測定終了待ちgateは限定通常review pass。5-shard wire-upはTDD（Red 14/15、Green 15/15）後、通常review NR-01をcount-neutral文言へ修正してclosure pass、全体 `pass_with_held`。実装候補はローカルcommit `10862f1185ec22899f3fef623409bb4c9faaf12a`、未push。R24-05 CI・測定・pushはactive run終端まで保留。実装候補はPR #64とは別branch。
最小動作版の独立判定と提出証拠は `reports/2026-09-25-independent-review.md` と PR #1 を参照する。
公開用の通常指摘は `reports/2026-09-25-remote-normal-review.md` で追跡し、ChatGPT の実操作と公開用の独立レビューは未完了。複数PCの F02 は後続であり、単一 PC 接続の完了条件には含めない。
