# セッション情報MCP後編集 設計レビュー報告

## レビュー対象

- Issue #71 / PR #74
- ブランチ: `design/session-metadata-mcp-edit`
- reviewed HEAD: `6dbcead75db8b741ad4b6b397a12d6e280bffc0d`
- base HEAD: `f20c75e1ecd409f0e8573720c0f74b39d8178f93`
- 方式: 通常の初回設計レビュー（利用者指示により同一 reviewed HEAD を再度全体確認）
- 判定: **fail**
- 必須修正: Medium 1件

PRの全変更ファイル、対象設計、`src/index.ts`、`src/session-links.ts`、`src/user-console.ts`、Todo回帰試験、MCP公開契約試験、lint設定、CI診断設定を確認した。

## RDMCP-71-DREV-001: 更新拒否でも `applied: true` を返し得る

- severity: Medium
- location:
  - `doc/design/session-metadata-mcp-edit.md:200-202,237,242,258`
  - `src/index.ts:440,458,1321-1330`
  - `test/issue-56-shared-todo.test.ts:718`

設計は `session_update` を通常のTodo期限ゲート対象にし、共有更新処理の拒否を `ok: false` で返す。一方、成功済み更新の後でMCP共通ラッパーの終端監査だけが失敗した場合は、`ok: true` の `session_update` を `appliedByTool` に追加して `applied: true` とする方針である。

現行ラッパーは終端監査失敗時に `gated || appliedByTool` が真なら `applied: true` を付与する。`session_update` はTodo例外ではないため、新鮮なTodoでは `gated` が真になる。このため `version_conflict` などで共有処理が状態変更前に `ok: false` を返しても、その後の `operation.succeeded` 監査だけが失敗すると `ok: false` と `applied: true` が同居し得る。既存Todo試験でも、ゲート対象の `node_list` で終端監査失敗時に `applied: true` となる挙動を確認している。

### 必須修正

- `ok: false` は終端監査失敗時でも拒否結果と矛盾しない `applied` 状態にする。
- `ok: true` の適用済み更新だけ `applied: true` とできるよう、`gated` 分岐との優先規則を設計に明記する。
- `version_conflict` と共有更新監査失敗について、終端監査失敗との組合せ回帰試験を追加する。

## 問題なしと確認した点

- MCP側は `RemoteDesktopService.updateSessionMetadata` を一度呼び、所有者、状態、期限、緊急停止、版、パス、用途、外部リンク検証を重複実装しない。
- `session_list` に `version` を追加する。
- 作業ディレクトリ更新と `process_start` は既存 `processLock` で順序付け、開始済みプロセスのスナップショットを変えない。
- URL・題名は既存 `session-links.ts` の正規化、世代管理、所有者再確認、SSRF対策を再利用する。
- 更新値を監査へ複製せず、共有更新監査失敗時は既存ロールバックを使う。
- 設計用語lintへの追加と用語方針に問題は見つからなかった。

## 検証

reviewed HEAD で次を再実行し、すべて成功した。

- `git diff --check f20c75e1...6dbcead75d`
- `npm run lint`
- Markdown lint: 146 files / 0 issues
- 設計用語lint
- `npm run check`

exact-head CIだけを確認した。

- workflow: `lint`
- run: `37299449587`
- headSha: `6dbcead75db8b741ad4b6b397a12d6e280bffc0d`
- event: `pull_request`
- status: completed
- conclusion: success
- Ubuntu / Windows 全ジョブ: success

`.github/workflows/lint.yml` はテスト結果、標準出力、標準エラー、終了結果、環境情報、Windowsテスト分割診断をartifactへ保存する。必要な診断workflowは既存のため変更不要だった。

## required coverage

| 観点 | 判定 | 根拠 |
| --- | --- | --- |
| 要求・設計適合 | checked_finding | Issue #71 と設計全体を照合し、RDMCP-71-DREV-001を検出 |
| 正しさ・境界条件 | checked_finding | 版競合、監査失敗、Todoゲート、無変更更新、終端状態を確認 |
| スコープ規律・無関係変更 | checked_no_finding | 設計、report、lint設定に限定。製品実装は未変更 |
| 変更ファイル・直接依存影響 | checked_no_finding | PR全変更ファイルと直接依存実装・試験を確認 |
| API・データ・設定・workflow・互換性 | checked_finding | `session_update` / `session_list.version` は整合。 `applied` 契約にfinding |
| エラー処理・失敗診断 | checked_finding | 構造化拒否、監査ロールバック、CI診断を確認。終端監査との合成にfinding |
| セキュリティ・機微値 | checked_no_finding | 所有者境界、値非記録、SSRF共通処理再利用を確認 |
| 試験・ローカル検証 | checked_finding | TDD計画は概ね十分だがfindingの合成回帰が不足 |
| current-HEAD CI | checked_no_finding | reviewed HEAD一致 run `37299449587` success |
| report・追跡・文書精度 | checked_no_finding | 設計report/handoff、用語lint、workflow診断説明を確認 |
| 回帰・保守性 | checked_finding | 共通ラッパーと共有更新処理の合成契約にfinding |

## finding closure readiness

RDMCP-71-DREV-001 の限定再レビューを開始する前に、次を同一の新しい reviewed HEAD に揃える。

- `ok: false` と `applied` の優先規則を設計で固定する。
- `session_update` + fresh Todo gate + terminal `operation.succeeded` audit failure の合成fixtureを用意する。
- `version_conflict` と `update_unavailable` のfocused回帰を追加する。
- 無変更 `ok: true` の `applied` 契約も固定する。

現時点ではclosure準備未完了であり、同じfinding ID・severityを維持して同じ通常レビュアーでfix verificationを行う。

## held / unexplored / unknown

- held: なし
- unexplored: なし
- unknown: なし
- 成功runのCIアーティファクト本体はダウンロードしていない。workflow定義と成功ジョブで診断保存経路を確認しており、今回findingの根拠には不要である。

## validation assessment

- reviewed HEAD固定: supported
- Issue #71要求との照合: supported
- 共有更新処理の再利用方針: supported
- `process_start`との作業場所順序: supported
- 外部リンク安全規則の再利用: supported
- 監査ロールバック: supported
- Todoゲートと終端監査の合成契約: failed（RDMCP-71-DREV-001）
- ローカル文書・型検証: supported
- exact-head CI: supported

## verdict

**fail**

必須finding `RDMCP-71-DREV-001` Medium が未修正のため、設計を確定できない。

## remaining risks

- `applied` 契約を曖昧なまま実装へ進むと、拒否結果と副作用状態が矛盾するMCP応答を固定してしまう。
- 共通ラッパーの `gated` を汎用的に変更する場合、既存操作の監査欠落時契約へ影響し得るため、`session_update`だけの規則として最小化するか、共通規則を変更するなら既存回帰も対象にする。

## レビュー担当の変更範囲

設計本文、製品コード、製品テスト、CI workflowは変更していない。レビュー報告と引き継ぎ情報だけを追加する。マージは行わない。

## 次の作業

`RDMCP-71-DREV-001` を設計で修正し、同じID・severityのまま同じ通常レビュアーで再レビューする。修正後は新しい current HEAD と完全一致するCIだけを確認する。
