# PR #1 差分設計レビュー

## メタデータ

- リポジトリ: `ssaattww/RemoteDesktopMCP`
- PR: #1
- レビュー種別: 差分部分の設計レビュー
- 前回通常レビュー report commit: `15e6372f12f390bbcde8bae7e74bf94788c1b063`
- current PR HEAD: `72a3414ed25304840f29160dee3d4ce037aa9f38`
- 今回の主対象 technical HEAD: `e11fc23c12aa17e3d95bbfd623c90ea862c01feb`
- 主対象: ファイル転送、構成図、Desktop Commander 設定ファイル除外、およびそれらの直接回帰

## 範囲

前回レビュー後の全差分は34 commitsあるが、今回の依頼は差分部分の設計レビューであり、current HEADで新たに追加されたファイル転送設計を中心に、関連する既存設計との整合性を確認した。

確認対象:

- `doc/design/functional-requirements.md`
- `doc/design/multi-pc-architecture.md`
- `doc/design/tailscale-funnel-architecture.md`
- `doc/report/2026-09-24-pr1-file-transfer-design.md`
- `doc/report/2026-09-24-pr1-file-transfer-design-handoff.yaml`

## 確認できた設計

- ChatGPT/OpenAI側の MCP Connector と利用者PC上の RemoteDesktopMCP の配置関係は明確になった。
- ファイル転送を RemoteDesktopMCP 独自責務とし、通常の検索・読取・部分編集・プロセス操作は Desktop Commander に委譲する責務分担は一貫している。
- 転送は既存 MCP 接続上の base64 チャンクで行い、遠隔実行ノードを追加公開しない。
- `transfer_id` を `session_id` / `node_id` に固定し、後続呼び出しで対象ノードを差し替えない。
- upload は同一ディレクトリの一時ファイルへ順次書込み、サイズと SHA-256 の検証後だけ転送先へ置き換える。
- 既存ファイル上書きは begin 時の明示許可を要求する。
- Desktop Commander 設定ファイルは file API / transfer API の対象外とし、`process_start` まで隔離するとは主張していない。既存の同一 OS ユーザー権限モデルと整合する。

## Findings

### RDMCP-DR-001 — High — ダウンロードの整合性保証に TOCTOU が残る

**Location:** `doc/design/multi-pc-architecture.md` 「ファイル転送 / ダウンロード」

**Description:** ダウンロード開始時にファイルサイズ・SHA-256を取得し、各 chunk では転送開始時の「サイズまたは更新時刻」が変化した場合に失敗させる設計になっている。しかし、通常のパスを各 chunk で再読込する方式では、転送中に内容が変更された後、サイズと更新時刻が開始時と同じ値へ戻された場合を検出できない。また、begin 時の SHA-256 と実際に返した全 chunk の SHA-256 が一致することを完了条件として明記していない。

**Impact:** begin で提示した SHA-256 が、実際にクライアントへ返したバイト列の整合性を保証しない実装が設計上許される。転送途中に元ファイルが置換・変更された場合、複数時点の内容を混ぜたダウンロードを成功扱いできる余地がある。

**Required action:** begin 時に読み取り対象を固定できるファイルハンドル/スナップショットを保持してその同一実体から全 chunk を読む、または全送信バイト列の SHA-256 を転送完了時に検証し begin 時の値との一致を成功条件にするなど、実際に送信したバイト列と提示した SHA-256 の一致を保証する方式を定義する。

### RDMCP-DR-002 — Medium — アップロードの「上書き不可」が begin 後の競合を防げない

**Location:** `doc/design/multi-pc-architecture.md` 「ファイル転送 / アップロード」

**Description:** 既存ファイルの上書きは begin 時に明示許可された場合だけ行うと定義されているが、`overwrite=false` で begin した後、commit までの間に別プロセスが転送先を作成した場合の扱いが定義されていない。「検証後だけ一時ファイルを転送先へ置き換える」だけでは、commit 時の置換操作が新しく作られたファイルを上書きする実装になり得る。

**Impact:** 利用者が上書きを許可していない転送でも、begin と commit の間に作成されたファイルを破壊する可能性がある。

**Required action:** `overwrite=false` の場合は commit 時にも転送先が存在しないことを原子的に保証して確定し、競合した場合は失敗して一時ファイルを削除することを定義する。単純な事前 existence check + rename ではなく、対象 OS で no-replace semantics を実現する方法を実装要件にする。

## 直接回帰

今回の追加設計について、上記2件以外に直接的な設計矛盾は確認しなかった。

特に次は整合している。

- `node_id` の選択規則は transfer begin にも既存ルールを適用している。
- 後続 transfer 操作は `transfer_id` に記録したノードへ固定される。
- セッション終了・期限切れ後は transfer を継続しない。
- 遠隔 executor の外部公開は増えていない。
- Desktop Commander 設定ファイル除外と `process_start` の同一 OS ユーザー trust model は矛盾していない。

## Validation / CI

実装担当 report では technical HEAD `e11fc23c12aa17e3d95bbfd623c90ea862c01feb` と publication candidate について lint/check/build/audit/diff-check の pass が記録されている。

レビュー開始時の current PR HEAD は `72a3414ed25304840f29160dee3d4ce037aa9f38`。この SHA に一致する workflow run を GitHub connector で確認したが、run は返らなかった。別 SHA の run は代用していない。

## Verdict

**fail**

差分設計には High 1件、Medium 1件の修正が必要である。既存設計全体の再レビューではなく、今回追加されたファイル転送設計に対する指摘である。

merge は行わない。
