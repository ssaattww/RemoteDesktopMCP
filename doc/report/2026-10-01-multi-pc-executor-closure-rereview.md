# 複数 PC 実行ノード 通常再レビュー

## 対象

- Repository: `ssaattww/RemoteDesktopMCP`
- PR: #28
- Issue: #25
- Review mode: fix verification
- Reviewed implementation HEAD: `6f4cae8b3df5456463691104962e85bf6c10b3d1`
- Base: `main` / `ef54f7a93dc10bafcd8114f740bdd666f26b0e7a`
- Reviewer continuity: 前回の通常レビューと同じチャット
- 判定: **fail**

利用者の追加指示に従い、同種処理の共通化、actual composition、Issue #25 の本来の完了条件、利用者向け手順まで確認した。

## 前回 finding の closure

### RDMCP-25-DR-001 — High — 解消確認

前回要求した actual composition fixture が追加されている。

`test/multi-pc-mcp.test.ts` の `RDMCP-25-DR-001: download replay survives lost node responses and same-generation reconnects` は、実際の `CoordinatorNodeServer` と `ExecutorNodeClient` を接続し、実行ノードの共通 handler がチャンク状態を更新した後に接続を閉じて node response を失わせる。中間チャンクと最終チャンクの双方で、同じ `executor_generation` による再接続後に未受信の同一 `offset` を再要求し、保持済み応答を回収する。

`src/index.ts` の共通 `executeNodeOperation` 内で `downloadReplay`、位置更新、SHA-256、完了後の終端再送情報を管理しており、同一 `offset` の再送では状態を二重に進めない。

exact-head CI run `36848628110` は reviewed HEAD と一致し、Ubuntu と Windows 3 shard の全 job が success。したがって DR-001 は解消確認とする。

### RDMCP-25-DR-002 — Medium — 解消確認済み

`node_list` の session 前提は設計文書と実装で統一済み。今回の差分でも再発を確認しなかった。

### RDMCP-25-DR-003 — Medium — 解消確認

`src/node-operation.ts` に typed operation registry が追加され、operation 名、capability、入力 schema、応答 schema、監査イベント、session 要否が一元化されている。

`RemoteDesktopService.executeNodeRequest` は `parseNodeOperationRequest` を通して同じ `executeNodeOperation` を呼び、公開 MCP 側のローカル経路も `dispatchNodeOperation` / `executeLocalNodeOperation` を通して同じ共通処理へ集約されている。download に加え upload と process の状態機械も共通 handler 側に移された。

`test/multi-pc-mcp.test.ts` には公開 MCP → 統括ノード → 認証済み node transport → executor 共通 handler の構成試験があり、typed transport 境界と共通 handler の利用を確認している。exact-head CI も success のため DR-003 は解消確認とする。

## 新規 findings

### RDMCP-25-DR-004 — High — 遠隔 transfer / process の公開 MCP mapping が未実装

- Origin: incomplete implementation
- Location: `src/index.ts:1701-1760`
- Authoritative requirement: Issue #25 の目的・要件・完了条件、および `doc/design/multi-pc-architecture.md` の振り分け・公開ID設計

current HEAD では、遠隔ノードを選んだ次の公開 MCP 操作が明示的に失敗する。

- `file_transfer_download_begin`: `Remote download public transfer mapping is not implemented yet.`
- `file_transfer_upload_begin`: `Remote upload public transfer mapping is not implemented yet.`
- `process_start` / `process_status` / `process_output` / `process_kill`: `Remote process public mapping is not implemented yet.`

さらに後続 transfer 操作は現在 `executeLocalNodeOperation` を直接呼ぶため、設計で要求している「統括ノードの公開 `transfer_id` → `node_id` / `executor_generation` / `remote_transfer_id`」の対応表を利用して遠隔ノードへ中継する経路になっていない。process も外部論理プロセスIDと `remote_process_id` の統括ノード側対応表が公開 MCP 経路へ接続されていない。

Issue #25 は ChatGPT から `node_id` を指定して追加PCのファイル操作・プロセス操作を実行できることを完了条件としており、転送開始も `node_id` 対象操作として要求している。したがって共通 executor core が存在しても、利用者が公開 MCP から遠隔 process/transfer を利用できず、Issue の完了条件を満たさない。

Required action:

- 設計済みの公開 `transfer_id` と `remote_transfer_id` の対応表を統括ノードへ実装し、begin 後の chunk/status/cancel/commit を固定済みノードへ中継する。
- 公開論理プロセスIDと `remote_process_id` の対応表を統括ノードへ実装し、start/status/output/kill を固定済みノードへ中継する。
- 公開 MCP adapter は既存の共通 operation core を再利用し、遠隔専用の transfer/process 状態機械を複製しない。
- 公開 MCP → coordinator → node transport → executor 共通 handler を通す remote download/upload/process の actual composition fixture を追加する。
- 未登録、切断、世代変更、session mismatch、結果不明時に公開IDを別資源へ付け替えないことを確認する。

### RDMCP-25-DR-005 — Medium — 複数 PC セットアップ手順が利用者文書へ反映されていない

- Origin: incomplete documentation
- Location: `doc/remote-setup.md`
- Authoritative requirement: Issue #25「セットアップ手順も用意する」、`functional-requirements.md`、`multi-pc-architecture.md`

current HEAD の `doc/remote-setup.md` は Google 認証、Tailscale Funnel、単一 PC の ChatGPT 接続手順のみで、次の複数PC操作が記載されていない。

- executor PC の `node-config init --role executor`
- coordinator 側の `add-executor`
- executor 側の `set-coordinator --psk-stdin`
- `node_list` による追加PC確認
- PSK更新
- 登録解除前の transfer/process 後処理
- `remove-executor` / `clear-coordinator`
- 旧PSK・旧公開IDが復活しないことの確認

Issue #25 はこれらを利用者が実施できる手順の提供まで完了条件に含めているため、実装だけでは完了しない。

Required action:

- `doc/remote-setup.md` に PC追加、PSK更新、登録解除を実際の CLI 名と順序で追記する。
- executor は Funnel を公開しないこと、統括ノードの Tailscale IPv4/MagicDNS を使うこと、PSKを引数へ残さないことを明記する。
- 実装済みの実際のCLIと一致することを確認し、Markdown lint・設計用語検査を通す。

## Finding completeness matrix

| Finding | Required action | Production path | Actual composition fixture | Focused evidence | Disposition |
| --- | --- | --- | --- | --- | --- |
| RDMCP-25-DR-001 High | node response 喪失後の中間/最終チャンク再送 | `src/index.ts` 共通 download state machine | `CoordinatorNodeServer` + `ExecutorNodeClient` の response-loss fixture | exact-head CI success | closed |
| RDMCP-25-DR-002 Medium | `node_list` session 契約統一 | 設計文書 + `node_list` | session 前 `node_list` fixture | exact-head CI success | closed |
| RDMCP-25-DR-003 Medium | typed operation registry / common core | `src/node-operation.ts`, `src/index.ts`, `src/node-transport.ts` | public MCP → coordinator → executor common handler | exact-head CI success | closed |
| RDMCP-25-DR-004 High | public remote transfer/process mapping | **未実装** | **未実装** | 該当なし | open |
| RDMCP-25-DR-005 Medium | 複数PCセットアップ手順 | `doc/remote-setup.md` | 利用者手順の静的整合確認 | 該当なし | open |

## 検証

### current HEAD CI

GitHub Actions run `36848628110`:

- event: `pull_request`
- head SHA: `6f4cae8b3df5456463691104962e85bf6c10b3d1`
- conclusion: success
- Ubuntu `Lint, check, build, and test`: success
- Windows shard 1/3: success
- Windows shard 2/3: success
- Windows shard 3/3: success
- 各 job の `Upload diagnostics`: success
- diagnostics artifacts: 4件、未失効

別SHAの run は判定に使用していない。

### ローカル確認

レビュー開始時に RDMCP で current HEAD と clean worktree を確認し、設計・実装・試験を読み取った。後半に RDMCP `process_start` / file operation が内部失敗する状態となり、RDC も全端末 offline だったため、追加の focused test 再実行は完了していない。これは成功へ読み替えない。

ただし reviewed HEAD と一致する上記 CI が lint / check / build / full test を完了しており、DR-001/003 の fixture は current HEAD の test suite に含まれている。

## Required coverage

- requirement / design conformance: **checked_finding** — DR-004, DR-005
- correctness / edge cases: **checked_finding** — DR-004
- scope discipline / unrelated changes: **checked_no_finding**
- changed files / direct dependencies: **checked_finding** — DR-004
- API / data / configuration / workflow compatibility: **checked_finding** — DR-004, DR-005
- error handling / failure diagnostics: **checked_no_finding**
- security / secret handling: **checked_no_finding**
- tests / validation adequacy: **checked_finding** — DR-004 の公開 remote transfer/process composition fixture 不在
- current-HEAD CI evidence: **checked_no_finding**
- report / tracking / documentation accuracy: **checked_finding** — DR-005
- regression / maintainability: **checked_no_finding** — DR-003 の共通化は改善を確認

## 判定

**fail**

前回の DR-001 / DR-002 / DR-003 は解消確認できたが、Issue #25 の主要利用経路である遠隔 transfer/process の公開 MCP mapping が未実装であり、利用者向け複数PCセットアップ手順も欠落している。

次は同じ通常 reviewer で DR-004 / DR-005 の fix verification を行う。merge は行わない。
