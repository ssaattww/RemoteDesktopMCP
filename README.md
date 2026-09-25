# RemoteDesktopMCP

単一 PC のファイル・プロセスを操作する MCP サーバーです。`127.0.0.1` で
待ち受け、ChatGPT からの公開接続には Tailscale Funnel と Google OIDC を使います。
公開認証の設定と、この PC 上での本人登録が必要です。
複数 PC の振り分けと画面・マウス操作は提供していません。

ChatGPT から使う場合は [公開接続の設定手順](doc/remote-setup.md)へ進んでください。
実 Google アカウントと ChatGPT の接続確認は、認証設定を作成した後に行います。

以下は開発用パスワード認証の手順です。このモードは公開できません。
既存の Funnel が転送しているポートでは開発用サービスを起動しないでください。

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

設定 pin と upload 所有 manifest の file identity は bigint から得た10進文字列で
保存します。旧版の数値 manifest は安全な整数で、保持済み private pin または
一時ファイルと正確に一致する場合だけ移行します。安全に照合できない旧 manifest
は起動を停止し、既存の user-root 一時ファイルを推測して削除しません。ローカル
state を確認し、private pin から正確な記録を復旧できる場合は復旧してから再起動
してください。manifest を削除すると過去設定の保護と upload 所有証明を失うため、
既知の設定別名と orphan 一時ファイルの内容を確認して fresh local state を作る
場合だけ行ってください。

安全な旧数値でも、config pin が現在の private pin と一致しなければ起動を停止
します。upload の安全な旧数値が user-root の一時ファイルと一致しない場合は、
そのファイルを残して manifest の所有記録だけを破棄します。どちらも別 inode を
保護対象や削除対象と誤認しないためです。
