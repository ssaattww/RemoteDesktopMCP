# RemoteDesktopMCP

単一 PC のローカル開発用 MCP サーバーです。`127.0.0.1` だけで待ち受け、
1 人の設定済みユーザーが OAuth 認可コード + PKCE で利用します。Tailscale
Funnel、Google OIDC、更新トークン、複数 PC は後続の作業であり、この版を
インターネットへ公開してはいけません。

## セットアップ

```powershell
copy .env.example .env
npm.cmd ci
npm.cmd run user:hash -- '12文字以上の固有パスワード'
```

生成したハッシュ、ローカルの `FILE_ROOTS_JSON`、十分に長い
`TOKEN_SECRET` を `.env` に設定します。`DATA_DIR` はファイル root の外に
置いてください。

## 起動と確認

```powershell
npm.cmd run build
npm.cmd start
npm.cmd run check
npm.cmd test
npm.cmd run lint
```

通常のファイル操作とプロセス操作は、固定版
`@wonderwhy-er/desktop-commander@0.2.51` の stdio MCP 接続へ委譲します。
子プロセス用の設定は `DATA_DIR` 内に隔離し、既存ユーザーの Desktop
Commander 設定を変更しません。`process_start` はこのサーバーと同じ OS
ユーザーの任意コマンドを起動できるため、その OS アカウントの信頼境界内で
だけ使用してください。
