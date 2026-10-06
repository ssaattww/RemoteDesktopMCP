# PR #6 current HEAD 通常レビュー報告

## メタデータ

- Repository: `ssaattww/RemoteDesktopMCP`
- Issue: `#57 Audit Logの拡充`
- Pull request: `#6 Add rejection diagnostics to audit log`
- Review mode: normal review
- Reviewed PR HEAD: `bdb7dd11547c981ef4a8529082072c6e446bb7be`
- Base / current `origin/main`: `5dac2528e80cba3e3ff5c855f14420075b2da717`
- Review date: 2026-10-07
- Merge state at review: `MERGEABLE / CLEAN`
- Verdict: **fail**

この報告は current HEAD `bdb7dd11547c981ef4a8529082072c6e446bb7be` に対する通常レビューである。旧HEAD `d5b193a65016a6404de7931f40e118a454ff0c39` に対する先行レビューは履歴として別報告へ保存済みであり、本判定には代用していない。

## 対象差分

`origin/main` から Reviewed PR HEAD までの差分は4ファイル、186 additions / 3 deletions。

- `reports/2026-09-26-audit-rejection-logging.md`
- `reports/2026-10-06-issue57-pr6-normal-review.md`
- `src/index.ts`
- `test/operation-audit-details.test.ts`

`git diff --check 5dac2528e80cba3e3ff5c855f14420075b2da717 bdb7dd11547c981ef4a8529082072c6e446bb7be` は成功した。

## CI と診断 artifact

Reviewed PR HEAD と完全一致する pull_request CI を確認した。

- Workflow: `lint`
- Run ID: `37545481212`
- `headSha`: `bdb7dd11547c981ef4a8529082072c6e446bb7be`
- Status: `completed`
- Conclusion: `success`
- Ubuntu: lint / type check / build / test 成功
- Windows: assignment job と8 shardの check / build / test がすべて成功
- 同一HEADの診断 artifact: 10件

主なartifact:

- Ubuntu diagnostics: `11450357262`
- Windows shard diagnostics: `11450576795`, `11450741351`, `11450866986`, `11451215617`, `11450826434`, `11450511403`, `11449897998`, `11450751399`
- Test scheduler: `11449927736`

診断workflowは stdout、stderr、テスト結果、環境情報をartifactへ保存する既存構成を維持しており、レビュー開始時の診断artifact要件を満たしている。ユーザー指示に従い、この成功済みexact-head CIを証拠として追加のCI待機は行っていない。

## 旧HEAD findings の再確認

- 旧Blocking finding「current mainとの競合」は、最新main統合により解消済み。PRは現在 `MERGEABLE / CLEAN`。
- 旧Medium finding「任意の `errorName` / `errorCode` を未加工保存」は、固定クラス名と明示allowlist方式へ変更され解消済み。
- 追加テストは任意例外name/codeのsecret sentinel、未知numeric code、既知numeric code、入力検証識別子を検証している。

## Findings

### PR6-NR-CURRENT-001 — Medium — 現行コードで既知の `EBUSY` が安全な `errorCode` allowlistから欠落している

**Origin:** introduced_by_change / requirement completeness

**Location:** `src/index.ts` の `AUDIT_ERROR_CODES`、`persistProtectedConfigIdentities()`、`rememberProtectedConfigIdentityLocked()`、共通tool catch

**Evidence:**

- 新しい `AUDIT_ERROR_CODES` は `EACCES`, `EEXIST`, `ENOENT`, `EPERM` などを許可するが `EBUSY` を含まない。
- 同じ `src/index.ts` の `persistProtectedConfigIdentities()` は `rename()` の `EPERM`, `EACCES`, `EBUSY` を一時失敗として再試行し、20回目まで解消しなければ元の例外を再throwする。
- `rememberProtectedConfigIdentityLocked()` の `transientLinkFailure()` も `ENOENT`, `EPERM`, `EACCES`, `EBUSY`, `EEXIST` を明示的な一時失敗として扱い、再試行期限を超えると元の例外をthrowする。
- これらは `safePath()` 等から呼ばれ、MCP toolの共通catchへ到達し得る。
- `EBUSY` が共通catchへ到達した場合、`auditErrorName()` は通常 `Error`、`auditErrorCode()` はallowlist不一致でcodeを省略する。
- Nodeの `EBUSY: ...` メッセージは既存 `publicMessage` prefix allowlistにも含まれないため、operation detailは `Operation failed.` に一般化される。結果として監査上は実原因 `EBUSY` を識別できない。
- 追加回帰テストには `ENOENT`、任意string code、未知numeric code、`-32001` はあるが `EBUSY` ケースはない。

**Impact:**

Issue #57は拒否・失敗時に原因調査へ必要な診断情報を監査ログへ残すことを目的としている。現行実装自身が明示的に扱うWindows/ファイルシステム系の `EBUSY` が再試行後に失敗した場合、今回追加した安全なcode診断から落ち、`Error` と汎用detailだけに戻る。そのため既知の実運用失敗原因を監査ログだけで識別できない。

**Required action:**

`EBUSY` を安全な固定error codeとして `AUDIT_ERROR_CODES` に追加し、`EBUSY` を持つ例外が共通tool catchへ到達した場合に `errorCode: "EBUSY"` が保存され、任意メッセージ・path・secretは新診断項目へ入らないことを回帰テストで確認すること。

### PR6-NR-CURRENT-002 — Low — 診断helper自体が特殊なthrow値で例外化し、元の失敗監査を失う

**Origin:** introduced_by_change / edge case

**Location:** `src/index.ts` の `auditErrorName()` と `auditErrorCode()`

**Evidence:**

- tool wrapperのcatch変数は `unknown` だが、`auditErrorName()` は複数の `instanceof`、`auditErrorCode()` は `Object.getOwnPropertyDescriptor(error, "code")` を保護せず実行する。
- JavaScriptのProxyは `getPrototypeOf` / `getOwnPropertyDescriptor` trapから例外をthrowできる。
- Nodeで `getPrototypeOf` がthrowするProxyに対して `proxy instanceof AggregateError` を実行すると実際に `instanceof_threw=prototype trap` となることを確認した。
- 同様に `Object.getOwnPropertyDescriptor(proxy, "code")` は `descriptor_threw=descriptor trap` となることを確認した。
- これらhelperは元のtool例外を処理しているcatch内で呼ばれ、helper側の例外を捕捉していないため、その場合は `operation.failed` / `operation.rejected` の監査記録処理まで到達できない。
- 現行テストは通常の `Error` オブジェクトを使うため、この境界はexact-head CIでも未検証。

**Impact:**

通常のNodeエラーでは発生しないが、adapterや将来の依存先が特殊オブジェクトをthrowした場合、診断追加処理自体が元のfailure pathを上書きし、今回の目的である失敗監査を欠落させる可能性がある。

**Required action:**

`auditErrorName()` / `auditErrorCode()` を任意の `unknown` に対して非throwingにし、内部例外時は安全な固定fallbackへ落とすこと。Proxy等で `instanceof` / property descriptor accessがthrowするfixtureを追加し、MCP失敗応答とterminal auditが維持されることを確認すること。

## Required coverage disposition

| Criterion | Disposition | Evidence |
| --- | --- | --- |
| Requirement / design conformance | checked_finding | 既知の `EBUSY` で診断codeが欠落 |
| Correctness / edge cases | checked_finding | 特殊throw値で診断helper自体がthrow可能 |
| Scope discipline | checked_no_finding | current main統合後の差分はIssue #57実装・テスト・報告に限定 |
| Changed files / direct dependencies | checked_no_finding | 現行wrapper / Todo gate / input validation監査を保持 |
| API / data / config / workflow compatibility | checked_no_finding | 公開tool schema変更なし、merge conflict解消済み |
| Error handling / failure diagnostics | checked_finding | `EBUSY`欠落とhelper例外化境界 |
| Security / secret handling | checked_no_finding | 任意name/code sentinelの生保存防止を回帰テスト済み |
| Tests / validation adequacy | checked_finding | exact-head CI成功。ただし `EBUSY` とthrowing Proxy fixtureなし |
| Current-HEAD CI evidence | checked_no_finding | run `37545481212` はReviewed PR HEADと完全一致し成功 |
| Report / tracking / documentation | checked_no_finding | 実装・通常レビュー記録あり |
| Regression / maintainability | checked_finding | code allowlistが同一ファイルの既知retryable codeと不整合 |

## Held / unexplored

- Held: なし。
- live service再起動・実公開接続は今回の通常コードレビューでは実施していない。
- 本レビューでコード修正・mergeは行っていない。

## 判定

**fail**

Medium finding `PR6-NR-CURRENT-001` と Low finding `PR6-NR-CURRENT-002` が残っている。exact-head CIは成功しているが、上記はCIで未検証のコードレビュー指摘である。

## 次のアクション

1. `EBUSY` を安全なerror codeとして扱い回帰テストを追加する。
2. 診断helperを任意のthrow値に対して非throwingにする回帰テストを追加する。
3. 修正を新しいPR HEADへcommit / pushする。
4. 同じ通常reviewerでfindingのfix verificationを行う。
5. CI確認時は修正後current HEADとrun `headSha` が完全一致するものだけを証拠にする。

## Merge boundary

このレビューではmergeを行っていない。required findingが残っているため、現時点ではmerge対象としない。

