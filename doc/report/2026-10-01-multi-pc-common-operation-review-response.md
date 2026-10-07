# 複数 PC 共通操作コア 指摘対応中間報告

## 対象

- プルリクエスト: #28
- 対象指摘: `RDMCP-25-DR-001`、`RDMCP-25-DR-003`
- 静的確認開始時 HEAD: `6dc92f5932e7eacce0c45fa24fcddf9735dca42a`

## 対応済み内容

`RDMCP-25-DR-001` 向けに、実際の `CoordinatorNodeServer` と `ExecutorNodeClient` を接続した構成試験を追加した。
実行ノードでダウンロード状態を更新した後に応答だけを失わせ、同じ実行ノード世代で再接続して同じ位置を再要求する中間・最終チャンク経路を試験する。

`RDMCP-25-DR-003` 向けに `src/node-operation.ts` を追加し、現在実装済みのファイル操作とダウンロード系操作について次を共通契約へ集約した。

- 内部操作名
- 必要な操作区分
- 入力形式
- 応答形式
- 監査種別
- セッション必須有無

ノード間 transport は `NodeOperationRequest` を受け、実行ノード境界で `parseNodeOperationRequest` を通す。
公開 MCP から遠隔 `file_read` 等を実行する構成試験では、統括ノード、認証済みノード間通信、実行ノードの `executeNodeRequest`、共通 handler までを通す。

## 静的確認で残っている共通化

current HEAD では upload と process の公開 MCP 経路がまだ従来の個別実装を直接保持しており、`NODE_OPERATION_CONTRACTS` と `executeNodeOperation` には全操作が集約されていない。

したがって `RDMCP-25-DR-003` は現時点では完了扱いにしない。
次の論理単位で upload / process も同じ内部操作契約と共通実行処理へ寄せ、公開 MCP adapter と実行ノード adapter の処理重複を減らす。

## 検証状態

RemoteDesktopMCP のローカル `process_start` とファイル操作が現在失敗し、Remote Desktop Commander も接続端末がないため、ローカル実行検証は未実施。

GitHub Actions についても `6dc92f5932e7eacce0c45fa24fcddf9735dca42a` と `head_sha` が一致する workflow run は0件であり、別 SHA の成功 run は検証証拠に使用しない。
