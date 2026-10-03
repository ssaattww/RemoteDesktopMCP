# Phase 一覧

更新規則: このファイルは `task-breakdown-planner`、`task-consistency-manager`、`progress-sync-manager` を通してのみ更新する。

| Phase | 内容 | 対象 | 完了条件 | 状態 |
| --- | --- | --- | --- | --- |
| P1 | 指摘修正と実装前準備 | T01,T02 | 3設計修正、skills リンク、task 一覧 | 設計レビュー合格・準備完了 |
| P2 | 単一PCの最小動作版 | T03〜T06a | 設定と起動、認証、委譲、転送の回帰・結合試験と依存監査を確認 | 完了 |
| P3 | レビューと提出 | T07,T07a〜T07e,T08,T08a〜T08d | 通常・独立レビュー、ローカル検証、PR 更新 | 通常工程完了。最終独立判定・提出は独立レビュー報告と PR #1 を参照 |
| P4 | 単一 PC の公開接続、後続の複数PC、Issue #55 | F01〜F04,T09 | 先に Google 認証・Funnel・ChatGPT から1台への実接続と公開用レビューを確認。複数PCはその後。T09 は設計レビュー、Red/Green、認可回帰とWindows実画面手順で確認 | 実 Google 本人登録・公開起動・通常レビュー・全体検証済み。ChatGPT実操作未確認。独立指摘3件をF01dで修正・全体検証成功、解消確認待ち。T09 は設計レビューと修正確認済み、FA780実画面・画像証拠待ち |
| P5 | PR #54 / Issue #48 と User Console 自動更新 | R54-01〜R54-11,T10 | Issue #48のworkdir/purpose/URL/title後編集、PR #51一覧自動更新と選択保持、PR #60 process context、PR #50日時表示を統合。通常レビュー・fix verification・統合後CIを確認。PR #54はIssue全体の実装完了までDraft・未merge | PR #51はmain `bfe3793` に統合済み。PR54統合候補は最新main `bfe3793` とPR52最新 `b03c72b` を取り込み、PR52共有 `src/session-links.ts` とテストは最新PR52とbyte一致。全体172件中161 pass/11 skip/0 fail、check/build/lint/デザイン用語lint/diff-check成功。Chromium headless 7ケースと4 PNGを保存。PR54 merge commit、同じ通常レビュアーのfix verification、push/exact-head CIは未完了。独立最終レビュー/予約/freeze/attestationは未開始。 |

最小動作版の独立判定と提出証拠は `reports/2026-09-25-independent-review.md` と PR #1 を参照する。
公開用の通常指摘は `reports/2026-09-25-remote-normal-review.md` で追跡し、ChatGPT の実操作と公開用の独立レビューは未完了。複数PCの F02 は後続であり、単一 PC 接続の完了条件には含めない。
