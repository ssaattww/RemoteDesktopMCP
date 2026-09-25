# 公開認証の試験報告

## タスクと境界

公開認証と設定の試験を `test` に作成し、既存24件の検証を保持する。
製品コード、依存、手順は別担当。実 Google アカウントの確認は試験用応答で代用しない。

## Dispatch profile

- selection inputs: implementation, bounded_technical, medium uncertainty, cross_module, high criticality, single repetition, independent_workstreams, fresh context.
- selection source: user_override; 実装 Terra / high。
- decomposition policy / disposition: allowed; 製品コード担当と書込みを分離。
- requested profile: gpt-5.6-terra / high / fork_turns none.
- agent role / default-role plan: ツールの既定 role。別の role 切替フィールドなし。
- role config evidence / profile effect: 公開ツール定義の model と reasoning_effort を指定、別 role による変更設定なし。
- planned runtime profile: gpt-5.6-terra / high.
- applied profile: null.
- application status: spawn_succeeded_profile_unverified; identity /root/remote_auth_tests.
- runtime profile observability: final_profile_hidden.
- approval: not_required; 利用者が明示指定。
- fork policy: none. 異なる作業なので新規担当。

## 結果

`test/public-auth.test.ts` に公開認証の 9 件を追加した。固定 client metadata、Google ID token の RSA 署名と claim、cookie と state、PKCE、refresh の再利用失効、再起動後の状態、公開 HTTP から MCP tool までの経路、設定 CLI の隔離を扱う。

既存 `NR003/NR004` は Windows の既定 `cmd.exe` で `C:\Program Files\nodejs\node.exe` を先頭に引用して渡すと `C:\Program` と分割されて失敗した。fixture の Node 実行を `node "script"` にし、Desktop Commander が修復する PATH 解決を使う形へ直した。これは Node 本体の実行を省略せず、同じ Windows host の `C:\Program Files` 配下の Node を shell が解決する経路である。

## 試験表

試験は `reference/validation` 配下に作る一時ディレクトリ、`127.0.0.1` と port `0` だけを使う。既存の Funnel 用 port `3000`、実 Google アカウント、実際の公開 URL は使わない。Google の通信は、署名検証の単体試験では固定の discovery と JWKS 応答を注入し、認可交換の経路試験では `OidcVerifier` 境界を注入する。後者は署名検証の代替ではない。

| 識別子 | 経路 | 確認すること |
| --- | --- | --- |
| `RA-01` | metadata と未認証 MCP | issuer、resource、各 endpoint、401 challenge が固定 base URL と一致する。Host と転送用 header では変化しない。 |
| `RA-02` | CIMD と認可要求 | 固定 ChatGPT の client metadata URL と callback だけを受ける。別 URL、同一 origin の別 path、別 client、別 redirect、別 resource、平文 PKCE と scope は拒否する。成功と安全なエラーの redirect は `iss` と元の state を持つ。 |
| `RA-03` | Google ID token 検証 | fixture の RSA 鍵で署名が正しい token を受け、改ざん署名、issuer、audience、azp、nonce、期限、発行時刻を拒否する。許可表にない `iss+sub` は登録しない。 |
| `RA-04` | 認可 transaction | HTTP から Google mock callback までを通し、Secure、HttpOnly、SameSite の cookie と server state の両方を照合する。cookie 欠落、CSRF、state 再利用、callback 再実行を拒否する。 |
| `RA-05` | code と token | code が client、redirect、resource、scope、S256 verifier に束縛され、一回だけ交換できる。token 応答は必要な access/refresh 以外の Google 秘密と署名鍵を含めず、no-store を返す。 |
| `RA-06` | access token と MCP | 正常認証で実際の MCP transport を通して `session_open` と `node_list` を実行できる。未認証、期限切れ、旧 epoch の access token は MCP tool 実行前に拒否する。 |
| `RA-07` | refresh token | refresh は一回の正常回転だけを許し、旧 token 再使用または同時交換の負け側を検出したら family を撤回する。撤回後の access token も拒否する。 |
| `RA-08` | 永続化と再起動 | 同じ `DATA_DIR` で service を再作成して有効 refresh を使える。保存失敗は fail-closed とし、未完了 transaction と未使用 code は復元しない。 |
| `RA-09` | 公開設定と秘密 | 公開モードは password 確認画面を出さず、必要な Google 設定、許可ユーザー、署名鍵、安全な data directory がない場合に起動失敗する。秘密値と Desktop Commander 用の環境変数は HTTP 応答、監査、例外に出ない。 |
| `RA-10` | 外部取得の境界 | discovery/JWKS 取得は許可先、応答サイズ、timeout、redirect を制限する。local test hook は production 環境変数だけでは有効化できない。 |

実 Google OAuth と ChatGPT 接続画面の確認は、資格情報作成と本人ログイン後の人手検証である。ここで作る mock 試験はその接続を実施済みとは記録しない。

## 検証結果

- `npx tsx --test test/public-auth.test.ts`: 9 件成功。署名検証は fixture の RSA 鍵を使い、Google 認可交換だけを注入した。
- `npm run check`、`npm run lint:ts`: 成功。
- `npm test`: Node 24 host で 33 件中 32 件成功、既存 `NR003/NR004` の未引用 Windows 実行だけが失敗した。fixture 修正後の `npx tsx --test --test-name-pattern='NR003 and NR004' test/regressions.test.ts` は成功した。修正後の全件 gate は親担当の Node 22 相当環境で実行待ちである。
- `npm run lint:md -- --files reports/2026-09-25-remote-tests.md`: 成功。用語機械検査は既存の Dispatch profile と新規の実識別子が whitelist 対象外のため失敗し、用語表の編集はこの担当境界外である。

## 文言セルフチェック

`document-wording-review` を新規報告として適用した。対象は本ファイル全体、baseline は新規文書のため不在であり、設計の公開認証契約と実測した試験結果を比較した。意味、識別、読みやすさに問題は見つからなかった。実 Google 接続未実施と mock 範囲を明記し、access/refresh を必要な token として区別した。用語機械検査の失敗は上記のとおり別記であり、用語承認は行っていない。
