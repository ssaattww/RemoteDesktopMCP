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
- fix continuity: REMOTE-NR-001〜009 の同じ試験修正として /root/remote_auth_tests を継続。application status は reused_existing_agent_profile、元の実行設定は未観測のまま保持。

## 結果

`test/public-auth.test.ts` に公開認証の 16 件を追加した。固定 client metadata、Google ID token の RSA 署名と claim、cookie と state、PKCE、refresh の再利用失効、再起動後の状態、公開 HTTP から MCP tool までの経路、設定 CLI の隔離を扱う。永続 state の fixture は `reference/validation` 下の private な一時 directory を使い、実 `.env`、実 OAuth state、実 Google credential は参照しない。

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
| `RA-10` | 外部取得の境界 | 固定 Google token/JWKS と CIMD の取得で、許可先、応答サイズ、timeout、redirect を制限する。local test hook は production 環境変数だけでは有効化できない。 |

実 Google OAuth と ChatGPT 接続画面の確認は、資格情報作成と本人ログイン後の人手検証である。ここで作る mock 試験はその接続を実施済みとは記録しない。

## 通常 review finding matrix

各行は通常 review の required action、実装で通る production path、実際に組み立てた fixture と focused test を対応づける。Google の mock は署名検証、認可交換、HTTP 境界を分けている。実 Google 本人登録の証拠は mock fixture と混同しない。

| finding | required action と production path | actual composition fixture / test | 結果と範囲 |
| --- | --- | --- | --- |
| `REMOTE-NR-001` | 7 日間の通常回転を容量で止めず、replay を検知し、期限後 family を清掃する。`src/public-auth.ts` の `PublicAuthService.issue`、`tokenUnlocked`、`clean`、`normalize`。 | memory state、可変 clock、固定 Google/CIMD verifier を組み立てた `REMOTE-NR-001: a seven-day refresh family rotates beyond 256 uses, detects replay, and cleans expired families`。v1 state は `REMOTE-NR-001: a v1 state with one approved subject and no refresh records remains usable`。 | 1,008 回の10分間隔 rotation、同一 refresh の `Promise.all`、最初の token replay、8日後 cleanup、v1 single-subject/empty-refresh state が通過。replay は family と旧 access を無効化する。 |
| `REMOTE-NR-002` | Windows で state、監査、一時 file、`.env`、`DATA_DIR` の ACL を作成・再読して確認し、広い parent/existing ACL を拒否する。`src/private-storage.ts`、`src/public-auth.ts` の `createFileOAuthStateStore.load`、`src/bootstrap.ts`、`src/remote-auth-cli.ts`。 | [保存領域保護報告](2026-09-25-remote-storage.md) の `REMOTE-NR-002: Windows ACLs protect audit pairs, private leaves, and reject untrusted writes or owners`（`test/private-storage.test.ts`）。`test/public-auth.test.ts` の `REMOTE-NR-002: startup, CLI, and state loading reject broad existing secret files` と `REMOTE-NR-002: configure creates a strict .env from a safe ordinary checkout parent`。 | broad existing state leaf は read 前に拒否する。broad existing `.env` は startup/CLI が callback listener 起動前に拒否し、Users RX の通常 checkout parent から configure は strict `.env` を作る。Windows focused 証拠であり mock state の代用ではない。 |
| `REMOTE-NR-003` | 各 MCP tool の protocol top-level `securitySchemes` と互換 meta alias を出し、失効 Bearer の `tools/call` を `resource_metadata`、`error="invalid_token"`、`error_description` の runtime challenge へ導く。`src/index.ts` の `RemoteDesktopService.server` と `createApp` の `/mcp`。 | protected `DATA_DIR`、injected approved Google identity/CIMD、port 0 loopback server、raw JSON-RPC wire と SDK MCP client を併用する `RA-01, RA-02, RA-04, RA-06; REMOTE-NR-003, REMOTE-NR-006, and REMOTE-NR-008: loopback HTTP flow reaches actual protected MCP tools`。 | SDK が unknown top-level field を parse 時に除外するため、生 HTTP `tools/list` response の全 tool で top-level field を assert する。SDK client では meta aliases、失効 `tools/call` では完全な challenge を別に assert する。初期 unauthenticated HTTP 401 discovery も同 test で別に確認した。 |
| `REMOTE-NR-004` | 1人制約を永続 state で強制し、明示 replacement は旧 grant を失効する。`src/public-auth.ts` の `addAllowedSubject`、`authenticateUnlocked`。 | fixed Google identity、memory state、authorization code/refresh を組み立てた `REMOTE-NR-004 and REMOTE-NR-005: subject replacement revokes old grants and unexchanged codes`。 | 別 subject の通常追加は拒否され、`replace: true` 後は旧 access と refresh が拒否される。 |
| `REMOTE-NR-005` | code exchange 前に subject 許可と epoch を確認し、client/redirect/resource/PKCE に束縛する。`src/public-auth.ts` の `consent`、`tokenUnlocked`。 | replacement 前に発行した code の exchange と、別 client/redirect/resource/verifier をそれぞれ発行済み code に渡す `REMOTE-NR-004 and REMOTE-NR-005: subject replacement revokes old grants and unexchanged codes` および `REMOTE-NR-005 and REMOTE-NR-007: code bindings and signed access claims fail closed`。 | 未交換 code と全 binding 不一致は `invalid_grant` になり、削除済み主体への新 grant を発行しない。 |
| `REMOTE-NR-006` / `IFR001/P2` | 固定容量の期限付き rate limiter と callback/MCP/token/consent admission を state read より前に置き、body size/timeout を設定する。`src/index.ts` の `RateLimit`、`createApp`、`src/public-auth.ts` の `mcpAdmissionKey`、`googleCallbackAdmission`、`tokenAdmissionKey`、`consentAdmissionKey`。 | 同じ port 0 loopback composition。unknown client 11回、固定 ChatGPT client、invalid callback 31回と既存 state/cookie、unknown MCP 32回、固定 client の invalid `/token` 11回、cookie を持つ forged consent 11回、chunked 17 KiB `/token` body を送る。 | unknown authorize bucket の11回目は 429、fixed client は 303。invalid callback bucket の31回後も既存 cookie/state は 200、unknown MCP は configured prefix だけを受け persistent-state read を30回以下に抑える。invalid token/consent の11回目は 429 だが、発行済み code、署名済み refresh、cookie-bound transaction は各々成功する。chunked body は 413。 |
| `REMOTE-NR-007` | 署名済み access の `iat`/`nbf`、固定 client ID、最大 TTL を認証時に検査する。`src/public-auth.ts` の `authenticateUnlocked`。 | HMAC を test token secret で作る fixture の `REMOTE-NR-005 and REMOTE-NR-007: code bindings and signed access claims fail closed`。iat 欠落、future iat/nbf、別 client、過大 TTL を生成する。 | 署名が正しくても必須 claim または寿命が不正な token はすべて拒否される。 |
| `REMOTE-NR-008` | 実 file store で restart を確認し、save 失敗では token を出さず code を復活させない。誤 scope を拒否し、Google/client/token secret が HTTP response、例外、監査に出ないことを確認する。`src/public-auth.ts` の `createFileOAuthStateStore`、`persist`、`tokenUnlocked` と `src/index.ts` の public error/audit paths。 | `reference/validation` の private temporary `DATA_DIR` で実 file store を再生成し、`save` を throw する `REMOTE-NR-008: file-state restart preserves a valid grant, while a failed save cannot issue or revive a code`。sentinel secret、invalid scope、verifier exception、malformed HTTP body、監査 file を組み立てる上記 loopback HTTP test。 | 保存済み refresh は再起動後に使え、保存失敗は token を返さず、同じ code の再試行は `invalid_grant`。invalid scope は拒否され、sentinel は HTTP response、exception response、audit record に含まれない。 |
| `REMOTE-NR-009` | configure が安全な `.env` だけを書き、browser 起動失敗時も本人登録 URL を表示して localhost callback と明示承認を完了できるようにする。`src/remote-auth-cli.ts` の `configure`/`authorizeGoogle`、`src/index.ts` の `configFromEnv`/`createApp`。 | private fixture cwd/data、fixture client JSON を使う `RA-09: configure writes only a new isolated .env and never prints the Google secret` と `RA-09: password mode and incomplete Google settings fail closed for a public URL`。実 `authorize-google` の URL fallback と本人登録成功は [作業前提の実設定進捗](2026-09-25-remote-context.md) を参照する。 | fixture は既存 `.env`、root/data overlap、HTTP、secret output を拒否する。実 Google では利用者本人のログイン、ID token 検証、明示承認、終了コード0まで成功している。この matrix の closure 時点では公開 service 起動と ChatGPT 接続は未実施だった。現在は公開 service の起動と 96b immutable full gate の成功を別途確認済みであり、実 ChatGPT 接続は未確認のままである。 |

## 検証結果

- closure 集計: `npx.cmd tsx --test test/public-auth.test.ts test/private-storage.test.ts` は exit 0、18 tests 中17 pass、Windows では対象外の POSIX 1 skip、0 fail、0 cancel、51,961.5453 ms。署名検証は fixture の RSA 鍵を使い、Google 認可交換だけを注入した。
- 履歴: 先行する `npx tsx --test test/public-auth.test.ts` は host 側の30秒収集上限で完了集計前に出力が切れたため、長い file-store/HTTP case と CLI/configure case を focused run でも確認していた。上記 closure 集計がこの履歴を置き換える。
- `npm run check`、`npm run lint:ts`: 成功。
- `IFR001/P2` focused: `npx tsx --test --test-name-pattern='loopback HTTP flow reaches actual protected MCP tools' test/public-auth.test.ts` は exit 0、1 pass、0 fail、49,046.3432 ms。固定 client の無効 token/consent flood 後に、bound code、signed refresh、cookie-bound consent の HTTP 成功を確認した。
- 履歴（この closure 時点）: Node 24 host の `npm test` は33件中32件成功、既存 `NR003/NR004` の未引用 Windows 実行だけが失敗した。fixture 修正後の `npx tsx --test --test-name-pattern='NR003 and NR004' test/regressions.test.ts` は成功した。修正後の全件 gate はこの時点では親担当の Node 22 相当環境で実行待ちだった。後続の 96b immutable full gate 成功は別の現行検証である。
- `npm run lint:md -- --files reports/2026-09-25-remote-tests.md`: 成功。用語機械検査は既存の Dispatch profile と新規の実識別子が whitelist 対象外のため失敗し、用語表の編集はこの担当境界外である。

### 全体 gate の follow-up

- 初回の Node 22 full gate は `reference/validation/remote-full-gate-3d676b89d0268c9d41f78251d7a351f232ad4f6f/05-test.stdout.txt` に 42 tests、33 pass、8 fail、1 skip と記録された。`test/mvp.test.ts` の3件は、ACL 統合後に isolated `DATA_DIR` を private 化していなかったため、元 assertion 前に fail-closed となった。
- 2026-09-25T20:41:15+09:00 に `test/mvp.test.ts` だけを最小修正した。fixture の空 `DATA_DIR` を初期化前に保護し、root/data overlap の case も isolated protected `DATA_DIR` を使う。assertion を弱めず、timeout は増やしていない。focused `configuration fails`、`OAuth authorization code`、`transfer snapshot remains` はそれぞれ pass した。
- 2026-09-25T20:43:18+09:00 に `test/independent-fixes.test.ts` の `RDMCP-MVP-IFR-001` を最小修正した。新 owner の合法 watcher 呼出と stale owner の拒否を同じ adapter call list で混同していたため、B/D が確立後に watcher を fixture 内で停止して stale A/C の3操作だけが adapter へ委譲しないことを確認する。production と timeout は変えず、focused case は pass した。
- 同じ full gate で残る `RDMCP-MVP-IFR-004` の2件、`NR003 and NR004`、`NR005` は shared `test/fixture.ts` がすでに protected `DATA_DIR` を渡してから service を初期化している。前者は watcher/audit の非同期観測、後者は MCP request timeout のため、ACL fixture 不足としては扱わず、製品側の調査と Luna の再実行集計を待つ。
- 監査/watcher の製品側修正後、`RDMCP-MVP-IFR-004` の focused 2件は製品担当が pass を確認した。`NR003 and NR004` は pagination 修正後、製品担当が focused 2連続 pass（13.2 秒、13.0 秒）を確認した。両者は Luna の full gate による独立した再確認待ちである。
- `NR005: real HTTP OAuth validates PKCE, scope, redirect, replay, claims, and MCP file operations` の初回 timeout を「audit batch 修正前に開始した run の時機」とした説明は撤回する。`reference/validation/remote-full-gate-f4b2076` の immutable full gate でも 42 tests 中40 pass、1 fail、1 POSIX skip となり、NR005 は 73.45 秒で再発した。stage 診断を追加した focused run も exit 1、74,017.2006 ms で再現し、`session_open`、`file_read`、`file_patch` の後の `content_search` RPC が MCP `-32001 Request timed out`（SDK timeout 60,000 ms）になった。test timeout を増やさず、公開 HTTP MCP 経路の `content_search` 処理を製品側で調査中である。
- 再現用に NR005 fixture は service 内部の Desktop Commander call を一時 wrapper し、method 名と相対開始/完了時刻だけを failure message に加える。query、path、response、token、環境値は記録しない。wrapper は cleanup 前に復元する。診断追加直後の focused run は 1 pass、0 fail、14,069.9801 ms だったが、解消証拠にはしなかった。
- 同じ source（`f4b2076d4d026c8710985c0a81f9c9c83617ad41`、`src/index.ts` は IFR004 の `process_output` にだけ未 commit の1行差分）で、診断付き再実行の1回目は exit 1、73,430.9833 ms で再発した。trace は `read_file` と `edit_block` の各 `get_config` 完了後に、`start_search` とその前提の `get_config` を開始して、後者の完了を記録しないまま timeout となった。`get_more_search_results` と `stop_search` には到達していない。したがって問題は `content_search` の `start_search` 前に `verifyAllowedRoots` が呼ぶ Desktop Commander `get_config` の応答待ちであり、最大3回の診断 run は失敗を得た時点で停止した。

## 文言セルフチェック

`document-wording-review` を新規報告として適用した。対象は本ファイル全体、baseline は新規文書のため不在であり、設計の公開認証契約、通常 review finding matrix、実測した試験結果を比較した。意味、識別、読みやすさに問題は見つからなかった。実 Google 接続未実施と mock 範囲を明記し、access/refresh を必要な token として区別した。用語機械検査の失敗は上記のとおり別記であり、用語承認は行っていない。
