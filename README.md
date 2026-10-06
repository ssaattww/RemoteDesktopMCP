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

使用者コンソールは `/user`、管理者コンソールは `/admin` です。
`.env` の `ADMIN_USERS` に管理者をカンマ区切りで指定して再起動してください。
ローカルの password モードでは登録済みのメールアドレス、公開用の google
モードでは承認済み Google アカウントの subject ID（`sub`）を指定します。
未設定では誰も管理画面にログインできません。公開環境では Google でログインし、
管理者指定とアカウントの承認状態を閲覧のたびに確認します。

管理者コンソールではサーバー状態と認証・セキュリティ監査を確認できます。
通常のツール呼び出し履歴やコマンド出力は管理者画面に表示せず、使用者コンソール
で本人だけが確認できます。使用者のログイン方法はローカル開発ではパスワード、
公開環境では承認済み Google アカウントです。

使用者コンソールには本人のセッション一覧を表示します。各行の先頭から詳細ページを開け、作成日時と最終アクセス日時を確認できます。有効なセッションだけを表示するフィルターをブラウザーに保持できます。履歴は SSE の新着通知を受け、使用者が更新ボタンを押したときだけ本文を取得して表示します。各セッションの操作履歴とコマンド出力は詳細ページで確認でき、出力は初期状態で畳まれます。
履歴には受信・開始・終了時刻、実行時間、Tool、状態、対象概要を含み、既存の
コマンドと出力の詳細も本人の画面に移しています。履歴は `DATA_DIR/audit.jsonl`
に保存し、サーバーの共有索引は直近20,000イベント、ブラウザーは最大1,000イベントを保持します。出力は各記録の先頭4,000文字
まで保存します。既知の認証情報はマスクしますが、任意の出力に含まれる秘密情報を
すべて検出するものではありません。追加前に保存されていない出力は復元しません。

「EMERGENCY STOP」はログイン中の使用者に属する新規実行を遮断し、既存接続を
無効化して、把握できる実行中プロセスに終了を要求します。再起動後も停止状態を
維持し、本人が使用者コンソールで再開した後も停止前の接続は使えません。停止は
実行を中断したと表示するものではありません。Windows では専用ランナーが管理する
プロセスと子孫を Job Object に所属させ、親プロセスが先に終了しても所有関係を保って
停止します。所有管理を準備できない場合は管理外の起動へ切り替えず拒否します。
他の OS では子孫プロセス全体の停止を保証しません。いずれの OS でも、プロセス終了を
確認できない場合は一覧にその状態を表示します。完了済みのファイル変更などの副作用は
取り消せません。

```powershell
npm.cmd run build
npm.cmd start
npm.cmd run check
npm.cmd test
npm.cmd run lint
```

通常のファイル操作とプロセス操作は、固定版
`@wonderwhy-er/desktop-commander@0.2.51` の stdio MCP 接続へ委譲します。

## ファイル操作のパス基準

`file_search`、`content_search`、`file_read`、`file_patch`、`file_transfer_*` は、
`root_id` で選んだ設定済み root を基準にします。`relative_path` はその root
からの相対パスであり、同じ session の `working_directory` を基準にしません。
`node_list` の `roots` で各 `root_id` の `absolute_path` を確認してください。
転送の upload begin、download begin、upload commit でも、対象の
`resolved_path`、`root_id`、`path_base: "root"` を返します。

`process_start` だけは session の `working_directory` からコマンドを開始します。
ファイル操作とプロセス操作で同じ相対パスを使う場合は、それぞれの基準が一致する
ことを確認してください。

RemoteDesktopMCP 専用の Desktop Commander 設定と private cache は `DATA_DIR` 内に隔離し、
既存ユーザーの Desktop Commander 設定を変更しません。
`DATA_DIR` 自体は親フォルダから権限を継承できます。認証状態と監査ログの
ファイルは、本人・SYSTEM・Administrators のみがアクセスできる設定を維持します。
Desktop Commander と
`process_start` の子プロセスは、サーバー起動時の `USERPROFILE`、`APPDATA`、
`LOCALAPPDATA`、`HOME` などのユーザー環境を継承し、CLI ごとの設定先は
上書きしません。`process_start` はこのサーバーと同じ OS ユーザーの任意コマンドを
起動できるため、その OS アカウントの信頼境界内でだけ使用してください。Windows では
起動した子プロセスを専用ランナーで Job Object に登録します。ルートプロセスが先に終了しても
Job Object が子孫の所有関係を維持し、Emergency Stop の停止対象にします。専用 C# ランナーは
private な `DATA_DIR` に生成し、Windows .NET Framework コンパイラで作成できない場合や
Job Object による所有管理を準備できない場合は、起動を拒否します。一般的な管理下プロセスと
子孫は、Emergency Stop で停止対象になります。
同じ OS 権限による意図的な管理外への移動や、独立したサービスへ依頼した処理は対象外です。
`process_kill` は Desktop Commander が返したルート PID に対する終了要求です。
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
