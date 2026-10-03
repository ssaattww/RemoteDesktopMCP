# Phase 一覧

更新規則: このファイルは `task-breakdown-planner`、`task-consistency-manager`、`progress-sync-manager` を通してのみ更新する。

| Phase | 内容 | 対象 | 完了条件 | 状態 |
| --- | --- | --- | --- | --- |
| P1 | 指摘修正と実装前準備 | T01,T02 | 3設計修正、skills リンク、task 一覧 | 設計レビュー合格・準備完了 |
| P2 | 単一PCの最小動作版 | T03〜T06a | 設定と起動、認証、委譲、転送の回帰・結合試験と依存監査を確認 | 完了 |
| P3 | レビューと提出 | T07,T07a〜T07e,T08,T08a〜T08d | 通常・独立レビュー、ローカル検証、PR 更新 | 通常工程完了。最終独立判定・提出は独立レビュー報告と PR #1 を参照 |
| P4 | 単一 PC の公開接続、後続の複数PC | F01〜F04 | 先に Google 認証・Funnel・ChatGPT から1台への実接続と公開用レビューを確認。複数PCはその後 | 実 Google 本人登録・公開起動・通常レビュー・全体検証済み。ChatGPT実操作未確認。独立指摘3件をF01dで修正・全体検証成功、解消確認待ち |
| P5 | Issue #24 Windows CI実行時間の改善 | R24-01〜R24-04 | 必須テスト集合・各ケースの意味・実Commander/ACL/隔離/cleanupを保ち、設計レビュー、TDD実装、通常レビュー、両OS CI、比較可能な実測で所要時間の変化を確認。約3分目標を実測し未達ならIssueを閉じない | R24-01〜R24-03の測定・レビュー・exact-head CIを記録済み。R24-03候補PR #63はworkflow中央値6分04秒、最大Windows Test step中央値4分32秒で未達。次はR24-04の設計/レビューと`independent-fixes.test.ts`分割。PR #63は独立して統合可能だがdraft/openのまま、PR #62の変更は別保持。Issue全体は進行中 |

現在の位置: P1〜P3 の最小動作版とP4の公開接続工程を記録済み。P5ではR24-03（29ケース分割・CI/Windows個別測定）を結果記録まで完了。3分目標が未達のため、R24-04（independent-fixes 8ケースの意味単位分割）を設計・レビュー中。
最小動作版の独立判定と提出証拠は `reports/2026-09-25-independent-review.md` と PR #1 を参照する。
公開用の通常指摘は `reports/2026-09-25-remote-normal-review.md` で追跡し、ChatGPT の実操作と公開用の独立レビューは未完了。複数PCの F02 は後続であり、単一 PC 接続の完了条件には含めない。
