# 小容量ファイル転送の通常レビュー

## メタデータ

- 対象リポジトリ: `ssaattww/RemoteDesktopMCP`
- 対象PR: #30 `小容量ファイル転送を1回のMCP呼び出しで完了する`
- 関連Issue: #29 `ファイル転送のMCP往復回数を削減して高速化する`
- レビューモード: initial review / normal reviewer
- 対象ブランチ: `issue29-transfer-chunk-size`
- base ref: `main`
- reviewed implementation HEAD: `60070033c3ec614d69cdc41e47b02351cb29ab68`
- relevant commits:
  - `faf0a39894b3997923344cc2c20185602773ea9e` 小容量ファイル転送を1回で完了できるようにする
  - `1358107fb5ce71514b152ecf4bb893ee8e842ff0` ファイル転送の単発経路を設計へ反映する
  - `60070033c3ec614d69cdc41e47b02351cb29ab68` 小容量ファイル転送の最適化結果を記録する
- 実行環境: Windows / `C:\Users\donabe\RemoteDesktopWorkspace\RemoteDesktopMCP-pr30-review`
- source state: clean detached worktree
- Node.js: `v24.20.0`
- npm: `11.19.0`
- verification capability: `local_execution_available`
- reviewer: 本チャット。PR #30 の実装・修正は行っていない。

## 目的と範囲

Issue #29 の受入条件、設計、PR差分、関連する転送処理、設定、テスト、workflow、実装レポート、current-HEAD CI を確認した。

主な確認対象:

- `.env.example`
- `src/index.ts`
- `src/remote-auth-cli.ts`
- `test/mvp.test.ts`
- `test/regressions.test.ts`
- `doc/design/functional-requirements.md`
- `doc/design/multi-pc-architecture.md`
- `doc/report/2026-09-30-single-call-file-transfer-optimization.md`
- `.github/workflows/lint.yml`

製品コードやテストの修正は行っていない。

## authoritative requirements

Issue #29 では、MCP tool 呼び出し回数の削減に加え、次を完了条件としている。

- 1 MiB / 5 MiB / 25 MiB の end-to-end 時間、server側処理時間、tool呼び出し回数を計測できること。
- 現状比でtool呼び出し回数が明確に減少すること。
- 完全性、原子性、停止、監査要件を維持すること。
- 実測結果をIssueまたはreportへ残し、削減できた待ち時間を説明すること。

設計では、転送開始・完了・失敗・中断を監査ログへ記録することを要求している。

## 変更内容の確認

実装は次の方針になっている。

- `TRANSFER_CHUNK_BYTES` の既定値を128 KiBから512 KiBへ変更。
- `file_transfer_download_begin(inline=true)` で1チャンク以下を同一tool call内で返却。
- `file_transfer_upload_begin(data=...)` で1チャンク以下を同一tool call内で検証・確定。
- 512 KiBを超える転送は従来のchunk経路を維持。
- uploadの確定処理を `completeUpload` へ共通化。
- 旧クライアントが従来フローを使用できるよう、inline経路は明示指定時のみ利用。

512 KiBのbase64長は699,052文字で、`data` の700,000文字上限内に収まる。実HTTP focused検証でも512 KiB uploadは成功した。

## Findings

### RDMCP-PR30-NR-001 — Medium — 単発downloadで `transfer.complete` が記録されない

- origin: `introduced_by_change`。既存chunked downloadにも同種の欠落があるが、新設inline完了経路も監査契約を満たしていない。
- location:
  - `src/index.ts:906`
  - `doc/design/multi-pc-architecture.md:481`
  - `doc/report/2026-09-30-single-call-file-transfer-optimization.md` の「完全性と安全性」
- description:
  - inline downloadは `item.state = "complete"`、cleanup、terminal保持まで行うが、`transfer.complete` を監査しない。
  - uploadの `completeUpload` は `transfer.complete` を記録している。
  - 実装レポートは単発経路でも「完了監査ログ」を維持すると記載しているため、実装と報告も一致していない。
- impact:
  - transfer lifecycleを監査ログだけで追うと、成功したdownloadが `transfer.begin` のまま終わったように見える。
  - 使用者ログ・監査調査で転送完了を確定できない。
- evidence:
  - focused validationでinline download自体は `complete=true` を返したが、transfer eventは `["transfer.begin"]` のみだった。
  - source横断検索でも `transfer.complete` はupload完了処理にしか存在しない。
- required action:
  - download成功完了処理を共通化し、inline完了と最終chunk完了の双方で `transfer.complete` を記録する。
  - audit内容に `transferId`, direction, sessionId, size, sha256 を含める。
  - inlineとchunked双方について監査ログを確認する回帰テストを追加する。
  - 実装レポートの記述を実際の挙動と一致させる。

### RDMCP-PR30-NR-002 — Medium — Issue #29の1/5/25 MiB実測完了条件を満たしていない

- origin: `coverage_miss`
- location:
  - Issue #29 完了条件
  - `doc/report/2026-09-30-single-call-file-transfer-optimization.md`
  - `test/regressions.test.ts:181-227`
- description:
  - 実装レポートの実績集計は最大16,938バイトの過去24件が対象で、1 MiB / 5 MiB / 25 MiBのend-to-end時間、server側処理時間、tool call回数の実測値がない。
  - レポート自身も、稼働中サービスには未反映であり実運用効果は更新後の再計測が必要と明記している。
  - 新規回帰テストは `InMemoryTransport` と `chunkBytes=1024` を使っており、accepted completion criteriaの性能測定ではない。
- impact:
  - 小容量の単発化は確認できるが、大きいファイルで待ち時間がどの程度削減されるか、Issueで求めた完了証拠がない。
  - 512 KiB化だけで十分か、batch/bulk方式を追加すべきか判断するためのデータが不足する。
- evidence:
  - reviewer focused validationでは512 KiBちょうどのInMemory upload/downloadが成功。
  - 実HTTP localhostで512 KiB inline uploadが成功し、base64 699,052文字、所要1,732 msだった。ただしこれはChatGPT connector/Tailscale経由のend-to-end測定ではない。
  - matching current-HEAD CIは成功しているが、CIもIssueが要求する実運用性能測定を行っていない。
- required action:
  - 1 MiB / 5 MiB / 25 MiBについて、少なくともupload/downloadごとにtool call数、server処理時間、end-to-end時間を計測してreportまたはIssueへ記録する。
  - localhost、MCP transport、ChatGPT connector/Tailscale等、どの区間を測った値か明示する。
  - 実運用経路で測れない段階なら、Issueの完了条件を未完了として残し、完了扱いにしない。

### RDMCP-PR30-NR-003 — Low — 詳細設計のdownload/upload節が単発経路に追随していない

- origin: `introduced_by_change`
- location:
  - `doc/design/multi-pc-architecture.md:407-430`
- description:
  - 同文書の表と直前の説明ではinline downloadとinline uploadを定義している。
  - しかし詳細な「ダウンロード」「アップロード」節では、download_beginがmetadataを返してchunkで本体を送り、upload_begin後にchunkを書いてcommitで検証する従来フローだけを記述している。
  - inline時の本体返却/受信、完了条件、監査、chunked fallbackとの分岐が詳細節にない。
- impact:
  - authoritative design内で概要と詳細がずれ、今後の修正・レビュー時にどちらを契約として扱うか曖昧になる。
- required action:
  - 詳細節にinline条件、返却/入力、検証、完了処理、監査、fallbackを明記し、表・機能要件・実装と一致させる。

## Required coverage

| criterion | disposition | evidence |
| --- | --- | --- |
| requirement/design conformance | checked_finding | NR-001, NR-002, NR-003 |
| correctness and edge cases | checked_finding | inline completion監査欠落。512 KiB境界自体はfocused検証成功 |
| scope discipline | checked_no_finding | PR差分は転送往復削減と関連設計・テスト・reportに限定 |
| changed files/direct dependencies | checked_no_finding | `src/index.ts`、設定、CLI、transfer tests、design/reportを確認 |
| API/config/compatibility | checked_no_finding | inline/dataはoptional、従来chunked経路を維持 |
| error handling/failure diagnostics | checked_no_finding | size/hash/no-replace/temp identity/cleanupの既存保証を維持 |
| security/secret handling | checked_no_finding | 新しいsecret処理なし。root/session/atomic commit境界を維持 |
| tests and validation adequacy | checked_finding | NR-002。focused機能テストは成功 |
| current-HEAD CI | checked_no_finding | run `36632465851`, head SHA完全一致, 全4job success |
| report/tracking/documentation accuracy | checked_finding | NR-001の監査記述、NR-002、NR-003 |
| regression/maintainability | checked_no_finding | upload完了共通化は既存commit処理と意味的に同等 |

## Validation

### 診断workflow

`.github/workflows/lint.yml` に成功・失敗の双方で診断artifactを保存する処理が存在する。

含まれるもの:

- test result
- stdout
- stderr
- lint/check/build/testのresult
- environment情報

Ubuntu/Windows各jobで `actions/upload-artifact@v4` を使用している。

### ローカル検証

対象HEADは全検証前後で `60070033c3ec614d69cdc41e47b02351cb29ab68`、worktreeはclean。

| validation | result |
| --- | --- |
| Issue #29 focused regression | pass |
| `npm run lint` | pass |
| `npm run check` | pass |
| `npm run build` | pass |
| `git diff --check` | pass |
| 512 KiB InMemory inline download/upload | pass |
| 512 KiB actual HTTP inline upload | pass |
| inline download transfer audit | product call succeeds, but `transfer.complete` missing |
| full `npm test` | fail: 97 tests, 95 pass, 1 fail, 1 skip |
| failing `Issue 13` test isolated rerun | pass |

全テストの1失敗は、`Issue 13` 本体のassertion失敗ではなく、test終了後の非同期処理がfixture削除後の `data` を `lstat` して `ENOENT` になったため、Node test runnerが `test/regressions.test.ts` をfile-level failureとして追加計上したもの。

同じ `Issue 13` の単独再実行は終了コード0で成功した。さらに、同じreviewed HEADのCIは全job成功している。したがって、この1回のローカルfull-suite失敗をPR #30の製品回帰とは判定しない。ただし「今回のローカルfull suiteはgreenだった」とは扱わない。

ローカル診断:
`C:\Users\donabe\RemoteDesktopWorkspace\_review_artifacts\pr30-60070033`

### CI

- workflow: `lint`
- run id: `36632465851`
- event: `pull_request`
- head SHA: `60070033c3ec614d69cdc41e47b02351cb29ab68`
- conclusion: `success`

成功job:

- Lint, check, build, and test (Ubuntu)
- Check, build, and test (Windows shard 1/3)
- Check, build, and test (Windows shard 2/3)
- Check, build, and test (Windows shard 3/3)

runの `headSha` とreviewed implementation HEADは完全一致している。

## Held / unexplored

### Held

- ローカルfull-suiteで既存Issue 13のtest終了後非同期処理が1度失敗した。
- isolated rerunとmatching CIは成功。
- PR #30由来の再現証拠がないためfindingにはしない。

### Unexplored

- PR実装を実際の稼働RemoteDesktopMCPへ反映した後のChatGPT connector/Tailscale経由の1/5/25 MiB end-to-end性能。
- これはNR-002の完了条件として実測が必要。

## Verdict

`fail`

理由:

- Medium finding 2件。
- Low finding 1件。
- 特に監査契約の欠落とIssue #29受入条件の未完了は、PRを完了扱いにする前に対応が必要。

## Next action

実装担当へ次を戻す。

1. `RDMCP-PR30-NR-001` のdownload完了監査をinline/chunked双方で修正し回帰テストを追加する。
2. `RDMCP-PR30-NR-002` の1/5/25 MiB測定を実施し、測定区間と実測値をreport/Issueへ記録する。
3. `RDMCP-PR30-NR-003` の詳細設計をinline経路へ同期する。
4. 修正・検証・commit/push後、同じnormal reviewerでfinding単位のfix verificationを行う。

mergeは行わない。
