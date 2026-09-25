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
- fix continuity: REMOTE-NR-001〜009 は同じ公開認証実装の指摘修正として /root/remote_auth_implementation を継続。application status は reused_existing_agent_profile、元の実行設定は未観測のまま保持。

## 結果

`src/public-auth.ts` に公開 OAuth 状態、Google OIDC 検証、CIMD 検証を分離した。Google ID token は固定 JWKS を取得し、サイズ・時間制限と `jose` の署名、issuer、audience、azp、nonce、iat、exp 検証を通したものだけを本人識別に使う。公開認可の最初の Google ログインでは許可表へ自動登録せず、`iss` と `sub` の完全一致で既存の許可表を照合する。

公開モードは固定 CIMD URL と ChatGPT callback の完全一致、`resource`、S256 PKCE、明示的なブラウザー同意を要求する。Google callback は state、nonce、Secure HttpOnly Cookie の三者を照合し、一回だけ許可画面へ進める。成功とリダイレクト可能な拒否には RFC 9207 の issuer と元の client state を付ける。公開 metadata は CIMD、issuer identification、authorization code、refresh token、`none`、S256 を正しく広告し、DCR endpoint は公開しない。

refresh token は原文を保存せずハッシュ・family・対象・client・resource・scope・期限を `DATA_DIR/oauth-state.json` に書く。更新は一時ファイルから rename し、回転と再利用検知で family を撤回する。アクセストークンは短命で、すべての MCP 呼び出しで現在の許可表、epoch、family を再確認する。許可表の変更は epoch を上げるため既存 grant を無効にする。ローカル登録 CLI はサービスを停止した状態で実行し、登録後にサービスを再起動する運用である。

`npm run remote-auth -- configure <Google client JSON> --base-url <HTTPS URL> --root <workspace>` は root を明示指定するか、専用の `RemoteDesktopWorkspace` を作成して `.env` を生成する。設定ファイル、Google client JSON、`DATA_DIR` が root と重ならないことを検査する。`npm run remote-auth -- authorize-google` は `http://localhost:8765/callback` だけで本人を検証し、ローカル端末で `approve` と入力されたときだけ許可表を更新する。公開 callback は `${BASE_URL}/google/callback` である。

Desktop Commander 子プロセスには Google client secret、トークン署名鍵、認証設定を渡さない。公開モードで password 認証を使おうとすると設定時に拒否される。`node_list` はファイルの絶対パスを出さずに利用可能な `root_ids` を返す。

初回実装時点の focused check: `npm run check` と `npm run lint:ts` は成功。`npx tsx --test test/public-auth.test.ts` は 9/9 成功した。全体 `npm test` は 32/33 成功し、既存の `NR003 and NR004` だけが `C:\Program` を未引用で起動する portable-process ケースとして失敗した。Desktop Commander 子環境を旧全継承へ一時的に戻しても同じ単独失敗を再現したため、公開認証の差分ではない。この初回時点では Google OAuth credential はまだ作成されておらず、実 Google ログイン、Tailscale Funnel 経由の ChatGPT 接続、restart 後 refresh の実運用確認は未実施だった。

## 通常レビュー修正の追記

`REMOTE-NR-002` に対し、OAuth state は既存ファイルの ACL を確認してから読む。`npm start` と `npm run dev` は Node の `--env-file` を使わず、`src/bootstrap.ts` が `.env` の親の置換権限とファイル ACL を確認してから環境を読み込む。CLI の本人登録も同じ順序にし、configure は許可していない主体が書込み・削除できる親を拒否し、一般主体の読取りだけを許す親では作成できる storage helper を使う。既存の実 `.env`、Google credential、OAuth state は読まず変更していない。

`REMOTE-NR-003` では、現行 MCP SDK が `tools/list` を組み直して top-level field を落とすため、同じ SDK の元 handler を tool list だけ包み、各 tool の wire descriptor に OAuth `securitySchemes` を追加した。互換用の `_meta` aliases も残す。失効 Bearer による `tools/call` は HTTP 401 discovery と区別して、`invalid_token` と説明を含む `mcp/www_authenticate` runtime challenge を返す。

`REMOTE-NR-006` では、公開 MCP の永続 state 読込み前に admission を行う。自サーバー署名済みの access token は token ごとの固定 bucket を使い、未署名または不正な入力は別の固定 bucket を使う。Google callback も cookie と state が一致する未使用 transaction を別 bucket にする。したがって無効入力の連続送信が進行中の正規 transaction を同じ bucket で枯渇させない。送信元 IP や `X-Forwarded-For` には依存しないため、匿名の新規無効入力に公平な可用性を保証するものではない。

この追記時点の focused source check は `npm run check`、`npm run lint:ts`、`npm run build` が成功した。公開サービス起動、ChatGPT 接続、Funnel 経由の実 refresh は実施していない。Google のローカル本人登録は別途成功しているが、その実 state は本実装確認で開いていない。

## 全体 gate 失敗の追跡

2026-09-25 20:42 JST に、ACL 統合後の Node 22 全体 gate 失敗への修正を開始した。失敗ログは `reference/validation/remote-full-gate-3d676b89d0268c9d41f78251d7a351f232ad4f6f/05-test.stdout.txt` にあり、42 件中 8 件が失敗した。MVP の 3 件は保護していない isolated `DATA_DIR` を使う fixture の不備で、試験担当が fixture を修正した。残る process watcher と MCP timeout は、private audit の directory と file の Windows ACL 検査が tool 呼出ごとに複数の PowerShell child を待つことによる待ち時間と、終了状態を audit 完了前に公開する競合が原因だった。

strict ACL 検査を弱めず、storage helper の `assertPrivateAuditStorage` で strict `DATA_DIR` と直下の audit file を一つの PowerShell 呼出で検査するよう変更した。初期化で `DATA_DIR` は検査済みであり、audit file がないときだけ protected file として作成してから同じ一括検査を行う。append 後に同じ ACL を再検査する重複は除去した。終了は `process.exit` audit の永続化成功後にだけ `finished` として公開し、audit が失敗すれば次回観測で再試行する。termination timeout 後に Desktop Commander session が残る間、watcher は output を読まず `terminating` を維持する。`process_start` は audit 失敗時にも `finally` で watcher を開始するため、開始済み process を無監視にはしない。

修正後、`npx tsx --test --test-name-pattern='same PID reuse' test/independent-fixes.test.ts` は成功した。`npx tsx --test --test-name-pattern='IFR-004' test/independent-fixes.test.ts` も 2 件とも成功した（24.3 秒）。NR003/004/005 の focused regression は試験担当へ依頼済みで、全体 gate は親担当がこの修正後に一度だけ実行する。

同じ focused regression で、timeout 解消後に streaming `file_search` のページ境界不備を確認した。Desktop Commander 0.2.51 の `get_more_search_results` は実際に返した slice を `Showing results start-end` として出力する。結果配列が成長中に pagination hint を先に採用すると中間 range を飛ばす場合があったため、表示された inclusive range の末尾を次の offset として優先するよう修正した。この欠落は ACL のデータ破損ではなく、待ち時間が縮んで既存の streaming 境界を再現できたことで観測された。`NR003 and NR004` は連続 2 回成功（13.2 秒、13.0 秒）、`NR005` は 14.0 秒で成功した。`npm run check`、`npm run lint:ts`、`npm run build` も成功した。ここで source を凍結し、以後の全体 gate は親担当が実行する。

## F01c 全体 gate 修正の証跡

| 失敗群 | 原因 | 修正箇所 | focused 証跡 |
| --- | --- | --- | --- |
| IFR-001 | stale 操作の audit 待機中に後継 logical process の watcher が同じ PID を読んだ。 | `src/index.ts` の start audit 後 watcher 開始。試験は old/new watcher を区別して検査。 | `same PID reuse` 成功、12.9 秒。 |
| IFR-004 | exit audit より先に `finished` を公開し、fixture cleanup と非同期 append が競合した。termination timeout 中も active session を読む余地があった。 | `src/index.ts` の `auditExit`、`observe`、`finishWhenRootIsGone`、`watchProcess`。 | IFR-004 2 件成功、24.3 秒。 |
| NR003/004/005 timeout | audit ごとに strict directory、file の pre/post ACL を別 PowerShell child で確認していた。 | `src/private-storage.ts` の strict 一括 audit assertion と `src/index.ts` の `audit` 呼出。 | NR003/004 連続 2 回成功、NR005 成功。 |
| NR003 page omission | streaming 検索で pagination hint を先に採用した。 | `src/index.ts` の `search` offset 選択。 | 全 115 hit を確認。 |
| MVP ACL fixture 3 件 | isolated fixture `DATA_DIR` が strict storage 前提を満たしていなかった。 | 試験担当の fixture 準備のみ。production ACL は緩和しない。 | overlap 0.84 秒、OAuth 12.25 秒、snapshot 14.60 秒。 |

`process_start` は start audit が失敗しても `finally` で watcher を開始する。そのため監査保存が fail-closed になっても、既に開始した process を無監視で残さない。実 `.env`、Google credential、実 OAuth state は本修正で読まず変更していない。

## F01c follow-up: REMOTE-NR-010 と NR005

immutable `f4b2076` の全体 gate は 42 件中 40 pass、1 fail、POSIX 1 skip であり、失敗は NR005 の `content_search` MCP timeout だけだった。診断 fixture は timeout が `start_search` 自体より前の `verifyAllowedRoots` 内 `get_config` 応答待ちで起き、`get_more_search_results` と `stop_search` には到達していないことを確認した。

Desktop Commander 0.2.51 の `getConfig()` は呼出ごとに stderr へ診断を書き出す。`StdioClientTransport` の `stderr: "pipe"` は child stderr を PassThrough へ接続するだけであり、consumer がなければ backpressure により child の MCP stdout 応答まで止め得る。`src/index.ts` は stderr の内容を保存・ログ出力せず data listener で drain するよう修正した。1 MiB のダミー stderr を drain 待ちで書いた stdio MCP stub に対して initialize、繰返し `get_config`、`file_read` が成立する composition fixture を加えた。stderr の内容は test output、audit、report に出さない。

`REMOTE-NR-010 / P2` には、active な `terminating` process の `process_output` を `process_status`、watcher と同じ規則にそろえた。Desktop Commander session が残る間は output read を委譲せず、保存済み output と `termination_unconfirmed` を返す。IFR-004 fixture は status と output の双方で read count が増えず owner が保たれること、session 消滅後に一度だけ exit audit と `finished` になることを検査する。

NR006 の body timeout は、socket の idle timeout を handler 実行と keep-alive に残す方式から、受信開始からの絶対 15 秒 deadline に置き換えた。request `end`、`aborted`、response `close` で deadline を解除するため、body を受信し終えた後の MCP handler 実行は切断しない。public HTTP fixture には 15 秒超の `session.open` audit を使う境界確認を追加した。

この時点で IFR-004 focused、stderr capacity fixture は成功し、`npm run check`、`npm run lint:ts`、`git diff --check` は成功した。stderr drain 後の NR005 focused は最初の 2 回が約 12 秒で成功した。長時間の body 境界 fixture と連続 NR005 の完走は親担当の session polling と current-HEAD full gate で確認するため、ここでは成功と断定しない。

## RDMCP-REMOTE-IFR-001 / P2: token と consent の admission 分離

| required action | production path | composition / focused evidence |
| --- | --- | --- |
| 無効な `/token` POST が既存の有効 code または refresh の共有 bucket を枯渇させない。 | `src/public-auth.ts` の `tokenAdmissionKey` は persistent state を読まず、ChatGPT client と resource に束縛された未期限 in-memory code、または HMAC 検証済みの構造・期限が妥当な refresh だけを credential digest bucket に分類する。`src/index.ts` はその key を `/token` rate admission に渡す。本体 `token()` は従来どおり reload、epoch、許可 subject、family、rotation/replay を検証する。 | port 0 HTTP fixture は fixed ChatGPT client を装う無効 code/refresh を既定 10 件まで送った後、未使用の有効 code と有効 refresh が各々成功することを検査し、focused は 1 pass / 0 fail、49 秒。 |
| 無効な consent POST が cookie-bound の有効 consent transaction を阻害しない。 | `src/public-auth.ts` の `consentAdmissionKey` は未期限・subject 済み transaction と HMAC cookie の一致だけを in-memory で確認して transaction digest bucket を返す。`consent()` 本体は serialized reload、現在の許可 subject、cookie、one-use 削除を維持する。`src/index.ts` は invalid と valid bucket を分け、public mode なしは 400、rate exhaustion は 429 とする。 | port 0 HTTP fixture は forged consent 10 件の後、cookie-bound transaction の consent が成功することを検査する。invalid consent の 11 件目は 429 で固定容量を確認する。focused は同じ 1 pass / 0 fail、49 秒。 |

この分類は anonymous new `/authorize` の識別不能性を変更しない。署名済みだが revoke/replay 済みの refresh は credential 固有 bucket になり得るが、発行物を知る相手だけがその bucket を使え、本体の永続 state 検証では必ず拒否される。実 PID、`.env`、Google credential、実 OAuth state は読まず変更していない。`npm run check`、`npm run lint:ts`、`git diff --check` は成功した。ここで source と本報告の編集を停止し、統合 commit と後続 review/full gate は親担当が行う。
