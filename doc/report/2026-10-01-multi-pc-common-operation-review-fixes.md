# 複数 PC 共通操作基盤 レビュー指摘対応レポート

## メタデータ

- 日付: 2026-10-01
- リポジトリ: `ssaattww/RemoteDesktopMCP`
- ブランチ: `issue-25-design`
- ベース: `main`
- 対象プルリクエスト: #28
- 指摘元レビュー HEAD: `ad7fb065a99740c43453f5fab58b8bc2ef837422`
- 指摘対応の技術 HEAD: `6214352db8d30bbc7f95feaa21f63255e6de4a29`
- 実装モード: review follow-up
- 検証能力: `remote_ci_only`

## 対象指摘

### RDMCP-25-DR-001 — High

前回追加した `downloadReplay` は単体の状態遷移を確認していたが、`CoordinatorNodeServer` → `ExecutorNodeClient` の認証済みノード間経路で応答だけを喪失させる実構成試験が不足していた。

対応:

- `test/multi-pc-mcp.test.ts` に実際の `CoordinatorNodeServer` と `ExecutorNodeClient` を接続する構成試験を追加した。
- 実行ノード側の共通処理が中間チャンクを読み、転送位置と SHA-256 状態を更新した後、応答を送る前に接続を閉じる故障注入を追加した。
- 同じ `executor_generation` と `desktop_commander_generation` を維持したクライアントで再接続し、統括側が未受信の同じ `offset` を再要求する。
- 中間チャンクと最終チャンクの両方で、同じデータ、同じ次位置、同じ完了有無を再取得する試験を定義した。
- 最終チャンクは読み取り用複製の清掃後でも `downloadReplay` から再送できる契約を試験する。

### RDMCP-25-DR-003 — Medium

公開 MCP、統括ノード側の遠隔振り分け、実行ノード側の `onRequest` に操作名、入力形式、応答形式、能力判定、状態遷移が分散していた。

対応:

- `src/node-operation.ts` を追加し、固定内部操作の operation registry を作成した。
- operation registry に操作区分、入力 schema、応答 schema、監査種別、セッション必須有無を集約した。
- `requestRemote` の操作名を `string` から `NodeOperationName` へ変更し、能力判定を registry から取得するようにした。
- `CoordinatorNodeServer.request` と `ExecutorNodeClient.onRequest` を `NodeOperationRequest` に固定した。
- 実行ノードの transport 境界で `parseNodeOperationRequest` を実行し、未知操作や不正入力を共通処理へ渡さないようにした。
- `RemoteDesktopService.executeNodeRequest` と内部 `executeNodeOperation` を共通実行経路として追加した。
- 現在遠隔対応対象になっている検索、読取、部分編集、ダウンロード開始・チャンク・状態確認・中断を共通処理へ集約した。
- ダウンロードの位置更新、SHA-256 更新、`downloadReplay` を含む状態機械を共通実行処理へ移した。
- 任意の Desktop Commander ツール名を実ノード間 transport に送って `NODE_REQUEST_FAILED` になる境界試験を追加した。
- operation registry の capability、入力 schema、応答 schema を固定する試験を追加した。

## 実装コミット

| Commit | 内容 |
| --- | --- |
| `8cd0fec5937ee0570082acf88346e7aa823b6d89` | 実構成の共通操作・応答喪失試験を先行追加 |
| `877ba1fa00e951ad8f22eeddbd733abb7a99f58e` | 共通 operation registry と共通実行処理を追加 |
| `0bf7d5973693c6da17369edfd6d147d33a5aedfa` | executor transport 境界を型付き操作要求へ固定 |
| `c09239927483fe7a05680df541d1208297e54adb` | 共通操作基盤と実構成故障注入の設計契約を文書化 |
| `6dc92f5932e7eacce0c45fa24fcddf9735dca42a` | transport 試験のセッション識別子を共通 parser 契約へ適合 |
| `6214352db8d30bbc7f95feaa21f63255e6de4a29` | 未定義操作拒否と registry schema の境界試験を追加 |

## TDD 状態

実構成試験は `8cd0fec...` で実装コミット `877ba1f...` より先に追加した。

ただし現在の実行環境では RDMCP の `process_start` が `Process start failed.` となり、Remote Desktop Commander の全端末も offline である。さらにテスト先行 HEAD に完全一致する GitHub Actions run が発生しなかった。このため、テストを先に配置した Git 履歴は存在するが、RED の実行結果は観測できていない。RED を確認済みとは扱わない。

## 検証

### 実行環境

- RDMCP: ファイル系操作は利用できたが `process_start` は最小コマンドでも `Process start failed.`。
- Remote Desktop Commander: 確認時点で全端末 offline。
- よってローカルの lint、型検査、build、focused test、全テストを current HEAD に対して実行できていない。

### GitHub Actions

- 技術 HEAD `6214352db8d30bbc7f95feaa21f63255e6de4a29` に一致する workflow run: 0件。
- CI は未実施として扱う。
- 過去 SHA の成功 run は代用していない。
- `.github/workflows/lint.yml` には失敗調査用のテスト結果、標準出力、標準エラー、環境ログを保存する artifact 構成が既にあるため、今回の指摘対応では workflow を変更していない。

### 静的確認

GitHub 上の PR 差分について次を確認した。

- `NODE_OPERATION_CONTRACTS` が存在する。
- executor request 境界で `parseNodeOperationRequest(frame.payload)` を使用する。
- RDMCP-25-DR-001 の actual composition fixture が存在する。
- 任意 Desktop Commander ツール名の transport 境界拒否試験が存在する。
- 共通内部操作契約と共通実行処理を要求する設計記述が存在する。
- PR 差分の追加行に末尾空白を検出していない。

これらはソース構造の確認であり、コンパイル・テスト成功の代替ではない。

## 設計更新

`doc/design/functional-requirements.md`、`doc/design/multi-pc-architecture.md`、`doc/workflow/multi-pc-executor-registration-workflow.md` に次を追加した。

- 公開 MCP のローカル経路と遠隔実行ノード経路は同じ内部操作契約と共通実行処理を使う。
- transport 層は認証、フレーム検証、接続管理、要求と応答の対応付けに限定する。
- ファイル操作、転送状態、プロセス所有の状態機械を transport 層へ重複実装しない。
- actual composition fixture で中間・最終チャンクの応答喪失と同一世代再接続を検証する。

## 意図的に未変更の範囲

- 遠隔アップロードの公開 ID と `remote_transfer_id` の対応は、このレビュー指摘対応だけでは実装していない。
- 遠隔プロセス操作の `remote_process_id` 管理は、このレビュー指摘対応だけでは実装していない。
- 使用者停止状態の実行ノード同期など、複数 PC 実装全体の残工程は別途残る。
- これらを未完成のまま「複数 PC 実装完了」とは扱わない。

## 残存リスクと未確認事項

- current HEAD はコンパイル・実行試験未確認。
- RDMCP-25-DR-001 の実構成故障注入試験は追加済みだが未実行。
- RDMCP-25-DR-003 の共通操作境界試験も追加済みだが未実行。
- operation registry は現在遠隔対応候補になっているファイル操作とダウンロード系を中心に共通化している。今後アップロード・プロセスを遠隔対応する際も、設計契約どおり同じ registry と共通実行処理へ追加する必要がある。
- current HEAD に一致する CI 証跡がないため、指摘解消の技術的合格判定はまだできない。

## 次の操作

1. 利用可能な実行経路が復旧したら `npm run lint`、`npm run check`、`npm run build`、対象 focused test、全テストを current HEAD で実行する。
2. 失敗時は既存の診断 artifact 契約に従い stdout、stderr、テスト結果、必要ログを保存して原因調査する。
3. PR current HEAD と完全一致する `pull_request` workflow run を確認する。一致 run がなければ引き続き CI 未実施とする。
4. 同一 finding ID のまま通常再レビューへ戻し、RDMCP-25-DR-001 と RDMCP-25-DR-003 の解消確認を依頼する。
5. merge は利用者が行う。
