# セッション情報のMCP後編集

## 目的

作成済みセッションの情報を、認証済みMCP利用者が同じMCP接続経路から後編集できるようにする。

既存の使用者画面とHTTP APIは、作業ディレクトリ、用途、外部URL、表示題名の更新を
`RemoteDesktopService.updateSessionMetadata`へ集約している。この機能では新しい更新規則を作らず、
MCP用の薄い変換層から同じ共有処理を呼び出す。

対象は次の四項目に限る。

- 作業ディレクトリ
- 用途
- 外部URL
- 表示題名

所有者、セッション識別子、状態、有効期限、実行先、Todo状態は更新対象にしない。

## 現行実装

現在の`Session`は`version`、`workingDirectory`、`purpose`と外部リンク情報を保持する。
`session_open`は作成時の作業ディレクトリ、用途、任意のURLと題名を受け付け、
`session_list`は本人所有の稼働中セッションを返す。一方、作成後に情報を更新するMCP操作は存在しない。

使用者画面の`PATCH /api/sessions/:sessionId`は
`RemoteDesktopService.updateSessionMetadata`を呼び出す。この共有処理には次の規則が既にある。

- 認証主体とセッション所有者を照合する。
- 稼働中かつ期限内で、緊急停止中ではないセッションだけを更新する。
- `expectedVersion`を現在の`version`と比較し、古い更新を拒否する。
- 作業ディレクトリを絶対パスとして再検証し、`realpath`、ディレクトリ実体、実行可能性を確認する。
- 用途は前後空白を除き、空文字を拒否し、200文字以内に制限する。
- URLと題名は`session-links.ts`の共通処理を使い、既存の形式検査、取得世代、SSRF対策を維持する。
- 変更を`processLock`と`executionStateLock`の既存順序で確定する。
- 実変更時だけ`version`を一度増やし、`touched`と有効期限を更新する。
- `session.metadata.updated`には値を記録せず、変更項目名と版だけを記録する。
- 更新監査に失敗した場合は直前状態へ戻す。ただし終了、期限切れ、緊急停止などの終端遷移を巻き戻さない。
- 作業ディレクトリ変更前に開始済みのプロセスは開始時の`workingDirectorySnapshot`を保持する。

MCP経路はこの処理を直接再利用し、所有者確認、入力検証、競合判定、監査、巻き戻しを重複実装しない。

## MCP公開契約

### 操作名

新しい操作名は`session_update`とする。

既存の`session_open`、`session_list`、`session_close`と同じ接頭辞を使い、
作成済みセッションを更新する操作であることを短い名前で示す。

### 入力

公開入力は次とする。

| 項目 | 必須 | 型 | 意味 |
| --- | --- | --- | --- |
| `session_id` | 必須 | 文字列 | 更新対象のセッション識別子 |
| `expected_version` | 必須 | 1以上の整数 | 利用者が読み取った現在版 |
| `working_directory` | 任意 | 文字列 | 新しい作業ディレクトリ |
| `purpose` | 任意 | 文字列 | 新しい用途 |
| `url` | 任意 | 文字列または`null` | 外部URL。`null`または空文字で解除 |
| `title` | 任意 | 文字列または`null` | 手入力題名。`null`または空文字で手入力上書きを解除 |
| `comment` | 必須 | 文字列 | 既存共通ラッパーが要求する操作目的 |

`working_directory`、`purpose`、`url`、`title`のうち一項目以上を指定する。
省略した項目は変更しない。

MCPのスネークケース入力を共有処理の既存名へ一度だけ変換する。

| MCP入力 | 共有処理 |
| --- | --- |
| `expected_version` | `expectedVersion` |
| `working_directory` | `workingDirectory` |
| `purpose` | `purpose` |
| `url` | `externalUrl` |
| `title` | `externalTitle` |

MCPスキーマは型と必須項目だけを表し、作業ディレクトリの実体確認、用途の正規化、
URLと題名の意味検証を再実装しない。意味検証は`updateSessionMetadata`に委譲する。

### 成功結果

成功時は共有処理の確定状態をMCP用の名前へ変換して返す。

- `ok: true`
- `session_id`
- `working_directory`
- `purpose`
- `external_url`
- `external_title`
- `external_title_source`
- `external_title_status`
- `version`
- `changed_fields`

`changed_fields`は`working_directory`、`purpose`、`url`、`title`の公開名で返す。
指定値が保存済み状態と同一で実変更がない場合は成功として扱い、
`changed_fields`は空配列、`version`は増やさない。

未設定の外部URLや題名は、既存`session_list`と同じく省略可能な値として扱う。
内部の`linkRevision`は公開しない。

### 拒否結果

共有処理が入力または状態を拒否した場合は、MCP呼び出し自体の再試行を促す例外へ変換せず、
次の構造化結果を返す。これは更新結果を表す業務上の拒否であり、共通ラッパーが呼び出し処理を完了したことを示す
`operation.succeeded`とは区別する。更新成否は`ok`と`session.metadata.updated`の有無で判定する。

- `ok: false`
- `error`
- 版競合時だけ`current_version`

共有処理のHTTP用数値`status`はMCP結果へ公開しない。
`error`は共有処理が返す固定分類をそのまま使う。

- `invalid_request`
- `invalid_working_directory`
- `invalid_purpose`
- `invalid_external_link`
- `session_unavailable`
- `version_conflict`
- `update_unavailable`

`version_conflict`を自動再送しない。利用者は`session_list`で最新状態と版を読み直し、
更新意図を再評価した後に新しい`expected_version`で明示的に再実行する。

緊急停止とTodo更新期限の拒否は、共有MCPラッパーの既存規則を維持する。
`session_update`をTodo更新期限の例外操作には追加しない。

## `session_list`との整合

`session_list`の各稼働中セッションへ`version`を追加する。
既存項目は削除、改名、意味変更しないため、既存利用者との読み取り互換性を維持する。

MCP利用者は更新前に`session_list`から対象の現在値と`version`を取得する。
更新成功後に再度`session_list`を読むと、`session_update`の成功結果、
使用者画面の`/api/console-state`と同じ作業ディレクトリ、用途、外部リンク情報、版を確認できる。

`session_open`の入力契約は変更しない。初回更新にも`session_list`で現在版を取得するため、
初期版番号をクライアント側の固定値として推測させない。

## 共有処理の再利用

`session_update`のハンドラーは次の順序だけを担当する。

1. 公開入力名を共有処理の入力名へ変換する。
2. `updateSessionMetadata`を一回呼ぶ。
3. 成功または拒否結果をMCP用の名前へ変換する。

所有者、稼働状態、有効期限、緊急停止、版、作業ディレクトリ、用途、外部リンクを
ハンドラー側で先行判定しない。同じ検証を二経路へ複製すると、
HTTP編集とMCP編集で許可範囲や競合時点がずれるためである。

HTTP経路も引き続き同じ`updateSessionMetadata`を呼ぶ。
共通処理の変更が必要になった場合はHTTPとMCPの双方に同じ規則が適用される形で行う。

## 作業ディレクトリと実行中プロセス

`updateSessionMetadata`と`process_start`は既存の`processLock`で順序付けられる。

更新より先に`process_start`が作業ディレクトリを取得した場合、そのプロセスは
開始時の`workingDirectorySnapshot`を使い続ける。後からセッションの値を変更しても遡及しない。

更新が先に確定した場合、その後に始まる`process_start`は新しい作業ディレクトリを取得する。

ファイル読取、ファイル変更、転送は引き続き`root_id`基準であり、
セッションの作業ディレクトリ変更によって基準位置を変えない。

## 外部URLと題名

URLと題名は既存`session-links.ts`を通して更新する。
新しいURL解析器、DNS検査、転送処理、HTML題名抽出、資格情報利用は追加しない。

URLを変更して題名が手入力でない場合の旧取得題名破棄、
手入力題名を解除した場合の再取得、手入力題名の優先、取得世代による古い結果の破棄は、
使用者画面からの更新と同じ共有処理へ委譲する。

題名取得は更新結果を待たず、既存の非同期処理を使う。
取得完了後の反映条件、所有者再確認、終了後の破棄、通知内容も変更しない。

URL、題名、URLに含まれる付加値を監査、エラー、診断へ複製しない。

## 監査と操作ログ

情報変更そのものの監査は既存`session.metadata.updated`を正本とする。
記録するのは利用者、セッション識別子、変更前後の版、変更項目名であり、
作業ディレクトリ、用途、URL、題名の値は記録しない。

MCP共通ラッパーの`operation.received`、`operation.started`、`operation.succeeded`は維持する。
`session_update`専用の値を含む`operationDetail`は追加しない。

MCPスキーマで拒否された呼び出しを監査する`rejectedArgumentProjection`には、
`session_update`の`session_id`と`expected_version`だけを追加する。
作業ディレクトリ、用途、URL、題名は投影しない。

共有処理の更新監査が失敗した場合は既存ロールバックを使い、
`ok: false`、`error: update_unavailable`として返す。

共有処理の更新監査は成功したが、MCP共通ラッパーの終端監査だけが失敗した場合は、
既に適用済みの更新を巻き戻さない。`appliedByTool`に`session_update`の
`ok: true`を追加し、`audit_warning: true`と`applied: true`を返して適用状態を明示する。

## 終了、期限切れ、緊急停止

共有処理は所有者、`active`状態、有効期限、緊急停止を確定直前にも再確認する。
他人所有、存在しない、終了済み、期限切れ、停止によって閉じられたセッションは
同じ`session_unavailable`として扱い、存在や所有者の違いをMCP利用者へ細分化して明かさない。

緊急停止がMCP共通ラッパーへ入る前に有効であれば、既存の
`USER_STOP_REQUESTED`を返す。更新処理中に停止世代が変わった場合も、
既存ラッパーと共有処理の終端遷移優先規則を維持する。

停止解除によって閉じたセッションを再開しない。

## Todo更新期限

`session_update`は通常の変更操作としてTodo更新期限の対象にする。
作業一覧が古い場合は既存`TODO_STALE`を返し、共有処理を呼ばない。

Todoの確認、更新、強制設定、セッション終了など、既に例外扱いされている操作の規則は変えない。

## テスト駆動の実装計画

実装では先にMCP境界の回帰試験を追加し、`session_update`が未登録で失敗することを確認してから
最小実装を追加する。既存HTTP編集試験は共有処理の意味検証を既に広く扱うため、
MCP側では公開契約と共通処理利用の境界を重点的に検証する。

新しいMCP専用試験ファイルを設け、少なくとも次を確認する。

1. `tools/list`に`session_update`が現れ、`session_id`、`expected_version`、編集項目、`comment`の契約が正しい。
2. `session_list`が現在の`version`を返す。
3. 作業ディレクトリ、用途、URL、題名を個別に変更でき、省略項目は維持される。
4. URLと題名の解除、手入力題名解除後の再取得がHTTP経路と同じ状態遷移になる。
5. 複数項目の一括更新は`version`を一度だけ増やし、一項目でも不正なら何も保存しない。
6. 同値更新は`version`を増やさず、不要な題名取得を開始しない。
7. 古い`expected_version`は`version_conflict`と`current_version`を返し、自動再送しない。
8. 他人所有、存在しない、終了済み、期限切れ、緊急停止中のセッションを更新できない。
9. Todo更新期限が切れている場合は共有処理を呼ばず`TODO_STALE`になる。
10. 作業ディレクトリ変更前から走るプロセスは元の`workingDirectorySnapshot`を保持し、変更後の新規プロセスは新しい値を使う。
11. `session.metadata.updated`の監査失敗では更新が戻り、終了などの終端遷移をロールバックが打ち消さない。
12. MCP共通ラッパーの終端監査だけが失敗した場合は、成功済み更新について`audit_warning`と`applied: true`を返す。
13. スキーマ拒否、成功、競合、URL・題名更新の監査と診断に更新値が含まれない。
14. 更新成功後の`session_update`結果、`session_list`、`/api/console-state`で値と`version`が一致する。

`test/tool-root-contracts.test.ts`の必須MCP操作一覧も更新し、
既存の`session_open`、`session_list`、`session_close`互換性を回帰する。

実装後のローカル検証は、対象試験を先に実行し、その後に
`npm run check`、`npm run build`、`npm run lint`、`npm test`を行う。

## 変更予定箇所

- `src/index.ts`
  - `session_update`のMCP登録と入出力変換を追加する。
  - `session_list`へ`version`を追加する。
  - 入力拒否時の安全な引数投影を追加する。
  - 終端監査失敗時の`applied`判定へ`session_update`を追加する。
  - MCPサーバー説明へ更新前の`session_list`取得と競合時の再読込を追記する。
- MCP専用試験
  - 公開契約、共通処理への接続、競合、安全性、プロセス順序を試験する。
- `test/tool-root-contracts.test.ts`
  - MCP操作一覧と既存セッション操作の互換性を回帰する。

既存の`updateSessionMetadata`、`session-links.ts`、使用者画面のHTTP更新処理は、
MCP専用の規則を追加せず共有正本として維持する。

## 対象外

- セッション所有者、識別子、状態、有効期限、実行先、Todo状態の後編集
- 終了済みまたは期限切れセッションの再開
- 開始済みプロセスの作業ディレクトリ変更
- ファイル操作や転送をセッション作業ディレクトリ基準へ変更すること
- 外部リンク情報の永続化
- 新しい認証方式、URL取得方式、外部依存の追加
- 未統合の複数実行ノード構成を先行実装すること

将来、セッション自体が遠隔実行先を所有する構成を統合する場合も、
MCP経路だけに別の更新規則を追加せず、その時点の共有セッション更新処理を呼ぶ。
