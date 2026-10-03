# Issue #55 設計指摘の修正確認

## 対象

- 初回レビュー: `reports/issue-55-design-review-20261003151512.md`
- 指摘: D55-1（中、フォーカス保持条件と試験不足）、D55-2（低、Windows実画面手順の具体性不足）
- 修正対象: `doc/design/long-running-process-context.md`
- 基点: `de18fa19186883fde3017e5779e329297f95fcdd`

## Dispatch profile

- continuation: 同一 reviewer、fix verification。新規 agent dispatch ではない。
- selection source: user override `gpt-6-luna`, `medium`, fork `none` を継続。
- applied profile: null（親から最終適用情報を観測できない）。
- application status: existing reviewer continuation; runtime profile remains unverified.
- role/default-role plan: spawn tool に照会・指定項目なし。実効 role と調整影響は不明。
- 対象範囲: D55-1/D55-2 の設計変更と設計検査結果だけ。
- 禁止事項: 実装、他ファイル編集、Git/PR操作、マージ。

## 修正内容

- 対象差分: `doc/design/long-running-process-context.md` の表示契約 8、試験計画 3・7 を確認。加えて `tasks/tasks-status.md` の進捗更新と初回レビュー報告の追記を差分で確認した。製品実装・テストコードは変更されていない。
- D55-1: 描画直前に操作対象を調べ、セッションID + プロセスID + 要素種別で識別する契約、更新後に同一キー要素がある場合だけ操作位置を戻す契約、対象消失時に別プロセスへ移さない契約が追加された。試験計画は出力追加/状態再描画後の操作位置維持と対象消失ケースを追加した。
- D55-2: FA780上で自身の有効セッションを使い、A/Bを別目的にした120行・1秒間隔のPowerShell標準出力を2つ起動し、即時終了のDONE出力も作る具体的な手順になった。画面外まで出力後の更新、複数runningと完了済みの並び、各目的/コマンド/出力の対応、交互更新、記録画像3種、実施ログ項目、完了確認まで指定している。
- 履歴保持や所有者・認可・秘密値の境界、既存APIや保存形式を変える設計差分は見当たらない。

## 確認コマンドと結果

- `git rev-parse HEAD`: `3d25fcfe01f0f9e29b6886c01b344d42131a6e1d`（指定HEAD一致）。
- `git diff --stat de18fa19186883fde3017e5779e329297f95fcdd...3d25fcfe01f0f9e29b6886c01b344d42131a6e1d`: 設計書1、初回報告1、タスク状態1の計3ファイル。設計書差分は9行追加/変更。
- `git diff de18fa19186883fde3017e5779e329297f95fcdd...3d25fcfe01f0f9e29b6886c01b344d42131a6e1d -- doc/design/long-running-process-context.md tasks/tasks-status.md`: 設計とステータスの差分を確認。実装・テスト差分なし。
- GitHub Issue #55 全文（背景、目的、要件、受入条件、PR #19関連記述）と初回報告のD55-1/D55-2を照合。
- `npm run lint:md`: 初回は本報告の表区切りスタイルでMD060を6件検出。区切りをリポジトリ標準のパディング形式に直し、再実行した。
- Windows実画面の手順は設計としてレビューしたが、FA780上の実実行や画像証跡はこの設計レビューでは未実施。

## 指摘ごとの判定

- **D55-1 — partially_fixed（重大度: 中、初回から維持）**。契約は識別キー、再描画後の操作対象復元、対象消失時の非転送を具体化し、試験項目も増えた。一方、試験計画の「同じプロセス内での操作位置を保つ」「別のプロセスへ移らない」は、フォーカス（active element）を観察する試験かスクロール位置アンカーの試験かを明記していない。新契約は操作位置/フォーカスを主題としており、キー一致後にフォーカスを戻すこと、対象消失時にフォーカスが他へ移らないこと、画面位置を不用意にスクロールしないことが試験で判定できる形に落ちていない。必要な残作業: focus対象を取得し再描画後に同じ要素種別へ復元する試験、対象消失時のfocus先を観察する試験、同プロセス/別セッション同一process IDのケースを明記する。
- **D55-2 — fixed（重大度: 低、初回から維持）**。安全な具体コマンドとA/Bの一意な目的・出力、2 runningとDONE、初回行出現後/出力が画面外に伸びた後の更新、並び・表示対応・交互移動を確認する操作、必要画像と実施記録が指定された。Issueの長時間・複数 running受入条件を実行者が同じ手順で評価できる。実際のWindows実施証拠がまだ無い点は、設計修正の未解消ではなく後続の実装検証に残る。

### Coverage dispositions

| 観点 | disposition | 根拠 |
| --- | --- | --- |
| D55-1 必須変更（複合識別キー） | checked_no_finding | session ID、process ID、要素種別を明示。 |
| D55-1 必須変更（対象消失時） | checked_no_finding | 更新後に消えた対象から別プロセスへ操作位置を移さないと規定。 |
| D55-1 必須変更（再描画後の操作位置） | checked_finding | 契約は追加されたが、試験でfocusを識別・観察するのか不明瞭。 |
| D55-1 必須変更（試験） | checked_finding | 対応ケースは書かれたがfocus喪失や誤移動を機械的に判定する明示が不足。 |
| D55-2 実行コマンド・目的 | checked_no_finding | PowerShell標準出力コマンドと異なるA/B目的、固有出力を指定。 |
| D55-2 複数実行中・完了済み | checked_no_finding | 2 runningに加えて即時完了DONEを置く。 |
| D55-2 更新操作・確認順 | checked_no_finding | running行出現後と出力が画面外まで伸びた後に更新し、A/Bを交互に確認。 |
| D55-2 観察点・記録 | checked_no_finding | 上下順、正しい目的/コマンド/固有出力、画像3枚と実施ログ項目を列挙。 |
| スコープ・実装非介入 | checked_no_finding | 設計・報告・タスク進捗だけの差分。製品コード、試験、Issue、Git/PR操作なし。 |
| Windows実画面実施証拠 | held | 設計手順は具体化されたが、実画面確認と添付証拠は後続工程。 |
| Markdownlint | checked_no_finding | 下記の実行結果に従う。 |

## Verdict と残件

- **Design review verdict: fail**。D55-1 は `partially_fixed` のため、必須findingが1件残る。D55-2 は `fixed`。
- Reviewed HEAD: `3d25fcfe01f0f9e29b6886c01b344d42131a6e1d`; base: `de18fa19186883fde3017e5779e329297f95fcdd`。対象rangeはbase..HEAD。これは同一レビューライフサイクルの指摘限定fix verificationであり、初回レビューと同一reviewerがD55-1/D55-2および関連差分のみを確認した。独立した新規レビューではない。
- D55-1 completeness: 識別キー = 完了; 消失時非転送 = 完了; 再描画後のフォーカス復元/スクロール非移動を試験で観測 = 部分的; sibling case（同一process IDの別session）を使ったテストケース = 未記載。設計段階のため production path、composed fixture、focused validationは未作成であり、実装受入の閉鎖証拠とはしない。
- D55-2 completeness: 実行する具体例、2件の継続中と完了済み、更新順、見るべき表示、画像/実施ログ要件 = 完了。Windows実施証拠は未取得でheld。
- Held items: FA780実画面の実施と証拠添付（設計者ではなく実装検証担当）。Unexplored: なし。重大度再分類: なし。
- Markdownlint: `npm run lint:md` 成功。85文書（本報告を含む）、0件。
- 次の対応: 試験計画3にキーボードfocusの保存・復元/消失確認と別session同一process IDケースを明示し、再確認を依頼。D55-2は閉鎖。
- report_attestation_allowed: false（これは独立最終レビュー報告ではない。attestation条件は適用しない）。
