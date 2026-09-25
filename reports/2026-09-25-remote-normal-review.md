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
