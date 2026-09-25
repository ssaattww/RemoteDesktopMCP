# 公開認証の実装報告

## タスクと境界

ChatGPT から単一 Windows PC を操作するための公開認証と設定 CLI を実装する。
対象は `src`、`package.json`、`package-lock.json`、`.env.example`、本報告。試験ファイルと利用手順は別担当。

## Dispatch profile

- selection inputs: implementation, bounded_technical, medium uncertainty, cross_module, high criticality, single repetition, sequential_dependencies, fresh context.
- selection source: user_override; 実装 Terra / high。
- decomposition policy / disposition: allowed; 試験と手順は境界を分離。
- requested profile: gpt-5.6-terra / high / fork_turns none.
- agent role / default-role plan: ツールの既定 role。別の role 切替フィールドなし。
- role config evidence / profile effect: 公開ツール定義の model と reasoning_effort を指定、別 role による変更設定なし。
- planned runtime profile: gpt-5.6-terra / high.
- applied profile: null.
- application status: spawn_succeeded_profile_unverified; identity /root/remote_auth_implementation.
- runtime profile observability: final_profile_hidden.
- approval: not_required; 利用者が明示指定。
- fork policy: none. 異なる作業に担当を再利用しないという追加指示に従い新規作成。

## 結果

`src/public-auth.ts` に公開 OAuth 状態、Google OIDC 検証、CIMD 検証を分離した。Google ID token は固定 JWKS を取得し、サイズ・時間制限と `jose` の署名、issuer、audience、azp、nonce、iat、exp 検証を通したものだけを本人識別に使う。公開認可の最初の Google ログインでは許可表へ自動登録せず、`iss` と `sub` の完全一致で既存の許可表を照合する。

公開モードは固定 CIMD URL と ChatGPT callback の完全一致、`resource`、S256 PKCE、明示的なブラウザー同意を要求する。Google callback は state、nonce、Secure HttpOnly Cookie の三者を照合し、一回だけ許可画面へ進める。成功とリダイレクト可能な拒否には RFC 9207 の issuer と元の client state を付ける。公開 metadata は CIMD、issuer identification、authorization code、refresh token、`none`、S256 を正しく広告し、DCR endpoint は公開しない。

refresh token は原文を保存せずハッシュ・family・対象・client・resource・scope・期限を `DATA_DIR/oauth-state.json` に書く。更新は一時ファイルから rename し、回転と再利用検知で family を撤回する。アクセストークンは短命で、すべての MCP 呼び出しで現在の許可表、epoch、family を再確認する。許可表の変更は epoch を上げるため既存 grant を無効にする。ローカル登録 CLI はサービスを停止した状態で実行し、登録後にサービスを再起動する運用である。

`npm run remote-auth -- configure <Google client JSON> --base-url <HTTPS URL> --root <workspace>` は root を明示指定するか、専用の `RemoteDesktopWorkspace` を作成して `.env` を生成する。設定ファイル、Google client JSON、`DATA_DIR` が root と重ならないことを検査する。`npm run remote-auth -- authorize-google` は `http://localhost:8765/callback` だけで本人を検証し、ローカル端末で `approve` と入力されたときだけ許可表を更新する。公開 callback は `${BASE_URL}/google/callback` である。

Desktop Commander 子プロセスには Google client secret、トークン署名鍵、認証設定を渡さない。公開モードで password 認証を使おうとすると設定時に拒否される。`node_list` はファイルの絶対パスを出さずに利用可能な `root_ids` を返す。

focused check: `npm run check` と `npm run lint:ts` は成功。`npx tsx --test test/public-auth.test.ts` は 9/9 成功した。全体 `npm test` は 32/33 成功し、既存の `NR003 and NR004` だけが `C:\Program` を未引用で起動する portable-process ケースとして失敗した。Desktop Commander 子環境を旧全継承へ一時的に戻しても同じ単独失敗を再現したため、公開認証の差分ではない。Google OAuth credential はまだ作成されていないため、実 Google ログイン、Tailscale Funnel 経由の ChatGPT 接続、restart 後 refresh の実運用確認は未実施である。
