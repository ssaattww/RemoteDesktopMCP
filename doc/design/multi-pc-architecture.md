# 複数 PC 接続設計

## 目的

1つの ChatGPT 接続から、複数の PC 上で動作する RemoteDesktopMCP を操作できるようにする。

外部へ公開する MCP サーバーは1つに集約し、そのサーバーが操作対象のPCを選び、各PCへリクエストを振り分ける。

## 役割

各 PC では同じ RemoteDesktopMCP を動作させ、設定によって次の役割を持たせる。

- 統括ノード: ChatGPT からの MCP 接続、ユーザー認証、RemoteDesktopMCP セッション管理、対象ノードの選択、リクエストの振り分けを担当する。
- 実行ノード: 各PCの操作制限を確認し、実際のファイル操作とプロセス操作はローカルの `@wonderwhy-er/desktop-commander` に実行させる。
- 兼任ノード: 統括ノードと実行ノードの両方を同一 PC 上で担当する。

初期版では、1つの構成に統括ノードを1台だけ置く。
実行ノードは複数台登録できる。
統括ノード自身を実行ノードとして使う構成にも対応する。

構成例:

| PC | 役割 |
| --- | --- |
| PC A | 統括ノード + 実行ノード |
| PC B | 実行ノード |
| PC C | 実行ノード |

どのPCでも同じ RemoteDesktopMCP を動かし、設定によって統括ノード、実行ノード、または両方の役割を選べるようにする。

概念例:

```yaml
roles:
  - coordinator
  - executor
```

## 全体構成図

```mermaid
flowchart LR
    ChatGPT[ChatGPT] -->|HTTPS| Funnel[Tailscale Funnel]
    Funnel -->|loopback| C[統括ノード]
    C --> CA[統括 PC の Desktop Commander 呼び出し]
    CA -->|stdio MCP| CD[Desktop Commander]

    subgraph Tailnet[tailnet]
        C <--> P1[実行ノード PC 1]
        C <--> P2[実行ノード PC 2]
        C <--> PN[実行ノード PC N]
    end

    P1 --> P1A[Desktop Commander 呼び出し] -->|stdio MCP| P1D[Desktop Commander]
    P2 --> P2A[Desktop Commander 呼び出し] -->|stdio MCP| P2D[Desktop Commander]
    PN --> PNA[Desktop Commander 呼び出し] -->|stdio MCP| PND[Desktop Commander]
```

ChatGPT から見える MCP 接続先は統括ノードだけとする。
各実行ノードを ChatGPT へ個別登録する構成は初期版では採用しない。

実行ノード側では Tailscale Funnel を有効にしない。
外部公開は統括ノードだけに限定する。

## ノード間接続

遠隔の実行ノードは Tailscale の tailnet 内で統括ノードへ接続する。
インターネットへ直接待ち受けるポートは設けない。

実行ノードから統括ノードへ接続し、その接続を維持したまま双方向にリクエストと結果をやり取りする構成を基本とする。
これにより、実行ノード側で受信用の公開設定を追加する必要をなくす。

統括ノードは次を管理する。

- 接続済み実行ノード一覧
- `node_id`
- 表示名
- 接続状態
- 最終確認時刻
- 利用可能な操作種別
- 実行中プロセスとの対応

Tailscale で通信が暗号化されているだけでは、接続相手を信頼済みとはみなさない。
RemoteDesktopMCP 側でも統括ノードと実行ノードを相互認証する。

## ノード識別

各実行ノードは、再起動後も変わらない `node_id` をローカルで生成して保持する。

管理者がPCを見分けやすいよう、表示名も設定できるようにする。
表示名は `pc1`、`workstation` など任意に設定できるが、実際の処理先は `node_id` で特定する。

最低限、次の情報を保持する。

- `node_id`
- 表示名
- 役割
- ノード認証情報
- 最終確認時刻
- 接続状態
- 利用可能な操作

`node_id`、ノード認証設定、統括ノード設定はローカル操作からだけ変更できるようにする。
MCP ツールから登録、削除、書き換えはできない。

## ノード認証

### 何を確認するか

ノード認証では、統括ノードと実行ノードが互いに、事前に登録した接続相手であることを確認する。
Tailscale に接続できるだけでは、RemoteDesktopMCP の操作を許可しない。

ユーザーの認証・認可とは役割が異なる。
ユーザーの認証・認可は統括ノードが担当し、実行ノードへは確認済みのリクエストに必要な情報だけを渡す。
ユーザーのアクセストークンそのものは実行ノードへ転送しない。

### 認証に使う鍵と値

| 名前 | この設計での役割 |
| --- | --- |
| 事前共有鍵（PSK） | 接続前に両方のPCへ設定する秘密の鍵。同じ鍵を持つ相手かどうかの確認に使う |
| nonce | 接続のたびに作る使い捨ての乱数。以前の認証メッセージを使い回せないようにする |
| HMAC値 | 鍵とメッセージから計算する認証用の値。受信側も計算し、受け取った値と一致するか確認する |
| セッション鍵 | 認証後のノード間通信で使う、その接続専用の鍵。PSKと双方のnonceから生成する |

ここでいうセッション鍵は、ノード間の接続に使う鍵であり、ユーザーの操作をまとめる `session_id` とは別のものである。
HMACはメッセージの認証に使い、通信内容の暗号化と通信経路の保護は引き続き Tailscale が担当する。

### 接続前の準備

管理者は、統括ノードと実行ノードの組ごとに異なるPSKを設定する。
PSKは暗号学的に安全な乱数32バイトを `base64url` で表現した値とする。

統括ノードは、許可する実行ノードの `node_id` とPSKを対応付けて保存する。
各実行ノードは、接続先の統括ノード用PSKを1件だけ保持する。
複数の実行ノードで同じPSKを使い回さない。

### 接続時のやり取り

PSKそのものを接続相手へ送るのではなく、PSKから計算したHMAC値を照合する。
以下の手順では、まず実行ノードが統括ノードを確認し、次に統括ノードが実行ノードを確認する。

1. 実行ノードは `client_nonce` を生成し、プロトコルのバージョン、`node_id` とともに統括ノードへ送る。
2. 統括ノードは `node_id` に対応するPSKを取得し、`server_nonce` を生成する。PSKと双方のnonceを使ってHMAC値を計算し、`server_nonce` とHMAC値を返す。
3. 実行ノードは、自分が保持するPSKで同じ計算を行い、統括ノードから受け取ったHMAC値と照合する。
4. 照合に成功した実行ノードは、今度は実行ノード用のHMAC値を計算し、統括ノードへ返す。
5. 統括ノードも受け取ったHMAC値を照合する。双方の照合が成功した場合だけ、認証済みの接続として操作を受け付ける。

`client_nonce` と `server_nonce` は、接続のたびに新しく生成する乱数である。
以前の認証メッセージを再送しても、今回のnonceを使った計算結果とは一致しないため受け付けない。
認証が完了するまでは、ファイル操作、プロセス操作、ノード状態更新を受け付けない。
照合に失敗した場合は接続を閉じ、リクエストを実行しない。

#### 接続時のHMAC計算

双方とも、PSKを鍵として `HMAC-SHA-256` を計算する。
入力に含める役割名を変え、統括ノードの返答と実行ノードの返答を区別する。

統括ノードが返すHMAC値の入力:

```text
rdmcp-node-auth-v1|coordinator|node_id|client_nonce|server_nonce
```

実行ノードが返すHMAC値の入力:

```text
rdmcp-node-auth-v1|executor|node_id|client_nonce|server_nonce
```

### 認証後の通信

認証後も、接続を開始したときの確認結果だけでリクエストを実行するわけではない。
各リクエストと応答にHMAC値を付け、メッセージが変更されていないことを受信側で確認する。
さらに接続IDと送信順序を確認し、以前のメッセージを再送するリプレイ攻撃を防ぐ。

まず双方が、PSKと今回のnonceから同じセッション鍵を生成する。
`HKDF-SHA-256` に渡す値は次のとおりとする。

| 入力項目 | 値 |
| --- | --- |
| 元になる鍵 | PSK |
| `salt` | `client_nonce \|\| server_nonce` |
| 追加情報 | `rdmcp-node-session-v1` |

接続IDも双方が同じ式で計算する。

```text
connection_id = base64url(SHA-256("rdmcp-node-connection-v1" || client_nonce || server_nonce))
```

ノード間で送る各メッセージには、次の情報を含める。

| 項目 | 内容 |
| --- | --- |
| `connection_id` | どの接続のメッセージかを示すID |
| 送信方向 | 統括ノードから実行ノードへ送るか、その逆か |
| `sequence` | 送信方向ごとに1から増加する番号 |
| `request_id` | リクエストと応答を対応付けるID |
| メッセージ本文 | 実行する操作、またはその結果 |

本文のハッシュ値を計算し、セッション鍵を鍵とする `HMAC-SHA-256` で以下の入力を認証する。

```text
body_hash = SHA-256(body_bytes)
rdmcp-node-frame-v1|connection_id|direction|sequence|request_id|body_hash
```

受信側は、接続IDが異なるメッセージ、HMAC値が一致しないメッセージを拒否する。
また、同じ送信方向で直前に受け付けた `sequence` 以下の番号を持つメッセージも拒否する。

### 鍵の保管・更新と登録解除

PSKは認証設定に保存し、サーバープロセスを実行するOSユーザーだけが読み取れる権限にする。
認証設定の保存先を、ファイル操作ツールの許可範囲に含めない。

| 作業 | 管理者が行う操作 |
| --- | --- |
| 新しい実行ノードの登録 | 統括ノード上でPSKを生成し、安全な方法で対象PCのローカル設定にも同じ値を設定する |
| PSKの更新 | 対象ノードとの接続を停止し、両方のPCへ新しいPSKを設定してから再接続する。新旧のPSKは同時に有効にせず、設定が揃うまでは接続できなくてよい |
| ノード登録の解除 | 統括ノードから対象の `node_id` とPSKを削除し、既存接続も直ちに切断する。実行ノード側で接続先の認証情報を削除した場合も、再接続しない |

これらの変更はローカル操作で行う。
ノード登録用のMCPツール、公開HTTP管理API、自動参加機能は作らない。

### 認証結果の記録

監査ログには、対象の `node_id`、認証結果、失敗した処理段階を記録する。
PSK、nonce、HMAC値、セッション鍵はログへ出力しない。

HMACと鍵生成の用語・計算方法は、[HMACの仕様](https://www.rfc-editor.org/rfc/rfc2104.html)と[鍵生成の仕様](https://www.rfc-editor.org/rfc/rfc5869.html)を参照する。

## Desktop Commander の利用

実行ノードはファイル操作とプロセス操作の実行機能を独自実装しない。
ローカルの `@wonderwhy-er/desktop-commander` を `stdio` MCP サーバーとして起動または接続し、RemoteDesktopMCP が MCP クライアントとして利用する。

この構成は Desktop Commander の Remote Device と同様に、ローカル MCP を起動して `listTools()` と `callTool()` で操作する。
RemoteDesktopMCP から Desktop Commander の内部実装を直接 `import` せず、Desktop Commander との連携は MCP インターフェースだけに依存する。

起動時は次を行う。

1. 初期版の検証対象を `@wonderwhy-er/desktop-commander` 0.2.50 とする。導入時は検証済みのバージョンを固定し、実行コマンドと引数はローカル設定で指定する。本番環境で自動的に `latest` へ更新しない。
2. MCP クライアントから `listTools()` を実行し、必要なツール名と入力定義が存在することを確認する。
3. その実行ノードで利用できる RemoteDesktopMCP 操作を統括ノードへ通知する。
4. 必要な Desktop Commander ツールがない操作は利用できないものとし、RemoteDesktopMCP の独自実装へ自動的に切り替えない。

初期版で各公開操作から呼び出す Desktop Commander ツールは次のとおり。

| RemoteDesktopMCP 公開操作 | 呼び出す Desktop Commander ツール | RemoteDesktopMCP 側の処理 |
| --- | --- | --- |
| `file_search` | `start_search` (`searchType="files"`), `get_more_search_results`, `stop_search` | `node_id`、`session_id`、許可ディレクトリを確認し、検索結果を RemoteDesktopMCP の返却形式へ変換する |
| `content_search` | `start_search` (`searchType="content"`), `get_more_search_results`, `stop_search` | 検索範囲と結果数を制限し、Desktop Commander の検索IDを外部APIの仕様にしない |
| `file_read` | `read_file` | 許可ディレクトリを確認し、引数と結果を RemoteDesktopMCP の形式へ変換する |
| `file_patch` | `edit_block` | 書き込み可否を確認し、部分変更だけを許可する |
| `process_start` | `start_process` | RemoteDesktopMCP の論理プロセスIDと Desktop Commander の PID を対応付ける |
| `process_status` | `list_sessions`, `read_process_output` | Desktop Commander の状態を RemoteDesktopMCP の状態へ変換する |
| `process_output` | `read_process_output` | 統合出力、実行状態、取得できる場合は終了コードを RemoteDesktopMCP の形式へ変換する。stdout / stderr の区分は推測しない |
| `process_kill` | `force_terminate` | 論理プロセスIDから起動元ノードと PID を特定して停止する |

### プロセス出力仕様

初期版では、固定した Desktop Commander 版の `read_process_output` が返す統合出力を仕様の基準とする。
`process_output` は初期版で少なくとも次の値を返す。

- `output`: Desktop Commander から取得した統合出力
- `state`: 実行中、終了、状態不明などの RemoteDesktopMCP 側の状態
- `exit_code`: Desktop Commander から取得できた終了コード。実行中または不明の場合は `null`

初期版では `stdout` と `stderr` を個別の項目として返さない。
統合出力の各行を stdout または stderr と推測して分類せず、Desktop Commander が保持していない stdout / stderr の区分情報を作らない。
将来、Desktop Commander が stdout / stderr を区別した出力を安定して返せるようになった場合は、RemoteDesktopMCP の公開仕様を拡張してよい。

固定する Desktop Commander のバージョンを更新するときは、更新前にプロセス出力仕様を自動テストする。
検証用プロセスで stdout と stderr の両方へ別々の文字列を出力して終了させる。`read_process_output` が両方を統合出力として返すこと、終了状態と終了コードを取得できること、RemoteDesktopMCP が stdout / stderr の区分を推測して追加しないことを確認する。
この検証を満たさない版へは更新しない。

Desktop Commander は、ユーザー認証・認可、`session_id`、`node_id`、監査、各PCの操作制限をすべて確認した後にだけ `callTool()` で呼び出す。
Desktop Commander のツールをそのまま外部公開せず、上表で定義した RemoteDesktopMCP の操作だけを MCP ツールとして公開する。

Desktop Commander の `allowedDirectories` などローカル設定は対象 PC の管理者がローカルで管理する。
RemoteDesktopMCP 側の許可ディレクトリと書き込み制限は、Desktop Commander と同じか、より厳しい範囲に設定できる。
どちらかの制限に違反するリクエストは拒否する。また、RemoteDesktopMCP から `set_config_value` など Desktop Commander の設定変更ツールは公開しない。

RemoteDesktopMCP が担当する機能は、Desktop Commander が提供しない次のものに限定する。

- 外部ユーザーの OAuth/OIDC 認証と認可
- RemoteDesktopMCP の `session_id` 管理
- `node_id` の登録、認証、リクエストの振り分け
- `request_id` を使った統括ノードと実行ノードの監査ログの関連付け
- 外部公開するツールと引数の制限
- 複数PC間で一意な論理プロセスIDと、各PC上の PID との対応管理
- Tailscale Funnel を使った外部公開

初期版では、Desktop Commander で提供されないファイル操作やプロセス操作を RemoteDesktopMCP 側で独自実装しない。
将来どうしても独自実装が必要になった場合は、対象機能、Desktop Commander で代替できない理由、必要な権限、監査方法、検証項目を設計書へ明記してから実装する。

### 現在の `src/index.ts` の扱い

現在の `src/index.ts` は最終構成ではなく、公開接続と認証の検証を開始するための暫定実装とする。
Desktop Commander の MCP ツール呼び出しへ置き換える段階で、重複するローカル操作は次のように整理する。

- `searchFiles()` と `readdir` / `stat` による探索は削除し、`file_search` / `content_search` から Desktop Commander の検索ツールを呼び出す。
- `launch_configured_process` 内の直接 `spawn` は削除する。固定起動設定を残す場合も、RemoteDesktopMCP 側で起動を許可してよい設定か確認した後に `start_process` を呼び出す。
- `create_file_download` と `/downloads/:token` は初期版の機能要件に含まれないため、現在の直接ファイル読み出し実装を初期版から削除する。将来必要になった場合は、Desktop Commander を経由しない理由と安全性を別途設計してから追加する。
- `getRoot()` やパスの正規化処理は、RemoteDesktopMCP 側のアクセス制限を確認するために必要な範囲だけ残してよい。ただし、これらの処理から対象PCのファイルを直接読み書きしない。
- OAuth/OIDC、RemoteDesktopMCP セッション、ノード振り分け、監査など RemoteDesktopMCP 固有の機能は引き続き本体で実装する。

## リクエストの振り分け

ファイル操作とプロセス操作には対象ノードを指定できるようにする。

既存ツールには `node_id` を追加する。

- `file_search`
- `content_search`
- `file_read`
- `file_patch`
- `process_start`
- `process_status`
- `process_output`
- `process_kill`

構成に登録された実行ノードが1台だけの場合に限り `node_id` を省略できる。
この台数判定には統括ノード自身が兼任する実行ノードも含め、現在の接続状態は使わない。
登録済み実行ノードが2台以上ある場合、接続中のノードが1台だけでもファイル操作とプロセス操作の `node_id` を必須とする。
`node_id` が必要なのに指定されていない場合はエラーを返し、接続中のノードを推測して実行しない。

指定された `node_id` が登録済みでも切断中の場合は、対象ノードに接続できないエラーを返し、別のノードへ振り替えない。
登録済み実行ノードが1台だけで `node_id` が省略された場合も、そのノードが切断中なら接続できないエラーを返す。
表示名は画面表示やユーザーへの候補表示に使ってよいが、実行先の特定には必ず `node_id` を使う。

## リクエスト処理図

```mermaid
sequenceDiagram
    participant U as ChatGPT
    participant C as 統括ノード
    participant LA as 統括 PC Desktop Commander 呼び出し
    participant LD as 統括 PC Desktop Commander
    participant R as 遠隔実行ノード
    participant RA as 遠隔 PC Desktop Commander 呼び出し
    participant RD as 遠隔 PC Desktop Commander

    U->>C: ツール呼び出し + node_id
    C->>C: ユーザー認可と対象ノード決定
    alt 統括ノード自身が対象
        C->>LA: 操作制限確認済みのリクエスト
        LA->>LD: MCP callTool
        LD-->>LA: 結果
        LA-->>C: RemoteDesktopMCP の形式に変換した結果
    else 遠隔 PC が対象
        C->>R: 認証・認可済みのリクエスト
        R->>R: ローカルの操作制限を確認
        R->>RA: Desktop Commander 呼び出し
        RA->>RD: MCP callTool
        RD-->>RA: 結果
        RA-->>R: RemoteDesktopMCP の形式に変換した結果
        R-->>C: 結果
    end
    C-->>U: MCP 応答
```

統括ノード自身が対象の場合も、遠隔ノードと同じ手順で認証・認可と監査を行う。

## ノード管理ツール

初期版では次の MCP ツールを追加する。

- `node_list`

`node_list` は、利用者が操作可能な実行ノードについて次を返す。

- `node_id`
- 表示名
- 接続状態
- 統括ノードとの兼任有無
- 利用可能な操作種別
- 最終確認時刻

ノード登録や設定変更のツールは提供しない。

## セッションとプロセス

RemoteDesktopMCP のセッションは、MCP の通信セッションや個々の HTTP 接続とは別に統括ノードで管理する。
`session_open` で生成した `session_id` は、認証済みユーザーが一致し、有効期限内であれば別の HTTP 接続からも継続利用できる。
ファイル操作とプロセス操作では明示された `session_id` を使い、接続状態からセッションを自動生成したり自動選択したりしない。

統括ノードは各操作のログに `session_id` と対象の `node_id` を記録する。
遠隔実行ノードへはログを追跡するための `session_id` と `request_id` を渡すが、セッションの作成、期限管理、一覧表示は統括ノードだけが行う。
プロセスは必ず起動時の `session_id` と起動元ノードに関連付ける。
異なるPCでは同じ PID が使われることがあるため、外部へ返すプロセスIDは複数PCをまたいで一意になるよう RemoteDesktopMCP が生成する。

統括ノードは、外部へ返す論理プロセスIDと、実際の実行先を対応付けて管理する。
対応表には少なくとも `{ node_id, desktop_commander_generation, pid }` を保持する。
論理プロセスIDには PID をそのまま使わず、RemoteDesktopMCP が生成した一意のIDを使う。

各実行ノードは、現在接続している Desktop Commander の世代を表す `desktop_commander_generation` を持つ。
この世代IDは、Desktop Commander との新しい接続を確立するたびに、暗号学的に安全な乱数16バイトから生成する。
Desktop Commander の子プロセスまたは `stdio` 接続を作り直した場合は新しい世代IDを生成し、以前の値は再利用しない。
統括ノードとの通信だけが再接続し、Desktop Commander との接続が継続している場合は世代IDを変えない。
実行ノード自身が再起動した場合も新しい世代IDを生成する。
実行ノードは現在の世代IDを統括ノードへ通知する。統括ノードが記録している世代IDと異なる場合は、以前の世代に属する実行中プロセスの対応を無効にする。

### プロセス操作の排他制御

同じ実行ノードかつ同じ Desktop Commander 世代に対するプロセス操作は、同時に1件だけ実行する。
排他制御の単位は `{ node_id, desktop_commander_generation }` とする。
初期版では並列実行より誤操作の防止を優先し、`process_start`、`process_status`、`process_output`、`process_kill` が同じ世代の Desktop Commander プロセス用ツールを同時に呼び出さないようにする。

`process_start` は、Desktop Commander の `start_process` を呼ぶ前にロックを取得する。
PID の取得、同じ PID を使っていた古い論理プロセスIDの無効化、新しい論理プロセスIDの登録、状態更新までを同じロック内で行う。
新しい論理プロセスIDは、これらの処理を完了してロックを解放した後に利用者へ返す。

`process_status`、`process_output`、`process_kill` が Desktop Commander へ PID を渡す場合も、同じロックを取得する。
ロック取得後に、世代IDが現在の値と一致することと、その論理プロセスIDが現在有効なIDであることを必ず確認し直す。
確認に成功した場合だけ Desktop Commander を呼び出し、その結果に基づく状態更新が終わるまでロックを保持する。
ロック取得前の確認結果だけで PID を Desktop Commander へ渡してはならない。

終了済みプロセスについて、保存済みの状態や出力だけを返す `process_status` と `process_output` は Desktop Commander を呼び出さないため、このロックは不要とする。
1つのリクエストで複数の排他単位を同時にロックしない。

`process_start` が成功したら、`{ node_id, desktop_commander_generation, pid }` を `process_key` とし、そのキーに現在有効な論理プロセスIDを最大1件だけ対応付ける。
実装上、この現在有効なIDを `current_process_owner` として保持する。

新しい `process_start` が既存と同じ `process_key` を返した場合は、新しい論理プロセスIDを利用者へ返す前に、古いIDを `stale`（無効）にする。
その後、同じロック内で `current_process_owner` を新しい論理プロセスIDへ切り替える。
論理プロセスID自体は `process_start` 完了前に生成してよいが、切り替えが完了するまでは外部へ返さない。

`process_status`、`process_output`、`process_kill` から Desktop Commander を呼ぶのは、世代IDが現在の値と一致し、かつ指定された論理プロセスIDが `process_key` の `current_process_owner` と一致する場合だけとする。
どちらかが一致しないIDは `stale`（無効）として扱い、PID を Desktop Commander へ渡さない。
特に `process_kill` では、無効なIDに対して `force_terminate` を呼び出さない。

Desktop Commander との接続が切れた場合は、その世代に属する実行中プロセスの対応をすべて `stale`（無効）にし、その世代の `current_process_owner` の対応表も削除する。
新しい Desktop Commander 接続で同じ PID が使われても、古い論理プロセスIDを新しいプロセスへ対応付け直さない。

プロセスの終了を確認できた場合は、終了状態、取得済みの統合出力、取得できた終了コードを保存し、実行中プロセスの対応表から外す。
その論理プロセスIDが `current_process_owner` だった場合は、`current_process_owner` の対応も削除する。
終了済みプロセスの `process_status` と `process_output` は保存済みの結果から返し、`process_kill` は終了済みとして拒否する。
終了確認前に Desktop Commander との接続が切れた場合は、終了したと推測せず状態不明とする。

RemoteDesktopMCP のセッションが終了または期限切れになっても、それだけを理由に実行中プロセスは停止しない。
同じユーザーの別の有効なセッションから論理プロセスIDを指定した場合は、上記の世代IDと現在有効なIDの確認を通過した場合だけ、状態確認、出力取得、停止を行えるようにする。

## ファイル操作の制約

許可ディレクトリ、書き込み可否、検索対象などのファイル操作制限は、各実行ノードのローカル設定で管理する。

統括ノードからのリクエストであっても、実行ノード側のローカル設定で許可していない操作は実行しない。

同じパスが複数PCに存在しても、同じファイルとは扱わない。
ファイルは `node_id` とローカルパスの組で識別する。

PC 間ファイル転送は初期版の対象外とする。

## ログ

統括ノードは少なくとも次を記録する。

- ユーザーID
- セッションID
- 対象 `node_id`
- リクエスト種別
- 振り分け結果
- 成功、拒否、失敗
- 実行ノードから返された実行結果

実行ノード側にも、そのPCで実行した操作の監査ログを記録する。

同じ操作を統括ノードと実行ノードのログで追跡できるよう、リクエストごとに共通の `request_id` を付与する。

## 統括ノード自身を操作する場合

統括ノード自身が操作対象の場合は、外部の実行ノードへ送らず、同じPC上の Desktop Commander 呼び出し処理へ渡す。
RemoteDesktopMCP はローカルの `@wonderwhy-er/desktop-commander` へ MCP 経由で処理を渡し、統括ノード自身が対象の場合でもファイル操作やプロセス操作を本体内で直接実行しない。
認証、認可、対象ノードの決定、ローカルの操作制限確認、監査ログ記録は遠隔ノードと同じ手順で行う。
統括ノード自身を操作する場合でも、認証・認可・操作制限の確認や Desktop Commander の呼び出しを省略しない。

## 障害発生時

実行ノードとの接続が切れた場合は、そのノードを切断状態として扱い、新しい操作を送らない。
実行中の処理結果を確認できない場合は、成功したと推測せず状態不明として返す。

実行ノード上の Desktop Commander 子プロセスまたは `stdio` MCP 接続が利用できなくなった場合、その間は該当する操作を実行できないものとする。
Desktop Commander との接続が切れたことを検出した時点で、現在の `desktop_commander_generation` に属する実行中プロセスの対応を `stale`（無効）にし、以後その PID を Desktop Commander へ渡さない。
RemoteDesktopMCP は再接続または Desktop Commander の再起動を試みてよい。新しい接続が利用可能になった時点で、新しい `desktop_commander_generation` を生成する。
新しい世代の Desktop Commander 接続が確立しても、古い世代のプロセス対応を復元しない。また、その間だけ RemoteDesktopMCP の直接実装へ切り替えることもしない。
処理中に Desktop Commander 接続が失われ、完了を確認できない場合は成功と推測せず状態不明として返す。

統括ノードが停止した場合、ChatGPT から全実行ノードへの操作はできなくなる。
初期版では統括ノードの自動切り替えは実装しない。

実行ノードは統括ノードとの接続が復旧したとき、自身の `node_id` で再接続する。

## 初期版の対象外

- 統括ノードの自動切り替え
- 複数統括ノードの同時稼働
- 1回の操作を複数ノードで同時に実行する機能
- PC 間ファイル転送
- ChatGPT からのノード登録・削除

## 検証項目

実装後は最低限次を確認する。

1. ChatGPT から1つの MCP 接続だけで複数の実行ノードを一覧表示できる。
2. PC 1 と PC 2 に同じパスが存在しても、指定したノードだけを操作する。
3. 実行ノードを2台以上登録し、そのうち1台だけが接続中のときも、`node_id` を省略したファイル操作とプロセス操作を拒否する。
4. 統括ノード自身を実行ノードとして操作できる。
5. 遠隔実行ノードは Tailscale Funnel を公開しなくても操作できる。
6. 未登録ノードからの接続を拒否する。
7. 実行ノードとの接続が切れた場合に、別のノードへ誤って処理を振り替えない。
8. 同じ操作を統括ノードと実行ノードの監査ログで追跡できる。
9. 実行ノードの起動時に `listTools()` で必要な Desktop Commander ツールを確認し、必要なツールがない操作は利用できないと通知する。
10. `file_*` と `process_*` の実行が Desktop Commander の `callTool()` を経由し、RemoteDesktopMCP 内の同等処理へ自動的に切り替わらない。
11. RemoteDesktopMCP が拒否するパスや操作は Desktop Commander が許可していても実行されず、Desktop Commander のローカル設定が拒否する操作も実行されない。
12. Desktop Commander の設定変更ツールや初期版で許可していないツールが外部 MCP へ公開されない。
13. 現在の `src/index.ts` にある直接探索、直接 `spawn`、初期版対象外の直接ファイル取得処理を Desktop Commander の MCP ツール呼び出しへ置き換え、同じローカル操作を RemoteDesktopMCP 側にも重複実装していないことを確認する。
14. 固定した Desktop Commander バージョンで、stdout と stderr の両方へ識別用の文字列を出す検証用プロセスを実行する。`read_process_output` と RemoteDesktopMCP の `process_output` が両方を1つの統合出力として返すこと、終了状態と取得可能な終了コードを返すこと、stdout / stderr の区分を推測して付けないことを確認する。
15. 世代 `G1` で起動した論理プロセスIDを保持したまま Desktop Commander を再起動して世代 `G2` に変更する。`G2` で同じ PID のプロセスが存在しても、古い論理プロセスIDの `process_status`、`process_output`、`process_kill` は `stale`（無効）となり、`read_process_output` や `force_terminate` を呼び出さないことを確認する。
16. 終了を確認したプロセスは実行中プロセスの対応表と `current_process_owner` から外す。その後の `process_status` と `process_output` は保存済みの状態・統合出力・終了コードから返し、`process_kill` は終了済みとして拒否する。
17. Desktop Commander を再起動せず、同じ世代 `G1` のまま検証用実装から2回の `process_start` に同じ PID `P` を順に返す。1回目の終了を RemoteDesktopMCP がまだ確認していない状態で2回目を開始し、2回目の論理プロセスIDを返す前に1回目を `stale`（無効）にすること、`current_process_owner[{node_id,G1,P}]` が2回目のIDだけを指すこと、1回目のIDから `read_process_output` や `force_terminate` を呼び出さないことを確認する。
18. 同じ実行ノードの世代 `G1` で、PID `P` に対応する現在有効な論理プロセスIDを A とする。`process_status`、`process_output`、`process_kill` の各操作について、A が先にロックを取得した場合と、並行する `process_start` B が先にロックを取得した場合の両方を検証する。A が先の場合は、A の Desktop Commander 呼び出しと状態更新が終わるまで B が `start_process` を呼べないことを確認する。B が先に同じ PID `P` の新しいIDを登録した場合は、待機していた A がロック取得後の再確認で無効と判定され、`read_process_output` や `force_terminate` を呼び出さないことを確認する。
