# Issue 43 使用者コンソール認証セッション設計

## 状態と範囲

本書は Issue #43 の設計草案であり、製品コードや実環境の認証設定は変更しない。認証境界を保ったまま、使用者コンソールで短時間に再ログインを求められる原因を識別し、改善する設計を定める。

対象は `/user` と `/api` の使用者コンソール認証セッションである。OAuth refresh token による MCP 接続認証、`session_open` が返す操作セッション、実行プロセスの寿命は対象外とする。

## 原因の切り分け

現行コードで確認できる第一候補は、ログインから 3,600 秒後に到来する固定の絶対有効期限である。`src/user-console.ts` の `newLogin` はログイン記録を `Date.now() + 3600_000` で作り、パスワードログインと Google callback は同時に `Max-Age=3600` の `rdmcp_user` cookie を発行する。`/user` middleware が cookie を再発行する場合も、既存の `login.expires` までの残り秒数を設定するだけで、期限を延長しない。よってコンソールを継続利用していても、ログイン後およそ 1 時間で cookie とサーバー側記録の双方が期限切れになる。

期限切れ後、`/api` middleware は `401 { error: "unauthorized" }` を返し、`/user` middleware は `/user/login` に redirect する。SSE `/api/events` は認証切れを `auth-expired` として通知する。ブラウザー側は `src/user-console-client.ts` で初回に状態を一度取得し、以降は SSE を開く。SSE heartbeat はログ接続状態の表示を更新するだけで、認証要求や cookie 更新を行わない。このため、ログ通知を受けながら画面を開き続ける利用形態でも期限は延びない。

別の確定した要因として、ログイン記録は `mountUserConsole` 内の `Map` にだけ保存される。プロセス再起動後は以前の cookie に対応する記録が存在せず、再ログインになる。これはコードから導ける挙動だが、今回の実際のログアウトが再起動で起きたという運用証拠は確認できていない。

| 候補 | コード上の判定材料 | 現時点で言えること |
| --- | --- | --- |
| 1 時間の固定期限 | cookie と `Login.expires` が 3,600 秒。認証済み要求でも期限を更新しない | 発生間隔が約 1 時間なら最有力。ソースで因果を説明できる |
| idle timeout | 現行 `Login` に最終利用時刻や独立した idle deadline がない | 現行実装の説明にはならない。提案設計では固定絶対期限と分けて導入する |
| refresh 処理 | 使用者コンソール認証には cookie/session refresh 処理がない | `/user` の cookie 再発行は残時間の再掲であり refresh ではない |
| SSE 再接続 | `/api/events` の再接続も新しい `/api` 認証を通る。heartbeat 自体は期限を延長しない | 接続断後に期限切れなら再認証が必要。SSE は期限延長の代替にならない |
| 認証プロセス再起動 | `logins` がプロセス内 `Map` | 再起動で全コンソールログインが失効する。永続化は現設計にない |
| 明示的 logout / 認可撤回 | `/user/logout` は CSRF を検証して map entry を削除。Google identity は許可判定を再確認 | これらの再認証は期待された境界であり、維持する |

Issue #22 / PR #23 はログ本文を分離した cursor 付き SSE 通知の設計・実装であり、認証 cookie の期限を扱わない。PR #35 は `src/public-auth.ts` の OAuth refresh token 同時更新競合を扱う。MCP 接続 token の有効期間や refresh retry を変えても、`rdmcp_user` cookie の 1 時間期限は変わらない。Issue #39 / PR #38 の CUI は読み取り専用コンソールの別表示を扱い、専用資格情報を増やさない方針である。これらは本 Issue の原因修正と重複しない。

`src/index.ts` の `SESSION_TTL` は操作セッションの 24 時間 idle timeout であり、各操作アクセスで更新される。これはコンソールのログイン cookie と別の認証・状態であり、使用者コンソールの期限を決めない。

## 推奨案

サーバー内の不透明なログイン session を維持し、新しい credential、永続保存、OAuth scope、依存 package を導入しない。ユーザーが操作している間だけ既存 session を更新し、idle と絶対期限を別々に適用する。

- idle timeout は 60 分とする。これは現行 cookie lifetime と同じ長さを維持し、操作が止まった後に使える時間を増やさない。
- absolute timeout はログイン成立から 8 時間とし、更新操作で延長しない。再認証は最長 8 時間ごとに必要となる。
- ログイン記録に `createdAt`、`lastActiveAt`、`idleExpiresAt`、`absoluteExpiresAt` を保持する。受理条件は両方の期限より現在時刻が前であることとする。Map の上限 2,000 件は維持する。
- 認証済み `/user` と `/api` の要求は `lastActiveAt` を更新し、`idleExpiresAt = min(now + 60 分, absoluteExpiresAt)` とする。SSE heartbeat だけでは idle 時刻を更新しない。
- 現在のブラウザーは SSE を開いたままローカルで画面を閲覧でき、操作のたびに HTTP 要求を出すとは限らない。そこで表示中かつ信頼できる pointer、keyboard、touch 操作があった場合、ブラウザーは 15 分以上間隔を空けて `POST /api/session/refresh` を送る。無操作、非表示 tab、通信切断では送らない。新しい endpoint は session expiry を更新するだけで、操作権限を追加しない。
- refresh 要求は同じ `rdmcp_user` cookie、既存 login CSRF token、正確な `Origin` 一致を要求する。成功応答は `Cache-Control: no-store` とし、応答 body に期限時刻以外の認証情報を含めない。ブラウザーは `credentials: same-origin` と `X-CSRF-Token` を使用する。
- 新 cookie の `Max-Age` は idle の残り秒数と absolute の残り秒数の小さい方を使う。サーバー側判定を最終権威とし、cookie の有効期間をどちらの期限より後へ伸ばさない。
- 同じ `/` path の cookie、`HttpOnly`、`SameSite=Lax`、HTTPS 時の `Secure`、既存 `/user` path cookie の削除、CSP、no-store を維持する。cookie に新情報を格納せず、既存のランダム bearer 値を継続する。

この案では 60 分の無操作失効を維持しつつ、操作の続く利用者は最大 8 時間まで再認証を避けられる。現行の絶対期限 1 時間を 8 時間に延ばすため、漏えいした browser cookie が利用可能となり得る最大時間が長くなる。cookie 属性や所有者分離を変えなくても時間ベースの露出は増える。従って「8 時間 absolute + 60 分 idle」は親レビューで明示承認されるまで実装・展開しない。より短い absolute timeout が必要であれば 4 時間などへ下げるが、活動中に 1 時間で切れないことは維持する。

## 認証・失効の境界

| 状態 | 判定と応答 |
| --- | --- |
| 未ログイン / 未知の cookie | `/api` は既存の generic 401、`/user` はログイン画面へ案内する。未知 cookie だけから再起動・改ざんを断定しない |
| idle timeout | session を失効し、次の要求で再認証を求める。最後の活動から 60 分後は refresh 不可 |
| absolute timeout | session を失効し、活動中でも 8 時間で再認証を求める。refresh は期限を越せない |
| 許可 identity の撤回 | 現行 `loginAllowed` の確認を維持し、拒否された session は即時利用不可として削除する |
| 明示的 logout | Origin と CSRF を検証して map entry を削除し、`/` と旧 `/user` path の cookie を期限切れにする。古い cookie の再利用を認めない |
| CSRF / Origin 失敗 | refresh は拒否し、期限を動かさない。既存の状態変更操作と同じ CSRF 境界を保つ |
| プロセス再起動 | Map が空になるため既存 session は失効する。再認証を案内し、session を復元しない |
| SSE 接続 | 認証済み接続の heartbeat は無操作扱い。サーバーは idle / absolute deadline で `auth-expired` を送り接続を閉じる。EventSource 再接続は通常の cookie 認証を通す |

login session を永続化して再起動後に復元する案は採らない。導入には cookie signing/encryption key の保護、保存先 ACL、共有環境での一貫した失効、鍵ローテーションを含む別設計と追加承認が必要であり、この Issue の最小修正ではない。

## 安全な診断

本番で起きた個々の logout 原因をコードだけで断定しない。既存の匿名化済み統計・ログが利用可能な範囲で、時刻と件数を照合する。token / cookie 値、cookie の hash、authorization header、password、Google token、メールアドレス、ユーザー主体、IP address は読取・記録しない。

必要な場合のみ、低頻度で次の定数カテゴリと件数を記録する: `missing_session`、`expired_idle`、`expired_absolute`、`identity_denied`、`logout`、`process_started`、`csrf_rejected`。認証失敗理由を外部 API の body に追加せず、既存の generic 401/403 応答を保つ。プロセス再起動後の未知 cookie は `missing_session` と数え、直前の有効 session があったとは推定しない。診断が既存の安全な匿名化ログで足りれば新ログは追加しない。

## 先行検証計画

製品実装前に次をテストで固定する。時計は `mountUserConsole` にテスト専用の `now()` 依存を注入して進め、global `Date.now` の差し替え、実認証設定変更、サービス再起動、ログアウト操作は行わない。

1. password login と Google callback が同じ idle / absolute session policy と cookie 属性を発行すること。
2. 59 分無操作の要求が通り、60 分到達後は `/api` 401 と `/user` の再認証案内になること。
3. 15 分間隔の CSRF 保護 refresh と通常の認証済み要求が idle timeout を更新し、活動中の session が 60 分で切れないこと。
4. 各 refresh の `Max-Age` が idle / absolute の残時間の小さい方を超えず、8 時間 absolute を越えた直後に拒否されること。
5. 非表示 / 無操作、Origin 不一致、CSRF 不一致では refresh されないこと。CSRF は既存の constant-time 比較を使うこと。
6. `/api/events` の heartbeat が idle timeout を更新せず、idle / absolute 到達時の `auth-expired` と通常の EventSource 再接続時の再認証を確認すること。
7. logout 後、直前の cookie で `/user`、`/api`、SSE、refresh を再利用できないこと。user A の cookie では user B のデータを取得できないこと。
8. allowlist から撤回された identity が再要求時に拒否され、認証 failure を外部に細分表示しないこと。
9. 別の `mountUserConsole` instance を作る単体テストで restart 後の Map 消失を表現し、以前の cookie が失効すること。これはテスト内の instance 境界であり、実プロセスの再起動ではない。
10. diagnostic sink を capture し、許可したカテゴリだけが記録され、cookie、token、主体、email、IP がログにないことを検査すること。

## 親レビューの決定事項

- 活動中の session に限り absolute timeout を現行 1 時間から 8 時間へ延長することを承認するか。承認しない場合は許容する absolute timeout を指定する。
- 60 分 idle timeout と、表示中の信頼できる操作に基づく 15 分 refresh 間隔を許容するか。
- 再起動失効は既存のプロセス内 session 契約として維持するか。永続化は本 Issue の範囲外であることを確認する。

実装は上記決定と親レビュー後に行う。本書だけでは実稼働 cookie / authentication の変更、サービス再起動、実 logout を行わない。
