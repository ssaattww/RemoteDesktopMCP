# PR #1 ファイル転送・構成図 設計更新

## メタデータ

- リポジトリ: `ssaattww/RemoteDesktopMCP`
- PR: #1
- 作業開始 HEAD: `95ec1874e6fe82d92d2d77253cfe83a6ccbf1865`
- technical HEAD: `e11fc23c12aa17e3d95bbfd623c90ea862c01feb`
- ブランチ: `feat/tailscale-funnel-design-lint`
- 実行環境: FA780
- 実装: なし。設計文書だけ更新

## 全体構成図

`multi-pc-architecture.md` の構成図へ、
ChatGPT / OpenAI 側の MCP Connector を明示した。

接続経路は次のとおり。

ChatGPT
→ MCP Connector
→ HTTPS / MCP
→ Tailscale Funnel
→ 統括ノードPC上の RemoteDesktopMCP
→ Desktop Commander または遠隔実行ノード

MCP Connector は ChatGPT / OpenAI 側にあり、
RemoteDesktopMCP の MCP サーバー本体は利用者側PCで動作する。

## Desktop Commander のサーバー設定ファイル

Desktop Commander のサーバー設定ファイルは、
RemoteDesktopMCP の通常ファイル操作対象から除外する設計を追加した。

対象外とする操作:

- `file_search`
- `content_search`
- `file_read`
- `file_patch`
- すべての `file_transfer_*`

各実行ノードは設定ファイルの実体パスをローカル設定として保持する。
可能な限り Desktop Commander と RemoteDesktopMCP の
許可ディレクトリ外へ配置する。

検索範囲自体に設定ファイルを含めない。
設定ファイルを走査してから結果だけ隠す方式にはしない。

この保護は RemoteDesktopMCP の file API と転送APIに対するものとする。
同じOSユーザー権限で動く `process_start` の任意コマンドまで
追加隔離する設計にはしていない。

## 双方向ファイル転送

Desktop Commander / RDC 自体には、
遠隔クライアント向けの汎用バイナリ転送を追加しない。

転送は RemoteDesktopMCP 独自機能として設計した。
初期版では追加HTTP公開口を使わず、
既存の MCP 接続上でチャンクを送受信する。

公開予定ツール:

- `file_transfer_download_begin`
- `file_transfer_download_chunk`
- `file_transfer_upload_begin`
- `file_transfer_upload_chunk`
- `file_transfer_upload_commit`
- `file_transfer_status`
- `file_transfer_cancel`

転送開始時に `transfer_id` を発行する。
`transfer_id` は `session_id` と `node_id` に固定し、
後続操作で転送先ノードを変更できないようにする。

## 転送データと整合性

ファイル本体は base64 のチャンクとして MCP 上で送受信する。
チャンクサイズはサーバーが返し、初期値は256 KiBを目安とする。

ダウンロード開始時に次を返す。

- ファイル名
- サイズ
- SHA-256
- チャンクサイズ
- `transfer_id`

転送中に元ファイルのサイズまたは更新時刻が変化した場合は、
同一転送を成功として継続しない。

アップロードは転送先と同じディレクトリの一時ファイルへ書き込む。
全チャンク受信後にサイズとSHA-256を確認し、
一致した場合だけ転送先へ置き換える。

既存ファイルの上書きは明示指定がある場合だけ許可する。
失敗・中断・期限切れの場合は完成ファイルを変更せず、
一時ファイルを削除する。

## 複数PCでの転送

統括ノード自身が対象の場合は、
統括ノード上で転送チャンクを処理する。

遠隔実行ノードが対象の場合は、
統括ノードが既存のノード間接続で
`transfer_id` とチャンクを中継する。

遠隔実行ノードを外部公開しない。
ChatGPT から見える接続先は、
通常のツール呼び出しと同じく統括ノード1台だけとする。

現在の `create_file_download` と `/downloads/:token` は
正式な転送方式として残さず、
`file_transfer_*` へ置き換える設計とした。

## Desktop Commander 再利用との関係

検索、通常読取、部分編集、プロセス操作は引き続き
Desktop Commander へ委譲する。

ファイル転送のみ、
任意バイナリの分割送受信に必要な
バイト列の読込みと一時ファイル書込みを
RemoteDesktopMCP が担当する例外とした。
この例外から通常の検索、編集、一般ファイル管理へ
RemoteDesktopMCP の責務を広げない。

## 検証

technical HEAD と同一内容で次を確認した。

- `npm run lint`: pass
- markdownlint: 28 files / 0 issues
- design terminology lint: pass
- design unknown terms: 0件
- `npm run check`: pass
- `npm run build`: pass
- `npm audit --audit-level=low`: 0 vulnerabilities
- `git diff --check`: pass

report / handoff を追加したpublication候補でも、`npm run lint` は29 files / 0 issuesでpassした。
handoff YAML parse、`npm run check`、`npm run build`、`npm audit --audit-level=low`、`git diff --check` もpassした。

追加したホワイトリスト候補は、
OpenAI、Connector、バイナリ、バイナリファイル、
サイズ、ファイルサイズ、チャンク、チャンクサイズ、
ダウンロード、アップロード、KiB、テキスト、データ、
シンボリックリンク。

不自然な英語表現は日本語へ変更し、
lint回避だけを目的とした引用やコード表記は使っていない。

## マージ境界

マージは行わない。
