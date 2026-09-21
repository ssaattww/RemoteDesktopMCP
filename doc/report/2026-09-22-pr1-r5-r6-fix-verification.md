# PR #1 RDMCP-R5 / RDMCP-R6 fix verification

## メタデータ

- リポジトリ: `ssaattww/RemoteDesktopMCP`
- PR: #1
- モード: fix verification
- source findings: RDMCP-R5 (High), RDMCP-R6 (High)
- source reviewed HEAD: `71d039f0ea2d3b0d57bc5a3d4e4c6ba4d0a59ed8`
- reviewed implementation HEAD: `75c50f61ae2855817aacebe739e8e731e7c64f1e`
- base: `main`
- branch: `feat/tailscale-funnel-design-lint`
- 実行環境: FA780
- worktree: `C:\Users\donabe\Project\RemoteDesktopMCP-pr1-r4-20260922`
- validation evidence: `C:\Users\donabe\Project\RemoteDesktopMCP-pr1-r5-r6-rereview-20260922-0729`

## レビュアー継続性

このチャットは RDMCP-R5 / RDMCP-R6 を指摘した通常レビュアーの継続チャットである。
当該修正は実装していないため、今回は fix verification と直接回帰のみを確認した。

## 対象同一性

GitHub の PR #1 current HEAD と FA780 の専用 worktree HEAD が
`75c50f61ae2855817aacebe739e8e731e7c64f1e` で一致した。
レビュー開始時の worktree は clean だった。

RDMCP-R5 / RDMCP-R6 対応差分は次の4ファイルである。

- `doc/design/functional-requirements.md`
- `doc/design/multi-pc-architecture.md`
- `doc/report/2026-09-22-pr1-r5-r6-review-followup.md`
- `doc/report/2026-09-22-pr1-r5-r6-review-followup-handoff.yaml`

診断 workflow `.github/workflows/lint.yml` は `if: always()` で
npm install / lint の stdout、stderr、結果、対象 SHA、Node.js/npm 情報を artifact 保存する。
追加変更は不要と判断した。

## RDMCP-R5 verification

RDMCP-R5 の required action は満たされている。
確認内容:

- 初期版の公開 `process_output` は combined `output`、`state`、`exit_code` を返す。
- 個別の `stdout` / `stderr` 欄は初期版契約から削除された。
- wrapper は stdout / stderr の由来を推測しない。
- 初期検証対象を `@wonderwhy-er/desktop-commander` 0.2.50 に固定した。
- RDC 版更新前に process output contract probe を必須化した。
- probe は stdout / stderr 双方の識別文字列、終了状態、取得可能な終了コードを確認する。

FA780 の RDC 0.2.50 で再現確認した。

- `cmd.exe` から stdout と stderr へ別々の識別文字列を出力した。
- `read_process_output` は両方を単一出力として返した。
- `exit /b 7` の終了コード `7` を返した。
- `read_process_output` は個別 stream provenance を返さなかった。

以上から **RDMCP-R5 (High) は resolved** とする。

## RDMCP-R6 verification

RDMCP-R6 の required action も source finding の範囲では満たされている。
確認内容:

- logical process mapping に少なくとも `{ node_id, desktop_commander_generation, pid }` を含める。
- `desktop_commander_generation` は新しいローカル RDC 接続ごとに新規生成する。
- executor 自体の再起動でも generation を変更する。
- mapping の generation と current generation が一致するときだけ PID を RDC へ渡す。
- RDC 接続喪失時に旧世代の active mapping を即時 `stale` / 状態不明へ遷移する。
- stale mapping の `process_status` / `process_output` / `process_kill` から PID を新世代 RDC へ渡さない。
- 特に stale `process_kill` から `force_terminate` を呼ばない。
- 終了確認済みプロセスは active PID mapping を退役し、確定 snapshot から status/output を返す。
- RDC再起動による世代変更と同一PID再出現を検証する項目が追加された。

したがって **RDMCP-R6 (High) は resolved** とする。

ただし、R6 修正が generation による identity を導入したことで、
同一 generation 内の PID 再利用に関する未定義経路が残ることを確認した。

## RDMCP-R7 — High — 同一 Desktop Commander 世代内の PID 再利用を区別できない

### R7 の位置

- `doc/design/multi-pc-architecture.md` のセッションとプロセス
- 同文書の process validation case

### R7 の内容

現設計では logical process mapping を
`{ node_id, desktop_commander_generation, pid }` で検証する。
この対策は RDC 再起動・再接続に伴う世代変更時の PID 再利用には有効である。

しかし同じ RDC instance / generation が動作し続ける間にも OS PID は再利用され得る。
旧プロセスが終了しているが、RemoteDesktopMCP がまだ終了確認を行っていない状態で、
別の `process_start` が同じ PID を取得するケースが設計されていない。

このとき旧 logical process ID と新 logical process ID が
同じ `{ node_id, generation, pid }` を保持し得る。
generation 検査は両方で成功するため、旧 logical ID から
`read_process_output` や `force_terminate` が新 process へ到達し得る。

Desktop Commander 0.2.50 は terminal session を PID key で管理し、
active session を completed session より優先して参照する。
そのため同一 PID の新 active session が作られた後は、
旧 logical ID が同じ PID を渡すだけで新 session を参照する。

### R7 の影響

特に `process_kill` では古い logical ID が新しい別 process を停止する可能性がある。
これは process identity と destructive operation の正当性を崩す。

### R7 の required action

同一 `{ node_id, desktop_commander_generation, pid }` の current owner を
RemoteDesktopMCP 側で一意に管理すること。

最低限、次を設計する。

1. `process_start` が返した PID と current generation の tuple に既存 active mapping があるか確認する。
2. 同じ tuple が既存 mapping に使われている場合、新 logical ID を公開する前に旧 mapping を `stale` / 状態不明へ失効させる。
3. current owner ではない logical ID の status/output/kill から PID を RDC へ渡さない。
4. 完了確認済み mapping の final snapshot は PID owner 判定から外す。
5. 「RDC再起動なし・同一generation・PID再利用」の validation case を追加し、旧 ID から `read_process_output` / `force_terminate` を呼ばないことを確認する。

## Direct regression review

R5 の combined output 契約と R6 の generation change 処理には、
R7 を除いて source finding に対する直接回帰を確認しなかった。
RDC 再利用方針も維持されている。

## Validation

reviewed HEAD `75c50f61ae2855817aacebe739e8e731e7c64f1e` で reviewer が次を実行した。

| command | result |
| --- | --- |
| focused markdownlint (2 design files) | pass、0 issues |
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
R5/R6 修正差分由来の markdownlint finding はない。

レビュー途中で RDC remote 接続が一時的に offline 表示となり tool call が失敗したが、
FA780 復帰後に同じ evidence directory から各コマンドの exit/result を回収した。
別環境や別HEADの結果へ置き換えていない。

## CI

GitHub connector で reviewed HEAD の workflow run と combined status を確認したが、
どちらも 0件だった。
別 SHA の run は代用していない。
したがって reviewed implementation HEAD の exact-HEAD CI は **未確認** とする。

## Coverage dispositions

- requirement/design conformance: checked_finding — R7
- correctness/edge cases: checked_finding — same-generation PID reuse
- scope discipline: checked_no_finding
- changed files/direct dependencies: checked_finding — RDC 0.2.50 PID-keyed session modelを照合
- API/data/config/workflow compatibility: checked_no_finding for R5 contract; R7 affects process identity
- error handling/failure diagnostics: checked_finding — current-owner invalidation不足
- security/secret handling: checked_no_finding
- tests/validation adequacy: checked_finding — same-generation PID reuse case不足
- current-HEAD CI: held — matching evidenceなし
- report/documentation accuracy: checked_no_finding
- regression/maintainability: checked_finding — R7

## Verdict

判定は `fail`。

RDMCP-R5 と RDMCP-R6 は resolved だが、
RDMCP-R7 (High) が残るため PR #1 の設計レビューは通過しない。

## Remaining risks / next action

- R7 の current-owner / PID reuse 規則を設計する。
- 修正後、この通常レビューチャットで R7 の fix verification を行う。
- exact-HEAD CI は新しい PR current HEAD に一致する run だけを使用する。
- merge は行わない。
