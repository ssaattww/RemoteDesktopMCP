# 組み込みツール操作詳細ログ 入力検証拒否境界の修正確認レビュー

## 対象

- リポジトリ: `ssaattww/RemoteDesktopMCP`
- PR: #33 `#26 組み込みツール操作の詳細ログを表示する`
- レビューモード: fix verification
- 対象 finding: `RDMCP-PR33-REV-001`
- source severity: Medium
- severity reclassification: なし
- 前回 fix verification 報告 HEAD: `2db3eb40cd1c5a6f95c95ad116cb593afa095347`
- technical implementation HEAD: `b7bcb1b29db9188f39b660755f835425d454d794`
- 今回レビュー対象 current HEAD: `4fcb89a5a753490fb63a6e202843cc2ae1a40797`
- base: `origin/main`
- reviewer continuity: 前回の通常 reviewer と同じチャットで継続確認

今回レビュー対象 HEAD は、technical implementation HEAD に実装報告とhandoffを加えた publication HEAD である。製品・テストの修正内容は `b7bcb1b29db9188f39b660755f835425d454d794` までに確定し、その後の `4fcb89a5a753490fb63a6e202843cc2ae1a40797` は報告2ファイルだけを追加している。

## 判定

判定結果: pass_with_held

`RDMCP-PR33-REV-001` は解消確認した。新しい required finding は検出していない。

held は、既存 Issue 13 の非同期 fixture cleanup 競合により repository-wide local `npm test` が1件失敗する既知事項である。今回の修正経路とは独立しており、REV-001 focused tests、該当回帰、current HEAD の exact-head repository CI は成功しているため、本修正の受け入れを妨げない held とする。

## Finding completeness matrix

### RDMCP-PR33-REV-001 / Medium

#### Required action 1

入力検証エラーの監査生成では、生引数を直接 `operationDetail` へ渡さず、ツールごとに保存可能な項目を先に長さ制限した安全な投影へ変換する。

- production path: `src/index.ts` の `rejectedArgumentProjection`
- 実装確認:
  - 未検証 `params.arguments` は `rawRecord` として分離される。
  - SDK入力検証エラーと判定した後、`rejectedArgumentProjection(toolName, rawRecord)` を通した `record` だけが target、comment、`operationDetail`、`operation.received`、`operation.rejected` に使用される。
  - switch は現行の登録済みツール群に必要な既知フィールドを列挙し、未知フィールドを自動保存しない。
- actual composition fixture: `schema validation rejection bounds variable-length bodies before detail processing`
- focused evidence: current HEAD で schema validation rejection 系3テストが 3 pass / 0 fail
- disposition: satisfied

#### Required action 2

拒否された comment を通常スキーマの最大500文字を超えて監査へ保存しない。

- production path: `rejectedArgumentProjection` の `text("comment", 500)`
- actual composition fixture: `schema validation rejection bounds oversized comments before audit persistence`
- fixture behavior:
  - 5001文字 comment と負数 `offset` を実 MCP 経路の `callRaw` へ渡す。
  - SDK入力検証で拒否された後、監査イベントの comment 長を500文字として確認する。
- focused evidence: current HEAD で pass
- disposition: satisfied

#### Required action 3

`file_patch` の変更前後文字列や upload chunk data など、入力検証前の可変長本文を全量 split / decode せず、限定範囲だけを処理する。

- production path:
  - `file_patch`: `old_string` / `new_string` を各4000文字へ投影
  - `file_transfer_upload_chunk`: `data` を4096文字へ投影
  - `process_start`: `command` を4000文字へ投影
  - `session_open`: `working_directory` 4096文字、`purpose` 200文字へ投影
  - 検索 query は120文字、パス類・識別子類も個別上限へ投影
- actual composition fixture: `schema validation rejection bounds variable-length bodies before detail processing`
- fixture behavior:
  - 10,000文字 patch 本文と別の無効フィールドを組み合わせ、`operationDetail` 到達時点で4000文字に制限されていることを確認する。
  - 10,000文字 upload data と負数 offset を組み合わせ、`operationDetail` 到達時点で4096文字に制限されていることを確認する。
- focused evidence: current HEAD で pass
- disposition: satisfied

#### Required action 4

oversized comment と可変長本文の上限超過入力を使う Red テストを先に追加し、監査側の保存長と処理対象が有界であることを確認する。

- Red commit: `2bd5e71eac74b9a8a5cf455a17c764e0bd7ad830`
- Red local evidence: 5001文字 comment に対して `5001 !== 500` で失敗
- Red CI: run `36818236014` は後続pushにより cancelled。Red 成否の根拠としては使用しない。
- Green implementation commit: `b7bcb1b29db9188f39b660755f835425d454d794`
- current HEAD focused evidence: 3 pass / 0 fail
- disposition: satisfied

Finding disposition: resolved

## 修正差分と兄弟ケース

前回 fix verification report commit `2db3eb40cd1c5a6f95c95ad116cb593afa095347` 以降の製品・テスト修正は次の2ファイルである。

- `src/index.ts`
- `test/regressions.test.ts`

その後の2ファイルは実装報告・handoffであり、製品挙動は変更していない。

- `doc/report/2026-10-01-tool-operation-detail-rejected-arguments-fix.md`
- `doc/report/2026-10-01-tool-operation-detail-rejected-arguments-fix-handoff.yaml`

`rejectedArgumentProjection` は current `server.registerTool` 群と照合した。`session_list` は追加引数として comment だけを持ち、共通の500文字投影で扱われる。その他の既存ツールは switch に対応ケースがあり、入力検証拒否時に監査へ必要な既知値だけが渡される。

未検証の文字列を投影後に `operationDetail` が処理するため、前回問題となった「制限前の全量 split / decode」は解消している。

## 必須レビュー観点

- requirement and design conformance: checked_no_finding
  - 「検証前に安全に保存できる要求範囲」を有界なツール別投影で満たす。
- correctness and edge cases: checked_no_finding
  - oversized comment、patch本文、upload data を実経路で確認。
- scope discipline: checked_no_finding
  - REV-001と直接の兄弟ケースだけを修正。無関係な製品変更なし。
- changed files and direct dependencies: checked_no_finding
  - MCP SDK の入力検証が tool handler より前に行われ、エラー応答になる前提を継続確認。
- API / data / configuration / workflow compatibility: checked_no_finding
  - 公開ツール応答契約は変更せず、拒否時監査用の内部投影だけを追加。
- error handling and diagnostics: checked_no_finding
  - 入力検証拒否イベントを維持したまま、監査対象値だけを安全化。
- security and secret handling: checked_no_finding
  - 未検証の可変長入力が通常スキーマ上限を迂回して無制限保存・再処理される経路を解消。
- tests and validation adequacy: checked_no_finding
  - focused 3件が current HEAD で pass。exact-head CI 全job success。
- current-HEAD CI: checked_no_finding
  - run `36821469506` の `headSha` は current HEAD と完全一致。
- report / documentation accuracy: checked_no_finding
  - 実装報告は technical HEAD と publication HEAD を区別し、publication結果はPRコメントで補完している。
- regression and maintainability: checked_no_finding
  - 安全投影を1メソッドへ集約し、未知フィールドを既定で保存しない構成。

## ローカル検証

current HEAD `4fcb89a5a753490fb63a6e202843cc2ae1a40797` で reviewer が再実行した。

- `npm run lint`: pass
  - TypeScript lint: pass
  - Markdown lint: 65 files / 0 issues
  - 設計文書許可語 lint: pass
- `npm run check`: pass
- `npm run build`: pass
- `git diff --check`: pass
- `node --import tsx --test "--test-name-pattern=schema validation rejection" test/regressions.test.ts`: 3 pass / 0 fail / 0 skip
- 作業ツリー: clean

実装担当の technical HEAD ローカル full gate では `npm test` が 105 tests / 103 pass / 1 fail / 1 skip だった。失敗は既存 `Issue 13: published tool descriptions match session, file-root, transfer, and process boundaries` 終了後の非同期 `lstat` が fixture cleanup 後の一時 data ディレクトリへ到達して発生する `ENOENT` unhandledRejection であり、今回追加した3テストは full suite 内でも pass している。Issue 13 単独は 1 pass / 0 fail と報告されている。

この local full-suite 競合は held として残す。

## CI

PR current HEAD と run の `headSha` が完全一致する run だけを使用した。

- reviewed current HEAD: `4fcb89a5a753490fb63a6e202843cc2ae1a40797`
- workflow run: `36821469506`
- event: `pull_request`
- headSha: `4fcb89a5a753490fb63a6e202843cc2ae1a40797`
- conclusion: success

job:

- Ubuntu: success
- Windows shard 1/3: success
- Windows shard 2/3: success
- Windows shard 3/3: success

run の診断 artifact 件数は4件である。

`.github/workflows/lint.yml` は結果、標準出力、標準エラー、環境情報を保存する診断 artifact workflow を持つため、追加変更は不要だった。

## Held

### Existing Issue 13 asynchronous fixture cleanup race

- origin: pre_existing
- owner: existing repository test infrastructure
- evidence:
  - technical HEAD の repository-wide local `npm test` は 103 pass / 1 fail / 1 skip。
  - 失敗は fixture cleanup 後の非同期 `lstat` / `ENOENT`。
  - Issue 13 単独は pass。
  - REV-001 focused tests は current HEAD で 3/3 pass。
  - current HEAD exact-head repository CI は全4 job success。
- verdict impact: non-blocking held

## Unexplored

なし。

## Remaining risks

- 既存 Issue 13 のローカル full-suite 非同期競合は別作業として残る。
- 将来ツールを追加する場合は `rejectedArgumentProjection` と通常 input schema の境界を同時に更新する必要がある。

## 次の作業

通常レビューの finding はすべて解消確認済み。PR #33 は independent final review へ進められる状態である。

このレビューは merge を行わない。
