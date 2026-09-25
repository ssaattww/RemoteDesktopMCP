# ChatGPT プラグインの設定とリリース成果物

確認日: 2026-09-25。対象: PR #1 のローカル開発版と、追加する配布用プラグイン。

## 現在できることと未完了の部分

PR #1 の `8d72bb8dbc9464e03268bc5be39b72cb929f7e11` は、単一 PC の
ローカル開発版です。ローカル認証、OAuth 認可コードと PKCE、ファイルと
プロセスの操作は実装されています。Google OIDC、CIMD、更新トークン、
複数 PC、Funnel 経由の ChatGPT 接続は、既存の F01〜F03 に残っています。
この版をそのままインターネットへ公開してはいけません。

プラグインの ZIP はサーバー本体ではありません。ZIP の導入、MCP の登録、
アカウント認証、操作の許可は別々です。接続 ID が入った ZIP でも、接続確認が
完了したことにはなりません。この変更はサーバーの公開設定や認証を変更しません。

## ChatGPT 側の登録手順

以下は接続可能なサーバーが準備できた後の手順です。現在のローカル版だけでは
完了できません。Web 版で設定画面を開き、アカウントで表示される項目を確認します。

1. 設定の「Security and login」で「Developer mode」を有効にします。
2. 「Plugins」の MCP 接続作成画面を開き、名前を `RemoteDesktopMCP` にします。
   新しい画面で通常の「Add」が Plugin Creator を開く場合は、別の
   「Create MCP app」を使います。
3. 公開接続には、公開運用への対応を終えたサーバーの HTTPS の MCP URL を入力します。
   `127.0.0.1` は ChatGPT から自宅 PC を指定する URL にはなりません。
4. 実装に対応した認証方式を選び、自分の許可済みアカウントで認証します。
   現行ローカル版に Google 認証が実装済みであると扱わないでください。
5. 検出されたツール一覧を確認し、読取だけの操作から試します。
6. 作成された接続の技術 ID を取得します。開発者向け接続では、詳細画面の
   URL に含まれる `plugin_asdk_app...` が公式文書の例です。

開発者モードには Secure MCP Tunnel という非公開サーバー向けの接続方法もあります。
本リポジトリの現行認証との組合せは未検証であり、Funnel の代わりに選べば自動で
動く、という意味ではありません。

画面名、作成・アップロードの可否、読取・書込の許可は、プラン、ワークスペース、
ロール、利用画面によって変わります。「公開 RDC は使える」という事実だけから、
自作接続の可否を決めないでください。作成画面の有無、ツール検出、認証、操作許可を
分けて確認します。書込を可能にするために認証を無効化する必要はありません。

## ZIP の導入

ZIP アップロードが提供されている Web 版では、権限を持つ管理者が
「Admin > Plugins > Add > Upload plugin」から導入します。
手動アップロード版の更新には、詳細画面の「Upload new version」を使います。
項目がないアカウントで利用できると断定してはいけません。

アップロードは MCP の登録や OAuth を代行しません。接続と権限を確認した後、
通常のチャットで `@RemoteDesktopMCP`、またはツール選択から有効にして試します。
ツール定義や認証を変更した場合は MCP 接続を Refresh し、新しいチャットで確認します。

デスクトップのローカルプラグインとして試す場合は、ZIP を展開し、公式の
ローカル marketplace 手順でそのディレクトリを指定します。Web 版への ZIP 導入と
デスクトップのローカル配置は、同じ操作ではありません。

## 成果物の作り方

Python 3.11 以降の標準ライブラリだけで作成できます。出力先には新しいディレクトリを
指定します。既存の成果物への混入を避けるため、同じ出力先の再利用は拒否します。

```sh
python scripts/build_chatgpt_plugin.py --output plugin-artifacts
```

接続済み ID を組み込む場合は、次の環境変数を設定して同じコマンドを実行します。
`CHATGPT_MCP_APP_ID` の値は ChatGPT が実際に発行した ID にしてください。
ID の文字列検証は、接続先の存在や所有者の検証ではありません。

GitHub Actions では repository variable `CHATGPT_MCP_APP_ID` を使います。
OAuth シークレット、アクセストークン、PC のパスワードは設定しません。
この ID は ZIP に入るため、公開リリースなら第三者にも見えます。ID の公開が
不適切な運用では変数を設定せず、手元だけで接続 ID を組み込んでください。

常に作る成果物は次のとおりです。

- `remotedesktopmcp-chatgpt-plugin-template-v<VERSION>.zip`: 接続 ID のないテンプレート。
- `CHATGPT-SETUP.md`: この設定手順。
- `build-info.json`: 元の revision、版、接続 ID 設定の有無。実接続の検証済み表示はしません。
- `SHA256SUMS`: 上記ファイルと、存在する場合は接続 ID 入り ZIP の SHA-256。

ID が設定されている場合だけ、追加で
`remotedesktopmcp-chatgpt-plugin-v<VERSION>.zip` を作ります。
`.app.json` が実際の ID を参照し、manifest の `apps` がそのファイルを参照します。
両 ZIP とも `.codex-plugin/plugin.json` が ZIP 直下にあり、余分な親ディレクトリはありません。

生成対象は manifest、専用の SKILL.md、設定手順、生成メタデータに限定します。
`.env`、秘密鍵、トークン、DATA_DIR、実行ログ、依存パッケージは取り込みません。
版はルートの `package.json` に合わせます。

## CI とリリース

追加する workflow は、PR と main の配布関連変更で試験とパッケージ生成を行い、
Actions の成果物に保存します。公開リリースとプレリリースは `release: published`
で同じ処理を行い、リリース対象のコミットから作った成果物を Release assets に添付します。
試験失敗時には配布物をリリースへ添付せず、成功・失敗にかかわらず診断ログを保存します。
この workflow を含まない過去のリリースには、自動では遡って添付されません。

ID 未設定ならテンプレートを配布し、設定済みなら接続 ID 入りの ZIP も配布します。
テンプレートを「ChatGPT から遠隔操作可能な完成版」と表示しません。
既存のリリースを作成することや、PR #1 をマージすることは、この追加作業に含みません。

## 接続完了の判定

ツール検出、許可した PC の読取、作業用ファイルの変更、無害なプロセスの起動と終了を
利用者の許可範囲で確認します。さらに認証の失敗、期限切れ後の再認証、サーバー再起動後の
再接続を確認してから、遠隔操作に使えると判断します。ZIP の構造試験だけでは代用しません。

## 参照資料

- [現行版 README](https://github.com/ssaattww/RemoteDesktopMCP/blob/8d72bb8dbc9464e03268bc5be39b72cb929f7e11/README.md)
- [既存タスクと F01〜F03](https://github.com/ssaattww/RemoteDesktopMCP/blob/8d72bb8dbc9464e03268bc5be39b72cb929f7e11/tasks/tasks-status.md)
- [OpenAI: Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [OpenAI: Package your plugin](https://developers.openai.com/plugins/build/plugins)
- [OpenAI: Plugins in ChatGPT and Codex](https://help.openai.com/en/articles/20001256-plugins-in-chatgpt-and-codex)
