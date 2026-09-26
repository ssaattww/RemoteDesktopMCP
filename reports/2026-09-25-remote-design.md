# ChatGPT 遠隔接続の設計

## タスク

- 目的: ChatGPT からこの Windows PC を操作する公開接続を設計する。
- 対象: Google OIDC、MCP OAuth、公開運用、起動と検証。
- 対象外: 複数実行 PC、前回の独立判定の変更。

## Dispatch profile

- selection inputs: design, judgment_heavy, high uncertainty, cross_system, high criticality, single repetition, bounded_history.
- selection source: continuity_reuse; ユーザー指定の設計 Sol / high を継続。
- observed decomposability: sequential_dependencies.
- decomposition policy / disposition: forbidden / single_agent.
- requested profile: null; 新規 spawn ではない。
- original profile evidence: reports/2026-09-25-design-followup.md; gpt-6-sol / high。
- agent role / default-role plan: 既存 /root/design を継続。
- planned runtime profile: 元の要求を継続。実際の設定は非公開。
- applied profile: null.
- application status: reused_existing_agent_profile.
- runtime profile observability: final_profile_hidden.
- approval: not_required; ユーザーのモデル分担指定。
- fork policy: 既存エージェントの継続。

## 結果

### 現状と到達点

既存の単一 PC ローカル版は稼働可能だが、現時点では公開接続できない。`src/index.ts` はパスワード画面、実行中メモリの OAuth コードと登録クライアント、1 時間のアクセストークンのみを持つ。Google OIDC、CIMD、refresh token、RFC 9207 の `iss`、OAuth 状態の再起動後復元は未実装である。実行ポート 3000 は停止中で `.env` もない。Tailscale Funnel は `https://fa780.tail8bf1af.ts.net` から `127.0.0.1:3000` へ既に設定されているが、バックエンド不在を公開完了と数えない。旧ローカル MVP の判定は変更しない。

今回の完了条件は、**ChatGPT がこの Windows PC の単一ノードへ OAuth 接続し、許可ユーザーとして `session_open`、`node_list` と安全な読み取りツールを実行でき、サービス再起動後も許可済み refresh token で接続を継続できること**である。複数 PC ルーティングは対象外。既存の同一 OS ユーザーによる Desktop Commander 委譲と任意コマンドの信頼境界は変えず、公開前に認証を厳格にする。

### 最短の実装契約

1. 公開モードを明示し、`BASE_URL=https://fa780.tail8bf1af.ts.net`、MCP リソース ID を `https://fa780.tail8bf1af.ts.net/mcp` に固定する。PRM の `resource`、OAuth 要求の `resource`、アクセストークンの `aud`、401 challenge を同一値にする。issuer は `BASE_URL` と厳密一致。HTTP サーバーは `127.0.0.1:3000` にのみ bind し、Host や転送ヘッダーから外部 URL を推定しない。公開モードで Google 設定・許可済み `iss+sub`・永続署名鍵・安全な `DATA_DIR` が欠けたら起動失敗とする。パスワード方式への暗黙 fallback は禁止する。
2. ChatGPT の OAuth クライアントを CIMD ID `https://chatgpt.com/oauth/client.json` として扱い、文書をその固定 HTTPS URL から取得・検証する。登録済みクライアントの `client_id` とリダイレクトを完全一致で検査し、ChatGPT 側 callback を `https://chatgpt.com/connector_platform_oauth_redirect` に固定する。任意の CIMD URL 取得や URL の origin 一致だけによる `/register` 許可は公開モードでしない。公開する authorization server metadata に `client_id_metadata_document_supported: true`、`authorization_response_iss_parameter_supported: true`、`code_challenge_methods_supported: ["S256"]`、実際に実装した `authorization_code` と `refresh_token` を正確に載せる。`none` の公開クライアントとして処理する場合は PKCE を必須にし、CIMD 文書との認証方式の整合も検査する。RFC 9207 の `iss` は認可成功と安全にリダイレクトできる認可エラーの両方へ必ず含める。[OpenAI 認証仕様](https://developers.openai.com/plugins/build/auth)。
3. `/authorize` は `client_id`、完全一致の `redirect_uri`、`response_type=code`、`scope`、S256 challenge、正しい `resource` を先に検証する。ChatGPT の `state` はそのまま保管し、Google OIDC 用の別 `state` と `nonce` を乱数で発行する。短命の認可トランザクションを `Secure`・`HttpOnly`・`SameSite=Lax` Cookie とサーバー側値に結び、Google callback の state とブラウザー側 Cookie の両方を照合して一回限り消費する。認可コードも短命・一回限りで `client_id`、`redirect_uri`、`resource`、scope、PKCE challenge、許可ユーザーに束縛する。`/token` では `resource` の再確認を含め、束縛された値を一致検査した後にコードを原子的に消費する。Google callback から ChatGPT callback への成功・エラーは許可済み URI だけへ遷移させ、値を HTML やログへ出さない。
4. Google OIDC は固定 discovery/JWKS と認可コード交換を行う小さな `GoogleOidcClient` / `OidcVerifier` 境界として分離する。ID token の署名、許可 issuer、Google client ID に一致する `aud`、`exp`・`iat`、要求時の `nonce` を検査する。本人識別は検証済み `iss+sub` の完全一致だけとし、email は表示・監査補助に限定する。公開接続の最初のログインを自動的に許可しない。[Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect)、[Google の ID token claim](https://developers.google.com/identity/openid-connect/reference)。
5. 管理者用の**ローカル専用**登録コマンドを用意する。Google Cloud の同じ Web OAuth クライアントに公開 callback `https://fa780.tail8bf1af.ts.net/google/callback` と、登録用の厳密な loopback callback（例 `http://localhost:8765/callback`）を登録する。管理者が PC 上でコマンドを起動すると、コマンドが loopback で Google OIDC の state・nonce 付き認可を受け、ID token を検証し、得た `iss+sub` と表示用 email を確認して明示的なローカル承認を受けてから許可表へ書き込む。Google の Web アプリケーションは開発用 localhost HTTP redirect を許容し、redirect URI の完全一致が必要である。[Google Web server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)。コマンドは ID token・client secret・認可コードを表示/保存せず、許可表の変更時に token epoch を上げる。loopback 登録フローの導入が困難なら、事前に検証した `iss+sub` を管理者がローカル CLI へ入力して確認する方式でもよいが、検証前の email 自動登録はしない。
6. OAuth 永続状態を `DATA_DIR` に保管し、許可表、失効 epoch、refresh token のハッシュと family、期限・client/resource/scope/user 束縛をサービス再起動後も保持する。refresh token は一回使うごとに原子的にローテートし、再利用が見つかれば family を撤回する。アクセストークンは短命（目安 10～15 分）で署名し、`iss`、検証済み主体、`aud`、scope、client、`iat`・`nbf`・`exp`、許可表 epoch を検査する。すべての MCP 呼び出しで現在の許可表と epoch を検査し、ユーザー削除や鍵更新で旧アクセストークンを即座に無効化する。永続データは一時ファイルと atomic replace またはトランザクションで更新し、秘密鍵・refresh 原文は保存/監査しない。再起動で認可中トランザクションと未使用コードは失効してよいが、既発行の有効 refresh と許可表は消えてはならない。
7. `/mcp` の全ツールを認証前に実行させず、401 `WWW-Authenticate` に protected resource metadata URL を入れる。ChatGPT のリンク操作で必要な OAuth `securitySchemes` と `_meta["mcp/www_authenticate"]` を SDK 上の実際のツール応答に合わせて検証する。認可・Google callback・token・MCP には要求サイズ、期限、回数の上限を設ける。エラーと監査に秘密、token、Google code、ファイル内容や絶対パスを出さず、認可応答・token 応答には `Cache-Control: no-store` を付ける。設定ファイル、監査、永続データ、秘密鍵は許可 file root 外に置く。[OpenAI 認証仕様](https://developers.openai.com/plugins/build/auth)。

`src/index.ts` の公開モード差分は認証層へ集中させ、既存の file/process/transfer ツールを移植しないのが最短である。ただし既存 `/register` の origin だけの検証、メモリ Map、password form、`sub=email` のアクセス判断は公開モードでは必ず置き換える。現行 `README.md` の「Internet に公開しない」注意は公開接続の全検証後にモード別説明へ更新する。

### 試験と段階

Google 資格情報がなくても、注入した `OidcVerifier` と時刻・永続 store により次を先行実装・試験できる。

- metadata と 401 challenge の URL・issuer・resource 一致、RFC 9207 `iss` の成功/エラー応答、固定 CIMD ID と redirect 完全一致、未知 URL・origin だけ一致する別 path の拒否。
- 正常 OIDC と、署名/issuer/audience/expiry/nonce/`iss+sub` 不一致、Google state と Cookie 不一致、callback 再実行、CSRF の拒否。未登録の Google アカウントが最初のログインで追加されないこと。
- S256 PKCE 不一致・平文禁止、別 client/redirect/resource/scope への code 流用、code 二重交換、ChatGPT state 取り違えの拒否。
- refresh の正常な回転、同時交換で片方のみ成功、旧 token 再利用時の family 撤回、user 削除/epoch 更新時の access と refresh 失効、サービス再起動後の refresh 成功、永続書込失敗時の fail-closed。
- 未認証ツールが実行されないこと、認証後の既存単一ノード操作、秘密や絶対パスがレスポンス・監査へ漏れないこと、指定のない Host/forwarded header でも URL が変わらないこと、公開設定不足なら起動しないこと。

実資格情報が揃った後、管理者がローカル登録コマンドで本人の `iss+sub` を登録する。次に実 Google OIDC、公開 HTTPS discovery、ChatGPT の接続画面から認可・refresh、`session_open`→`node_list`→許可 root の `file_read` をエンドツーエンドで確認する。サービスを再起動し refresh 継続を確認する。3000 番の listen と Funnel の経路疎通だけでは完了としない。公開へ切り替える前にこれらを通し、Windows の同一ユーザーでの自動起動と `DATA_DIR` のアクセス権も確認する。

### 残る設定と人による作業

Google Cloud で OAuth consent と Web client を作成し、公開 callback と登録用 localhost callback を**正確に**設定する必要がある。client ID/secret は現在未取得で、ユーザーの Google アカウントによる実ログインとローカル登録も未実施である。これらはコードや mock 試験では代行できない。永続 `TOKEN_SECRET`、root と分離した `DATA_DIR`、許可 root、実行 Windows アカウント、自動起動方法も決める。秘密は `.env` の追跡対象に書かず OS 管理の環境設定か権限を絞ったファイルに置く。Funnel URL は既知だが、ポート 3000 のサービスが起動し、実認証経路が通るまでは ChatGPT からの遠隔操作は未達である。
