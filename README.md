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
だけ使用してください。`process_kill` は Desktop Commander が返したルート
PID に委譲します。Desktop Commander 0.2.51 はその子孫プロセスを安全に特定
する情報を返さないため、子孫を含むプロセスツリーの停止は保証しません。
停止要求の結果を 2 秒以内に確認できない場合は、接続を再起動せず
`terminating` と `termination_unconfirmed` を返します。この状態では重複した
操作を行わず、実際に確認できた終了だけを監査へ記録します。

隔離設定の保護は、現在の設定ファイルと、サービスが private hard link で
確認済みの過去バージョンに適用されます。同じ OS ユーザーが MCP ファイル API
の外から、確認前に消えた設定バージョンのハードリンクやコピーを作成する競合は
識別できません。この競合も同じ OS アカウントの信頼境界に含まれます。
