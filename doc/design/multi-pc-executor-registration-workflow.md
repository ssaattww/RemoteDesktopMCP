# 複数 PC 実行ノード追加・登録 作業フロー

## 目的

複数 PC を実行ノードとして追加・登録する機能を、設計、実装、検証、レビューの順に分離して進める。

この文書は製品仕様ではなく作業手順を定義する。
製品仕様は `functional-requirements.md` と `multi-pc-architecture.md` を正とする。

## 作業境界

この作業フローの対象は次のとおり。

- 統括ノードと複数の実行ノードのローカル設定。
- 実行ノードから統括ノードへの tailnet 内接続。
- PSK、nonce、HMAC-SHA-256、HKDF-SHA-256 によるノード相互認証。
- 登録済みノード一覧、接続状態、能力、ルート情報の管理。
- ファイル、転送、プロセス操作の `node_id` 振り分け。
- 再接続、切断、重複接続、実行ノード再起動時の状態遷移。
- 使用者の実行停止状態を複数ノードへ伝播する処理。
- PC追加、PSK更新、登録解除の利用者向け手順。
- 統括ノード + 実行ノード2台以上での実機確認。

次は対象外とする。

- 統括ノードの自動切り替え。
- 複数統括ノードの同時運用。
- ChatGPT または公開 HTTP API からのノード登録、削除、PSK変更。
- 切断時に別ノードへ自動的に振り替える処理。
- 1つの操作を複数ノードへ同時配信する機能。

## セッション分離

複数 PC 実行ノード追加・登録の作業では、他タスクの RDMCP セッションを再利用しない。

各工程は工程専用のRDMCPセッションを開き、対象worktreeの絶対パスを固定する。
工程終了時はそのセッションを閉じる。
レビュー工程は実装工程のセッションを再利用せず、別セッションで開始する。

同じ機能の作業内でも、並行作業が必要な場合は同じ worktree を共有しない。
別worktreeと別branchを使用し、合流点を明示する。

## 共通ゲート

作業開始時に `.github/workflows/lint.yml` の診断artifact設定を確認する。
既存workflowがテスト結果、標準出力、標準エラー、実行結果、環境情報を成功・失敗の両方で保存する限り、診断目的だけの重複workflowは追加しない。

実装変更はTDDで進める。

1. 対象契約を固定するテストを追加する。
2. 追加したテストが期待理由で失敗することを確認する。
3. 最小実装で成功へ変える。
4. 関連する回帰テストを実行する。
5. レビュー可能な小さな論理単位でcommitし、pushする。

CI確認では、対象PRのcurrent HEAD SHAとworkflow runの `head_sha` が完全一致するrunだけを使用する。
HEAD更新後は新しいHEADのrunを確認し、該当runがなければCI未実施として扱う。

## 設計契約の固定

### 入力

- 複数 PC 実行ノード追加・登録の要件。
- `doc/design/functional-requirements.md`。
- `doc/design/multi-pc-architecture.md`。
- 現行の単一ノード実装と公開接続設計。

### 作業

- 単一ノード前提が残るAPI、状態、設定を列挙する。
- ノード間transport、認証、接続状態、再接続、重複接続を固定する。
- roleごとの起動条件とローカル設定形式を固定する。
- 複数ノード時のsession working directoryを固定する。
- ファイル転送とプロセスIDのノード固定方法を固定する。
- 使用者の実行停止状態を遠隔実行ノードへ伝播する契約を固定する。
- setup、PSK更新、登録解除の手順を固定する。

### 完了条件

- 実装者が追加判断をせずテストケースへ落とせる。
- 機能要件と詳細設計に矛盾がない。
- Markdownと用語lintが成功する。

## ノード設定と暗号プロトコル

### 設定・暗号のRED

- role別必須設定。
- 永続 `node_id`。
- PSKの32バイトbase64url検証。
- 未登録 `node_id`、誤PSK、不正nonce、不正HMAC、未知protocol versionの拒否。
- session keyと `connection_id` の既知入力テスト。
- sequenceの再送、逆行、改ざんの拒否。

### 設定・暗号のGREEN

ローカル専用のnode設定ストア、管理CLI、暗号処理を実装する。
秘密値を監査ログ、エラー、Desktop Commander子プロセス環境へ渡さない。

## ノード接続と登録状態管理

### 接続・registryのRED

- coordinator-only、executor-only、bothの起動。
- Tailscale IP以外へのnode listener bind拒否。
- 実行ノードから統括ノードへの接続。
- signed heartbeatによる接続状態更新。
- 接続切断、再接続、重複接続。
- 実行ノード再起動時のruntime generation変更。
- 登録済みだが未接続のノードも `node_list` に残ること。

### 接続・registryのGREEN

NodeRegistry、CoordinatorNodeServer、ExecutorNodeClientを分離して実装する。
新しい認証済み接続が成立した場合だけ同じ `node_id` の古い接続を置き換える。

## 公開 MCP の振り分けとセッション

### 振り分け・sessionのRED

- 登録ノード1台時だけ `node_id` を省略できる。
- 登録ノード2台以上では接続数にかかわらず `node_id` が必須。
- 切断ノード、未登録ノードを拒否し、別ノードへ振り替えない。
- `node_list` がnodeごとのroot、operation、接続状態を返す。
- sessionはnodeごとにworking directoryを保持する。
- 対象nodeのworking directory未設定時に `process_start` を拒否する。

### 振り分け・sessionのGREEN

公開MCPからローカル実行と遠隔実行を同じdispatch契約へ集約する。
executorへ任意のDesktop Commander tool名を渡さず、RemoteDesktopMCPの内部operationだけを送る。

## ファイル転送とプロセス

### 転送・プロセスのRED

- transfer作成時の `node_id` 固定。
- chunk、commit、status、cancelで実行先を変更できない。
- node切断中に別nodeへ転送を継続しない。
- process IDをnodeとexecutor runtime/DC generationへ固定する。
- executor再起動後に古いprocess IDで別プロセスを操作しない。
- coordinator接続だけが切れて戻った場合は、executorが継続している状態を誤って別nodeへ結び直さない。

### 転送・プロセスのGREEN

coordinator側では公開IDとremote IDの対応だけを保持し、実際のファイル制限、転送一時ファイル、PID所有確認は対象executor側でも再検証する。

## 使用者の実行停止

### 実行停止のRED

- coordinatorの停止状態が全接続executorへ伝播する。
- 停止通知時にexecutorがその使用者の管理下プロセス停止を要求する。
- 停止中にexecutorが切断して再接続しても、新規操作を受け付けない。
- resume後も古いstop generationの要求を拒否する。
- 停止中に接続できなかったexecutorは再接続時の状態同期前にreadyにならない。

### 実行停止のGREEN

coordinatorを停止状態の正とし、各遠隔要求へprincipalとstop generationを含める。
executorは同期済みgenerationより古い要求を拒否する。

## セットアップと実機確認

利用者向け手順に次を追加する。

1. 追加PCへ同じ版のRemoteDesktopMCPとDesktop Commanderを導入する。
2. 追加PCを既存tailnetへ参加させる。
3. executorの `node_id` と表示名を生成する。
4. coordinatorで対象 `node_id` 専用PSKを生成して登録する。
5. executorへcoordinator接続先と同じPSKを安全に設定する。
6. coordinator、executorの順に起動する。
7. `node_list` で接続状態とrootを確認する。
8. `node_id` を指定してfile/process/transfer操作を確認する。
9. PSK更新と登録解除を確認する。

実機ゲートは統括ノード1台、実行ノード2台以上で実施する。
1台を切断した状態、再接続後、executor再起動後も確認する。

## 通常レビュー

実装担当とは別セッションで、複数 PC 実行ノード追加・登録の要件、設計、全差分、直接依存、テスト、current HEAD の CI 証跡を確認する。
指摘修正は実装工程へ戻し、同じ指摘IDで解消確認する。

## 独立最終レビュー

通常レビューと実装を担当していない別セッションで、最終implementation HEADを固定して確認する。
最終報告専用commitを使う場合は、製品・設計・workflow・設定を同じcommitへ混ぜない。
mergeは利用者が行う。

## 最終完了条件

- 複数 PC 実行ノード追加・登録の完了条件をすべて満たす。
- 利用者向けPC追加、PSK更新、登録解除手順がある。
- ローカルlint、check、build、対象テストが成功する。
- PR current HEADと完全一致する必須CI runを確認する。
- 詳細reportをrepositoryへ保存し、PRへ簡易reportをコメントする。
