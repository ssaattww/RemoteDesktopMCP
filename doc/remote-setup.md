# ChatGPT からこの PC を操作する設定

この手順は、Google 認証を使い、Tailscale Funnel 経由で1台の Windows PC に接続するためのものです。
Google の設定と本人ログインを終えるまで、ChatGPT からの操作は利用できません。
開発用のパスワード認証を公開接続に使わないでください。

## Google 側で用意するもの

1. [Google Cloud の認証設定](https://console.cloud.google.com/auth/overview)で、このサービス用のプロジェクトを選択または作成します。
2. 同意画面にサービス名と連絡先を設定します。個人用で公開前のテスト状態を使う場合は、利用する自分の Google アカウントをテストユーザーに追加します。
3. OAuth クライアントを作成し、種類はウェブアプリケーションを選びます。
4. 承認済みのリダイレクト URI に、次の2件を正確に登録します。末尾の `/` を追加しないでください。

   - `https://fa780.tail8bf1af.ts.net/google/callback`
   - `http://localhost:8765/callback`

5. 作成したクライアントの設定を JSON として保存します。ファイル操作を許可するフォルダと、このリポジトリの外へ保管してください。

1件目は ChatGPT から接続するときの本人確認、2件目はこの PC 上で自分のアカウントを登録するときに使います。
Google のクライアントシークレットを ChatGPT の接続設定やチャットへ貼る必要はありません。
Google 側の作成方法とリダイレクトの条件は [Google の公式手順](https://developers.google.com/identity/openid-connect/openid-connect)も参照してください。

## この PC 上で設定する

PowerShell でこのリポジトリを開き、依存と実行ファイルを用意します。

```powershell
Set-Location 'C:\Users\donabe\Project\RemoteDesktopMCP'
npm.cmd ci
npm.cmd run build
```

設定用コマンドに Google の JSON ファイル、公開 URL、許可フォルダを渡します。
次の JSON のパスは、実際に保存したファイルへ置き換えてください。

```powershell
npm.cmd run remote-auth -- configure 'C:\Users\donabe\Downloads\google-client.json' --base-url 'https://fa780.tail8bf1af.ts.net' --root 'C:\Users\donabe\RemoteDesktopWorkspace'
```

ファイル操作の許可範囲には専用フォルダ `C:\Users\donabe\RemoteDesktopWorkspace` を使うことを推奨します。
設定や監査を置く `DATA_DIR`、`.env`、Google の設定ファイルを許可範囲へ含めないでください。
プロセス操作は、このサービスを実行する Windows ユーザーの権限で任意コマンドを実行できます。
ファイル用の許可フォルダは、プロセス操作に対する隔離機能ではありません。

次に、この PC で本人登録用コマンドを実行し、表示された Google の認証画面で自分のアカウントを選びます。
サービスが既に起動している場合は、先に停止してください。

```powershell
npm.cmd run remote-auth -- authorize-google
```

Google の画面で選んだアカウントと、PowerShell に表示される本人情報を確かめ、`approve` と入力して登録を確定します。
登録後にサービスを起動または再起動します。
公開 URL へ最初にログインした人が自動登録される仕組みはありません。

## サービスを起動する

Google の本人登録が完了した後に起動します。

```powershell
npm.cmd start
```

この端末を閉じるとサービスも停止します。停止するときは `Ctrl+C` を使います。
再起動は同じフォルダから同じコマンドで行い、`.env` と `DATA_DIR` を保持してください。
PC の電源が切れている間やスリープ中は操作できません。

別の PowerShell で公開設定を確認します。

```powershell
tailscale funnel status
```

この PC では調査時点で、`https://fa780.tail8bf1af.ts.net` から `http://127.0.0.1:3000` への転送が設定済みでした。
既存の転送がある場合、追加設定は不要です。
サービスの起動と Google 認証の確認が済んでから、公開 URL の認証情報の案内が返ることを確認します。
URL の応答だけで操作成功と判断せず、次の ChatGPT からの操作まで確認してください。

## ChatGPT に接続先を追加する

ChatGPT の開発者モードを有効にし、MCP 接続の作成画面で公開接続を選びます。
接続先は次の URL です。

```text
https://fa780.tail8bf1af.ts.net/mcp
```

認証方式は OAuth、クライアントの識別方式を選べる場合は CIMD を使います。
Google で本人確認を行い、この PC で登録した同じアカウントで操作を許可します。
Google のクライアント ID とシークレットを、ChatGPT のクライアント情報として入力しないでください。
ChatGPT の接続画面や開発者モードの利用可否はアカウント設定に依存します。
[OpenAI の接続手順](https://developers.openai.com/plugins/deploy/connect-chatgpt)で現在の画面を確認できます。

接続を会話へ追加し、まず次のように依頼します。

> 操作セッションを開始して、接続している PC の一覧を表示してください。

次に許可フォルダへ自分で置いたテスト用テキストファイルの読み取りを依頼します。
`session_open`、`node_list`、`file_read` の実行結果を確認して、初めて接続成功とします。
サービスを再起動した後も、接続を作り直さずに認証を更新して操作できるか確認してください。
`node_list` の `root_ids` で、ファイル操作に使う `root_id` を確認できます。
上の設定コマンドで作成する許可フォルダの ID は `workspace` です。

## 接続できない場合

| 症状 | 確認する内容 |
| --- | --- |
| 公開 URL が応答しない | サービスの起動、Tailscale の接続、PC の電源と転送先ポート3000 |
| Google でリダイレクトのエラー | 上記2件の URI が完全一致し、同じ OAuth クライアントを読み込んだか |
| 本人登録が接続待ちになる | この PC のブラウザで操作しているか、ポート8765が別用途で使用中でないか |
| Google ではログインできるが操作を拒否される | この PC で登録したアカウントと同じか。別アカウントへ自動的に切り替えない |
| 再起動で認証をやり直す必要がある | `.env` の署名用設定と `DATA_DIR` を保持したか。認証中の再起動は最初からやり直す |

秘密を含む `.env`、Google JSON、トークン、認可コードを問題報告へ添付しないでください。
