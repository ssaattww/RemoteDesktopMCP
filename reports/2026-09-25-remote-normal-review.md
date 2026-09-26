# 公開接続の通常レビュー

## タスクと範囲

ChatGPT から単一 Windows PC を操作するための Google OIDC、MCP OAuth、設定手順、試験をレビューする。
前回のローカル版レビューとは別の作業。実アカウント接続の未実施を、試験用認証の成功と区別する。

## Dispatch profile

- selection inputs: review, judgment_heavy, high uncertainty, cross_system, high criticality, single repetition, fresh context.
- selection source: user_override; レビュー Sol / high。
- observed decomposability: independent_workstreams.
- decomposition policy / disposition: forbidden / prohibited_by_review_lifecycle; single_agent.
- requested profile: gpt-6-sol / high / fork_turns none.
- agent role / default-role plan: ツールの既定 role。別の role 切替フィールドなし。
- role config evidence / profile effect: 公開ツール定義の model と reasoning_effort を指定、別 role による変更設定なし。
- planned runtime profile: gpt-6-sol / high.
- applied profile: null.
- application status: spawn_succeeded_profile_unverified; identity /root/remote_normal_review.
- runtime profile observability: final_profile_hidden.
- approval: not_required; 利用者が明示指定。
- fork policy: none. 異なる作業なので新規担当。
- report persistence mode: normal_persistence.

## 結果

### 対象と結論

- mode: initial normal review。reviewer: `/root/remote_normal_review`。実装・試験・文書の著者ではない同一担当による単独レビュー。分解はしていない。
- reviewed implementation HEAD: `2e6ecefef8b0b2b4e0903565a7496b8050e5a443`。base: `8d72bb8dbc9464e03268bc5be39b72cb929f7e11`。branch: `feat/tailscale-funnel-design-lint`。実装21ファイルの全差分と直接依存を確認した。親所有の本報告 Dispatch 編集は対象 HEAD の実装変更として扱わない。
- verdict: **fail**。下記の必須修正を残した状態では公開接続のコード受入不可。実 Google 資格情報の作成、本人登録、ChatGPT 本人接続、公開 Funnel 経路、再起動後の実 refresh は別の F03 実運用証拠であり、このコード判定の代用品ではない。調査時点の「未作成」は歴史状態で、レビュー中に利用者が Google Web OAuth クライアントを作成した。実際の本人認証・接続は未達。
- verification capability: `local_execution_available`。Windows / PowerShell / `C:\Users\donabe\Project\RemoteDesktopMCP`、`exec_command` と Node/npm が利用可能。push 前のためこの HEAD と一致する CI run はない。commit と push は親所有、レビュー担当は実装・commit・push を行っていない。

### 必須 finding

| ID / severity | source・locus | proof / impact | required action |
| --- | --- | --- | --- |
| REMOTE-NR-001 / P1 | `src/public-auth.ts:15,131,161-164,180-181`; `reports/2026-09-25-remote-design.md` の7日 refresh 契約 | `MAX_REFRESHES=256` が使用済み refresh も数え、7日間保持する。`reference/validation/review-refresh-cap.ts` を `npx.cmd tsx` で実行すると、単一 family の256回目の更新が `The refresh-token store is full.`、保存件数256で失敗。10分 access TTL に沿う更新なら約42.7時間で継続不能となる。family 履歴も期限後に清掃されない。 | 使用済み token の再利用検知を維持しつつ、通常の1接続の7日間ローテーションが容量上限で止まらない永続表現と期限後の family 清掃を実装し、1 family の長時間連続更新・replay の組合せ試験を追加する。 |
| REMOTE-NR-002 / P1 | `src/remote-auth-cli.ts:26-37`, `src/public-auth.ts:41-48`, `src/index.ts:180-203`; Windows 公開運用設計 | `.env` は Google client secret と TOKEN_SECRET を平文保存し、state は許可主体と refresh hash を保存する。CLI と store は `mode: 0o600/0o700` だけで Windows ACL を設定・確認しない。[Node公式 fs 文書](https://nodejs.org/download/release/v24.20.0/docs/api/fs.html) は Windows では owner/group/others の権限差を実装しないと明記。継承 ACL が広い場所で秘密保護の保証がない。親が今回の実環境 `.env` ACL を手動で限定したことは、この一般コードの欠落を解消しない。 | Windows で `.env`、`DATA_DIR`、状態・監査・一時ファイルの ACL を作成時に狭めて検証し、広い ACL なら起動を拒否する。既存ファイルと親ディレクトリ、再起動後を試験する。 |
| REMOTE-NR-003 / P1 | `src/index.ts:483-536,632`; 公開設計の MCP tool metadata 契約 | `registerTool` 全件に OAuth `securitySchemes` がなく、失効時は transport 前に HTTP 401 のみで `_meta["mcp/www_authenticate"]` 付き tool error を返せない。公式 [OpenAI 認証仕様](https://developers.openai.com/plugins/build/auth) は tool-level linking UI に per-tool metadata と runtime challenge の両方が必要とする。HTTP 401 の resource metadata discovery は実装・試験済みだが、tool-level 再認可経路と同一証拠ではない。SDK現行 `registerTool` 型は `_meta` を受けるが `securitySchemes` フィールドを公開していないため wire 出力の確認が必要。 | 現行 SDK で ChatGPT が読む tool metadata と失効時 challenge を実際の `tools/list`・tool 応答で成立させ、期限切れ token からのリンク/再認可動線を検証する。初期 HTTP 401 discovery との役割を分けて示す。 |
| REMOTE-NR-004 / P1 | `src/public-auth.ts:157-158`; `doc/design/functional-requirements.md:13` | `addAllowedSubject` は別の `iss+sub` を既存許可表へ追加できる。CLI `authorize-google` を別アカウントで再実行すると2人とも `allowed()` を通り、要件「登録された1ユーザーだけ」に反する。 | 1人制約を永続状態と CLI の双方で強制する。アカウント交代を許すなら明示的な置換と epoch 失効を伴わせ、2人目の追加拒否または置換後に旧主体が通らない試験を追加する。 |
| REMOTE-NR-005 / P2 | `src/public-auth.ts:169-175`; 設計の許可主体失効契約 | code 交換は保存状態を再読込するが、その code の `subject` が現在の許可表にあるかを確認せず `issue` へ渡す。承認後・交換前に主体を削除/交代した場合、新 epoch の access と refresh が発行される。`authenticate` は access を拒否するため権限実行は防ぐが、削除済み主体への資格発行は fail-closed でない。 | code 交換時に現在の主体許可と grant epoch を確認してから発行し、削除・置換・epoch 更新後の未使用 code を拒否する試験を追加する。 |
| REMOTE-NR-006 / P2 | `src/index.ts:540,552,617-632`; 公開設計の要求サイズ/回数上限 | `RateLimit` は固定キーごとに直近1分の全 timestamp を保持し、11件目以降も無制限に append する。大量の unauthenticated `/authorize`・`/token` で配列走査とメモリが増え、単一の全利用者向け枠を飽和させられる。`/google/callback` と `/mcp` は回数制限がなく、`/mcp` は毎回 state 読込と拒否監査を行う。長い chunked body は content-length 事前条件も回避する。 | 固定容量・期限の制限器、公開 callback/MCP の上限、body bytes と時間の上限を実装する。未知 client からの連続拒否が正規接続を恒常的に塞がず、メモリが増え続けない試験を追加する。 |
| REMOTE-NR-007 / P2 | `src/public-auth.ts:165,183-185`; 設計の access claim 検証契約 | 発行 token は `iat`、`nbf`、`client_id` を含むが、認証時はこの3 claim を検査しない。署名・iss/aud/exp/epoch/family/主体の照合はある。現発行経路から不正 claim は作れないが、仕様で要求した token 境界検証が未完成。 | `iat` と `nbf` の型・時間、固定 client ID、許容最大 token 寿命を検査し、未来時刻・欠落/別 client の署名済み fixture token を拒否する試験を追加する。 |
| REMOTE-NR-008 / P2 | `test/public-auth.test.ts:151-194,209-320`; `reports/2026-09-25-remote-tests.md` の RA-02/05/07/08/09/10 表 | 追加9件は正常 HTTP→MCP と署名拒否の良い根拠だが、試験表で「同時交換」「保存失敗 fail-closed」「別 client/redirect/PKCE/scope の code 流用」「秘密の監査・例外除外」「実公開設定不足」を確認したとする範囲は実アサーションにない。`Promise.all` は fixture の mkdir のみで、refresh 競合試験がない。file store の保存失敗・restart は mock `memoryStore` では証明できない。 | 上記必須境界を focused 試験で実際に実行し、試験表と結果を実測範囲に直す。store 失敗・restart は実ファイル store または同等の失敗注入で確認する。 |
| REMOTE-NR-009 / P1 | `src/remote-auth-cli.ts:60-64`, `doc/remote-setup.md:50-64`; 実環境の本人登録試行 | CLI は `explorer.exe` を `spawn` してすぐ `unref()` し、起動成否を見ず認可 URL も表示しない。親担当が実 Windows で `authorize-google` を開始したところ利用者の画面に Google 認証画面は開かず、待受は残ったため Ctrl+C で終了した。本人登録が進められず、手順の「表示された Google の認証画面」と一致しない。秘密は出力されず、許可表は未登録。 | ブラウザー起動の結果/失敗を扱い、手動で安全に開ける公開 Google 認可 URL を端末へ表示するなど確実な fallback を用意する。localhost callback が待受中であること、ブラウザーで開いた後に本人確認と明示承認が完了することを Windows 実環境で確認し、手順へ反映する。 |

### カバレッジと証拠

| criterion | disposition / evidence |
| --- | --- |
| 要件・設計、単一ユーザー、公開/開発モード | `checked_finding` REMOTE-NR-003/004/005。公開時 password fallback 不使用、固定 base/resource/issuer、loopback bind は `src/index.ts:47-71,636` で確認。 |
| Google OIDC 署名・iss/aud/azp/nonce/exp/iat | `checked_no_finding` `src/public-auth.ts:63-101` と RSA fixture。JWKS fixed URL、body size/timeout/redirect 拒否を確認。実 Google は held。 |
| state/cookie/consent/replay、resource/client/redirect/PKCE/CIMD | `checked_no_finding` `src/public-auth.ts:121-155,169-181`, `src/index.ts:542-631`。stateとCookie照合、固定CIMD URL/callback、code原子消費、refresh 直列更新を確認。発見した失効・長期更新は REMOTE-NR-001/005。 |
| 永続化・epoch/restart・同時更新 | `checked_finding` REMOTE-NR-001/005/008。state file は一時書込と rename、refresh原文非保存。単一サービス内 mutex は確認したが、全試験表が主張する失敗/競合 fixture はない。 |
| 秘密・Windows ACL・DC環境・既存 file/process 権限 | `checked_finding` REMOTE-NR-002。DC 子環境の Google secret/TOKEN_SECRET 除外は `src/index.ts:97-100`、root/`DATA_DIR` 重複拒否は `src/index.ts:184-187` で確認。既存 process は同じ OS user の任意コマンド権限で、doc/remote-setup.md に明示。 |
| HTTP status/security headers/rate/body bounds | `checked_finding` REMOTE-NR-006。成功/拒否で `no-store`、Secure/HttpOnly/SameSite cookie、401 challenge を確認。tool metadata は REMOTE-NR-003。 |
| API、設定、workflow、回帰、直接依存 | `checked_finding` REMOTE-NR-007/008/009。`package.json`/lock、`.env.example`、`tsconfig.json`、`test/fixture.ts`、SDK `server/mcp.d.ts`、DC 呼出・root確認を読んだ。`test/regressions.test.ts` の Windows PATH fixture 修正は該当 focused test 成功の報告と整合。 |
| 文書・task・報告正確性と wording | `checked_finding` REMOTE-NR-008 の試験表と REMOTE-NR-009 の本人登録手順。別記の document wording review は `fail`、機械 lint と別判定。 |
| current-HEAD CI | `held`。この HEAD は未 push、同一 HEAD CI run 不在。local execution は可能であり、CI 不在を local gate pass と扱わない。 |
| F03 実 Google/ChatGPT/Funnel/再起動 | `held`。新しい Web client は作成済みだが、reviewed HEAD では実 credentials 取込・本人接続・実 refresh の成功証拠なし。初回レビューのコード finding とは別の外部残作業。 |

21変更ファイルは `.env.example`、`README.md`、`doc/design/{functional-requirements,multi-pc-architecture,tailscale-funnel-architecture}.md`、`doc/remote-setup.md`、`package.json`、`package-lock.json`、`reports/2026-09-25-remote-{context,design,implementation,normal-review,tests,verification}.md`、`src/{index,public-auth,remote-auth-cli}.ts`、`tasks/tasks-status.md`、`test/{public-auth,regressions}.test.ts`、`tools/lint/markdown-whitelist.yaml`。全差分と関連本文を確認。旧独立報告は異なる scope なので判定を転用していない。作成済み `.env` や実 credential 内容は読取・記載していない。

### document_wording_review

- mode: normal initial review。reader: `/root/remote_normal_review`、Windows runtime_local。Skill source: `skills/document-wording-review/SKILL.md` と `references/decision-examples.md` を実読。target HEAD は上記、base は既存文書について上記 base、新規 `doc/remote-setup.md` と新規 remote 報告は `baseline_absent_new_file`。
- read coverage: `README.md` 変更導入部、3設計文書の差分前後と周辺段落、`doc/remote-setup.md` 全114行、`.env.example` の説明、`tasks/tasks-status.md` の変更段落・表、remote 6報告の全文、`tools/lint/markdown-whitelist.yaml` 新規14 term と1 alias、および承認によって影響する利用箇所。製品 code/lock/test の識別子のみの行は人向け prose 範囲から除外し、コメント/試験名/報告本文は確認した。
- meaning: `checked_finding` REMOTE-NR-009。`doc/remote-setup.md` の「表示された Google の認証画面」は実環境では画面が出ない場合に手順が継続できず、実装に手動 URL fallback がない。それ以外の1台公開を複数PCより前にする承認済み順序、本人登録が自動ではないこと、file root と process 権限の別境界、実接続未実施の条件は保持。
- identification: `checked_no_finding`。Google OIDC、CIMD、PKCE、Tailscale Funnel、URI、実コマンド/field名を識別可能なまま使用。
- approved usage: `checked_no_finding`。context に記録されたユーザーの exact 14語+別名承認と用語表を照合。`クライアントシークレット`/`シークレット` は OAuth 秘密、`プロジェクト` は Google 設定単位、`テストユーザー` は同意画面の試験利用者など、利用箇所の意味が承認と一致。承認外の単独語を新規許可したとは解釈しない。
- readability: `checked_finding` REMOTE-NR-009。起動失敗時に利用者が次に何を開くか分からず手順が止まる。それ以外の Google 側の二つの callback、ローカル登録、サービス起動、ChatGPT 接続、実動作確認は順に読める。歴史的な「設計開始時」差分は日付と非完了宣言があり、現状表との混同を避けている。試験表の実証過大は語感でなく証拠の問題として REMOTE-NR-008 に記録。
- mechanical lint state: 親/担当報告では Markdown lint 48ファイル0件、手順と要件語彙確認成功。通常review自身は再実行していない。用語承認 evidence は `reports/2026-09-25-remote-context.md`。wording result: `fail` (REMOTE-NR-009)。policy conflict、missing wording evidence はなし。

### 検証評価・次の工程

同じ実装 HEAD に対する既存報告の `npm run check`、`npm run lint:ts`、`npm run build`、公開追加9件、依存監査0件を確認した。Node 24 全件は旧 NR003/004 の Windows 空白パス fixture が原因で32/33、fixture 修正後 focused 当該 test 成功。修正後の全件 Node 22 gate と同一 HEAD CI は未完了。通常 reviewer 自身の追加再現は `npx.cmd tsx reference/validation/review-refresh-cap.ts` で REMOTE-NR-001 を確認した。port 3000、Funnel、実 Google は再現に使っていない。

finding completeness matrix は初回指摘のため未適用。実装担当の修正後、各 ID の required action、production path、合成 fixture、focused validation、修正 HEAD をそろえて同一 reviewer が fix verification を行う。severity reclassification なし。unexplored: 実 ChatGPT UI の連携/refresh は F03 の外部未実施。reserved independent-final-review path と report attestation は通常 review には該当しない。

### 同一担当の修正確認 1

- mode: normal fix verification。initial reviewed HEAD: `2e6ecefef8b0b2b4e0903565a7496b8050e5a443`。closure candidate HEAD: `a08343014ac8214e5efeb62156b46fceb5d81e13`。base と branch は上記初回記録と同じ。reviewer `/root/remote_normal_review` を継続し、別作業への分解をしていない。元の要求 profile は Sol / high、実際の runtime profile は非公開で観測不能。application status: `reused_existing_agent_profile`。実装・試験・ACL 補助の担当ではなく、修正は行っていない。
- closure-readiness verdict: **incomplete**。matrix は9行を列挙するが、REMOTE-NR-002/003/006/008 では required action に対応する production path と合成 fixture が欠けるか不一致で、`review-worker` の finding-limited closure 前提を満たさない。直接影響の予備検査で4件の必須欠陥も確認したため、技術受入は不可。REMOTE-NR-001/004/005/007/009 の修正証拠は確認済みだが、全体 closure verdict を pass/fail として確定する段階にはない。元 severity はすべて維持し、reclassification はない。初回の他 criteria の網羅レビューを繰り返していない。
- identity / evidence: Windows / PowerShell / 同一 workspace。レビュー開始・記録時 HEAD は上記候補 SHA、実装 tree clean。`reports/2026-09-25-remote-tests.md` の NR001〜009 matrix、初回→候補の15変更ファイル差分と直接影響、`src/private-storage.ts`、`test/private-storage.test.ts`、`test/fixture.ts`、公開認証追加試験、設定・報告・task の変更箇所を確認した。`.env`、実 Google JSON、外部 `DATA_DIR` の内容は読んでいない。port 3000 と Funnel は使用していない。

| ID / source severity | required action / production path / composition / focused evidence の判定 | closure |
| --- | --- | --- |
| REMOTE-NR-001 / P1 | `src/public-auth.ts` は family ごとに現行 refresh hash 1件だけを保存し、署名付き旧 token の再提示時に family を撤回する。`clean` は期限切れ family を除く。可変 clock と memory store を組み立てた `test/public-auth.test.ts:218-242` が10分間隔1,008回更新、同時交換1件成功、旧 token replay、8日後清掃を確認。v1空 refresh 状態も307-314で確認。 | `closed`。旧 v1 の既存有効 refresh 原文を新表現へ移行する試験はないが、初回公開前の実 state は更新 token 0件であり、本指摘の7日継続条件を妨げない。 |
| REMOTE-NR-002 / P1 | `src/private-storage.ts` は新規空 file/dir の ACL を狭めて再検査し、`test/private-storage.test.ts` は実 Windows で broad 既存 file/親を拒否する。一方 `createFileOAuthStateStore.load()` は既存 `oauth-state.json` を `assertPrivateFile` せずに `readFile` する (`src/public-auth.ts:51-55`)。`npm start` は package script の `--env-file=.env`、登録 CLI は `process.loadEnvFile` で既存 `.env` を事前 ACL 検査なく読む。`configure` は repo 親そのものに `assertPrivateDirectory` を要求 (`src/remote-auth-cli.ts:38`) するが、この実 workspace の repo ACL は inheritance protected=false。初回手順どおりの新規 configure が通常 checkout で失敗する。matrix の fixture は親を事前に private 化しており、この合成を通していない。 | `open`。既存 state/`.env` の起動前検査と、普通の checkout から秘密を安全に作れる CLI 経路の production path + fixture が欠ける。今回の実 `.env` と実 state は親担当が手動で狭い ACL へ保護済みという個別運用証拠であり、汎用コードの closure にはならない。repo 全体の ACL を自動変更せず、秘密 leaf の保護と親の書込権限検査を両立させる。 |
| REMOTE-NR-003 / P1 | `src/index.ts:488` は `securitySchemes` を `_meta.securitySchemes` と独自 `_meta["openai/securitySchemes"]` に置き、`test/public-auth.test.ts:387-402` もその mirror だけを検査する。[OpenAI 認証仕様](https://developers.openai.com/plugins/build/auth) と [tool descriptor reference](https://developers.openai.com/plugins/reference) の正規の tool top-level `securitySchemes` は wire にない。失効 `tools/call` の `_meta["mcp/www_authenticate"]` は出るが、値に公式文書が要求する `error` と `error_description` がなく、`resource_metadata` だけである (`src/index.ts:645`)。HTTP 401 discovery は別経路として成立。 | `open`。tools/list の正規 metadata と失効 tool result の完全 challenge を実 wire fixture で確認する。実 ChatGPT 接続は F03 に残るが、文書化された tool-level 契約を先に満たす必要がある。 |
| REMOTE-NR-004 / P1 | `src/public-auth.ts:174-179` は二人目の通常追加を拒否し、明示 `replace` は主体を1件に置換、epoch 更新と family/refresh 清掃を行う。`normalize` は保存状態の複数主体も拒否。`test/public-auth.test.ts:244-256` が二人目拒否・置換後の旧 access/refresh 失効を確認。 | `closed`。 |
| REMOTE-NR-005 / P2 | consent 時に現在主体と epoch を確認し、code に epoch を保持。code exchange は再読込した主体/epoch と client/redirect/resource/PKCE を検査 (`src/public-auth.ts:168-179,195-201`)。`test/public-auth.test.ts:244-269` が置換後未交換 code と binding mismatch を確認。 | `closed`。 |
| REMOTE-NR-006 / P2 | `RateLimit` は固定容量128 bucket、60秒回復、callback と unauthenticated MCP の cap、16 KiB の認証body上限を導入。`test/public-auth.test.ts:403-413` は unknown client 11回と chunked超過bodyを合成。残りは、`/mcp` の制限が `authenticate()` の state file 読込後 (`src/index.ts:645`) で、匿名連続要求が高価な読込を無制限に起こすことと、`/google/callback` の全員共有 bucket が state/cookie 照合前 (`src/index.ts:630-632`) で、無効 callback 30回だけで進行中の正規 transaction を429にできること。 | `open`。高価な認証処理前の有界 admission と、無効 callback による既存 transaction の枠消費を防ぐ経路/fixture が必要。固定 public client 値を知る攻撃者と匿名の新規正規依頼を完全に区別することはできないため、全匿名新規依頼の可用性保証は残余リスクとし、本 finding は既存 transaction と無制限 state I/O の実現可能な境界に限定する。 |
| REMOTE-NR-007 / P2 | `src/public-auth.ts:209-213` は `iat`/`nbf` の型と未来時刻、固定 `client_id`、最大TTLを検査。署名済み fixture token の claim を変更する `test/public-auth.test.ts:258-279` が各拒否を確認。 | `closed`。 |
| REMOTE-NR-008 / P2 | code の別 client/redirect/resource/verifier、同時 refresh、実 file store restart、save 失敗は追加試験 (`test/public-auth.test.ts:218-305`) で確認した。一方、初回 required action の誤 scope 拒否、秘密の HTTP 応答/監査/例外除外の実アサーションはない。`reports/2026-09-25-remote-tests.md:37-45` の RA-02/05/09/10 表はこれらを確認済みと引き続き記載し、RA-10 discovery に対する試験も実際は固定 JWKS と token endpoint だけである。`tasks/tasks-status.md` の F01a は追加9件と記すが公開試験は14件に増えた。 | `open`。上記必要な境界 fixture を追加するか、設計が必須としない部分なら試験表と tracking を実測範囲へ直す。秘密出力/監査の実確認は安全上の元指摘なので単なる表修正では閉じない。 |
| REMOTE-NR-009 / P1 | `src/remote-auth-cli.ts:62-69` は loopback 待受後に公開 Google 認可 URL を端末へ表示し、ブラウザー起動失敗時の手動 fallback を提供。`doc/remote-setup.md:45-57` は同じ PC のブラウザー、5分期限、ローカル承認を案内。`reports/2026-09-25-remote-context.md` と verification に、利用者本人の Google ログイン、ID token 検証、ローカル approve、CLI exit 0 の実証があり、秘密値の報告転記はない。 | `closed`。ChatGPT 公開接続・実 refresh は引き続き F03。 |

表中の `closed` は当該 ID の修正証拠を予備検査で確認した状態を指す。全9件の matrix が完成するまでは正式な finding-limited closure 判定を開始せず、元の初回 `fail` と全必須指摘の履歴を維持する。

#### 修正確認の coverage / wording / held

| criterion | disposition / evidence |
| --- | --- |
| 初回 finding の全 required action、変更 code と sibling case | `checked_finding`。上表で9件すべてに production path・fixture・focused結果・不足セルを記録。特に helper 単体成功を service/CLI の合成成功へ転用していない。 |
| 追加の `src/private-storage.ts` と直接依存、設定/失敗診断/秘密 | `checked_finding` REMOTE-NR-002。Windows ACL は新規 file 保護に改善したが、既存 leaf の起動時検査と通常 checkout configure が未成立。 |
| OAuth tool wire と HTTP、rate/body | `checked_finding` REMOTE-NR-003/006。resource discovery、callback と MCP fixture の実経路を読み、tool top-level metadata、challenge parameter、admission 順を確認。 |
| 永続 refresh/主体/claim と回帰 | `checked_no_finding` REMOTE-NR-001/004/005/007 の限定修正範囲。互換影響は上表で明示。 |
| 試験・報告・tracking 正確性 | `checked_finding` REMOTE-NR-008。focused pass は不足アサーションの代用にならない。 |
| current HEAD CI / F03 実運用 | `held`。未 push のため同一 HEAD CI 不在。Windows focused は16件中15 pass/1 POSIX skip/0 fail、`npm run lint` exit 0 と親の記録に結び付けた。実 Google 本人登録は成功、ChatGPT/Funnel 公開 MCP/再起動後実 refresh は未実施。最終 Node22 全gate は通常収束後。 |

`document_wording_review` は同じ reviewer が fix scope で実施。対象は `doc/remote-setup.md:43-57` の元の「表示された画面」から新しい URL fallback への全文脈、`reports/2026-09-25-remote-{context,implementation,tests,verification,storage}.md` の変更箇所と新規 storage 報告全体、`tasks/tasks-status.md:31-39`。Skill 本文と decision examples は初回に実読し、今回も本文を再読。意味/同定/承認語の用法/読みやすさのうち、手順の NR009 は各 `checked_no_finding` で修正確認済み。新たな用語承認変更はない。試験表の実測より広い主張と F01a 件数は意味・識別の `checked_finding` REMOTE-NR-008。mechanical lint は親の `npm run lint` success と分離し、wording result は `fail`。policy conflict はなく、歴史的な「調査時点」と現在の実本人登録を区別した表現は保持されている。

次は同一指摘の未解消4件だけを実装・試験担当へ戻し、修正 matrix の不足セルと新たな immutable HEAD がそろってから同じ reviewer で再確認する。severity と finding identity は維持。normal review には独立最終レビュー用の report-attestation allowlist は該当せず、`report_attestation_allowed=false`。unexplored は実 ChatGPT UI の挙動であり、F03 の実環境確認に所有させる。

### 同一担当の修正確認 2

- mode: normal fix verification。reviewer: `/root/remote_normal_review`。初回実装 HEAD `2e6ecefef8b0b2b4e0903565a7496b8050e5a443`、前回候補 `a08343014ac8214e5efeb62156b46fceb5d81e13`、今回の immutable reviewed implementation HEAD `3d676b89d0268c9d41f78251d7a351f232ad4f6f`。base/branch は初回記録どおり。元の要求 profile Sol / high、実際の runtime profile は非公開で観測不能。application status: `reused_existing_agent_profile`。実装・試験変更も他 agent への分解もしていない。
- finding completeness: **complete**。`reports/2026-09-25-remote-tests.md` の NR001〜009 の各行で元 required action、production path、実際の合成 fixture、focused 結果を照合した。前回不足の NR002/003/006/008 と、それらが直接変更した ACL・MCP wire・認可・報告 prose を確認した。他5件は前回の確認結果を維持し、今回の直接影響を調べた。元 severity の変更はない。
- verdict: **fail**。`REMOTE-NR-002 / P1` の親 ACL 境界に必須の未解消が1件ある。NR001/003〜009 は当該 finding の closure として `closed`。この verdict は今回の固定実装 HEAD に限る。実 Google 本人登録の成功は別証拠であり、ChatGPT 経由の公開接続が完了したという判定ではない。

| ID / source severity | required action・production path・composition・focused evidence の確認 | closure |
| --- | --- | --- |
| REMOTE-NR-001 / P1 | 7日 rotation・replay・期限清掃の前回確認を維持。今回の直接変更なし。 | `closed` |
| REMOTE-NR-002 / P1 | `src/bootstrap.ts` と `src/remote-auth-cli.ts` は既存 `.env` の ACL を load 前に検査し、`src/public-auth.ts` の file store は既存 state を read 前に検査する。Windows 実 ACL fixture は広い既存 leaf を拒否し、Users RX の親から strict `.env` を作成する。`test/private-storage.test.ts` は read-only 親と broad write 親を分け、focused 18件中の該当例は成功。ただし `src/private-storage.ts` の `assert-parent` は親の Allow ACE だけを列挙し、親の owner を検査しない。別の非許可主体が owner の場合、見かけ上 read-only の DACL でも owner が権限を変更して `.env` を置換できる。POSIX 側は uid を検査し、実 Windows 作業フォルダの owner も別途修正済みだが、一般コードの親条件は未完成。 | `open`。Windows の親 owner を current user / SYSTEM / Administrators に限定し、非許可 owner を持つ見かけ上安全な親の拒否を実 ACL fixture で確認する。元 P1 を維持。[Microsoft の owner 権限説明](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-10/security/threat-protection/security-policy-settings/take-ownership-of-files-or-other-objects) による。 |
| REMOTE-NR-003 / P1 | `src/index.ts` の MCP `tools/list` handler は全 tool の protocol top-level `securitySchemes` を出し、互換 `_meta` も保持。署名失効 `tools/call` は `resource_metadata`、`error="invalid_token"`、`error_description` を含む challenge を返す。port 0 の生 HTTP `tools/list` と失効 `tools/call` を検査し、初期 HTTP 401 discovery と区別した。SDK client が未知の top-level field を parse 後に落とすため、生 wire assertion が必要であり今回追加された。 | `closed` |
| REMOTE-NR-004 / P1 | 1人制約・明示置換・旧 grant 失効の前回確認を維持。今回の直接変更なし。 | `closed` |
| REMOTE-NR-005 / P2 | code 交換前の主体/epoch と binding 拒否の前回確認を維持。今回の直接変更なし。 | `closed` |
| REMOTE-NR-006 / P2 | `mcpAdmissionKey` は署名済み access だけを token 別 key にし、不正/匿名入力を固定 unknown key にまとめる。`/mcp` は `authenticate()` の永続 state load 前に admission を実施。Google callback は既存未使用 transaction の state と cookie を照合して別 key にする。port 0 fixture は unknown MCP 32件の 429 と state load 上限、無効 callback 31件の後の正規 callback 200、unknown client 11件後の固定 client 成功、chunked 17 KiB の 413 を確認。固定 client 名を秘密とは扱わず、匿名新規要求の完全な可用性保証は残余リスクとする。 | `closed` |
| REMOTE-NR-007 / P2 | access claim 型・時間・固定 client・最大寿命の前回確認を維持。今回の直接変更なし。 | `closed` |
| REMOTE-NR-008 / P2 | file store restart/save 失敗、同時 refresh と code binding の前回試験に、誤 scope の HTTP 400、Google verifier 例外の secret sentinel 非出力、malformed body、監査 file の非出力 assertion を加えた。RA-10 の表現は実際の固定 Google token/JWKS と CIMD に限定し、F01a を公開16件へ同期した。 | `closed` |
| REMOTE-NR-009 / P1 | 認可 URL fallback、ローカル待受、本人ログイン/明示承認、CLI exit 0 の前回実証を維持。CLI の既存 `.env` 検査と通常親からの configure は NR002 の直接影響として別途確認した。 | `closed` |

#### coverage、wording、held

| criterion | disposition / evidence |
| --- | --- |
| finding 9件の対応と変更の直接影響 | `checked_finding` NR002、他8件 `checked_no_finding`。今回の差分は `src/bootstrap.ts`、`src/{index,private-storage,public-auth,remote-auth-cli}.ts`、試験、設定 script、report/task の変更を照合。初回の全 criteria を再網羅していない。 |
| Windows private storage・設定・失敗診断 | `checked_finding` NR002。既存 leaf 拒否、通常 checkout の Users RX 親許可は成立。親 owner の暗黙の権限変更能力が残る。実 `.env`、外部 `DATA_DIR`、Google JSON 内容は読んでいない。 |
| MCP metadata/HTTP challenge/rate/body | `checked_no_finding` NR003/006 の限定修正範囲。固定容量と60秒回復は前回確認済み。匿名新規要求を固定公認 client 名だけで保護できないことは残余制約。 |
| 永続 token・単一主体・code/claim の回帰 | `checked_no_finding` NR001/004/005/007/008 の限定修正範囲。今回の合成と前回の focused 証拠を区別した。 |
| 文書・task・試験表の整合 | `checked_no_finding`。NR008 の過大主張と F01a 件数は修正された。P4 は単一 PC 公開を先に置き、F02 複数PCを後続と明記。F03 未完了を保持。 |
| current-HEAD local gate / CI / 実公開 | `held`。親の Windows focused は18件中17 pass、POSIX 1 skip、0 fail/0 cancel、exit 0、`npm run check`・`lint:ts`・`build` 成功。同一 HEAD の Node22 全体 gate は別担当が実行中、CI は未 push のため不在。実 Google 本人登録は成功したが公開サービス・Funnel・ChatGPT 実接続・再起動後の実 refresh は F03 所有で未実施。 |

`document_wording_review`: mode normal fix verification、reader `/root/remote_normal_review`、Windows runtime_local。`skills/document-wording-review/SKILL.md` を今回も実読し、decision examples は初回に実読済み。文書 target は今回 HEAD、before は `a08343014ac8214e5efeb62156b46fceb5d81e13`、新規 `reports/2026-09-25-remote-full-gate.md` は `baseline_absent_new_file`。`reports/2026-09-25-remote-{context,implementation,tests,verification}.md`、`tasks/{phases,tasks}-status.md` の変更文脈、normal-review の前回報告、新規 full-gate 報告を読んだ。`package.json` と code/test の識別子・fixture 名のみの行は prose 対象外。意味・識別・承認済み用語の用法・読みやすさは各 `checked_no_finding`。歴史的な初回時点の Google credential 未作成と現在の本人登録成功を区別し、試験表は mock と実証を分ける。前回 wording finding NR009 は閉じたまま。新たな用語承認変更・policy conflict・不足 evidence なし。親の `npm run lint` 成功は機械検査 evidence であり wording 判定とは別。wording result: `pass`。

remaining risk / next action: NR002 の parent owner 条件を実装・Windows ACL fixture で修正し、同じ担当がその finding と直接影響のみを再確認する。Node22 全体 gate と F03 実運用は別工程。unexplored: 実 ChatGPT UI の linking・refresh、Funnel 公開経路。通常 review に independent-final-review の report-attestation allowlist は該当せず、`report_attestation_allowed=false`。

### 同一担当の修正確認 3

- mode: normal fix verification。reviewer `/root/remote_normal_review`。初回 reviewed implementation HEAD `2e6ecefef8b0b2b4e0903565a7496b8050e5a443`、前回 `3d676b89d0268c9d41f78251d7a351f232ad4f6f`、今回の immutable reviewed implementation HEAD `75197bb42085e87e340df6fa5982aab54073014e`。同じ指摘の同じ担当を継続。元の要求 profile Sol / high、runtime profile は非公開で観測不能、application status `reused_existing_agent_profile`。実装・試験・commit・push は行っていない。
- finding completeness: **complete**。前回の NR001〜009 matrix と NR002 の残存 required action を引き継ぎ、今回の `src/private-storage.ts`、`test/private-storage.test.ts`、`reports/2026-09-25-remote-storage.md` の全差分と直接依存を確認した。新規親所有 `reports/2026-09-25-remote-handoff.md` と前回通常報告の収録も読んだ。変更 code は親 owner の判定だけで、他8件の production path は変更されていない。severity reclassification はない。
- `REMOTE-NR-002 / P1`: **closed**。Windows `assertSafePrivateParent` の `assert-parent` は同じ ACL object から owner SID を取得し、現在の利用者・SYSTEM・Administrators 以外なら、ACE が読み取り専用でも拒否する (`src/private-storage.ts:41-52`)。これにより前回の、非許可 owner が ACL を変更して秘密 leaf を置換できる境界を閉じた。既存の read-only Users 親は許容し、broad write 親は拒否する sibling case を維持。今回の fixture は `Users` SID を実 owner にした親で `assertSafePrivateParent` と `createPrivateFile` の拒否、leaf 非作成を検査 (`test/private-storage.test.ts:86-96`)。`reports/2026-09-25-remote-storage.md` は Windows focused 1 pass / POSIX 1 skip、exit 0、TypeScript check と対象 ESLint 成功を記録。親の報告では Markdown lint と `git diff --check` も成功。実 `.env` や外部 `DATA_DIR` の内容は読んでいない。
- other findings: REMOTE-NR-001/003〜009 は前回 `closed` を維持。今回差分による再開条件を認めない。通常 reviewer の今回の **code review verdict: pass_with_held**。必須コード finding は0件。これは公開運用の完了判定ではない。

| criterion | disposition / evidence |
| --- | --- |
| NR002 の required action、production path、fixture、focused validation | `checked_no_finding`。Windows の所有者境界と普通の checkout の読み取り専用親許容を区別し、helper API 変更なしを確認。 |
| 変更の直接影響、設定・秘密・失敗診断 | `checked_no_finding`。親 owner 判定は `bootstrap`、CLI configure/authorize、state store の既存呼出に適用される。PowerShell の診断は具体的 SID/secret を出さない既存固定文面。 |
| report/task prose と wording | `checked_no_finding`。`document_wording_review` は同じ reviewer が fix scope で実施。reader は Windows runtime_local、Skill は前回までに実読済み。対象は storage 報告の一般親/別 owner 行と新規 handoff の全文。意味・識別・承認済み用語の用法・読みやすさは各 `checked_no_finding`。storage の親条件を正しく伝える。新規 handoff は非最終の途中記録で、固定 HEAD `3d676b8` の検証進行と記す点は最終 handoff 時の同期対象として親へ連絡済み。mechanical lint は親の記録と分ける。wording result: `pass`。 |
| current-HEAD full gate、CI、F03 | `held`。全体 Node22 gate は前 HEAD で開始され継続中であり、今回 HEAD の全件成功に読み替えない。CI は未 push のためなし。実 Google 本人登録は成功済みだが、公開サービス・Funnel・ChatGPT 実操作と実 refresh は未実施。 |

unexplored は実 ChatGPT UI/Funnel の F03 経路。次工程は新 HEAD に対する全体 gate の結果と、利用者の実公開接続を別途記録すること。通常レビューに独立最終レビューの report-attestation allowlist は該当せず、`report_attestation_allowed=false`。

### 同一担当の F01c 直接回帰確認

- mode: normal fix verification。reviewer `/root/remote_normal_review`。前回 code review HEAD `75197bb42085e87e340df6fa5982aab54073014e`、今回の immutable reviewed implementation HEAD `f4b2076d4d026c8710985c0a81f9c9c83617ad41`。初回 `2e6ecefef8b0b2b4e0903565a7496b8050e5a443` からの同一 reviewer continuity。元の要求 profile Sol / high、runtime profile は非公開で観測不能、application status `reused_existing_agent_profile`。実装・試験・commit・push をしていない。旧 REMOTE-NR-001〜009 と旧 IFR の判定をこの F01c 証拠で書き換えない。
- scope/evidence: F01c は NR002 の厳密 ACL 検査が Node22 全体試験の既存 process/MCP/MVP 経路へ与えた直接回帰。`75197bb..f4b2076` の11変更ファイル一覧、`src/index.ts`・`src/private-storage.ts` の全差分、`test/{independent-fixes,mvp,private-storage}.test.ts` の全差分、implementation/tests/storage/full-gate/task/通常報告の変更文脈と直接依存を確認。実 `.env`・Google JSON・外部 `DATA_DIR` の内容は読んでいない。追加の全域レビューはしていない。
- closure-readiness: **incomplete**。`reports/2026-09-25-remote-implementation.md` の F01c matrix は失敗群、production path、focused 結果を列挙するが、IFR-004 行の「termination timeout 中に active session を読まない」は `watchProcess` と `process_status` にだけ適用され、同じ公開 tool `process_output` と合成 fixture が欠ける。下記の具体的な P2 欠陥があるため、コード受入も不可。今回 HEAD に対する formal verdict は `incomplete`、技術判定は `fail`。他の focused 成功を全体 gate 成功へ転用しない。

| ID / severity | source・locus | proof / impact | required action |
| --- | --- | --- | --- |
| REMOTE-NR-010 / P2 | F01c `src/index.ts:548-554`。旧 IFR-004 の termination timeout 境界に直接影響する新差分。 | `process_kill` が timeout になり `terminating` となった後、`watchProcess` と `process_status` は active session なら `observe` を避ける。一方 `process_output` は `finished` 以外で無条件に `observe(item)` を呼ぶ。既存 IFR-004 adapter は active の間も `read` が completion を返すので、`process_status` では保留される同じ対象が `process_output` 経由なら active のまま `finished` と exit audit に進む。focused fixture は timeout 後に `process_status` だけを呼び、`process_output` の sibling 経路を検査していない。 | active な `terminating` process の `process_output` も読込を避け、保留状態と既存出力を返す。timeout 後に status と output の双方を呼び、adapter read 回数が増えず状態と owner が維持され、session 消滅後に一度だけ exit audit と `finished` になる composition fixture を追加する。 |

| F01c failure group / required action | production path / composition / focused assessment |
| --- | --- |
| IFR-001 stale PID と watcher 混同 | `process_start` audit 後に watcher を開始し、audit 失敗でも `finally` で保持する。fixture は合法な新 owner watcher を停止してから旧 owner 委譲3操作を検査する。focused `same PID reuse` pass。`checked_no_finding`。 |
| IFR-004 finished/audit 順と terminating active | `auditExit` の成功後だけ `finished` を公開し、`watchProcess` と `process_status` は active `terminating` を読まない。IFR-004 2件 focused pass。ただし `process_output` sibling が欠落。`checked_finding` REMOTE-NR-010。 |
| NR003/004/005 audit ACL timeout | `assertPrivateAuditStorage` は直接の audit file と private directory を一つの PowerShell 呼出で従来と同じ owner・継承・3主体・完全制御条件で検査する。cache/TTL はなく、追記前に再検査する。Windows ACL fixture は directory と file の broad 許可を別々に拒否し、NR003/004 を2連続、NR005 を focused pass。`checked_no_finding`。 |
| NR003 streaming page omission | `file_search` は実返却の inclusive `Showing results start-end` の末尾を次 offset に優先し、hint は次点。全115 hit の focused 証拠。`checked_no_finding`。 |
| MVP isolated DATA_DIR 3件 | fixture だけが isolated data directory を service 初期化前に private 化。root overlap・OAuth one-use・snapshot/no-replace の assertion は弱めず、focused pass。`checked_no_finding`。 |

`document_wording_review`: mode normal fix verification、同一 reviewer/Windows runtime_local。Skill と decision examples は既読。target は今回 HEAD、before は `75197bb42085e87e340df6fa5982aab54073014e`。implementation の F01c 原因・表、tests の follow-up、storage の監査境界、full-gate の混在 HEAD と42件失敗、task の F01c/F03/F04 行を確認。意味・承認用語・読みやすさは `checked_no_finding`。識別は `checked_finding`: immutable HEAD の `reports/2026-09-25-remote-tests.md` NR002 行は現行の改名済み Windows ACL test と異なる旧名を示す。親には報告済みで、review 後の report-only working tree 修正を確認したが、その未コミット修正を今回 HEAD の証拠に算入しない。wording result は `fail`（report evidence 同定）。mechanical lint 成功は別証拠。

held: この HEAD の Node22 全体 gate は別の同一 Luna 担当が実行中で、終了結果をまだ得ていない。前回の42件中33 pass・8 fail・1 skip は実行中に HEAD が変わった混在 tree の結果で、今回 HEAD の成否ではない。CI は未 push、F03 の実 ChatGPT/Funnel 操作・再起動後実 refresh は未実施。旧 NR001〜009 の code closure 自体は維持するが、新 F01c finding と full gate の未達を隠して公開完了とはしない。unexplored: 実 ChatGPT UI と公開経路。次は REMOTE-NR-010 の product/fixture 修正と current-HEAD full gate の結果を、同じ reviewer が限定確認する。`report_attestation_allowed=false`。

### 同一担当の F01c 修正確認 2

- mode: normal fix verification。reviewer `/root/remote_normal_review`。前回 F01c HEAD `f4b2076d4d026c8710985c0a81f9c9c83617ad41`、今回の immutable reviewed implementation HEAD `96b10cd8b7026e73512de3c294f67894621709bf`。元指摘 REMOTE-NR-010 / P2 を同じ severity のまま追跡し、NR005 timeout と NR006 body deadline は今回の直接影響として確認した。初回 reviewed HEAD と reviewer 独立性・元 profile 観測制約は前節どおり。application status `reused_existing_agent_profile`。実装・試験・commit・push は行っていない。
- closure matrix: **complete**。`reports/2026-09-25-remote-verification.md` 末尾で3件それぞれの required action、production path、composition fixture、親の Node22 focused 結果を照合し、`f4b2076..96b10cd` の10変更ファイルと直接依存を確認した。全域の再レビューはしない。`reports/2026-09-25-remote-tests.md` NR002 の現行テスト名も target HEAD で同期済み。

| target / source severity | production path、composition、focused evidence | closure |
| --- | --- | --- |
| REMOTE-NR-010 / P2 | `src/index.ts:557` の `process_output` は `process_status` と同じく、終了待ちかつ Desktop Commander session が active なら `observe` を呼ばず、既存出力と `termination_unconfirmed` を返す。IFR-004 fixture は timeout 後に status/output 双方を呼び、adapter read 回数不変と owner 維持を確認し、session 消滅後の `finished` と単一 exit audit まで検査する。親 Node22 focused 成功。 | `closed`。旧 IFR-004 の過去判定は変更しない。 |
| NR005 timeout の直接修正 | `DesktopCommander.start` は `StdioClientTransport` の stderr pipe に data listener を connect 前に設け、内容を保存・ログ出力せず drain する。1 MiB stderr を書いて drain を待つ stdio MCP stub は initialize、`get_config`、`file_read` を合成し、実 HTTP NR005 も親 Node22 focused 成功。stage 診断は method 名・相対時刻だけで、query/path/token/response は記録しない。 | `closed`。前 HEAD の immutable full gate 42件中40 pass/1 fail/1 POSIX skip の唯一の NR005 timeout 原因に対応。今回 HEAD の全体成功とは別。 |
| REMOTE-NR-006 受信期限の直接影響 / P2 | `createApp` は受信開始から絶対15秒で遅い request を破棄し、`end`/`aborted`/response `close` で timer を解除する。port 0 公開 HTTP fixture は毎秒少量送る body の15秒拒否と、受信済み body の後に15秒超かかる MCP handler の成功を同じ構成で確認。途中の Accept 不足406は修正後の親 Node22 focused 1 pass/0 fail/exit 0、45,120.7298 ms に置き換えて評価した。 | `closed`。元 NR006 の severity と旧 closure を維持し、新しい timeout 経路のみ確認。 |

| criterion | disposition / evidence |
| --- | --- |
| process/HTTP/stdio の直接変更と sibling case | `checked_no_finding`。NR010 の公開 output tool、NR005 の stderr backpressure、NR006 の slow body と長 handler を確認。deadline や MCP SDK timeout を伸ばして試験を回避していない。 |
| secret・fail-closed・設定境界 | `checked_no_finding`。stderr は非保持で読み捨て、trace は method 名と相対時刻だけ。Google secret・実 `.env`・外部 `DATA_DIR` 内容を読まず、実運用 state を試験へ使わない。 |
| 試験表・task・文書 wording | `checked_no_finding`。`document_wording_review` は同じ reviewer が fix scope で実施。before は前回 F01c HEAD、target は今回 HEAD。implementation の stderr/timeout 原因、tests の NR005 再現記録、verification の3行 matrix、full-gate の前 HEAD 失敗、task の F01c 行、通常報告の変更を読み、意味・識別・承認用語の用法・読みやすさを各 `checked_no_finding` とした。前回の旧 test 名は target HEAD で一致する。親の Markdown lint 成功は wording 判定と別。wording result: `pass`。 |
| current-HEAD 全体 gate / CI / F03 | `held`。同じ Luna 担当が固定 HEAD の Node22 全体 gate を並行実行中で、終了結果は今回のコード判定へ転用しない。CI は未 push。Google 本人登録は完了、公開 ChatGPT/Funnel 実接続・再起動後の実 refresh は F03 所有で未実施。 |

verdict: **pass_with_held**。REMOTE-NR-010 / P2 の必須修正と F01c の直接関連2件はコード・focused 試験の範囲で解消。旧 NR001〜009 と旧 IFR の履歴を変更しない。全体 Node22 gate、CI、F03 実運用は別証拠であり、公開運用完了とは判定しない。unexplored: 実 ChatGPT UI/Funnel。独立最終レビューは未実施、通常 review で `report_attestation_allowed=false`。

### 独立 freeze 前の非最終文書同期確認

- mode: normal fix verification の文書・証拠 delta 限定。reviewer `/root/remote_normal_review`、前回のコード対象 HEAD `96b10cd8b7026e73512de3c294f67894621709bf`、今回の immutable reviewed implementation HEAD `69d504955dd8c21f8af8be8fa58b34d4f7442c5b`。`96b10cd..69d5049` は context/full-gate/handoff/normal-review/phases/tasks の6文書だけで、source/test/config は不変。元 Sol / high の要求と非公開 runtime profile、同一 reviewer 継続を維持。新たな code 網羅レビュー、実装変更、commit、push は行っていない。
- validation evidence: `reference/validation/remote-full-gate-96b10cd/` の開始・終了 source SHA は双方 `96b10cd8b7026e73512de3c294f67894621709bf`。`05-test.stdout.txt` の Node22 集計は43件、42 pass、0 fail、1 POSIX skip、153,650.9227 ms。test/lint/check/build/audit 各 exit file は0。今回 HEAD は文書差分だけなので、このコード・試験結果を今回の同一 source/test/config に適用できるが、Linux CI と POSIX 専用試験の結果にはならない。
- public operation evidence: context/handoff は、親が実 Google 本人登録を保持して公開サービスを起動し、起動時 PID28532、loopback `127.0.0.1:3000` と公開 HTTPS の health・Google モード・resource/issuer・CIMD 対応・未認証401案内を確認したと明記。これらは親の運用記録で、通常 reviewer 自身は実資格情報・外部 `DATA_DIR`・公開サービスを操作していない。非秘密の確認ファイルを許可 root に置き、利用者へ ChatGPT の `session_open`、`node_list`、`file_read` を依頼中。結果、再起動後の実 refresh、PC 再起動後の自動起動は未確認と区別されている。

| ID / severity | source・locus | proof / impact | required action |
| --- | --- | --- | --- |
| REMOTE-DOC-001 / P3 | `tasks/tasks-status.md:35` の F01 状態と、同ファイル F01c/F04・`tasks/phases-status.md` の今回変更 | F01 は現在も「通常指摘修正中、ChatGPT 認証待ち」と記す。一方 F01c/F04 と phase は今回の固定ソースの通常10件解消、全体 gate 成功を記す。同じ時点の task status として「修正中」は現在の事実と食い違い、独立 reviewer と利用者が未解消 code finding を誤認する。ChatGPT 認証待ちは正しい。 | F01 状態を「実 Google 本人登録成功、通常コード指摘解消、ChatGPT 認証待ち」等の現状に同期する。実 ChatGPT 接続を完了とは記さない。 |

| criterion | disposition / evidence |
| --- | --- |
| 6文書の changed prose と前後文脈 | `checked_finding` REMOTE-DOC-001。context は歴史的な未起動記述の後に「その後」で公開起動を追記。full-gate は前 HEAD 失敗と96b成功を分け、handoff は同 HEAD・未完了 F03/独立レビュー/CI を記録。normal-review は前回同一担当 closure を収録。 |
| code/test/config 差分と実証範囲 | `checked_no_finding`。6文書以外の変更なし。Windows Node22 の全体 gate は実ログで確認し、POSIX skip と未 push CI を明示。公開 endpoint は親の実測記録であり ChatGPT 認証成功に読み替えない。 |
| secret と権限・運用残作業 | `checked_no_finding`。報告には個人の主体・認可コード・client secret が載らず、`.env` は Git 対象外。handoff はサービスが PC 再起動時に自動起動しないこと、実操作と実 refresh が未確認なことを記す。 |
| document wording | `checked_finding` REMOTE-DOC-001。`document_wording_review` は同じ reviewer が fix scope で実施。before=`96b10cd...`、target=`69d5049...`、対象は6文書の全変更文脈と影響する F01 行。Skill と decision examples は既読、reader は Windows runtime_local。意味・識別は F01 現在状態の矛盾で `checked_finding`、承認済み語の用法と読みやすさは `checked_no_finding`。新たな用語承認や policy conflict はない。mechanical lint 成功は別。wording result: `fail`。 |
| F03 / CI / 独立レビュー | `held`。ChatGPT 実操作・実 refresh、Linux CI、POSIX ACL 試験、独立最終レビューは未完了として正しく所有される。 |

verdict: **fail**（この非最終文書同期だけ）。コード review の必須指摘0件・Windows 全体 gate 成功は維持するが、REMOTE-DOC-001 の状態不一致を修正してから独立 freeze に進む。同一担当が次の文書だけの HEAD でこの1件を限定確認できる。`report_attestation_allowed=false`。

### REMOTE-DOC-001 の限定解消確認

- mode: normal fix verification、同一 reviewer `/root/remote_normal_review`。前回文書対象 HEAD `69d504955dd8c21f8af8be8fa58b34d4f7442c5b`、今回の immutable reviewed implementation HEAD `ad472320830acf1c31fc0f7781bc374d2fd1b4da`。元 severity P3 を維持し、別の指摘やコードを再レビューしていない。元の要求 profile Sol / high、runtime profile 非公開、application status `reused_existing_agent_profile`。実装・commit・push は行っていない。
- change identity: 前回 HEAD からの差分は `tasks/tasks-status.md` の F01 状態1行と、前回の当 reviewer 報告の収録だけ。source/test/config は不変。したがって `96b10cd8b7026e73512de3c294f67894621709bf` の Windows Node22 全体43件中42 pass・POSIX1 skip・0 fail、および通常コード指摘0件の証拠範囲は変わらない。新 HEAD の Linux CI 実行を意味しない。
- REMOTE-DOC-001 / P3: **closed**。F01 は「実 Google 本人登録成功、通常コード指摘解消、ChatGPT 認証待ち」となり、F01c/F04 の通常10件解消・全体 gate 成功、phases の通常レビュー済みと一致。ChatGPT の認証・実操作は待機中と保持し、実 Google 本人登録を実 ChatGPT 接続成功へ読み替えていない。required action、production path=`tasks/tasks-status.md` F01、composition=同表 F01c/F04 と `tasks/phases-status.md`、確認結果の全セルが揃う。
- `document_wording_review`: mode normal fix verification。target は上記 HEAD、before は前回文書 HEAD。reader は同じ reviewer/Windows runtime_local、Skill と decision examples は既読。F01 原文・修正文と同じ表の F01c/F03/F04、phase の段落を照合した。意味・識別・承認語の用法・読みやすさは各 `checked_no_finding`、policy conflict と missing evidence なし。wording result: `pass`。mechanical lint と別判定。
- coverage: `checked_no_finding` 文書の状態整合、`not_applicable` 新しい source/test/config、`held` F03 の ChatGPT `session_open`/`node_list`/`file_read` 実結果と再起動後実 refresh、Linux CI/POSIX 専用試験、独立最終レビュー。実 `.env`・Google JSON・外部 `DATA_DIR` の内容は読んでいない。

verdict: **pass_with_held**。今回の非最終文書同期に必須 finding は残らず、通常コードレビューの必須指摘0件と Windows 全体 gate 成功を維持する。独立 reviewer は次の凍結 HEAD に対し独立の判定を行い、実 ChatGPT 操作・実 refresh の未確認を F03 と区別する。通常 review の `report_attestation_allowed=false`。

### 公開独立指摘3件の同一通常担当による限定修正確認

- mode: normal fix verification。reviewer `/root/remote_normal_review`、初回独立対象 `3ffd783c3fc38b46b54ccbacb97075f8581de41e`、修正 commit `c58352ddd860f3b113c08852bbb28d9946f2eed1`、今回の immutable reviewed implementation HEAD `a27f36b33e85abd7688879c5e8588b39029102bc`。初回通常レビュー以来の同一 reviewer identity と元の Sol / high 要求を維持する。実 runtime profile は観測不能、application status `reused_existing_agent_profile`。実装・試験・commit・push、実資格情報・実 state・外部 `DATA_DIR` の参照はしていない。独立 reviewer の最終判定を代行しない。
- scope: `3ffd783..c58352d` の IFR001 認証制限変更と HTTP fixture、IFR002/003 文書修正、`c58352d..a27f36b` の5文書だけ、および直接依存を照合した。後者に source/test/config 差分はない。元 REMOTE-NR-001〜010 や以前の IFR 全域を再レビューせず、3指摘の元 severity を維持する。

| 元指摘 / severity | required action・production path・composition evidence | 限定 closure |
| --- | --- | --- |
| `RDMCP-REMOTE-IFR-001` / P2 | `src/public-auth.ts` の `tokenAdmissionKey` は現在の in-memory code または署名・期限・client/resource/scope が妥当な refresh を credential 別 bucket に分類し、`consentAdmissionKey` は cookie-bound の未期限・subject 済み transaction を別 bucket に分類する。`src/index.ts` の `/token` と `/authorize/consent` は無効要求を固定 invalid bucket に入れ、本体の serialized state reload、epoch、許可主体、one-use、refresh family/replay 検査は残す。port 0 の実 HTTP fixture は無効 code 11件目と forged consent 11件目の429後、未使用 code と既存 signed refresh の200、正しい cookie-bound consent の303を確認。担当 focused は1 pass/0 fail/49,046.3432ms、固定 `c58352d` の Node22 全体は43件中42 pass/1 POSIX skip/0 fail。 | **code/test closed**。固定 public client を秘密識別子として共有正常 bucket に入れる元欠陥は解消。匿名の新規認可要求すべての可用性は識別不能なので保証しない。実運用中の旧版にはまだ反映されていない。 |
| `RDMCP-REMOTE-IFR-002` / P3 | `reports/2026-09-25-remote-verification.md` の冒頭と初期文書確認は日付と過去形で初期履歴に修正された。しかし同報告の後続「現在地」節 :67 は追加修正を「再検証中」と現在形で示し、matrix :74 は全体検証を「別途行う」と未来形で示す。後続 :78 と `reports/2026-09-25-remote-full-gate.md` は固定 `c58352d` の全体検証成功を記録済み。 | **open**。同じ temporal-context 欠陥が直接変更節に残る。下の finding 参照。 |
| `RDMCP-REMOTE-IFR-003` / P3 | `reports/2026-09-25-remote-tests.md` の storage/context への相対リンクを同じ `reports` ディレクトリから解決し、両リンク先の存在を確認した。 | **closed**。リンクの解決先は正しい。 |

| ID / severity | source・locus | proof / impact | required action |
| --- | --- | --- | --- |
| `RDMCP-REMOTE-IFR-002` / P3（残存） | `reports/2026-09-25-remote-verification.md:67,74` | :67 の「追加修正は再検証中」と :74 の「全体検証は追加修正後に別途行う」は、同じ文書の :78 にある `c58352d` 全体43件・42 pass・0 failの成功後も現在の状態に読める。初期履歴を時点付きにする元 required action が後続節まで一貫していない。 | 両箇所を当時の時点付き過去形にし、後続の固定 HEAD 全体成功と現在の未確認事項を区別する。 |
| `REMOTE-DOC-002` / P3（直接証拠の新規指摘） | `reports/2026-09-25-remote-implementation.md:86` | IFR001 matrix は「無効 code/refresh を既定10件まで送った」と記すが、`test/public-auth.test.ts:475-479` の11件はすべて forged `authorization_code` であり、無効 refresh は送っていない。正常 refresh 200の確認はあるため機能 closure は保てるが、試験入力の説明は実証範囲を過大に示す。 | composition cell を「固定 client の無効 code 要求11件後、正しい code と signed refresh が各200」など実 fixture に一致させる。無効 refresh flood の実証を主張しない。 |

| coverage criterion | disposition / evidence |
| --- | --- |
| admission の識別・本体 authorization 境界 | `checked_no_finding`。無効要求は固定 invalid bucket、発行済み credential/transaction は固有 bucket、本体は永続 grant を再検証する。署名済みでも revoke/replay 済み refresh が固有 bucket へ分類され得るが、その token を持つ相手に限られ、本体は拒否する。 |
| port 0 合成・全体 gate | `checked_no_finding`。HTTP fixture の無効 code/consent 429 と正常 code/refresh/consent 成功を source assertions と照合。`reference/validation/remote-full-gate-c58352d` の Node22 test exit 0、43件42 pass/1 POSIX skip/0 failと全コマンド exit 0を確認。`a27f` は文書のみの後続差分なので同じ source/test/config の Windows 結果として適用できる。 |
| 文書の意味・証拠識別・リンク・読みやすさ | `checked_finding` 上記 P3 の2件。`document_wording_review` は同一 reviewer が normal fix scope で実施。before=`3ffd783...`、target=`a27f36b...`、reader=Windows runtime_local。初期履歴の過去形、test 報告のリンク、handoff/tasks/phases の現在地は整合。承認済み用語の用法と読みやすさは `checked_no_finding`、temporal meaning と fixture evidence の識別は `checked_finding`。wording result=`fail`。mechanical lint 成功はこれらを解消しない。 |
| 実サービス・外部検証 | `held`。PID28532 は旧 `96b10cd` 版で稼働中。停止・修正版再起動をまとめた要求は自動承認レビューに実行前拒否され、理由詳細は未提示、操作は未実施。実 Google 本人登録は成功済みだが、修正版の実サービス反映、ChatGPT `session_open`/`node_list`/`file_read`、実 refresh、Linux CI/POSIX 専用試験、同一独立 reviewer の限定解消判定は未確認。 |

closure-readiness: **incomplete**。IFR001 の code/test と IFR003 のリンクは閉じたが、IFR002/P3 と直接証拠 `REMOTE-DOC-002/P3` が残る。verdict: **fail**（この固定 HEAD の限定文書 closure）。コードの新しい必須 finding はない。unexplored は実 ChatGPT UI/Funnel の F03 経路、修正版サービスでの実 refresh、Linux CI。通常 review では `report_attestation_allowed=false`。文書2箇所の時制と matrix 入力数を修正した次 HEAD に限り、同じ reviewer が限定再確認できる。

### RDMCP-REMOTE-IFR-002 と REMOTE-DOC-002 の限定解消確認

- mode: normal fix verification。同一 reviewer `/root/remote_normal_review`、前回対象 `a27f36b33e85abd7688879c5e8588b39029102bc`、今回の immutable reviewed implementation HEAD `14ac3ece0b3fea95989b15e65d87a0a36288f2c2`。元の P3 severity と Sol / high 要求を維持。runtime profile は非公開で観測不能、application status `reused_existing_agent_profile`。差分は当 reviewer の前回報告収録と verification/implementation の文書2件だけで、source/test/config は不変。実装・commit・push はしていない。

| 元指摘・required action | production path / composition | closure |
| --- | --- | --- |
| `RDMCP-REMOTE-IFR-002` / P3。独立初回直後の「再検証中」と focused 後の「全体検証予定」を現在の検証状態から区別する。 | `reports/2026-09-25-remote-verification.md:67` は「初回独立レビュー直後には…再検証中だった」と時点付き過去形にし、`:74` は focused 後に `c58352d` の全体検証を行い成功したと明示。`:78` の固定 HEAD 43件中42 pass/1 POSIX skip/0 fail、全コマンド exit 0、旧 `96b` 全体成功、実 ChatGPT 未確認との前後関係を照合。 | **closed**。前回指摘の現在形・未来形の矛盾は解消。 |
| `REMOTE-DOC-002` / P3。IFR001 の composition cell を実 fixture 入力に一致させる。 | `reports/2026-09-25-remote-implementation.md:86` は固定 ChatGPT client の無効 code 要求11件後に有効 code と refresh が成功すると記す。`test/public-auth.test.ts:474-490` は forged authorization code を11件送り、11件目429、その後に有効 code 200、有効 signed refresh 200を assert。無効 refresh flood の主張を削除した。 | **closed**。試験入力と成果の記述が一致。 |

coverage: 文書の時点・試験証拠の識別は `checked_no_finding`、新しい source/test/config は `not_applicable`。同じ reviewer の `document_wording_review`（normal fix scope、before=`a27f36b...`、target=`14ac3ec...`、reader=Windows runtime_local）は意味・証拠識別・承認済み用語・読みやすさを各 `checked_no_finding`、wording result=`pass` とした。変更文書の Markdown lint は53 file(s)、0 issue(s)、`git diff --check` 成功。前回の固定 `c58352d` Node22 全体 gate は source/test/config 不変の範囲で有効であり、この文書確認を新たな Linux CI や公開サービス実証と混同しない。

held: 稼働中の実サービスは旧 `96b` 版、修正版への再起動は未実施。実 ChatGPT 操作、実 refresh、Linux CI/POSIX 専用試験、同一独立 reviewer の限定解消判定は未確認。実 `.env`・Google JSON・外部 `DATA_DIR` の内容は読んでいない。unexplored: F03 の実公開接続経路。verdict: **pass_with_held**。この2件の必須文書指摘は解消し、前回閉じた IFR001 の code/test と IFR003 のリンク判定を維持する。通常 reviewer は独立最終判定を代行せず、`report_attestation_allowed=false`。
