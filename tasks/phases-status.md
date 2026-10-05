# Phase 一覧

更新規則: このファイルは `task-breakdown-planner`、`task-consistency-manager`、`progress-sync-manager` を通してのみ更新する。

| Phase | 内容 | 対象 | 完了条件 | 状態 |
| --- | --- | --- | --- | --- |
| P1 | 指摘修正と実装前準備 | T01,T02 | 3設計修正、skills リンク、task 一覧 | 設計レビュー合格・準備完了 |
| P2 | 単一PCの最小動作版 | T03〜T06a | 設定と起動、認証、委譲、転送の回帰・結合試験と依存監査を確認 | 完了 |
| P3 | レビューと提出 | T07,T07a〜T07e,T08,T08a〜T08d | 通常・独立レビュー、ローカル検証、PR 更新 | 通常工程完了。最終独立判定・提出は独立レビュー報告と PR #1 を参照 |
| P4 | 単一 PC の公開接続、後続の複数PC、Issue #55 | F01〜F04,T09 | 先に Google 認証・Funnel・ChatGPT から1台への実接続と公開用レビューを確認。複数PCはその後。T09 は設計レビュー、Red/Green、認可回帰とWindows実画面手順で確認 | 実 Google 本人登録・公開起動・通常レビュー・全体検証済み。ChatGPT実操作未確認。独立指摘3件をF01dで修正・全体検証成功、解消確認待ち。T09 は設計レビューと修正確認済み、FA780実画面・画像証拠待ち |
| P5 | PR #54 / Issue #48, main機能・Issue #56統合 | R54-01〜R54-11,T10,T11 | Issue #48 post-edit, PR #51 auto-refresh, PR #60 process context, PR #50 dates, PR #52 shared links, and Issue #56 main Todo coexist and pass parent verification before merge. | Parent verified and squash-merged PR #54 as `8d9c77a49d342e15f7ce63802d3a1550eb158930`; Issue #48 is closed. Session metadata editing, external links, and main Todo are retained. |
| P6 | Issue #56 共有作業一覧と更新期限制御 | T11 | セッション単位・初期有効・有効化後5分猶予の設計、TDD、通常レビュー、mainとPR #60統合後の回帰・レビューを完了 | Issue #56 Todo remains in main through PR #54 squash merge `8d9c77a`; keep T11 as a distinct tracked workstream unless its closure is separately confirmed. |
| R24 | Issue #24 Windows CI実行時間の改善（独立workstream） | R24-01〜R24-08 | 必須テスト意味・網羅性・Windows検証を維持してCI時間を評価し、main統合候補の通常reviewとexact-head CIを完了。3分達成まではIssueを閉じない | R24-01〜06は8分割を採用済みだが3分未達。R24-08のPR #69はmain `8d9c77a` 対象のdraft。親最終レビューのKERO-R24-08-001/002を修正し、同一通常reviewerの限定確認はpass。実装candidate `a9b928c` は全体ローカル検証pass（226件中215 pass/11 skip/0 fail、check/build/lint/diff-check成功）とexact-head run `37197042561` 全job成功。PR #69へpush済みで、親の累積最終review/merge判断待ち。PR #62は比較・統合対象外 |

| P7 | Issue #70 Todoモバイル配置・詳細同期 | T12 | 親承認済み設計をTDDで実装し、回帰、実UI、通常レビューを完了。Draft PR #72は親最終判断まで未merge | 通常レビュー初回はR70-N01〜N13でfailし、全指摘を固定ID/重要度のまま修正。再確認で追加されたR70-N16/N17（R70-F02と重複する動的行構造、削除draft再追加時の折りたたみ欄表示）も修正・回帰確認。開発用自己完結HTML previewは `npm run preview:issue70` で生成でき、実製品route/CSS/client bundleと明示mockを使用。Independent preview finding R70-F04はform/native navigationを止めるpreview-only capture barrierと回帰を追加し、fix verification/current-head CI待ち。`scripts/issue70-ui-fixture.ts` は既存のcreateApp HTTP/SSR integration fixtureも保持。PR #72はDraft、マージ判断は親待ち。実viewport 320px/desktop画面の確認は未完了。PR #69とは独立 |

現在の位置: Issue #24のR24-08はPR #69のexact-head CI成功後、親最終レビュー/merge判断待ち。独立作業のT12はR70-N01〜N17およびR70-F01/F02（N16と重複）の修正とローカル検証を完了後、同一通常reviewerの再確認待ち。実createApp fixtureのHTTP/SSRは確認したが、携帯幅の正規ブラウザ実画面確認は親へ依頼する。PR #69の成果は再実装せず、T12固有差分のみ作成した。
最小動作版の独立判定と提出証拠は `reports/2026-09-25-independent-review.md` と PR #1 を参照する。
公開用の通常指摘は `reports/2026-09-25-remote-normal-review.md` で追跡し、ChatGPT の実操作と公開用の独立レビューは未完了。複数PCの F02 は後続であり、単一 PC 接続の完了条件には含めない。
