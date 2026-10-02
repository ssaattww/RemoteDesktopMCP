# 認証済みコンソールJSON表示設計

## 目的

PR38 CUI準備で検討した本人状態確認を、まず既存Web認証境界内のJSON表示として提供する最小案を定義する。

## 状態

過去PR38では既存APIの回帰確認は行ったが、独立CUI入口の認証接続方式は未確認だったため、以前の設計完了扱いと「指摘なし」の判定は撤回する。

## 採用案

既存Webコンソール内で本人向けJSON表示またはdownloadを提供する。Browser -> 既存認証 -> 既存API -> JSON表示の経路とし、cookie/token搬送、新資格情報発行、OAuth権限追加は行わない。

## 既存機能根拠

src/user-console.ts の /api/logs、/api/console-state、/api/events を再利用する。/api配下は既存認証確認後に処理され、未認証時は401 JSON errorとなる。console-stateはprincipal単位でsessionを絞り、logs/eventsはsession_id指定時にowner確認を行う。

## JSON対象

セッション: id, purpose, working directory, created time, last access, state。
実行状態: operation id, session id, status, timestamps。
ログ: event id, timestamp, type, event data。

## 境界

他ユーザー情報を含めない。管理者例外による閲覧拡張は本設計対象外。HTML表示では既存escape境界を維持する。

## TDD対象

未認証拒否、owner以外非表示、JSON項目固定、不正session指定、read-only取得で状態変更や監査追加が発生しないことを確認する。既存API回帰greenはCUI入口完成の証明とは扱わない。

## ログ量

/api/logsにはlimitと上限があり、大量全件取得を前提にしない。

## 独立CLI

独立CLIが必要な場合は別設計とする。CLI認証方式、token管理、有効期限、revoke、OS保管方式、監査設計を追加判断する。既存cookie/tokenコピーは採用しない。

## 表示契約

既存APIを再利用し、Web認証済み画面の表示adapterでJSON表示モデルへ変換する。

既存endpointの追加は必須条件としない。不足する既存機能が確認された場合のみ別途設計する。

表示入力から表示までの契約:

- 入力: 既存認証済みユーザーのconsole-state/logs/events取得結果
- 変換: 表示専用modelへ限定変換
- 出力: JSON表示またはdownload対象として明示した形式のみ
- 状態変更: 行わない

## JSON表示項目境界

許可する項目:

- セッション識別子
- 用途
- 作業ディレクトリ
- 作成日時
- 最終アクセス日時
- 状態
- 操作識別子
- 操作状態
- 操作日時
- ログ識別子
- ログ日時
- ログ種別

除外する項目:

- 他ユーザーに属する情報
- 認証情報
- cookie/token
- OAuth情報
- 新規認証用情報
- 表示用途で不要な内部実行情報

command、output、詳細event dataなどの内部情報は、表示目的と公開範囲を設計レビューで確認するまで既定のdownload対象には含めない。

HTML表示時のescapeとJSON serializerの安全性は別々に確認する。

## 取得量とdownload

/api/logsの既存limit制御を前提とし、全ログ無制限取得は行わない。

downloadはJSON表示と同一の許可field境界を利用し、対象項目を固定する。実装時に対象外項目を追加しない。

## TDD条件

新UI/API adapterで自然なred対象:

- 未認証時の表示拒否
- owner以外の情報非表示
- 表示model項目固定
- 不正session指定時の扱い
- 取得操作による状態変更なし
- 取得操作による監査イベント追加なし

既存API regression green:

- 既存console-state/logs/eventsの認証・owner境界確認

これは新UI完成確認とは別扱いとする。

## 独立レビュー対応履歴

PR38-JSON-001（重要度: 中）:
既存API利用時の表示adapter契約、表示model、error表示、download境界を本書の「表示契約」「JSON表示項目境界」「TDD条件」に追加した。

PR38-JSON-002（重要度: 中）:
許可field、除外field、command/output/event dataの扱い、HTML表示とJSON生成境界を本書の「JSON表示項目境界」に追加した。

PR38-JSON-003（重要度: 低）:
既存API regression greenと新UI自然red対象を「TDD条件」で分離した。src/cui-output.ts等のadapter確認は新UI完成根拠には扱わない。

## 固定UI契約

JSON表示は既存認証済みユーザーコンソール内の既存ページへ表示パネルとして追加する。新HTTP route、新endpoint、新認証経路は追加しない。

配置:

- セッション一覧表示領域の近くにJSON表示パネル入口を配置する。
- 既存ユーザーコンソールの認証済み画面からのみ到達する。

表示状態:

- 初期: 取得前の待機表示。
- 読込中: 取得中表示を行う。
- 成功: 許可fieldのみJSON textとして表示する。
- 空: 空配列または空状態を明示する。
- 401: 認証切れとして再ログイン導線を表示する。
- owner拒否: 対象なしとして扱い、他ユーザー情報は表示しない。
- 一般error: エラー内容を限定表示し、内部情報をJSON表示へ流出させない。

再取得:

- ユーザー操作による明示更新を基本とする。
- 取得は読み取りのみで、session変更、operation開始、audit追加を発生させない。

## 固定JSON schema

表示modelのキーは以下に固定する。

Session:

- sessionId: string
- purpose: string | null
- workingDirectory: string | null
- createdAt: string（ISO日時）
- lastAccessAt: string（ISO日時）
- state: string

Operation:

- operationId: string
- connectionId: string
- status: "running" | "terminating"
- startedAt: null
- endedAt: null

`connectionId` は `/api/console-state` の `running[].connection_id` をそのまま対応させる。現行の `src/index.ts` は通常operationで入力`session_id`を`connectionId`と`sessionId`の両方へ記録し、session_open成功時は返却session IDを両方へ記録する。process項目は`process.sessionId`を使う。一方、同APIはoperation値を`event.connectionId ?? session.id`から作り、session未確定の要求では`request:<operationId>`となり得る。したがってwire/API契約名を保持し、表示modelでは `sessionId` へ読み替えない。session選択時の範囲はAPIの`session_id` owner検査とserver-side filterに委ね、`connection_id`から所有権や選択session一致を再推定しない。`label` は表示modelに含めない。実行時刻は同APIにfieldがないため、初期表示ではnullとし、別データから推定しない。

Log:

- logId: string
- timestamp: string（ISO日時）
- type: string

許可field:

- 本人所有session情報
- 本人所有operation情報
- 本人所有log識別情報

除外field:

- cookie
- token
- OAuth情報
- 他ユーザー情報
- 認証用情報
- command
- output
- 未分類の詳細event data

JSON本文は安全なtext表示として扱い、HTMLとして解釈しない。HTML表示時のescapeとJSON serializerの安全性は別々に確認する。

## 取得量とdownload固定

/api/logsの既存limit制御を利用する。現在の既存API制限を超える全件取得は行わない。

初期目的はブラウザ内JSON表示であり、download機能は対象外とする。将来downloadが必要になった場合は、同じallowlistを利用する別設計として扱う。

## 独立CLIの別設計

独立CLIが必要な場合は本設計対象外とし、CLI認証方式、token管理、有効期限、revoke、OS保管方式、監査設計を別途承認する。

## API field対応とscope固定

表示modelは以下の対応だけを許可し、API応答のspreadや未記載fieldの転送を行わない。

| 出所 | API field | 表示model | 規則 |
| --- | --- | --- | --- |
| `/api/console-state.sessions[]` | `session_id` | `Session.sessionId` | 非空string必須 |
| 同上 | `purpose`, `working_directory` | 同名camelCase field | string/null/欠損。nullまたは欠損はnull |
| 同上 | `created_at`, `last_used_at` | `createdAt`, `lastAccessAt` | 有効なISO日時string必須 |
| 同上 | `state`, `active` | `state` | `state`は`active`, `closed`, `expired`, `unavailable`。`active`はboolean必須で、trueならstate=`active`、falseならstateは`active`以外 |
| `/api/console-state.running[]` | `operation_id` | `Operation.operationId` | 非空string必須 |
| 同上 | `connection_id` | `Operation.connectionId` | 非空string必須。session IDと同一と仮定しない |
| 同上 | `status` | `Operation.status` | `running`または`terminating`のみ |
| 同上 | — | `startedAt`, `endedAt` | endpointに時刻fieldがないためnull固定 |
| `/api/logs.items[]` | `id` | `Log.logId` | 非空string必須 |
| 同上の`event` | `at`, `event` | `timestamp`, `type` | 有効なISO日時string、非空string必須 |

`termination_unconfirmed`は出力に使わない。`running[].label`もmodelに含めない。実装により内容が変わる可能性があり、command/output等の除外境界を保証できないためである。必須fieldの欠損・型違い・列挙外・不正日時は応答全体を不正とする。日時は`Z`または明示offsetを持つISO日時のみ。明示したnullable field以外にnull/欠損補完をしない。未記載のextra fieldは無視する。

対象sessionが選択されている場合、全API要求に同じ`session_id`を付ける。logsは既存 `/api/logs?limit=200&session_id=...` を使い、認証principalと指定sessionのowner検査はサーバーに委ねる。sessionsは既存 `/api/console-state?session_id=...` のowner-scoped結果から、選択された`session_id`と完全一致するsessionだけを表示する。operationsは同じ要求の`running`配列を使う。API側はoperation eventを選択sessionで絞り、processも`process.sessionId`で絞るので、表示側で`connection_id`をsession IDと比較して再判定しない。

session未選択時は`session_id` queryを省略し、既存APIが本人principalへ返す範囲を表示する。sessionsは本人所有session一覧の先頭200件、operationsは本人所有running項目の先頭200件、logsは本人所有の最新pageである。他ユーザーの項目は取得・表示しない。各配列の表示上限は200件。logsはAPI上限200の最新pageだけを使い、全件取得や自動の過去ページ巡回はしない。sessions/operationsも先頭200件までとし、超過時は「一部のみ表示」と件数上限をパネルに明示する。項目順はAPIの返却順を保持する。

## 固定UI操作と非同期応答

パネルは既存認証済みユーザーコンソールのsession一覧付近に置く。session選択は既存ページの選択状態を使い、新たな認証・選択APIは設けない。初期表示は未取得状態とし、「JSONを取得」ボタンで取得する。成功・空状態では「再取得」ボタンを表示する。取得中はボタンを無効にし、連打で重複fetchを起こさない。対象session変更時は旧取得を無効化し、新しい対象の内容だけを取得する。

表示状態は未取得、読込中、成功、空、401認証切れ、404対象なし、一般errorに分ける。読込開始時に既表示JSONを消し、成功時のみ今回の許可modelを表示する。401、404、malformed response、通信失敗・中断時も旧JSONを残さない。error bodyや内部詳細は表示しない。

各取得世代に単調増加するgenerationを付け、session変更、再取得開始、logout、SSEの`auth-expired`、明示中断で旧世代を失効させる。可能ならAbortControllerで中断する。成功・失敗を描画する直前に、要求時generationと現在generation、選択sessionが一致することを検証し、一致しない遅延応答は破棄する。現在世代の401はJSONを消して既存ログイン導線へ、404はJSONを消して対象なしを表示する。ログアウトform送信時に同期的に表示・cursorを消去し、SSEと要求を停止する。

`/api/events`は既存owner scope内の通知に限り利用し、`logs-available`は新着通知だけとして扱う。payloadはJSON表示modelに混ぜず、再取得ボタンから bounded page を取得する。`resync-required`では既存内容を残さず、再取得可能状態にする。

## 表示JSONの安全性と検証追加

JSONはserialize後にtext-only DOM APIへ渡し、HTMLとして解釈しない。TDDでは、選択session付き/未選択時の3配列scope、各必須・nullable field、state/statusの列挙、200件上限と一部表示通知、labelおよび余剰fieldの除外を確認する。

非同期UIテストでは、session A要求後にBへ切り替えてAの遅延成功/401/404/失敗を返すケース、logoutと`auth-expired`中の遅延応答、通信失敗とmalformed response、明示中断、連打を確認する。旧JSONが残らず、現在世代だけが描画できることを検証する。既存API regression greenはこの新UI挙動の証拠とは別扱いとする。

## PR38扱い

本書は実装前設計であり、PR38完了を意味しない。設計レビュー通過後に実装判断する。
