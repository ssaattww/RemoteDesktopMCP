# PR #1 ファイル転送差分 設計レビュー

## メタデータ

- リポジトリ: `ssaattww/RemoteDesktopMCP`
- PR: #1
- review mode: `initial_review`（今回追加された設計差分に対する通常レビュー）
- reviewer: この通常レビューチャット
- reviewer continuity: PR #1 の通常レビューを継続している同一チャット
- 差分開始 HEAD: `95ec1874e6fe82d92d2d77253cfe83a6ccbf1865`
- technical design HEAD: `e11fc23c12aa17e3d95bbfd623c90ea862c01feb`
- reviewed implementation HEAD: `72a3414ed25304840f29160dee3d4ce037aa9f38`
- reviewed range: `95ec1874e6fe82d92d2d77253cfe83a6ccbf1865..72a3414ed25304840f29160dee3d4ce037aa9f38`
- review execution: FA780 の独立 worktree `C:\Users\donabe\Project\RemoteDesktopMCP-pr1-delta-reviewed-head`
- validation evidence: `C:\Users\donabe\Project\_review-evidence\RemoteDesktopMCP-pr1-delta`

技術判定は `72a3414ed25304840f29160dee3d4ce037aa9f38` に対して行う。

## 目的と範囲

今回追加された設計差分を対象に、ファイル転送、ChatGPT/OpenAI側 MCP Connector の構成図、Desktop Commander 設定ファイル除外、それらが既存の認証・セッション・複数PC・Desktop Commander再利用方針へ与える直接影響を確認した。

technical commit `e11fc23c...` で変更された設計ファイルは次の4件。

- `doc/design/functional-requirements.md`
- `doc/design/multi-pc-architecture.md`
- `doc/design/tailscale-funnel-architecture.md`
- `tools/lint/markdown-whitelist.yaml`

publication commit `72a3414e...` は設計更新 report と handoff の追加である。

非対象:

- ファイル転送の製品実装
- PR #1 の既存設計全体の再レビュー
- merge

## 作業環境と対象同一性

Project 添付の `chatgpt-worker-skills 4.zip` を展開し、`chat-review-worker` → `work-context-manager` → `review-worker` → `report-writer` → `chat-handoff-manager` の契約を今回の作業基準として使用した。

FA780 上に対象 repository がなかったため、レビュー専用 clone と reviewed HEAD 固定 worktree を作成した。reviewed worktree は detached HEAD `72a3414ed25304840f29160dee3d4ce037aa9f38` で、検証時に product/design の変更は加えていない。

## 差分設計の確認結果

次の設計は既存方針と整合している。

- MCP Connector を ChatGPT / OpenAI 側、RemoteDesktopMCP 本体を統括ノードPC側として区別した。
- 通常の検索・読取・部分編集・プロセス操作は Desktop Commander に委譲し、ファイル転送だけを RemoteDesktopMCP の限定的な直接I/O例外とした。
- 外部転送用 HTTP endpoint を追加せず、既存 MCP 接続上で base64 chunk を送受信する。
- 遠隔 executor を外部公開せず、統括ノードが既存の認証済みノード間接続で中継する。
- `transfer_id` は `session_id` / `node_id` に固定し、後続操作で対象ノードを差し替えない。
- upload は同一ディレクトリの一時ファイルへ順次書き、サイズと SHA-256 の検証後だけ確定する。
- Desktop Commander 設定ファイルを file API / transfer API から保護する一方、`process_start` の同一 OS ユーザー trust model までは隔離しない。

## Findings

### RDMCP-DR-001 — High — ダウンロードの整合性保証に TOCTOU が残る

- Origin: `introduced_by_change`
- Location: `doc/design/multi-pc-architecture.md` 「ファイル転送 / ダウンロード」「ファイル転送の確認」

**Description:**

`file_transfer_download_begin` は開始時にファイルサイズと SHA-256 を返す一方、転送中の変更検出は開始時のサイズまたは更新時刻との比較だけで定義されている。

パスを chunk ごとに再度開く実装では、転送途中にファイルが置換・変更され、その後サイズと更新時刻が開始時と同じ値になった場合を検出できない。さらに、begin 時に提示した SHA-256 と「実際に返した全 chunk のバイト列」の SHA-256 が一致することを成功条件として設計本文に固定していない。

**Impact:**

begin で提示した SHA-256 が、クライアントが実際に受信したバイト列の整合性を保証しない実装が可能になる。複数時点の内容が混在した転送を成功扱いする余地がある。

**Evidence:**

- begin: ファイル名、サイズ、SHA-256、chunk size を返す。
- chunk: サイズまたは更新時刻の変化だけで変更を検出する。
- 検証項目: 開始時 SHA-256 と転送後ファイルの一致を確認するが、実装契約として同一ファイル実体を固定する方法または送信全バイト列 hash の照合方法がない。

**Required action:**

begin 時に読み取り対象を固定できるファイルハンドル/スナップショットを保持して同一実体から全 chunk を読む、または実際に送信した全バイト列の SHA-256 を完了時に検証して begin 時の値との一致を成功条件にするなど、提示 hash と送信バイト列の一致を保証する方式を設計に固定する。対応する競合変更 fixture も検証項目へ追加する。

### RDMCP-DR-002 — Medium — overwrite=false の commit が競合ファイルを上書きし得る

- Origin: `introduced_by_change`
- Location: `doc/design/multi-pc-architecture.md` 「ファイル転送 / アップロード」「ファイル転送の確認」

**Description:**

既存ファイルの上書きは begin 時に明示許可された場合だけ行うと定義されている。しかし `overwrite=false` で begin が成功した後、commit までの間に別プロセスが同じ転送先を作成した場合の確定規則がない。

「検証成功後だけ一時ファイルを転送先へ置き換える」だけでは、commit 時の rename/replace が begin 後に作られたファイルを上書きする実装になり得る。

**Impact:**

利用者が上書きを許可していない転送でも、並行処理で作られた既存ファイルを破壊する可能性がある。

**Evidence:**

- begin は上書き可否を受け取る。
- commit は一時ファイルを転送先へ置き換える。
- 検証項目は「上書き許可なしで既存ファイルを指定した場合」を確認するだけで、begin 後に競合ファイルが作成されるケースを含まない。

**Required action:**

`overwrite=false` では commit 時にも「転送先が存在しない場合だけ確定」を原子的に保証し、競合した場合は失敗して一時ファイルを削除することを定義する。単純な existence check + rename ではなく、対象 OS ごとの no-replace semantics を実装要件とし、begin 後に競合ファイルを作成する fixture を検証項目へ追加する。

### RDMCP-DR-003 — Medium — Desktop Commander 設定ファイル除外の構成契約が文書間で一意でない

- Origin: `introduced_by_change`
- Location:
  - `doc/design/functional-requirements.md` 「Desktop Commander の利用方針 / 公開範囲と設定の制限」
  - `doc/design/multi-pc-architecture.md` 「Desktop Commander の利用」「ファイル転送 / パス制限」「ファイル転送の確認」

**Description:**

機能要件では、Desktop Commander 設定ファイルが file tool の許可ディレクトリ内に存在する場合でも「この除外を優先する」としており、許可ディレクトリ内配置を許容したうえで個別ファイルを除外する契約に読める。

一方、複数PC設計では「検索範囲に設定ファイルを含める構成は許可しない」とし、検証項目でも「設定ファイルを含むディレクトリを検索範囲として構成できないこと」を要求している。

**Impact:**

実装者が、(A) 設定ファイルを含む allowed directory 自体を拒否するのか、(B) allowed directory は許可して対象ファイルだけを全 file/transfer API から除外するのかを一意に決められない。特に `content_search` は Desktop Commander に検索範囲を渡すため、後段で結果だけ隠す方式は禁止されており、この差は実装方式に直接影響する。

**Evidence:**

- functional requirements: 「許可ディレクトリ内に設定ファイルが存在する場合も、この除外を優先」
- multi-PC architecture: 「検索範囲に設定ファイルを含める構成は許可しない」
- validation: 「設定ファイルを含むディレクトリを検索範囲として構成できないこと」

**Required action:**

初期版の構成契約を一つに固定する。検索対象 root と設定ファイルの親ディレクトリが重なる構成自体を拒否するなら、機能要件もその制約へ合わせる。個別ファイル除外を許容するなら、Desktop Commander の検索が設定ファイルを走査しない具体的な検索範囲分割/除外方式を定義し、文書と検証項目を統一する。

## Required coverage

| Criterion | Disposition | Evidence |
| --- | --- | --- |
| requirement and design conformance | `checked_finding` | 設定ファイル除外契約が文書間で一意でない。RDMCP-DR-003 |
| correctness and edge cases | `checked_finding` | download TOCTOU と upload no-replace race。RDMCP-DR-001/002 |
| scope discipline and unrelated changes | `checked_no_finding` | technical commit は file transfer、構成図、設定ファイル保護と関連 whitelist に限定 |
| changed files and direct dependency impact | `checked_finding` | 3 design docs と whitelist、Desktop Commander delegation、node/session/path policy を照合。RDMCP-DR-003 |
| API, data, configuration, workflow, compatibility effects | `checked_finding` | transfer API の commit semantics と protected config configuration contract に finding |
| error handling and failure diagnostics | `checked_no_finding` | cancel、expiry、hash/size failure、node disconnect の失敗扱いが定義され、成功推測を要求していない |
| security and secret handling | `checked_finding` | path/content integrity と overwrite protection に RDMCP-DR-001/002。process_start trust model は意図どおり維持 |
| tests and validation adequacy | `checked_finding` | 基本 transfer tests は設計済みだが RDMCP-DR-001/002 の競合 fixture が不足 |
| current-HEAD CI evidence | `unexplored` | reviewed HEAD `72a3414e...` に一致する workflow run は GitHub connector から取得できなかった。別 SHA は代用していない |
| report, tracking, and documentation accuracy | `checked_finding` | implementation report/handoff は実施内容を概ね正確に記録。ただし authoritative design の RDMCP-DR-003 不一致は残る。tasks/tasks-status.md は repository に存在しない |
| regression and maintainability risks | `checked_finding` | transfer concurrency と protected-config policy の実装分岐が将来の挙動差につながる |

## Validation assessment

reviewed HEAD `72a3414ed25304840f29160dee3d4ce037aa9f38` を FA780 の detached worktree に固定して実行した。

| Validation | Result |
| --- | --- |
| `npm.cmd ci` | pass |
| `npm.cmd run lint` | pass |
| `npm.cmd run check` | pass |
| `npm.cmd run build` | pass |
| `npm.cmd audit --audit-level=low` | pass / 0 vulnerabilities |
| `git diff --check` | pass |

stdout/stderr は repository 外の `C:\Users\donabe\Project\_review-evidence\RemoteDesktopMCP-pr1-delta` に保存した。

最初の PowerShell 実行では `npm.ps1` が execution policy で拒否されたため、その試行を成功 evidence として使用していない。`npm.cmd` で再実行した結果だけを上表の validation evidence とする。

## CI

reviewed HEAD `72a3414ed25304840f29160dee3d4ce037aa9f38` に一致する workflow run は GitHub connector から取得できなかった。

このレビューは `local_execution_available` route であり、ローカル validation は reviewed HEAD に固定して完了している。CI がないことを別 SHA の run で補っていない。

## Held / unexplored / unknown

### Held

- MCP/ChatGPT 側の実メッセージ上限に対する最適 chunk size。
  - 理由: 実接続時の上限確認が必要。
  - owner: file-transfer implementation/integration validation。
  - remaining risk: 256 KiB 初期値を実環境で小さくする必要が生じる可能性。
  - verdict impact: non-blocking。設計は設定で小さくできることを要求済み。

### Unexplored

- current reviewed HEAD の GitHub Actions run。
  - blocker: matching run が存在しない/connector から返らない。
  - remaining risk: CI 環境固有の lint failure は未確認。
  - verdict impact: local route では technical review の追加 blocker にはしない。

### Unknown

- `tasks/tasks-status.md`: repository に存在しないため task tracking state は unknown。

## Intentionally untouched

- product source: 設計レビューのため変更しない。
- workflow/configuration: finding 修正は実装担当へ返すため変更しない。
- merge: 利用者が行うため実施しない。

## Verdict

fail

Required findings:

- RDMCP-DR-001 / High
- RDMCP-DR-002 / Medium
- RDMCP-DR-003 / Medium

今回の差分について、上記3件まで確認した。これらを除き、確認した差分範囲に追加の required finding はない。

## 次のアクション

実装担当で3 finding の設計を修正し、各 finding について required action、production/design path、実際の競合 fixture、focused evidence を揃える。その後、この同じ通常レビューチャットで fix verification を行う。

## Merge boundary

merge は実施しない。
