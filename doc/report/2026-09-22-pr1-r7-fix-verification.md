# PR #1 RDMCP-R7 fix verification

## メタデータ

- リポジトリ: `ssaattww/RemoteDesktopMCP`
- PR: #1
- モード: fix verification
- source finding: RDMCP-R7 (High)
- source reviewed HEAD: `75c50f61ae2855817aacebe739e8e731e7c64f1e`
- reviewed implementation HEAD: `5ee55a9d3f68a1c37efb4d8657697d57d266e18a`
- base: `main`
- branch: `feat/tailscale-funnel-design-lint`
- 実行環境: FA780
- worktree: `C:\Users\donabe\Project\RemoteDesktopMCP-pr1-r4-20260922`
- validation evidence: `C:\Users\donabe\Project\RemoteDesktopMCP-pr1-r7-rereview-20260922-0810`

## レビュアー継続性

このチャットは RDMCP-R7 を指摘した通常レビュアーの継続チャットである。
RDMCP-R7 の設計修正は実装していない。
今回は RDMCP-R7 の fix verification と、その修正差分から直接生じる回帰を確認した。

## 対象同一性

GitHub の PR #1 current HEAD と FA780 の専用 worktree HEAD が
`5ee55a9d3f68a1c37efb4d8657697d57d266e18a` で一致した。
worktree はレビュー開始時に clean だった。

RDMCP-R7 対応差分は次の3ファイルである。

- `doc/design/multi-pc-architecture.md`
- `doc/report/2026-09-22-pr1-r7-review-followup.md`
- `doc/report/2026-09-22-pr1-r7-review-followup-handoff.yaml`

診断 workflow `.github/workflows/lint.yml` は `if: always()` で
npm install / lint の stdout、stderr、結果、対象 SHA、Node.js/npm 情報を artifact 保存する。
追加 workflow 変更は不要と判断した。

## RDMCP-R7 verification

RDMCP-R7 の required action は設計へ反映されている。

- `process_key = { node_id, desktop_commander_generation, pid }` を定義した。
- active / 終了未確認の各 key に `current_process_owner` を最大1件だけ保持する。
- 同一 key が再利用された場合、旧 owner を stale にしてから新 owner を公開する。
- status/output/kill は current generation かつ current owner の場合だけ PID を RDC へ渡す。
- owner 不一致の `process_kill` は `force_terminate` を呼ばない。
- 完了済み final snapshot は active owner 判定から外す。
- RDC 接続喪失時は旧 generation の owner 索引も削除する。
- RDC 再起動なし・同一 generation・同一 PID 再利用の validation case を追加した。

以上から **RDMCP-R7 (High) は resolved** とする。

ただし current-owner 検査と RDC 呼び出しの並行実行について、
同じ誤プロセス参照クラスの未定義競合を確認した。

## RDMCP-R8 — High — owner 検査から RDC 呼び出しまでの並行実行が直列化されていない

### R8 の位置

- `doc/design/multi-pc-architecture.md` のセッションとプロセス
- `process_start` と `process_status` / `process_output` / `process_kill` の owner 検査
- 同文書の validation case 17

### R8 の内容

R7 修正は、要求を受けた時点で logical ID が current owner かを確認する。
しかし、owner 検査から Desktop Commander の PID tool 呼び出しまでを
同じ排他区間に置く規則がない。
Desktop Commander 0.2.50 は terminal session を PID key で管理する。
`force_terminate(pid)`、`read_process_output(pid)` は PID 以外の
process incarnation 識別子を受け取らない。

次の競合が成立する。

1. 旧 logical ID A の `process_kill` が current owner 検査を通過する。
2. A がまだ `force_terminate(P)` を呼ぶ前に、並行 `process_start` が実行される。
3. 旧 OS process が終了済みで PID P が再利用され、新しい RDC session B が P を取得する。
4. RDMCP は新 owner B へ更新するが、A はすでに owner 検査を通過済みである。
5. A の `force_terminate(P)` が新 RDC session B を停止し得る。

同様に `process_status` / `process_output` も新 session の情報を旧 ID へ返し得る。

R7 で定義した owner replacement 自体が原子的でも、
「owner 判定 + RDC tool call」と並行 `process_start` の間が直列化されなければ
TOCTOU を防げない。

### R8 の影響

特に `process_kill` は別の新プロセスを停止する destructive mis-target となる。
R7 が防ごうとした同一 generation PID 再利用の安全性が、並行要求時には成立しない。

### R8 の required action

PID が呼び出し前には分からない `process_start` と、
既存 PID を使う status/output/kill の競合を防ぐため、
少なくとも同一 executor / `desktop_commander_generation` の
process operation を owner 判定から RDC tool call 完了まで直列化する規則を設計すること。

最低限、次を満たす。

1. `process_start` と、PID を RDC へ渡す status/output/kill は同一 generation の排他制御に参加する。
2. status/output/kill は排他取得後に current owner を再確認し、そのまま排他を保持して RDC tool call を完了する。
3. `process_start` は `start_process` の呼び出し開始から PID 取得、旧 owner stale 化、新 owner 登録まで同じ排他を保持する。
4. 排他解除後にだけ新 logical ID を外部へ公開する。
5. owner 不一致または generation 不一致の場合は RDC tool を呼ばない。
6. validation に、旧 ID の kill/output を owner 検査直後で停止させた状態から並行 `process_start` を開始する interleaving を追加し、誤った RDC PID tool call が発生しないことを確認する。

RDC が将来 PID 以外の不変 process incarnation token を提供する場合は、
その token を利用する別設計へ変更してよい。

## Direct regression review

R7 の current-owner 一意化、旧 owner stale 化、final snapshot 除外そのものには
R8 以外の直接回帰を確認しなかった。

## Validation

reviewed HEAD `5ee55a9d3f68a1c37efb4d8657697d57d266e18a` で reviewer が次を実行した。

| command | result |
| --- | --- |
| focused markdownlint (1 design file) | pass、0 issues |
| `npm run lint:md:terms:design` | pass |
| `npm run lint:ts` | pass |
| `npm run check` | pass |
| `npm run build` | pass |
| `npm audit --audit-level=low` | pass、0 vulnerabilities |
| `git diff --check` | pass |
| implementation handoff YAML parse | pass |
| `npm run lint` | fail |

full lint の失敗は既存の
`doc/report/2026-09-19-pr1-design-review-fix-verification.md:91`
MD036 `no-emphasis-as-heading` 1件のみだった。
R7 修正差分由来の Markdown finding はない。

## CI

GitHub connector で reviewed HEAD の workflow run と combined status を確認したが、
どちらも0件だった。
別 SHA の run は代用していない。
したがって reviewed implementation HEAD の exact-HEAD CI は **未確認** とする。

## Coverage dispositions

- requirement/design conformance: checked_finding — R8
- correctness/edge cases: checked_finding — concurrent TOCTOU around PID ownership
- scope discipline: checked_no_finding
- changed files/direct dependencies: checked_finding — RDC 0.2.50 PID-keyed terminal session behaviorを照合
- API/data/config/workflow compatibility: checked_no_finding outside R8
- error handling/failure diagnostics: checked_finding — process-operation serialization未定義
- security/secret handling: checked_no_finding
- tests/validation adequacy: checked_finding — concurrent interleaving validation不足
- current-HEAD CI: held — matching evidenceなし
- report/documentation accuracy: checked_no_finding
- regression/maintainability: checked_finding — R8

## Verdict

判定は `fail`。

RDMCP-R7 は resolved だが、RDMCP-R8 (High) が残るため
PR #1 の設計レビューは通過しない。

## Remaining risks / next action

- R8 の process operation 排他と owner 再確認規則を設計する。
- 修正後、この通常レビューチャットで R8 の fix verification を行う。
- exact-HEAD CI は新しい PR current HEAD に一致する run だけを使用する。
- merge は行わない。
