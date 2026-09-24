# 単一PC最小版の実装

## Dispatch

Requested: gpt-5.6-terra / high; explicit user override. Fresh context, tool default role with no exposed role override; planned profile equals request, applied null, final profile hidden. Bounded technical implementation following Sol design; cross-module and high-criticality file/auth boundaries; sequential dependencies so one implementation owner. Tasks T03-T06. No mandatory TDD policy; focused meaningful tests required.

## Scope and changes

T03〜T06 の単一 PC ローカル最小版を実装した。src/index.ts は 127.0.0.1 だけで待ち受け、1 人のローカル開発ユーザー、OAuth 認可コード、PKCE S256、短期 Bearer token を実装する。登録済み redirect URI は完全一致で確認し、認可コードは一度だけ使える。

session_open、session_list、session_close、node_list を追加した。セッションは所有者と 24 時間の idle 期限を確認し、不明な node ID と remote role 設定を拒否する。通常の file search、content search、read、部分編集、process 操作は @wonderwhy-er/desktop-commander 0.2.51 の stdio MCP 接続へ委譲する。起動時に listTools で必要な tool を確認し、検索は結果を取得してから search session を停止し、部分編集には edit_block を使う。

Desktop Commander 子プロセスには DATA_DIR 配下の HOME、USERPROFILE、APPDATA を設定する。子の設定は root だけを明示し、get_config の応答で isolated allowedDirectories を確認する。既存ユーザーの設定は変更しない。7 個の file_transfer tool は immutable private snapshot、順序付き chunk、size と SHA-256、private temp file、hard link の atomic no-replace を使う。data directory、config parent、symlink を解決した root 範囲外、config file と同一 inode の hard link は拒否する。成功、拒否、失敗を audit JSONL に記録し、password、token、file bytes は記録しない。

create_file_download と downloads URL route は削除した。README と .env.example は local 起動、環境変数、process_start の同一 OS ユーザー信頼境界を説明する。

## Validation and source identity

Windows / PowerShell、C:\Users\donabe\Project\RemoteDesktopMCP、branch feat/tailscale-funnel-design-lint で確認した。環境確認時の Node は v24.20.0 であり、実装は Node 22 の型定義を使用する。

npm.cmd run check、npm.cmd run build、npm.cmd test、npm.cmd run lint はすべて pass した。test は 3 件である。各 fixture は isolated temporary DATA_DIR を作り、固定版 Desktop Commander を実際に起動して listTools と get_config を実行した。HTTP 経路では DCR、password login、authorization code、PKCE、one-use token を確認し、Streamable HTTP MCP client で認証済み session_open を呼んだ。transfer test は begin 後に source を同サイズ、同 mtime の別内容へ変更しても snapshot bytes が返ること、no-overwrite upload の commit 前に競合 file を作ると競合 file を残して失敗することを確認した。process test は stdout と stderr の marker が同じ combined output にあり、観測した exit code 0 を返すことを確認した。

npm audit omit dev は 0 vulnerabilities で終了した。Desktop Commander 0.2.51 の固定 pin は保持し、upstream の sharp 0.34.5 と exceljs 経由の uuid 8.3.2 に対して package override を追加した。sharp は 0.35.4、uuid は 11.1.1 を使う。uuid は exceljs が require uuid の v4 だけを利用する既知の経路であり、override 後の live Desktop Commander smoke と全 test を再実行した。

## Findings matrix

RDMCP-DR-001 は snapshot fixture が pass し、begin 時点の bytes を返した。RDMCP-DR-002 は race fixture が pass し、no-overwrite の競合 destination を残した。RDMCP-DR-003 は configuration fixture が pass し、protected config parent と root の overlap を Desktop Commander 起動前に拒否した。

## Limitations and next action

この最小版はローカル開発用である。Google OIDC、CIMD、refresh token、複数 PC、Tailscale Funnel の有効化と公開検証は実装していない。process_start は同じ OS ユーザーの任意 command を実行できるため、file root の制限は任意 command のアクセスを隔離しない。

Windows の no-overwrite は Node の link が提供する hard link に依存する。対象 directory で hard link を利用できない場合、commit は失敗して destination を変更しない。次の作業は通常レビューであり、最終候補に対して同じ validation command を再実行する。
