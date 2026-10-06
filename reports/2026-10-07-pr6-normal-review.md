# PR #6 通常レビュー報告

## メタデータ

- Repository: `ssaattww/RemoteDesktopMCP`
- Issue: `#57 Audit Logの拡充`
- Pull request: `#6 Add rejection diagnostics to audit log`
- Review mode: normal review
- Reviewed PR HEAD: `d5b193a65016a6404de7931f40e118a454ff0c39`
- Technical implementation HEAD: `ef39dfbd67eb2e99a812a363b19cc2857e265c38`
- Original PR base / merge-base: `865f6cd65763f36e0b48f39e1f3d402e696c8308`
- Current `origin/main`: `5dac2528e80cba3e3ff5c855f14420075b2da717`
- Review date: 2026-10-07
- Verdict: **fail**

この判定は Reviewed PR HEAD に対するものであり、後続修正 HEAD へ自動的には引き継がない。

## 対象差分

merge-base から Reviewed PR HEAD までの変更は次の3ファイル。

- `src/index.ts`
- `test/independent-fixes.test.ts`
- `reports/2026-09-26-audit-rejection-logging.md`

差分規模は 150 additions / 20 deletions。`git diff --check` は成功した。

## CI と診断 artifact

PR current HEAD と完全一致する pull_request CI を確認した。

- Workflow: `lint`
- Run ID: `36246016241`
- `headSha`: `d5b193a65016a6404de7931f40e118a454ff0c39`
- Conclusion: `success`
- Ubuntu: lint / type check / build / test が成功
- Windows: type check / build / test が成功
- 診断 artifact: `10907546986`, `10907193425`, `10907169262`

`.github/workflows/lint.yml` は Ubuntu / Windows の結果、stdout、stderr、テスト結果、環境情報を artifact として常時保存する構成であり、レビュー開始時の診断 artifact 要件は既に満たしていた。ユーザー指示に従い追加のCI待機は行っていない。

分離した review worktree には `node_modules` が無く、同一 HEAD のCIが両OSで全検証成功済みのため、このレビューでは依存導入を伴うローカル `npm test` を重複実行していない。

## Findings

### PR6-NR-001 — Blocking — current main と実装方式が競合しており、この PR HEAD は統合不能

**Origin:** introduced_by_change / compatibility

**Location:** `src/index.ts`, `test/independent-fixes.test.ts`, PR merge state

**Evidence:**

- GitHub の現在状態は `mergeable=CONFLICTING`, `mergeStateStatus=DIRTY`。
- current `origin/main` は `5dac2528e80cba3e3ff5c855f14420075b2da717`、PR の merge-base は `865f6cd65763f36e0b48f39e1f3d402e696c8308`。
- `git merge-tree` で `src/index.ts` の共通 tool wrapper、登録ツール周辺、process 周辺に複数の競合を確認した。
- current main の wrapper は登録ツール名を `rdmcpSetToolName` で取得し、`operation.received / started / succeeded / failed / rejected`、`operationId`、`connectionId`、`sessionId`、`target`、`comment`、`durationMs`、Todo gate、入力検証拒否を統合している。
- PR #6 は旧 wrapper を `this.tool(user, "tool_name", ...)` へ全面置換する方式であり、そのまま片側採用すると current main の監査契約・Todo gate・入力検証拒否処理を失う。
- `test/independent-fixes.test.ts` は current main 側では既に削除されており、追加テストをそのまま統合できない。

**Impact:**

現在の base へそのまま merge できない。競合解消で PR 側の旧構造を優先すると Issue #57 と無関係な現行機能を後退させる危険がある。

**Required action:**

current main を基準に Issue #57 の残差だけを再実装すること。現行の `tool()` / `operationDetail()` / 入力検証監査 / Todo gate / operation metadata を保持し、失敗 catch 経路へ不足する診断情報だけを統合する。テストも current main の現行テスト構成へ移し、新しい review-target HEAD を作成すること。

### PR6-NR-002 — Medium — `errorName` と文字列 `errorCode` が無制限・無秘匿で audit に保存される

**Origin:** introduced_by_change

**Location:** `src/index.ts` の `auditErrorCode()` と common tool catch

**Evidence:**

- `detail` は `auditDiagnosticDetail()` を通り、path、Bearer、credential形式、長いopaque値を秘匿した上で240文字に制限される。
- 一方 `errorName` は `error.name` をそのまま、`errorCode` は string / number をそのまま `audit.jsonl` へ渡す。
- `auditErrorCode()` は文字列長の上限や秘匿化を行わない。
- 追加テストは固定値 `Error` / `EADAPTER` だけを検証し、name/code に secret、path、長大文字列を入れた場合や audit ファイル全体から raw 値が消えることを検証していない。

**Impact:**

adapter や依存先が credential、path、token 相当値、長大文字列を `Error.name` または文字列 `code` に設定した場合、公開MCP応答が generic でも private audit log へ未加工値が永続化される余地がある。PR説明の bounded / sanitized diagnostics という意図とも整合しない。

**Required action:**

文字列 `errorName` / `errorCode` も共通の保守的な正規化・長さ制限・秘匿化を通すこと。secret / path / 長大値を name/code に注入する回帰テストを追加し、`detail` だけでなく `audit.jsonl` 全体に raw 値が残らないことを確認すること。

## Required coverage disposition

| Criterion | Disposition | Evidence |
| --- | --- | --- |
| Requirement / design conformance | checked_finding | current main へ適用不能。bounded/sanitized の残差あり |
| Correctness / edge cases | checked_finding | string errorName/errorCode 境界が未処理 |
| Scope discipline | checked_no_finding | PR自身の差分は実装・テスト・報告の3ファイル |
| Changed files / direct dependencies | checked_finding | current main の wrapper / test 構造が変化済み |
| API / data / config / workflow compatibility | checked_finding | current main の operation audit 契約と競合 |
| Error handling / failure diagnostics | checked_finding | detailのみ bounded/sanitized |
| Security / secret handling | checked_finding | name/code 由来の raw audit persistence 余地 |
| Tests / validation adequacy | checked_finding | exact-head CI成功。ただし name/code の秘匿境界fixtureなし |
| Current-HEAD CI evidence | checked_no_finding | run 36246016241 は Reviewed PR HEAD と完全一致し success |
| Report / tracking / documentation | checked_no_finding | 実装報告は technical HEAD と report commit を区別 |
| Regression / maintainability | checked_finding | current main の新 wrapper を保持した再統合が必要 |

## Held / unexplored

- Held: なし。
- live service の再起動・実公開接続確認は PR 自身の non-goal であり、今回の通常レビュー対象外。
- 修正後の current-main 統合 HEAD のテスト・CIは、その HEAD がまだ存在しないため未実施。

## 判定

**fail**

Blocking finding `PR6-NR-001` と Medium finding `PR6-NR-002` が残っている。

## 次のアクション

1. current main `5dac2528e80cba3e3ff5c855f14420075b2da717` を基準に Issue #57 の残差を再実装する。
2. current main の operation audit、Todo gate、input-validation logging、operation metadata を保持する。
3. `errorName` / `errorCode` に bounded + sanitized contract を適用し、audit全体の回帰fixtureを追加する。
4. 新しい review-target HEAD を commit / push する。
5. 同じ通常 reviewer で findings の fix verification を行う。
6. CI確認時は新しい PR current HEAD SHA と run `headSha` が一致するものだけを証拠にする。

## Merge boundary

このレビューでは merge を行っていない。現 PR は conflict 状態かつ required findings が残っているため merge 対象ではない。

