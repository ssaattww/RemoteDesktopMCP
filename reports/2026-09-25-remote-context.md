# ChatGPT 遠隔操作の作業前提

## 対象

- Repository: `ssaattww/RemoteDesktopMCP`。
- Branch: `feat/tailscale-funnel-design-lint`。PR #1 を継続する。
- 開始 HEAD: `8d72bb8dbc9464e03268bc5be39b72cb929f7e11`。開始時 clean。
- 実行環境: Windows / PowerShell / `C:\Users\donabe\Project\RemoteDesktopMCP`。
- 検証能力: `local_execution_available`。Node、npm、Tailscale を利用可能。
- 追加要求: ChatGPT からこの Windows PC を操作できる段階まで進める。
- 対象外: 複数実行 PC の追加、既存の独立判定の改変、マージ。

## 環境と未確定事項

既存 Tailscale Funnel は HTTPS から loopback の port 3000 へ転送済み。
調査時点で port 3000 は未待受、`.env` は未作成。公開設定自体は変更していない。
ユーザーは Google OAuth クライアント未作成と回答し、作成手順も依頼した。
実アカウントとの接続は資格情報の作成と本人ログインが必要であり、試験用認証との接続を代用しない。
公開用認証を設定する前に、開発用パスワード認証サービスをこの port で起動しない。

`https://chatgpt.com/oauth/client.json` を実際に取得し、固定の client ID と戻り先、`none` と `private_key_jwt` の併記、認可コードと更新トークンの方式を確認した。
これは公開メタデータの互換性確認であり、ユーザーの ChatGPT アカウントとの接続成功ではない。

## 実行分担と検証

設計・レビューは Sol / high、実装は Terra / high、機械的な確認は Luna / high。
利用者の追加指示に従い、異なる作業は新規担当にする。同じ作業の継続確認だけ担当を再利用する。
公開設計だけは追加指示前に既存担当へ着手済みのため、その限定作業を完了させる。
親は task、報告、統合、設定手順と接続確認を担当する。
実装担当は認証と起動設定、試験担当は境界試験を担当し、重複編集を避ける。
新しい公開変更の通常レビューと独立レビューを行い、前回の判定を転用しない。
ローカル lint、型検査、build、全試験と依存監査を行う。公開経路と ChatGPT 本人接続の証拠は別記する。
ユーザーの秘密は報告・標準出力・Git に含めない。

文書の用語追加は exact 候補と意味を利用者へ提示し、「上記の追加を承認する」と回答を得た。
Google Cloud、JSON、PowerShell、ログイン、プロジェクト、テストユーザー、ウェブアプリケーション、フォルダ、リポジトリ、クライアントシークレットと別名シークレット、チャット、スリープ、モード、ブラウザを承認された意味で登録した。

## 実設定の進捗

利用者は Google OAuth クライアントを作成し、設定 JSON のローカル保存先だけを共有した。
親は秘密を出力せず形式を確認し、公開 callback と localhost の本人登録 callback の2件だけを GCP に設定したという利用者の回答を受けた。
実 JSON から `.env` を作成し、Git の除外対象であることを確認した。
`.env` と `C:\Users\donabe\RemoteDesktopMCP-data` の ACL を、現在の Windows ユーザー、SYSTEM、管理者だけに限定した。
ファイル操作の許可先は `C:\Users\donabe\RemoteDesktopWorkspace`、root ID は `workspace`。
最初の本人登録ではブラウザが開かなかったため停止し、REMOTE-NR-009 として修正対象にした。
認証 URL を表示する修正後に本人登録を再開した。利用者自身の Google ログインと実 ID token の検証後、ローカル承認を行い、CLI が終了コード0で完了した。
許可ユーザーは1人、更新トークンは未発行。state の広い共有主体への許可は0件と確認した。
個人のメールアドレス、主体 ID、secret、認可コードはこの報告へ転記しない。
実サービスの公開起動と ChatGPT からの接続はまだ行っていない。

## 根拠

- [OpenAI の認証仕様](https://developers.openai.com/plugins/build/auth)
- [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
- `reports/2026-09-25-remote-design.md`
- `tasks/tasks-status.md` の F01〜F04
