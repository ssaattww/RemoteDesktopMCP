# Phase 一覧

更新規則: このファイルは `task-breakdown-planner`、`task-consistency-manager`、`progress-sync-manager` を通してのみ更新する。

| Phase | 内容 | 対象 | 完了条件 | 状態 |
| --- | --- | --- | --- | --- |
| P1 | 指摘修正と実装前準備 | T01,T02 | 3設計修正、skills リンク、task 一覧 | 設計レビュー合格・準備完了 |
| P2 | 単一PCの最小動作版 | T03〜T06a | 設定と起動、認証、委譲、転送の回帰・結合試験と依存監査を確認 | 完了 |
| P3 | レビューと提出 | T07,T07a〜T07e,T08,T08a〜T08d | 通常・独立レビュー、ローカル検証、PR 更新 | 通常工程完了。最終独立判定・提出は独立レビュー報告と PR #1 を参照 |
| P4 | 単一 PC の公開接続、後続の複数PC | F01〜F04 | 先に Google 認証・Funnel・ChatGPT から1台への実接続と公開用レビューを確認。複数PCはその後 | 実 Google 本人登録・公開起動・通常レビュー・全体検証済み。ChatGPT実操作未確認。独立指摘3件をF01dで修正・全体検証成功、解消確認待ち |
| P5 | PR #54 / Issue #48 セッション情報の全受入条件 | R54-01〜R54-11 | 本人所有のworkdir/purpose/URL/title後編集・再表示、競合・実行中processとのcwd整合、安全なリンク取得、既存・新規UI回帰、通常/独立レビューとcurrent-head CIを確認。PR #54はIssue全体の実装完了まで維持し、Draft・未merge | workdir/purpose側の通常修正・IFR-001/002修正は完了し、独立担当が `7b44f84` で両P2をchecked_no_finding。実ブラウザ既存7ケースは親報告に基づき成功、UI差分なしの後続report commitにも適用。最初のreport attestation `2e9b80b` はCI MD060失敗で撤回、報告修正 `8b5c5059` はMarkdown lint合格だがexact-head CI runなし。撤回済みattestationは現行completion proofに使わない。Issue #48のURL/title統合はPR52共有実装handoff後にR54-08〜10で実施し、その後新しい独立最終レビュー境界を設定する。 |

現在の位置: P1〜P3 の最小動作版を終え、P4 の単一 PC 公開接続に続き、利用者依頼で P5 の PR #54 / Issue #48 通常レビューを進めている。
最小動作版の独立判定と提出証拠は `reports/2026-09-25-independent-review.md` と PR #1 を参照する。
公開用の通常指摘は `reports/2026-09-25-remote-normal-review.md` で追跡し、ChatGPT の実操作と公開用の独立レビューは未完了。複数PCの F02 は後続であり、単一 PC 接続の完了条件には含めない。
