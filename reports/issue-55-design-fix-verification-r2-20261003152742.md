# Issue #55 設計指摘の修正確認 r2

## 対象

- 初回レビュー: `reports/issue-55-design-review-20261003151512.md`
- 前回の修正確認: `reports/issue-55-design-fix-verification-20261003152126.md`
- 対象指摘: D55-1（中、操作位置を更新後に観察する試験条件が不足）
- 修正対象: `doc/design/long-running-process-context.md`
- 基点: `3d25fcfe01f0f9e29b6886c01b344d42131a6e1d`

## Dispatch profile

- continuation: 同一 reviewer、D55-1 の fix verification。新規 agent dispatch ではない。
- selection source: user override `gpt-6-luna`, `medium`, fork `none` を継続。
- applied profile: null（親から最終適用情報を観測できない）。
- application status: existing reviewer continuation; runtime profile remains unverified.
- role/default-role plan: spawn tool に照会・指定項目なし。実効 role と調整影響は不明。
- 対象範囲: D55-1 の設計変更と設計検査結果だけ。
- 禁止事項: 実装、他ファイル編集、Git/PR操作、マージ。

## 修正内容

- `doc/design/long-running-process-context.md` の表示契約8と試験計画3を、base `3d25fcfe01f0f9e29b6886c01b344d42131a6e1d` との差分で確認。追加内容は D55-1 のみを対象としており、前回 closure の範囲内。
- 契約8は、セッションID + プロセスID + 要素種別の複合識別、要素が存在するときのみ新要素に `focus({ preventScroll: true })` すること、消失時はfocus設定をせず別プロセスへ移動しないことを明記した。操作対象はプロセス見出しと出力開閉操作に区別され、一覧から移動した後のキー操作位置も扱っている。
- 試験計画3は、更新前後の `document.activeElement`、セッションID/プロセスID/種別の一致、preventScroll、`window.scrollY` 不変を別々に検証する。対象消失時はfocusが他プロセスへ移らず復元focusを呼ばないこと、同一process IDを別セッションで使う混同回帰も明示した。
- Issue #55の要件との適合およびPR #19（プロセス別の出力履歴）、#50（日時表示と開閉状態）、#54（セッション情報編集）への非回帰を、初回設計・前回確認で記録した契約と最新差分を通して再確認した。今回の差分は保存/API/認可/所有者/秘匿契約を変えない。

## 確認コマンドと結果

- `git rev-parse HEAD`: `38aade620d64227b1e15a3f2380efa0ef4f46630`（指定HEAD一致）。
- `git diff --stat 3d25fcfe01f0f9e29b6886c01b344d42131a6e1d...38aade620d64227b1e15a3f2380efa0ef4f46630`: 設計書、前回レポート、タスク状態の3ファイル。今回の設計契約の直接変更は1箇所（表示契約8・試験計画3）。製品コードとテストコードは変更なし。
- `git diff 3d25fcfe01f0f9e29b6886c01b344d42131a6e1d...38aade620d64227b1e15a3f2380efa0ef4f46630 -- doc/design/long-running-process-context.md`: 契約と試験計画の修正を確認。
- GitHub Issue #55全文と初回・前回レビューのD55-1記録を照合。確認した受入点はプロセス別の目的/コマンド/出力/終了結果、長時間出力中のアクセス性、複数実行中の上位表示、fallback、マスク、認可、所有者分離。
- PR #19/#50/#54の既存統合条件: #19のプロセスごとの履歴を維持、#50の日時/open状態を維持、#54のセッション編集/API/保存範囲に触れないことを確認。
- `npm run lint:md`: 成功。86文書（本報告を含む）、0件。
- `git diff --check`: 成功。
- 設計レビューのため、製品テストとFA780実画面の実動作は実行していない。Windows手順実施と証拠取得は後続の実装検証担当に残る。

## 指摘の判定

- **D55-1: fixed（重大度: 中、初回から維持）**。契約は要求されたsession/process/typeの識別、キー一致時のみのpreventScroll付きfocus復元、対象消失時の非focus/非転送、見出しと出力開閉操作を定義した。試験計画はactiveElement、三つの識別属性、preventScroll、scrollY不変、対象消失、別セッションで再利用された同一process IDの取り違えを個別に確認するため、前回残ったfocusの曖昧さを閉じる。重大度変更・再分類なし。

### D55-1 closure completeness

| 必須変更 | 状態 | 根拠 |
| --- | --- | --- |
| session ID + process ID + 要素種別で対象を識別 | 完了 | 契約8と試験の属性一致条件。 |
| 同一対象が存在するときだけpreventScrollでfocus復元 | 完了 | 契約8とactiveElement/preventScroll/scrollYの試験。 |
| 消失時にfocus復元せず、別プロセスへ移動しない | 完了 | 契約8と対象消失の試験。 |
| running行から見出し/出力開閉操作へ移動後も同じ対象を保つ | 完了 | 契約8で対象種別を限定し、試験3で再描画後の識別属性を確認。 |
| 同じprocess IDを持つ別sessionの混同を防ぐ | 完了 | 試験3に同一ID別session回帰ケースを追加。 |
| production path、composed fixture、focused validation | 設計段階では該当なし | このfix verificationは設計契約の修正確認。実装受入時に別途実装経路・fixture・focused testが必要。 |

## Verdict と残件

- **Design review verdict: pass**。D55-1 は `fixed`。D55-2 は前回確認で `fixed` のまま。必須findingと未探索の設計観点は残っていない。
- Reviewed HEAD: `38aade620d64227b1e15a3f2380efa0ef4f46630`; base: `3d25fcfe01f0f9e29b6886c01b344d42131a6e1d`。同一レビューライフサイクルの bounded fix verificationであり、初回独立レビューHEADは `c0c786a3d696724d780291aed9c8b89cbe2d531e`、前回D55 closure確認HEADは `3d25fcfe01f0f9e29b6886c01b344d42131a6e1d`。同じreviewerがD55-1と直接影響差分のみを確認し、新しい網羅基準は導入していない。
- Coverage: D55-1の全設計アクション checked_no_finding。Issue受入要件、所有者/認可/秘密境界、PR #19/#50/#54の非回帰、差分scopeを確認。実装試験とWindows画面実施証拠は設計レビュー対象外/後続実装ゲート。
- Held: Windows実画面の実施および証跡（実装検証担当が所有、設計承認を妨げない）。Unexplored: なし。重大度再分類: なし。
- Markdownlint: `npm run lint:md` 成功、86文書・0件（本報告を含む）。
- 次の対応: D55-1/D55-2の設計指摘は閉鎖。実装着手時にテスト先行で要求を具現化し、Windows手順の実施証拠を取得する。
- `report_attestation_allowed: false`（独立最終レビュー報告ではなく、attestation条件は適用しない）。
