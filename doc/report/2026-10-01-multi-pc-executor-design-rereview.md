# 複数 PC 実行ノード設計 再レビュー報告

## 対象

- Repository: `ssaattww/RemoteDesktopMCP`
- PR: `#28`
- Issue: `#25`
- Review mode: fix verification
- 前回 reviewed HEAD: `9908eb6e5ff198bfb8cea85f5a4386856767bd52`
- 今回 reviewed HEAD: `ad7fb065a99740c43453f5fab58b8bc2ef837422`
- Reviewer continuity: 前回通常レビューと同じチャット
- 判定: **fail**

今回の追加観点として、利用者指示に従い、同じ契約・状態管理・入力検証・振り分け処理を極力共通化できているかを重点確認した。

## 前回 finding の確認

### RDMCP-25-DR-001 — High — 未解消

要求は、遠隔ダウンロードで実行ノードがチャンク状態を進めた後に応答だけを失っても、同じ実行ノードへ再接続し、未受信の同じ `offset` を再要求して同じチャンクを回収できることである。

今回の修正では `src/index.ts` に `downloadReplay` が追加され、直前のダウンロードチャンクを1件だけ冪等に再送する状態遷移が実装された。最終チャンクも `complete` 後に終端情報から再送できる。設計文書も同じ契約へ更新されている。

ただし、追加された `test/regressions.test.ts` の試験は公開 MCP クライアントを閉じて同じ `RemoteDesktopService` へ接続し直す構成であり、`CoordinatorNodeServer` / `ExecutorNodeClient`、ノード間 `request` / `response`、応答送信直前または送信中の切断、再認証・再同期を通していない。

したがって、前回必須とした「実行ノード側の状態更新後にノード間応答だけを失う」実構成の故障注入証拠がない。focused test の成功だけでは、この finding の actual composition fixture を満たさない。

必要対応:

- 実行ノードの共通転送コアでチャンクを処理する。
- 実行ノードがチャンク状態を更新した後、`response` が統括ノードへ到達する前に接続を切る故障注入を行う。
- 同じ `executor_generation` で再接続・状態同期後、統括ノードが未受信の同じ `offset` を再要求し、同じデータ・`next_offset`・`complete` を取得することを確認する。
- 中間チャンクと最終チャンクの両方を確認する。
- 再送で SHA-256 計算と転送位置が二重に進まないことを確認する。

### RDMCP-25-DR-002 — Medium — 解消

`doc/design/file-paths-and-live-logs.md` が更新され、`node_list` は認証済み本人が `session_open` より前に呼べ、`session_id` は任意、指定された場合も有効性と所有者だけを検証して一覧を絞り込まない契約へ統一された。

`functional-requirements.md`、`multi-pc-architecture.md`、現実装の `node_list` と一致している。focused test `node_list is available before session_open...` も成功したため、本 finding は解消確認とする。

## 新規 finding

### RDMCP-25-DR-003 — Medium — 公開 MCP と実行ノード内部要求の共通実行コアが固定されていない

設計は「公開 MCP からローカル実行と遠隔実行を同じ振り分け契約へ集約する」「内部操作名を固定一覧へ限定する」としている。一方、現実装では次の契約が複数箇所へ分散している。

- `src/index.ts` の `requestRemote` は `operation: string` を受け取る。
- `file_search`、`content_search`、`file_read`、`file_patch` は各 `registerTool` 内で個別にローカル/遠隔分岐、内部操作名、引数組み立て、応答検証、監査を記述する。
- `ExecutorNodeClient` の `onRequest` は `payload: unknown` の汎用 callback であり、内部操作の型・入力形式・応答形式・能力分類を共有定義していない。
- 今回の `downloadReplay` も公開 MCP の `file_transfer_download_chunk` 登録 callback 内に置かれており、実行ノードの内部要求処理から同じコア処理を必ず再利用する構造にはなっていない。

このまま転送・プロセスの遠隔実装を追加すると、公開 MCP 経路と実行ノード経路で同じ処理を別実装しやすい。今回の DR-001 の再送契約も、遠隔実装側で再度実装して差異が生じる可能性がある。また、固定内部操作一覧、能力分類、入力・応答検証が別々に増えると、許可境界のドリフトにつながる。

必要対応:

- MCP transport に依存しない共通の操作コアを作り、公開 MCP tool adapter と実行ノード `onRequest` adapter の両方から呼ぶ。
- 内部操作名を文字列の散在ではなく、1つの `InternalOperation` 型または操作レジストリへ集約する。
- 操作ごとに、必要 capability、入力 schema、応答 schema、共通 handler、監査情報を可能な範囲で1か所へ集約する。
- ファイル転送の状態遷移、特に `downloadReplay` は共通 transfer service に置き、ローカルと遠隔で同じコードを使う。
- 個別 tool に固有な MCP schema/description と、transport 固有の marshal/unmarshal だけを adapter に残す。
- 構成試験で公開 MCP → 統括ノード → ノード間 transport → 実行ノード共通 handler までを通し、同じ共通 handler が使われることを確認する。

既存の `operationTarget` と `requestRemote` に対象選択・能力確認の一部を集約している点は妥当であり、この方針を操作実行コアと契約定義まで拡張する。

## Finding completeness matrix

| Finding | Required action | Production path | Actual composition fixture | Focused evidence | Disposition |
| --- | --- | --- | --- | --- | --- |
| RDMCP-25-DR-001 High | 応答喪失後の中間/最終チャンク再送 | `src/index.ts` の `downloadReplay` / `file_transfer_download_chunk` | **不足**。追加試験は外部 MCP 再接続のみでノード間 transport を通さない | focused test は成功 | 未解消 |
| RDMCP-25-DR-002 Medium | `node_list` の session 前提を統一 | 設計文書 + 既存 `node_list` 実装 | `test/multi-pc-mcp.test.ts` の session 前呼び出し | focused test 成功 | 解消 |
| RDMCP-25-DR-003 Medium | 公開/遠隔の操作コアと操作契約を共通化 | 現状は分散 | **未実装** | 該当なし | 新規 |

## 検証

reviewed HEAD `ad7fb065a99740c43453f5fab58b8bc2ef837422` で確認した。

- `npm.cmd run lint`: success
  - ESLint success
  - markdownlint: 62 files, 0 issues
  - design term check success
- `npm.cmd run check`: success
- focused test:
  - `node_list is available before session_open...`: success
  - `RDMCP-25-DR-001: lost download chunk responses can be replayed after reconnect`: success
  - 2 tests / 2 passed
- `git diff --check origin/main...HEAD`: success
- 診断ログは reviewed source 外の `C:\Users\donabe\RemoteDesktopWorkspace\review-artifacts\pr28-rereview-ad7fb06` に保存した。
- 全テストの追加実行は RDMCP `process_start` の内部失敗・タイムアウトが発生し、成功証拠を取得できなかったため、成功とは扱わない。

## CI

GitHub connector で reviewed HEAD `ad7fb065a99740c43453f5fab58b8bc2ef837422` に紐づく `pull_request` workflow run を確認したが、該当 run は存在しなかった。

したがって current HEAD は **CI 未実施** と扱う。別 SHA の run は代用しない。

## 結論

再レビュー判定は **fail**。

- `RDMCP-25-DR-001` High: actual composition fixture が不足し、実際のノード間応答喪失経路の closure ができない。
- `RDMCP-25-DR-002` Medium: 解消。
- `RDMCP-25-DR-003` Medium: 共通実行コア・内部操作契約の一元化が必要。

次回は DR-001 と DR-003 を同じ normal reviewer で限定再確認する。merge は行わない。
