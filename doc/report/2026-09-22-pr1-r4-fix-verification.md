# PR #1 RDMCP-R4 fix verification

## メタデータ

- リポジトリ: `ssaattww/RemoteDesktopMCP`
- PR: #1
- モード: fix verification
- source finding: RDMCP-R4 (High)
- source reviewed HEAD: `15e6372f12f390bbcde8bae7e74bf94788c1b063`
- reviewed implementation HEAD: `71d039f0ea2d3b0d57bc5a3d4e4c6ba4d0a59ed8`
- base: `main`
- branch: `feat/tailscale-funnel-design-lint`
- 実行環境: FA780
- worktree: `C:\Users\donabe\Project\RemoteDesktopMCP-pr1-r4-20260922`
- validation evidence: `C:\Users\donabe\Project\RemoteDesktopMCP-pr1-review-20260922-0642`

## レビュアー継続性

このチャットは RDMCP-R4 を PR #1 へ投稿した通常レビュアーの継続チャットである。
RDMCP-R4 の設計修正は実装していない。
したがって今回は RDMCP-R4 の fix verification と、その修正差分から直接生じる回帰を確認した。

## 対象同一性

GitHub の PR #1 current HEAD と FA780 の専用 worktree HEAD が
`71d039f0ea2d3b0d57bc5a3d4e4c6ba4d0a59ed8` で一致した。
worktree はレビュー開始時および検証前に clean であった。

RDMCP-R4 対応差分は次の5ファイルである。

- `doc/design/functional-requirements.md`
- `doc/design/multi-pc-architecture.md`
- `doc/design/tailscale-funnel-architecture.md`
- `doc/report/2026-09-22-pr1-r4-review-followup.md`
- `doc/report/2026-09-22-pr1-r4-review-followup-handoff.yaml`

診断 workflow `.github/workflows/lint.yml` は、`if: always()` で
npm install / lint の stdout、stderr、結果、対象 SHA、Node.js/npm 情報を artifact 保存する。
このため今回のレビュー開始時点で追加 workflow 変更は不要と判断した。

## RDMCP-R4 verification

RDMCP-R4 の required action は設計へ反映されている。
確認した内容:

- 実行ノードのファイル・プロセス操作は `@wonderwhy-er/desktop-commander` の stdio MCP へ委譲する。
- 起動時に `listTools()` で能力を確認し、実行時は `callTool()` を使う。
- RemoteDesktopMCP の公開 `file_*` / `process_*` は wrapper/mapping とする。
- 認証、認可、RemoteDesktopMCP セッション、`node_id` routing、監査、公開方針、論理識別子を固有責務としている。
- 必須 RDC tool がない場合に RemoteDesktopMCP の重複実装へ fallback しない。
- 初期版には RDC にない file/process 操作の独自実装例外を設けない。
- 現行 `src/index.ts` の直接探索、直接 `spawn`、直接ファイル取得は暫定 scaffold とし削除対象を明示した。
- 統括ノード自身が executor を兼任する場合も Desktop Commander 委譲を省略しない。

以上から **RDMCP-R4 (High) は resolved** とする。

ただし RDC 0.2.50 の実際の MCP 契約と照合すると、
R4 修正で追加された process mapping に新しい required finding が2件ある。

## RDMCP-R5 — High — stdout / stderr 分離契約を RDC 0.2.50 から実現できない

### R5 の位置

- `doc/design/functional-requirements.md` のプロセス操作要件
- `doc/design/multi-pc-architecture.md` の `process_output -> read_process_output` mapping

### R5 の内容

機能要件は stdout と stderr を取得できることを別々に要求している。
設計は `process_output` を Desktop Commander の `read_process_output` へ委譲し、
stdout、stderr、終了状態を RemoteDesktopMCP の公開形式へ正規化するとしている。

しかし FA780 上の `@wonderwhy-er/desktop-commander` 0.2.50 実装では、
`TerminalManager.executeCommand()` が stdout と stderr の双方を同じ
`session.outputLines` へ `appendToLineBuffer()` している。
`readProcessOutput()` はその単一 line buffer を join して返すため、
後段の wrapper から完全な stdout / stderr の出所を復元できない。

`start_process(verbose_timing=true)` は初期 wait 中の output event に
`stdout` / `stderr` の source を付けるが、その情報は後続の
`read_process_output` の全出力には保持されない。
実機 probe でも `read_process_output` は stdout / stderr を同一出力として返した。

### R5 の影響

現在の設計のままでは、RDC を再利用しながら公開 process contract を正確に実装できない。
merged output を stdout / stderr のいずれかとして扱うと外部契約が事実と異なる。

### R5 の required action

次のいずれかを設計で確定すること。

1. 初期版の公開契約を RDC が提供できる combined output + exit status に変更する。
2. stdout / stderr を構造化して返す Desktop Commander 版または upstream tool を必須依存とする。
3. RDC で代替不能な例外として別設計する場合は、RDMCP-R4 の例外手順に従い理由・権限・監査・検証を明示する。

RDC 再利用を優先する現在方針では、1 または 2 が整合的である。
あわせて pinned RDC version に対して process output contract を機械検証する項目を追加すること。

## RDMCP-R6 — High — 論理 process ID が RDC instance generation に結び付いていない

### R6 の位置

- `doc/design/multi-pc-architecture.md` のローカル操作の委譲
- 同文書のセッションとプロセス
- 同文書の障害時の扱い

### R6 の内容

設計は RemoteDesktopMCP の論理 process ID を
Desktop Commander のローカル識別子へ対応付け、
`process_status` / `process_output` / `process_kill` で再利用する。

Desktop Commander 0.2.50 の terminal session のローカル識別子は PID である。
`TerminalManager` は active / completed session を PID key で保持し、
`force_terminate` と `read_process_output` も PID のみを受け取る。
一方、現設計は Desktop Commander の stdio MCP 接続が失われた場合に
子プロセスの再起動または再接続を許しているが、
その時点で既存の論理 process mapping を失効させる規則がない。

OS PID は再利用され得る。
古い論理 process ID が旧 Desktop Commander instance の PID だけを保持したまま、
新しい instance で同じ PID の別 session が生成されると、
古い論理 ID の status/output/kill が別 process を対象にする可能性がある。

特に `process_kill -> force_terminate` は誤った process を停止する破壊的影響を持つ。

### R6 の required action

process mapping を少なくとも
`{ node_id, desktop_commander_generation, pid }` の世代付き identity として定義すること。

- Desktop Commander の MCP child / transport を再生成したら generation を更新する。
- 旧 generation の論理 process ID は即時 stale / state_unknown とし、PID を新 instance へ渡さない。
- process 完了を確認した mapping は active mapping から退役させる。
- reconnect/restart 後の stale logical ID で status/output/kill が新 process へ到達しない検証項目を追加する。

## Direct regression review

R4 で変更された認証・node routing・file delegation の範囲には追加 finding を確認しなかった。
file search/read/edit の主な委譲先は現在の RDC tool surface と整合している。

## Validation

reviewed HEAD `71d039f0ea2d3b0d57bc5a3d4e4c6ba4d0a59ed8` で次を実行した。

| command | result |
| --- | --- |
| `npm run lint:md:terms:design` | pass |
| `npm run lint:ts` | pass |
| `npm run check` | pass |
| `npm run build` | pass |
| `npm audit --audit-level=low` | pass、0 vulnerabilities |
| `git diff --check` | pass |
| `npm run lint` | fail |

full lint の失敗は既存の
`doc/report/2026-09-19-pr1-design-review-fix-verification.md:91`
MD036 `no-emphasis-as-heading` 1件だけであり、R4 修正差分ではない。
ただし現在の PR HEAD 全体として lint green ではないことは保持する。

## CI

GitHub connector で reviewed HEAD に一致する workflow run を確認したが 0件だった。
別 SHA の run は代用していない。
したがって exact-HEAD CI は **未確認** とする。

## Coverage dispositions

- requirement/design conformance: checked_finding — R5, R6
- correctness/edge cases: checked_finding — process stream semantics と stale PID mapping
- scope discipline: checked_no_finding
- changed files/direct dependencies: checked_finding — RDC 0.2.50 process tool contract を照合
- API/data/config/workflow compatibility: checked_finding — process output contract mismatch
- error handling/failure diagnostics: checked_finding — restart generation invalidation不足
- security/secret handling: checked_no_finding in R4 delta
- tests/validation adequacy: checked_finding — process contract / restart identity の focused verification が未定義
- current-HEAD CI: held — matching runなし、full lintは既知MD036でfail
- report/documentation accuracy: checked_no_finding for R4 report except CI pending state
- regression/maintainability: checked_finding — R5, R6

## Verdict

判定は `fail`。

RDMCP-R4 自体は resolved だが、R4 の process delegation 設計から
RDMCP-R5 (High) と RDMCP-R6 (High) が確認された。
この2件が解消されるまで PR #1 の設計レビューは通過しない。

## Remaining risks / next action

- R5: RDC で実現可能な process output contract を確定する。
- R6: Desktop Commander instance generation を含む logical process identity と失効規則を定義する。
- その修正後、同じ通常レビューチャットで R5 / R6 の fix verification を行う。
- exact-HEAD CI は修正後の current HEAD と一致する run だけを使用する。
- merge は行わない。
