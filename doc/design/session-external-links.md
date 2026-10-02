# セッション作成時の外部リンク

## 目的と範囲

Issue #45 の設計。セッションを作成するときに任意の外部URLと任意の表示タイトルを受け取り、使用者コンソールのセッション一覧で作業先へのリンクを補助情報として表示する。

この設計はセッション作成時の入力、タイトル取得、安全な表示、および後編集に引き継ぐ保存契約を定める。既存セッションの後編集APIや画面は実装しない。後編集の要件はIssue #48が扱い、URLとタイトルの保存・検証契約を共有する。

## 現状の根拠と変更境界

- `src/index.ts` の `session_open` は `working_directory` と `purpose` を必須入力にし、作成者を `Session.user` に記録してからセッションを保存する。作成時に認証済み使用者と停止状態を検査する。
- `userOwnsActiveSession` はセッション所有者と有効状態を照合し、`userOwnsAuditSession` はセッション作成監査記録を使って履歴の所有者を照合する。新しいリンク情報も同じ認可の内側で扱う。
- `src/index.ts` の `session.open` 監査記録はセッション一覧・詳細の基礎となる。`src/admin.ts` の `readSessionLogs` がイベントをまとめ、`src/user-console.ts` が一覧と詳細を描画する。リンク情報は当人のセッションイベントに結び付け、他人のイベントから読み込まない。
- `src/user-console.ts` の `escape` はテキストと属性に使えるHTMLエスケープ関数であり、使用者画面はnonce付きCSP、`Referrer-Policy: same-origin`、`X-Content-Type-Options: nosniff` を設定する。リンク出力もこの表示境界を維持する。
- 現在の依存一覧に外部ページ取得用ライブラリはなく、`src` と `test` に安全な任意URL HTML取得機能は見当たらない。標準Node.jsのHTTP/TLS/DNS機能で限定実装する案とし、新しい依存は追加しない。

## 入力とURL契約

`session_open` に任意の `url` と任意の `title` を追加する。従来の `working_directory`、`purpose`、認証、所有者割当、停止中の作成拒否は変えない。

- URLは前後空白を除いて最大2,048 Unicodeコードポイントとする。空文字は未指定として扱う。絶対URLのみを受け付け、schemeは `https:` と `http:` に限る。
- URL parserが正規化したURLを保存値とする。hostはDNS名またはIPリテラルに限る。scheme-relative、相対URL、制御文字、ASCII空白、userinfo、壊れたport、非HTTP schemeは無効とする。無効URLでもセッション作成は続け、外部取得とリンク生成を行わない。
- 過長入力は要求検証エラーとする。形式不正は入力自体を保持して安全な文字列fallbackにできるよう、要求エラーにせず無効状態として扱う。元文字列は上限内に限って保存し、HTML表示時に制御文字を可視の置換文字へ変換する。
- URLのpath、query、fragmentは利用者が入力した値として扱う。queryに含まれる秘密値の推測や自動削除は行わない。完全なURLはセッション所有者が開けるリンク先情報としてセッション記録へ保存されるため、利用者に入力元の秘密情報をURLへ含めないよう入力UIで説明する。`session.open` の所有者付きリンク情報は既存の監査閲覧権限（本人と管理者）で扱う。操作監査の通常のdetail、診断ログ、エラー文、タイトル取得イベントにはURL、query、取得本文を出さない。
- HTTPとHTTPS以外のschemeは、リンク表示にもtitle取得にも利用しない。手入力titleがあり、URLが無効な場合はtitleを通常テキストとして表示する。

## タイトル契約

- `title` をtrimし、空なら未指定とする。空でない手入力titleは最大200 Unicodeコードポイントとし、自動取得を行わず手入力値を優先する。
- 手入力titleが未指定でURLが有効な場合にだけ非同期取得を開始する。title取得はセッション作成応答を待たせず、失敗してもセッションを失敗にしない。
- 自動取得titleはHTMLの文書タイトル要素からプレーンテキストを抽出し、前後空白を除く。空または200コードポイントを超えるtitleは採用せず、URL表示へfallbackする。HTML entityはデコード済みの安全な文字列として扱い、未対応entityは文字列のまま保持する。本文やscript/style要素をtitleとして使わない。
- title文字列は信頼できない入力である。画面へ出す際に毎回HTMLテキストとしてescapeする。URLをhrefへ使う場合も属性escapeの上で、保存値をHTTP/HTTPS URL parserで再検証する。DOMへ文字列連結で差し込む実装は禁止する。
- 有効なURLとtitleが揃った一覧項目は、URL文字列を表示せずtitle全体だけをリンクにする。titleがまだない、空、取得失敗の場合は有効URLを表示テキストとしたfallbackリンクを使う。URLが無効ならリンクを作らず、存在するtitleまたは置換済みURL文字列を通常テキストとして表示する。URLもtitleもなければ項目を表示しない。
- リンク項目はセッション行の右端に、日時・状態・作業ディレクトリより低い視覚優先度で置く。小さな文字と控えめな色を用い、主要なセッション詳細リンクより目立たせない。長い文字列は折り返す。
- 外部リンクは `target="_blank"`、`rel="noopener noreferrer"`、`referrerpolicy="no-referrer"` を明示する。画面全体のReferrer-Policyより厳しい属性を維持し、別ページからopener経由で操作されず、URLを外部サイトへrefererとして送らない。

## タイトル取得のネットワーク境界

取得はログイン済み利用者が指定したURLの表示補助にのみ使う。リクエストは専用のNode.js標準HTTP/TLSクライアントから直接行い、既存HTTP proxy設定、Desktop Commander、ブラウザーCookie jar、アプリのAuthorization headerを使用しない。送信headerは固定User-Agent、`Accept: text/html`、`Accept-Encoding: identity`、`Connection: close` に限る。Cookie、Authorization、Proxy-Authorization、Referer、環境変数にあるcredentialは送信しない。

### 宛先の検証とDNS固定

1. URLを解析し、scheme、host、port、userinfoを再確認する。許可portはHTTPS 443とHTTP 80のみとする。明示的な別portは取得対象として拒否するが、セッション作成は続ける。
2. IP literalはアドレス分類を直接検査する。hostnameはOS resolverでA/AAAAをすべて解決する。単一ラベル名、末尾を含む `.localhost`、`.local`、`.internal`、`.test`、`.invalid`、`.example`、`.home.arpa` は拒否する。
3. 解決結果が空、曖昧、または一つでも禁止アドレスを含む場合はhostname全体を拒否する。IPv4は通常の公開unicastだけを許し、以下をCIDR単位で拒否する: 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.31.196.0/24, 192.52.193.0/24, 192.88.99.0/24, 192.168.0.0/16, 192.175.48.0/24, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4, 255.255.255.255/32。登録済みspecial-purpose範囲はglobally-reachable指定の有無によらず拒否する。IPv6は2000::/3内だけを候補とし、::/128, ::1/128, ::ffff:0:0/96, 64:ff9b::/96, 64:ff9b:1::/48, 100::/64, 100:0:0:1::/64, 2001::/23, 2001:db8::/32, 2002::/16, 3fff::/20, 5f00::/16を拒否する。fc00::/7、fe80::/10、ff00::/8は候補範囲外として拒否する。IANA special-purpose表の変更を実装時に再確認し、境界fixtureを含める。
4. 解決で検査した公開アドレスのうち1個にsocketを直接接続し、その接続試行のlookup callbackは検査済みアドレスだけを返す。TLS SNIと証明書検査には元のhostnameを使う。接続時に名前を再解決させない。このためDNS応答が後から内部アドレスへ変わるrebindingを接続先に反映しない。
5. アプリ自身のbind hostがloopback等であっても内部宛先を例外許可しない。名前解決不能、判定不能、検査器例外、socket宛先と検査済み宛先の不一致はfail closedとしてtitle取得だけを断念する。

アドレス分類器はNode.jsの既存APIと、レビュー可能な明示CIDR表で実装する。CIDR表はIANA special-purpose registryに基づくテストfixtureを添え、曖昧な形式は拒否する。アプリケーション内検証だけではOS経路制御や透過proxyによる転送先までは証明できない。運用環境もサーバーからprivate/link-local宛のegressを防ぐことを推奨するが、本Issueで認証やOS設定を変更しない。

### HTTP応答とredirect

- 1 redirectを含む総取得時間は8秒、各socket接続と各応答待ちは3秒までとし、いずれかの期限超過で取得を打ち切る。処理は常に非同期で、セッション作成や他利用者の操作を待たせない。
- redirectは301、302、303、307、308のみを認識し、最大3回まで追う。`Location` は現URLから解決した後、scheme、port、userinfo、DNS解決、全宛先IP、接続先固定を毎回やり直す。検査を保てないredirect、HTTPSからHTTPへのdowngrade、過剰なredirectは拒否する。redirect応答へ認証情報やcookieを転送しない。
- `Content-Type` が `text/html` でcharsetがUTF-8または省略の場合のみ読み、圧縮は要求しない。`Content-Length` が256 KiBを超える応答は読まず、chunked等で受信する場合も累積256 KiBでsocketを閉じる。HTTP成功status以外、HTML以外、UTF-8として不正な本文は失敗扱いとする。
- 失敗理由は内部の固定分類（URL不正、DNS拒否、接続失敗、status不適合、timeout、上限超過、titleなし、解析失敗）だけにする。取得本文、socket情報、任意URLを利用者向けエラーや監査ログへ含めない。

## 保存モデルと非同期競合

セッションのリンク情報は次の論理フィールドを持つ。既存の保存形式を置き換えず、未設定フィールドを許容する。作成時の `session.open` 記録にリンク値とrevision初期値を含める。これが現行のユーザーコンソール用セッション記録へリンクを結合する永続データとなる。

| field | 内容 |
| --- | --- |
| `externalUrl` | 上限内の正規URL。形式不正なら上限内の元文字列と無効状態を保持し、hrefには使わない。未入力なら省略。 |
| `externalTitle` | trim後の手入力または取得済みtitle。最大200コードポイント。空は省略。 |
| `externalTitleSource` | `manual` または `fetched`。未確定・失敗時は省略。 |
| `externalTitleStatus` | `pending`、`resolved`、`failed`、`not_requested` のいずれか。未入力時は `not_requested`。 |
| `linkRevision` | リンク情報の単調増加する整数。作成時は0。Issue #48 の後編集保存ごとに増分する。 |

手入力titleはセッション作成時に `manual` として `session.open` へ記録し、取得処理を起動しない。自動取得開始時はURLと `pending` を同じsession記録へ入れてすぐ作成応答を返す。取得workerはsession ID、所有者principal、URL正規値、revisionを開始時に捕捉する。結果は同じsessionがまだ存在し、所有者、URL、revisionがすべて一致し、title sourceが `manual` ではなく、statusが `pending` の場合のみ反映する。

結果反映時はリンクフィールド全体を一度に更新し、revisionを増やす。解決・失敗イベントはsession ID、所有者、revision、状態、titleのみを持ち、URLと本文を含めない。管理者監査に成功・失敗の細部を複製しない。本人向けコンソールではイベントを同一所有者・同一sessionの最新revisionへ結合し、遅れて届いた小さいrevisionのイベントで新しい値を戻さない。無効URLまたはtitle指定なしは `not_requested` とし、fetch workerを作らない。

Issue #48 の編集実装では、所有者確認と更新時の入力検証を行う。利用者がURLまたはtitleを更新したら `linkRevision` を増やし、非同期取得が開始済みであっても旧revision結果を破棄する。手入力titleが新たに指定された更新では `manual` が優先され、以前の取得結果を採用しない。既存実行中processのcwd契約や編集APIの実装範囲を本Issueへ含めない。

## テスト計画（synthetic fixture、TDD）

先に隔離されたfixtureで失敗する契約テストを書き、続けて実装して通す。公開サイト、実ネットワークの攻撃再現、外部宛の負荷試験は行わない。DNS resolver、socket transport、clockは注入可能にし、テスト内の合成応答だけで検証する。

1. 入力: URL/title未指定、trim、境界長、上限超過、HTTP/HTTPS、相対・壊れたURL、userinfo、非HTTP scheme、非標準port、手入力title優先を検証する。無効形式と取得不能でもsession_open成功、作成者と停止状態検査が従来どおりであることを確かめる。
2. 取得許可: 合成DNSで公開IPv4/IPv6は通り、loopback、private、link-local、shared、unspecified、documentation、multicast、予約範囲、IPv4-mapped IPv6、非公開IPを含む混在回答、単一ラベル名、内部suffixは拒否されることを確認する。
3. 解決結果が空、曖昧、または一つでも禁止アドレスを含む場合はhostname全体を拒否する。IPv4は通常の公開unicastだけを許し、以下をCIDR単位で拒否する: 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.31.196.0/24, 192.52.193.0/24, 192.88.99.0/24, 192.168.0.0/16, 192.175.48.0/24, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4, 255.255.255.255/32。登録済みspecial-purpose範囲はglobally-reachable指定の有無によらず拒否する。IPv6は2000::/3内だけを候補とし、::/128, ::1/128, ::ffff:0:0/96, 64:ff9b::/96, 64:ff9b:1::/48, 100::/64, 100:0:0:1::/64, 2001::/23, 2001:db8::/32, 2002::/16, 3fff::/20, 5f00::/16を拒否する。fc00::/7、fe80::/10、ff00::/8は候補範囲外として拒否する。IANA special-purpose表の変更を実装時に再確認し、境界fixtureを含める。
4. redirect: 合成redirectを0〜4回与え、上限、relative Location、scheme downgrade、別hostへの再解決、内部IPへの転送拒否、userinfo/port拒否を確認する。各hopのresolverとtransport検査が必ず実行されることを記録する。
5. 応答: 合成status、Content-Type、charset、Content-Length、chunked相当stream、256 KiB超過、期限超過、不正UTF-8、空title、title上限を検証する。cookie、authorization、proxy authorization、referrerが送信headerにないこともtransport fixtureで照合する。
6. 非同期競合: pending fetchが終わる前の手入力更新、URL更新、セッション終了、revision更新、および古い更新イベントが新revisionへ上書きしないことを合成promiseで順序制御して確認する。
7. 表示と所有者: `<`, `>`, `&`, quote、制御文字を含むtitle/URLをfixtureに使い、escape後のHTML、属性、URL文字列を確認する。titleがあるとhref以外にURLが現れず、右端の低優先表示・新規tab・`noopener noreferrer`・`no-referrer` が揃うこと、無効URLはリンクにならないことを検証する。他人の監査sessionへリンク情報を返さない。
8. 回帰: 既存の `session_open`、ユーザーコンソール、監査ログ、作成認可、緊急停止テストを継続する。外部通信テストにはlocalhost serverを使わず、合成transport fixtureのみを使う。

## 非目標と次工程

- 外部ページの本文保存、サムネイル、favicon、script実行、meta refresh、cookie jar、credential保管、private repository accessは対象外。
- 認証scope・OAuth grant、OS firewall、egress proxy、session後編集APIの変更は対象外。非公開PR等にログイン既存credentialを流用しない。取得不能なURLでは手入力titleで補えるようにし、手入力がない場合はURL fallbackを表示する。
- 実装は親の設計レビュー後に開始する。レビューでCIDR分類表、タイトル解析のHTML entity処理、リンクフィールド保存・履歴表示の詳細が承認されてからIssue #45 のTDDを開始する。

## 参照

- [IPv4 Special-Purpose Address Space (IANA)](https://www.iana.org/assignments/iana-ipv4-special-registry)
- [IPv6 Special-Purpose Address Space (IANA)](https://www.iana.org/assignments/iana-ipv6-special-registry)
