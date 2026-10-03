# Phase 一覧

更新規則: このファイルは `task-breakdown-planner`、`task-consistency-manager`、`progress-sync-manager` を通してのみ更新する。

| Phase | 内容 | 対象 | 完了条件 | 状態 |
| --- | --- | --- | --- | --- |
| P1 | 指摘修正と実装前準備 | T01,T02 | 3設計修正、skills リンク、task 一覧 | 設計レビュー合格・準備完了 |
| P2 | 単一PCの最小動作版 | T03〜T06a | 設定と起動、認証、委譲、転送の回帰・結合試験と依存監査を確認 | 完了 |
| P3 | レビューと提出 | T07,T07a〜T07e,T08,T08a〜T08d | 通常・独立レビュー、ローカル検証、PR 更新 | 通常工程完了。最終独立判定・提出は独立レビュー報告と PR #1 を参照 |
| P4 | 単一 PC の公開接続、後続の複数PC、Issue #55 | F01〜F04,T09 | 先に Google 認証・Funnel・ChatGPT から1台への実接続と公開用レビューを確認。複数PCはその後。T09 は設計レビュー、Red/Green、認可回帰とWindows実画面手順で確認 | 実 Google 本人登録・公開起動・通常レビュー・全体検証済み。ChatGPT実操作未確認。独立指摘3件をF01dで修正・全体検証成功、解消確認待ち。T09 は設計中 |
| P5 | User Console 自動更新と選択保持 | T10 | Issue #46 / PR #51 の一覧をまたぐ選択、最新状態への追いつき、認証失効・離脱時の破棄を修正・確認。PR #50とPR #60統合、独立レビュー、exact-head CI、UI実画面確認を完了 | PR #51 は `bfe3793` にsquash-merged。T10の実装はIssue45支線へ通常統合。統合後auto-refresh/selection-preservation focused回帰は成功。 |

| P6 | Issue 45 / PR #52 セッション外部リンク（URL/タイトル） | I45、PR #54 から依存 | 安全な任意URL、自動/手入力題名、後編集共有契約、TDD、通常・独立レビュー、Linux/Windows exact-head CI | 最新 main `bfe3793` を通常merge済み（`650469a`）。双方のfeatureを併存。NR-001は通常reviewer確認済み。Independent closureで`ISSUE45-IFR-CLOSURE-001`を検出。pause/event/resume regression Red後、`statePending`修正でfocused 3/3 pass。fix commit `03cc09d` 全体159/148/0/11、check/lint/build合格。通常fix verification、新HEAD exact CI、同じ独立reviewerのclosureを続行。PRはDraft維持 |

現在の位置: P1〜P3 の最小動作版を終え、利用者の追加依頼で P4 の単一 PC 公開接続を進めている。Issue #46 / PR #51 は `bfe3793` に squash merge 済みで、T10 として統合後の検証を追跡する。P6 で Issue 45 / PR #52 を進める。
最小動作版の独立判定と提出証拠は `reports/2026-09-25-independent-review.md` と PR #1 を参照する。
公開用の通常指摘は `reports/2026-09-25-remote-normal-review.md` で追跡し、ChatGPT の実操作と公開用の独立レビューは未完了。複数PCの F02 は後続であり、単一 PC 接続の完了条件には含めない。
