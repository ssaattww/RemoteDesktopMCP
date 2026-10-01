# 複数 PC 共通操作基盤 レビュー指摘対応レポート

## メタデータ

- 日付: 2026-10-01
- リポジトリ: `ssaattww/RemoteDesktopMCP`
- ブランチ: `issue-25-design`
- ベース: `main`
- 対象プルリクエスト: #28
- 指摘元レビュー HEAD: `ad7fb065a99740c43453f5fab58b8bc2ef837422`
- 指摘対応の技術 HEAD: `6134288bc231a63dce5dcb9a50b02c47a1bc8446`
- 実装モード: review follow-up
- 検証能力: `local_execution_available`

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
- 検索、読取、部分編集、ダウンロード、アップロード、プロセス操作の内部処理を共通実行処理へ集約した。
- ダウンロードの位置更新、SHA-256 更新、`downloadReplay`、アップロードの一時ファイル・確定処理、プロセス所有・状態監視を共通実行処理へ移した。
- 公開 MCP 側の upload / process は薄い adapter とし、ローカル実行では同じ operation registry と共通 handler を呼ぶようにした。
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
| `e8da598f93b48292600641ca34b94d8c58dee578` | 応答喪失試験の要求期限と rejection 捕捉を安定化 |
| `c0ba7083b728b6efbb658d93611b2396f3194664` | ノード応答喪失を決定的に再現する fixture へ改善 |
| `24f6a9daf1856700e0d4a34823c568b6b275844b` | upload の registry・状態機械・公開 adapter を共通化 |
| `831e95a8d43ce3ceb710cde22247a3fe7723b5ce` | 設計用語 lint の列挙表現を修正 |
| `6134288bc231a63dce5dcb9a50b02c47a1bc8446` | process の registry・状態監視・公開 adapter を共通化 |

## TDD 状態

実構成試験は `8cd0fec...` で実装コミット `877ba1f...` より先に追加した。

RDMCP の `process_start` 復旧後に TDD と回帰検証を再開した。

- RDMCP-25-DR-001 は actual composition 試験の初回実行で `NODE_OUTCOME_UNKNOWN` を再現した。原因を切り分け、通常の download begin を誤って1秒で期限切れにしないことと、意図的な切断 rejection を発生時点から捕捉するよう fixture を修正した後、単独試験 1/1 が成功した。
- RDMCP-25-DR-003 の upload 共通 handler 試験は、共通 registry 実装前に `Node operation is not supported.` で失敗することを確認し、その後の共通化実装で成功へ転じた。
- process 共通 handler と registry の focused test は共通化後に 2/2 成功した。

応答喪失試験の最初期コミット `8cd0fec...` については当時実行経路が利用できず、当該コミットそのものの RED 実行証跡はない。今回復旧後の失敗・成功記録を検証根拠とする。

## 検証

### 実行環境

RDMCP の `process_start` は復旧し、技術 HEAD `6134288bc231a63dce5dcb9a50b02c47a1bc8446` の内容に対してローカル検証を実行できた。

- `npm run lint`: 成功。Markdown 64ファイル、0 issue。設計用語検査も成功。
- `npm run check`: 成功。
- `npm run build`: 成功。
- 複数PC focused tests: 25/25 成功。
- upload / process 既存回帰試験: 4/4 成功。
- 全テスト: 124件中123件成功、1件はPOSIX専用試験のためWindowsで除外、失敗0件。
- `git diff --check origin/main...HEAD`: 成功。

### GitHub Actions

- 技術 HEAD は `6134288bc231a63dce5dcb9a50b02c47a1bc8446` で、以降のコミットは report / handoff と CI 起動確認だけを対象とする。
- PR #28 metadata と branch ref は CI 起動確認用の空コミット `1bd79ebed2d4d2644974d194e5d4d239961c1586` まで一致することを確認した。
- `1bd79ebed2d4d2644974d194e5d4d239961c1586` と一致する `pull_request` workflow run は確認時点で0件だった。
- したがって CI は未実施として扱い、過去 SHA の成功 run は代用していない。
- `.github/workflows/lint.yml` は `main` と同一で、`pull_request:` トリガーと失敗調査用のテスト結果、標準出力、標準エラー、環境ログを保存する artifact 構成を保持している。
- この report-only 訂正の push 後は branch HEAD が再度変わるため、最終 PR HEAD と一致する run の有無を PR コメントで記録する。

### 静的確認

GitHub 上の PR 差分について次を確認した。

- `NODE_OPERATION_CONTRACTS` が存在する。
- executor request 境界で `parseNodeOperationRequest(frame.payload)` を使用する。
- RDMCP-25-DR-001 の actual composition fixture が存在する。
- 任意 Desktop Commander ツール名の transport 境界拒否試験が存在する。
- 共通内部操作契約と共通実行処理を要求する設計記述が存在する。
- PR 差分の追加行に末尾空白を検出していない。

これらの静的確認に加え、上記の型検査、build、focused tests、全テストでも成功を確認した。

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

- RDMCP-25-DR-001 の actual composition 故障注入試験と RDMCP-25-DR-003 の共通 operation core 試験は実行済みで成功している。
- upload / process を含む内部 operation registry とローカル公開 MCP adapter の共通化は完了した。
- 遠隔アップロードの公開 ID と `remote_transfer_id` の対応、遠隔プロセスの公開論理IDと `remote_process_id` の対応は、このレビュー指摘対応の範囲外として未実装のままである。
- PR metadata の HEAD が branch ref へ追随しておらず、current PR HEAD と完全一致する CI 証跡をまだ取得できていない。このためレビュー指摘の最終合格判定は CI と再レビュー待ちである。

## 次の操作

1. この report / handoff 更新を push し、GitHub PR metadata の current HEAD を再取得する。
2. その current HEAD と完全一致する `pull_request` workflow run だけを確認する。一致 run がなければ CI 未実施として報告し、別 SHA を代用しない。
3. 同一 finding ID のまま通常再レビューへ戻し、RDMCP-25-DR-001 と RDMCP-25-DR-003 の解消確認を依頼する。
4. merge は利用者が行う。
