# 認証済みコンソールJSON表示設計

## 目的
PR38 CUI準備で検討した本人状態確認を、まず既存Web認証境界内のJSON表示として提供する最小案を定義する。

## 状態
過去PR38では既存APIの回帰確認は行ったが、独立CUI入口の認証接続方式は未確認だったため、以前の設計完了/no findings扱いは撤回する。

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

PR38-JSON-001 Medium:
既存API利用時の表示adapter契約、表示model、error表示、download境界を本書の「表示契約」「JSON表示項目境界」「TDD条件」に追加した。

PR38-JSON-002 Medium:
許可field、除外field、command/output/event dataの扱い、HTML表示とJSON生成境界を本書の「JSON表示項目境界」に追加した。

PR38-JSON-003 Low:
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
- sessionId: string
- status: string
- startedAt: string | null
- endedAt: string | null

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

## 独立CLI

独立CLIが必要な場合は本設計対象外とし、CLI認証方式、token管理、有効期限、revoke、OS保管方式、監査設計を別途承認する。

## PR38扱い

本書は実装前設計であり、PR38完了を意味しない。設計レビュー通過後に実装判断する。
