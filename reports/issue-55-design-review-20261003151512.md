# Issue #55 設計レビュー

## タスク

- 目的: Issue #55 の設計が受け入れ条件、既存の表示契約、所有者・認可・秘密値境界を満たすか独立に確認する。
- タスク種別: 設計レビュー

## sub-agentを使う理由

- 理由: 独立レビューは必ず別の sub-agent が実施する。

## 対象範囲

- 対象: `doc/design/long-running-process-context.md`、Issue #55、関連する画面実装・試験、PR #19・#50・#54 との統合条件。

## 対象外

- 対象外: 製品実装、変更、実画面検証、マージ。

## Dispatch profile

- selection inputs (parent, pre-dispatch): review、judgment-heavy、uncertainty high、change radius cross-module、criticality high、single、observed decomposability independent_workstreams、decomposition_policy forbidden（単一の独立設計レビューとして割当）。
- selection source (parent, pre-dispatch): explicit user override.
- observed decomposability (parent, pre-dispatch): independent_workstreams.
- decomposition policy / disposition (parent, pre-dispatch): forbidden / one reviewer owns the full design review for independence.
- proposed profile (parent, pre-dispatch if applicable): none.
- approval status / evidence (parent): user explicitly requested gpt-6-luna, medium, fork none.
- Astra fields: not applicable.
- requested profile (parent, pre-dispatch): model `gpt-6-luna`, reasoning `medium`, fork `none`.
- agent role / default-role plan (parent, pre-dispatch): role selector is not exposed by the available spawn tool; effective role unknown.
- role config evidence / profile effect (parent, pre-dispatch): no role query or role argument available; effect unknown.
- planned runtime profile after known role constraints (parent, pre-dispatch): requested values; final role adjustment unknown.
- applied profile (parent, post-runtime exact evidence only; null when unverified): null.
- application status (parent, post-runtime evidence only): spawn_succeeded_profile_unverified.
- runtime profile observability (parent, post-runtime): final profile hidden; role query and role selection are not exposed by the available collaboration tool.
- reviewer continuity (parent, if applicable): new reviewer.
- fork policy (parent): none.
- reasons / constraints (parent): do not edit files; write findings and coverage dispositions in this report only.

## 実行コマンド

- `cat /workspace/CodexSkill/skills/review-worker/SKILL.md`
- `cat /workspace/CodexSkill/skills/design-executor/SKILL.md`
- `git status --short --branch`, `git rev-parse HEAD`, `git diff --stat c0c786a3d696724d780291aed9c8b89cbe2d531e...HEAD`
- Issue #55、PR #19、PR #50、PR #54 の GitHub ページを読み取り確認
- `nl -ba` / `rg -n` で設計、実装、テストの該当箇所を読み取り確認
- テストや製品検査は実行していない（設計のみレビュー）

## 対象ファイル

- 変更したファイル: 本報告書のみ。Dispatch profile 節は変更していない。
- 確認した設計: `doc/design/long-running-process-context.md`（未追跡の作業ツリー内容）
- 確認した実装: `src/user-console.ts`、`src/user-console-client.ts`、プロセス開始・監査処理の `src/index.ts`
- 確認した試験: `test/user-console.test.ts`、`test/user-console-client.test.ts`、`test/independent-fixes.test.ts`、`test/regressions.test.ts`
- 追跡状態: ブランチ表示は `issue-55-process-context` だが HEAD は `c0c786a3d696724d780291aed9c8b89cbe2d531e`（指定 base と同一）。設計書は未追跡で、実装コミット差分はない。したがってこの判定は設計ドラフトについてのみであり、実装の適合判定ではない。

## 指摘事項

- **D55-1 — 中 / 必須: state update 後のフォーカス保持契約と試験が不足。** 場所: `doc/design/long-running-process-context.md` 表示契約 7、試験計画 3。根拠: 現行 `src/user-console-client.ts` の `renderEvents` は表示中のプロセスを sessionId + processId でスクロール位置のアンカーとして保つが、`renderProcesses` は `#process-details` の子要素を再生成する。出力 `<details>` の open は復元する一方、summary 等に置かれたキーボードフォーカスは失われる。セッション日時行では既存クライアントが開閉に加え focus を復元している。設計は「画面状態」「操作対象」の保持を述べるが、フォーカス対象・復元条件・更新時に対象が消えた場合の扱いを明示せず、試験計画も開閉だけを列挙している。必要な変更: フォーカス可能要素の識別キーをセッションID + プロセスID + 要素種別（必要なら出力イベントID）で定義し、state update後に同一要素が存在するとき focus を戻し、対象消失時のフォールバックを決める。出力 open/closed、表示中ブロックのスクロール位置、実行行から移動した後の対象保持を同一セッション内・同一プロセスで検証する試験を追加する。
- **D55-2 — 低 / 必須: Windows 実画面手順が再現可能な検証手順になっていない。** 場所: 試験計画 7。根拠: FA780、長い出力、一覧から目的・コマンドに戻ること、running項目の上位表示、画面と手順を記録することは指定されているが、起動するコマンド／目的、出力の継続・画面外化条件、複数 running と完了済みの構成、更新操作、観察点と証拠の粒度がない。Issue の受入条件は大量出力時に実行中一覧から確認できることと複数 running の順序を含む。必要な変更: Windows担当がそのまま実行できる、ローカルの安全な長時間出力プロセスを用いた段階的手順、確認する画面・順序・再描画タイミング、記録するスクリーンショット／実施ログ項目を設計に加える。実 Windows 確認自体はこの設計レビューでは実施していない。

### Coverage dispositions

| 観点 | disposition | 根拠 |
| --- | --- | --- |
| Issue本文の目的、要件、受入条件 | checked_finding | 目的・複数 running 上位・組み合わせ・fallback・認可/秘密・所有者要件を設計と照合。D55-1、D55-2参照。 |
| 目的・コマンド・出力・終了結果のプロセス対応 | checked_no_finding | processごとの情報束縛を明示し、既存の sessionId/processId 複合キーとイベント対応に沿う。 |
| 実行中の上位表示と同一状態内順序 | checked_no_finding | 一覧と詳細の両方にrunning優先、同状態では直近記録順という規則が定義されている。テスト計画にも複数状態を含む。 |
| 欠落・空値fallbackと他プロセス値の誤用防止 | checked_no_finding | `未記録` と空値処理、値の流用禁止を定義し、欠落/空値の試験を計画している。 |
| セッションID・プロセスIDの相関 | checked_no_finding | 行と詳細の対応に両IDを明記。既存クライアントの複合キー設計と一致。 |
| open/focus・更新時の表示状態維持 | checked_finding | openとスクロールアンカーは触れているが、フォーカスは明文化・計画されていない（D55-1）。 |
| 本人認証・認可・所有者境界 | checked_no_finding | 認可変更なし、本人限定の既存データだけを使う規定と所有者回帰試験がある。実装済み適合は未判定。 |
| 秘密値・コマンドのマスク除去境界 | checked_no_finding | 既存の秘匿済み記録のみを表示する規定、マスク回帰試験の計画がある。新しい取得元を設けない。 |
| HTML/文字列安全性 | checked_no_finding | ID・表示値をHTML解釈せず既存安全変換を使う規定がある。 |
| PR #19 非回帰・統合 | checked_no_finding | PR #19 は複数回出力をプロセス単位でまとめる導入。設計は当該履歴・終了情報を維持し、追加をナビゲーションとソートに絞っている。 |
| PR #50 非回帰・統合 | checked_no_finding | PR #50 の相対日時・日時開閉状態を変更対象外として明記。state refreshの追加条件はD55-1の焦点。 |
| PR #54 非回帰・統合 | checked_no_finding | PR #54 のセッション情報編集契約と本件のプロセス表示は独立。編集/API/保存形式を変更しないと明記。 |
| 回帰・統合試験計画 | checked_finding | マスク、認可、fallback、複数プロセス、再描画、総合検査を計画。focus具体試験とWindows再現手順にD55-1/2あり。 |
| Windows実画面検証・証拠 | checked_finding | FA780での確認は予定のみ。設計段階として実施不能、また手順詳細不足（D55-2）。 |
| 実装差分と実装時テスト結果 | not_applicable | 指定HEADはbaseと一致し、変更実装が存在しない。 |

## 結果

- 結果: **fail**（設計レビュー）。D55-1とD55-2の設計上の必須追記が残る。レビュー対象 HEAD: `c0c786a3d696724d780291aed9c8b89cbe2d531e`。作業ツリーの設計ドラフトは未追跡のため、SHAに含まれない。
- 実装のVerdict: **incomplete**。実装差分がなく、製品動作・試験結果の判定対象がない。
- Coverage summary: 10 checked_no_finding、4 checked_finding（Issue全体、状態保持、試験計画、Windows実画面）、1 not_applicable。held/unexplored はなし。Finding completeness: 設計レビュー指摘のため実装経路・composed fixture・focused validationはまだ存在せず、両指摘とも未解消。
- 根拠上の統合条件: #19のプロセスごとの複数出力表示、#50の相対日時と開閉、#54のセッション編集とは対象を分離し、セッションIDとプロセスIDの複合相関を維持する。
- Independence: 実装担当ではなく、設計・関連コード・試験を独立に読んだ単一レビュー。immutable実装HEADは提供されず、base SHAのみ固定できた。
- 次の手順: D55-1/D55-2を設計に反映してレビューを依頼。その後にテスト先行実装を行い、実装 HEAD 上で認可・マスク・fallback・相関・状態維持の回帰を検証する。Windows手順の実施結果は別担当の証拠として添付する。
- report_attestation_allowed: false（独立最終レビュー用の予約報告ではなく、HEADもbaseと同一。attestation条件に該当しない）。

## リスク

- 未解決のリスクまたは後続対応: 本報告が判定するのは設計書の内容のみ。実装は存在せず、HTMLアンカーの実画面挙動、操作行更新後のフォーカス維持、秘密値マスクの実データ境界、Windowsでの表示は未検証。Issue上の関連PRの現況は確認したが、ブランチ差分としてのPRコミット統合検査は実装がないため対象外。
