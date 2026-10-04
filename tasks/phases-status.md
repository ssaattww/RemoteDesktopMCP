# Phase 一覧

更新規則: このファイルは `task-breakdown-planner`、`task-consistency-manager`、`progress-sync-manager` を通してのみ更新する。

| Phase | 内容 | 対象 | 完了条件 | 状態 |
| --- | --- | --- | --- | --- |
| P1 | 指摘修正と実装前準備 | T01,T02 | 3設計修正、skills リンク、task 一覧 | 設計レビュー合格・準備完了 |
| P2 | 単一PCの最小動作版 | T03〜T06a | 設定と起動、認証、委譲、転送の回帰・結合試験と依存監査を確認 | 完了 |
| P3 | レビューと提出 | T07,T07a〜T07e,T08,T08a〜T08d | 通常・独立レビュー、ローカル検証、PR 更新 | 通常工程完了。最終独立判定・提出は独立レビュー報告と PR #1 を参照 |
| P4 | 単一 PC の公開接続、後続の複数PC、Issue #55 | F01〜F04,T09 | 先に Google 認証・Funnel・ChatGPT から1台への実接続と公開用レビューを確認。複数PCはその後。T09 は設計レビュー、Red/Green、認可回帰とWindows実画面手順で確認 | 実 Google 本人登録・公開起動・通常レビュー・全体検証済み。ChatGPT実操作未確認。独立指摘3件をF01dで修正・全体検証成功、解消確認待ち。T09 は設計中 |
| P5 | User Console 自動更新と選択保持 | T10 | Issue #46 / PR #51 の一覧をまたぐ選択、最新状態への追いつき、認証失効・離脱時の破棄を修正・確認。PR #50とPR #60統合、独立レビュー、exact-head CI、UI実画面確認を完了 | PR #51 は `bfe3793` としてmainへマージ済み。Ubuntu・Windows 3 shardのCI成功、レビュー/独立レビュー、FA780実画面9ケースの証跡を維持 |
| P6 | Issue #56 共有作業一覧と更新期限制御 | T11 | セッション単位・初期有効・有効化後5分猶予の設計、TDD、通常レビュー、最新main/PR #60統合後の回帰とレビューを完了 | NREV-56-01〜03をTDD修正。最新main `bfe3793` との競合解消中。統合後回帰・fix verification待ち |

現在の位置: P1〜P5の既存作業を追跡し、Issue #56のP6を実施中。P4にはPR #60のprocess context、P5にはPR #51の自動更新がmainに含まれる。Issue #56はDraft PR #61で独立管理。
最小動作版の独立判定と提出証拠は `reports/2026-09-25-independent-review.md` と PR #1 を参照する。
公開用の通常指摘は `reports/2026-09-25-remote-normal-review.md` で追跡し、ChatGPT の実操作と公開用の独立レビューは未完了。複数PCの F02 は後続であり、単一 PC 接続の完了条件には含めない。
