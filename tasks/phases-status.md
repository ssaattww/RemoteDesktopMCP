# Phase 一覧

更新規則: このファイルは `task-breakdown-planner`、`task-consistency-manager`、`progress-sync-manager` を通してのみ更新する。

| Phase | 内容 | 対象 | 完了条件 | 状態 |
| --- | --- | --- | --- | --- |
| P1 | 指摘修正と実装前準備 | T01,T02 | 3設計修正、skills リンク、task 一覧 | 設計レビュー合格・準備完了 |
| P2 | 単一PCの最小動作版 | T03〜T06a | 設定と起動、認証、委譲、転送の回帰・結合試験と依存監査を確認 | 完了 |
| P3 | レビューと提出 | T07,T07a〜T07e,T08,T08a〜T08d | 通常・独立レビュー、ローカル検証、PR 更新 | 通常工程完了。最終独立判定・提出は独立レビュー報告と PR #1 を参照 |
| P4 | 単一 PC の公開接続、後続の複数PC、Issue #55 | F01〜F04,T09 | 先に Google 認証・Funnel・ChatGPT から1台への実接続と公開用レビューを確認。複数PCはその後。T09 は設計レビュー、Red/Green、認可回帰とWindows実画面手順で確認 | 実 Google 本人登録・公開起動・通常レビュー・全体検証済み。ChatGPT実操作未確認。独立指摘3件をF01dで修正・全体検証成功、解消確認待ち。T09 は設計レビューと修正確認済み、FA780実画面・画像証拠待ち |
| P5 | PR #54 / Issue #48, main機能・Issue #56統合 | R54-01〜R54-11,T10,T11 | Issue #48後編集、PR #51自動更新、PR #60 process context、PR #50日時表示とmain `4cd9f8d` のIssue #56 Todoを共存させる。競合解消後に設計整合、全体回帰、通常レビュー、exact-head CIを確認。PR #54はDraft・未mergeを維持 | `c29fe76` からmain `4cd9f8d` を統合中。PR52共有fix `362fc2f` とKERO-48修正を保持。競合解消済み。統合候補の回帰203件中192成功・11 skip・0失敗、check/build/TS lint/Markdown lint/design terms/diff-check成功。通常レビュー・push・exact-head CI待ち |
| P6 | Issue #56 共有作業一覧と更新期限制御 | T11 | セッション単位・初期有効・有効化後5分猶予の設計、TDD、通常レビュー、mainとPR #60統合後の回帰・レビューを完了 | main `4cd9f8d` にIssue #56が統合済み。PR #54へ共存統合後、統合後の回帰合格（203件中192成功・11 skip・0失敗）、通常レビュー・exact-head CI待ち |

現在の位置: PR #54 / Issue #48のmain再統合を進行中。PR #51、PR #60、PR52共有処理、およびmainのIssue #56 Todoを保持する。検証・通常レビュー・CI後に親が最終統合レビューする。Issue #56はDraft PR #61で独立管理。
最小動作版の独立判定と提出証拠は `reports/2026-09-25-independent-review.md` と PR #1 を参照する。
公開用の通常指摘は `reports/2026-09-25-remote-normal-review.md` で追跡し、ChatGPT の実操作と公開用の独立レビューは未完了。複数PCの F02 は後続であり、単一 PC 接続の完了条件には含めない。
