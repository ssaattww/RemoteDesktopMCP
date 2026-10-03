# Sub-agent実行レポート

## タスク

- 目的: 通常レビュー所見NREV-56-01〜03の修正をfinding単位で検証し、最新main統合差分がPR #51/PR #60の既存機能を保持していることを確認する。
- タスク種別: 通常レビューfix verification

## sub-agentを使う理由

- 理由: 初回通常レビューを行った同一reviewerが、所見ID・重大度・レビュー履歴を継続して独立検証するため。

## 対象範囲

- 対象: NREV-56-01〜03の必要対応と、それらに関連するproduction composition path/test fixture/focused evidence。最新main `bfe3793309e09acdd180ffe22a4e4a81e87fc668`のmerge delta（PR #51 User Console auto-refresh、PR #60 process context）との共存。変更範囲とvalidation coverageを確認する。

## 対象外

- 対象外: 新しい全範囲の独立review、実装・修正、PR/Issueへの書込み、PR #61のmerge、force-push。

## Dispatch profile

<!-- This section is parent-owned. The child must not infer or rewrite hidden runtime state or authorization evidence. -->

- selection inputs (parent, pre-dispatch): task_kind=focused_fix_verification; work_class=bounded_technical; uncertainty=medium; change_radius=cross_module; criticality=high (session ownership, audit ordering, fail-closed semantics, process termination certainty); repetition=single; observed_decomposability=independent_workstreams (three findings and upstream integration paths have separable inspection areas); context_need=bounded_history.
- selection source (parent, pre-dispatch): `sub-agent-task-manager` / `agent-profile-selection.md`; reviewer continuity owned by `review-enforcer`.
- observed decomposability (parent, pre-dispatch): `independent_workstreams`.
- decomposition policy / disposition (parent, pre-dispatch): forbidden / prohibited_by_review_lifecycle; retain the same reviewer identity and finding continuity.
- proposed profile (parent, pre-dispatch if applicable): none.
- approval status / evidence (parent): original explicit user request is `gpt-6-luna`, medium, `fork_turns none`. Reuse does not select a new profile; preserve original below-floor override evidence.
- Astra eligibility / prior-attempt and blocker evidence / expected benefit (parent, if applicable): not applicable.
- Astra cost notice / baseline / evidence date / unknown actual cost (parent, if applicable): not applicable.
- Astra grant ID / mode / status / explicit approval evidence (parent, if applicable): not applicable.
- Astra task / scope / completion conditions / parent context / agent binding (parent, if applicable): not applicable.
- Astra per-operation ID / work unit / target HEAD / grant usage and pre-submission consumption / outcome (parent, if applicable): not applicable.
- Astra revocation / expiry / invalidation reason and preserved grant history (parent, if applicable): not applicable.
- complete `astra_authorization` schema version 1 extension (parent; not applicable for ordinary non-Astra work): not applicable.
- requested profile (parent, original dispatch): `model: gpt-6-luna`, `reasoning_effort: medium`, `fork_turns: none`.
- agent role / default-role plan (parent): existing reviewer identity `/root/issue56_normal_reviewer`; continuation uses same role context.
- role config evidence / profile effect (parent): no role query available; role and effective profile are unobservable. Preserve original evidence; do not infer application.
- planned runtime profile after known role constraints (parent): inherited/original request Luna medium; actual profile remains unverified.
- applied profile (parent, post-runtime exact evidence only; null when unverified): null.
- application status (parent, post-runtime evidence only): reused_existing_agent_profile; same reviewer resumed by `followup_task`.
- runtime profile observability (parent, post-runtime): continuation succeeded, but final model/reasoning snapshot remains hidden; applied remains null.
- reviewer continuity (parent): reused `/root/issue56_normal_reviewer` from initial normal review; bounded NREV finding closure plus integration delta only.
- fork policy (parent): original `none`.
- reasons / constraints (parent): no new reviewer spawn; preserve finding identity and severity; fill only child-owned report sections; do not implement, write GitHub, push or merge.

## 実行コマンド

- 対象同一性: worktree clean、HEAD 4709fc61c297232008ce3ae164bf1548ed62ab37、branch feature/issue-56-shared-todo。merge parent1 8586650ac48b5fc0da37141eb513a2c6d7a14808（NREV修正）、parent2 bfe3793309e09acdd180ffe22a4e4a81e87fc668（最新main）。今回の検証範囲は前回reviewed HEAD d00909e35028dd7ded72130d317e2d0d41afd60eから今回HEAD、およびmain統合差分。元のIssue #56 baseはc0c786a3d696724d780291aed9c8b89cbe2d531e。
- 実行調査: git status/rev-parse/log/diff、修正commit 8586650のindex.tsとfocused test差分、統合後のuser-console.ts/user-console-client.tsおよびHTTP/client testsの直接関連箇所を確認。テストやlintの再実行なし。
- 提示されたtarget一致ローカル証拠: Issue #56 focused suite 23/23、tsc noEmit成功、統合後npm test exit 0（165 total / 154 pass / 11 skip / 0 fail）、npm run lint exit 0（ESLint、Markdown 105 files/0 issues、design terms）、npm run check exit 0、npm run build exit 0。親提供の実行記録であり、私自身が再実行したとは主張しない。
- exact-head GitHub run 37157521297 はdispatch時点で進行中。Ubuntu lint/check/build pass、Ubuntu test failed、Windows shard 1/3 pass、shard 2/3進行中。失敗diagnostic artifactはForbiddenで取得できず、shard 3/3と最終結論も未確認。成功扱いしない。

## 対象ファイル

- NREV closure: src/index.ts（Todo timestamp validation、tool wrapper processReadException処理、kill applied certainty）、test/issue-56-shared-todo.test.ts（所見別のcomposition tests）、reports/issue-56-implementation-20261003203851.md（修正/検証証跡）。
- 統合差分: src/user-console.ts、src/user-console-client.ts、test/user-console.test.ts、test/user-console-client.test.ts、package.json。Todo panelはsession detailsでsession metadataより前に挿入される。main由来のlist auto-refreshとselection preservation、PR #60のsession/process単位purpose/command表示と既存testsを確認。package.jsonはPR #51/#60のlint対象とIssue #56 design whitelistを併存させる。
- 調査範囲は3 findingの修正と直接関連のmain統合面に限定。

## 指摘事項

- NREV-56-01 (medium): closed。owner/session確認済みprocess status/outputはreceipt audit失敗でも通り、失敗警告を返す。stale時は保存snapshotを返し下流read 0回、fresh時はread可能。通常side effectはgate audit失敗時にfail-closed。processReadExceptionはtodo.gate_allowedを発行しないため、その個別監査失敗は実際には発生しない。fixtureはreceivedとgate eventの両方をfail指定するが、確認できる故障はreceived。
- NREV-56-02 (medium): closed。version>0のtimestampは有限number、非負、現在monotonic値以下を検査。invalid値でfail-closedし異常監査、Todo updateでのみ復帰。version0/null猶予を維持。
- NREV-56-03 (medium): closed。accepted/rejected/timeoutの結果はcommon wrapperのsuccess audit failureでもapplied true/false/unknownを維持し、redispatchなし。
- 新たな直接関連findingなし。重大度再分類なし。

### Finding completeness matrix

| Finding | Required action / production path | Composition fixture and focused evidence | Disposition |
| --- | --- | --- | --- |
| NREV-56-01 (medium) | wrapper receipt handling、todoGate、operation context、process status/output handlerでowner例外を継続、audit_warning表示、staleはsnapshot限定、freshはread可、通常操作はfail-closed | test/issue-56-shared-todo.test.ts: owned process status and output survive receipt-audit failure in fresh and stale states。4 status/output × fresh/stale。stale read 0、fresh read 1、warning true。a failed gate audit prevents dispatching an ordinary side effectも確認。todo.gate_allowedはsafe read pathで発行しない | closed。gate event故障自体は呼び出されないため追加証拠として数えない |
| NREV-56-02 (medium) | todoGateでversion>0 timestamp妥当性を検証しfail-closed、todoUpdateのみで回復 | versioned Todos reject every nonfinite or invalid update timestamp and recover only by updating。production session stateへundefined/null/NaN/±Infinity/string/negative/future相当値を注入し、MCP拒否・異常監査・更新後回復を確認 | closed |
| NREV-56-03 (medium) | process_kill + common wrapperでapplied certainty維持、dispatchを再試行しない | process kill preserves applied certainty across internal and common audit failure combinations。7 ProcessAdapter/audit compositions、terminateCalls=1。実Desktop Commanderではなくfixture | closed |

## 結果

- レビュー種別: 同一reviewerによる通常review bounded fix verification。前回reviewed HEAD d00909e35028dd7ded72130d317e2d0d41afd60e。今回HEAD 4709fc61c297232008ce3ae164bf1548ed62ab37、parent1 8586650ac48b5fc0da37141eb513a2c6d7a14808、parent2 bfe3793309e09acdd180ffe22a4e4a81e87fc668。レビュー中target不変。
- Reviewer continuity/profile: /root/issue56_normal_reviewerとして同一性を保持。元依頼profile gpt-6-luna, medium, fork none。effective role/profileは観測不能で推測しない。
- Coverage: NREV-56-01/02/03 closure=checked_no_finding。Todo panel上部とPR #51 auto-refresh/selection、PR #60 process context purpose/commandの統合=checked_no_finding。直接関連するauth/CSRF/owner/UI merge regression=checked_no_finding。target一致ローカル検証=checked_no_finding（親提示証拠）。exact-head CI失敗diagnosticと最終status=held。実Desktop Commander timeout mapping=held。未探索=なし。
- Verdict: incomplete。3 findingの修正と指定composition testsは確認済みだが、target一致CI runはUbuntu test failedで診断未取得、Windows残shardも未完了。exact-head CI全体の完了・原因判別が必要。
- Severity reclassification: なし。元のmedium identity/severityを保持。

## リスク

- 保留: GitHub run 37157521297のUbuntu test失敗原因はartifact取得Forbiddenにより未確認。Windows shard 2/3進行中、shard 3/3と最終run conclusionは未提示。
- 保留: ProcessAdapter fixtureはtimeout code -32001の共通結果を検証したが、実Desktop Commander adapter/network timeout mappingは未検証。
- NREV-56-01のfixtureはtodo.gate_allowedの故障も設定するものの、processRead例外は当該監査を発行しない。したがって検証した監査障害はoperation.received。これは現在のsafe exception経路の明示的挙動。
- 次の対応: 親がrun 37157521297の最終jobと失敗診断を確定する。原因が製品コードなら新HEADを対象に修正検証する。CI evidenceが成功または原因解消を示したらこのincompleteを更新する。実DC timeoutは利用可能な実環境で別途検証する。

## 2026-10-03 CI修正の同一reviewer検証

### 今回の対象と独立性

- レビュー種別: NREV closure後のCI修正に限定したfix verification。過去の4709fc6判定は削除・上書きせず、その時点でincompleteだった履歴として保持する。
- 今回target HEAD: 84a3abb6a7a043f30694d0079bd6db5cc6421a19。parent: 4709fc61c297232008ce3ae164bf1548ed62ab37。branch: feature/issue-56-shared-todo。作業treeはclean。HEADと親をrev-parseで確認し、target差分はtest/issue-56-shared-todo.test.ts、reports/issue-56-implementation-20261003203851.md、本レポートのみ。src/production code変更なし。
- reviewer identityは/root/issue56_normal_reviewerで継続。元指定profile gpt-6-luna / medium / fork noneを保持。runtime profileと実効roleは観測不能のままであり、null/unknownを維持して推測しない。
- 範囲はCI失敗再現・テスト時計/境界修正・SDK timeout fixture・検証証拠・新HEADのCI状態に限る。前回のNREV-56-01〜03 finding IDsとmedium severityを保持し、再分類なし。

### 確認結果

- CI失敗再現: 親のCI診断記録はrun 37157521297のUbuntu失敗がprocess kill owner-scoped testのretry箇所だけと記録。元のclock固定値123.45で式(123.45 + 2000) - 123.45が1999.9999999999998になることをローカル算術でも確認した。厳密な2秒未満比較で2000ms retryがthrottleされるため、製品codeではなくfloating-point test fixtureが原因という説明と一致する。
- 境界修正: テスト時計を整数10000に固定し、1999msではretryを拒否、さらに1ms経過した2000ms境界でretryを許可する。productionの2秒制限やsrc/index.tsは変更されていない。
- timeout fixture: test/issue-56-shared-todo.test.tsのDesktop Commander SDK request timeout testはMCP SDK Client/McpServerとInMemoryTransportで遅延requestを行い、実SDK RequestTimeout error code -32001を確認する。そのerrorをサービスのDesktop Commander call boundaryへ注入し、process_kill wrapperでtermination_unconfirmed=true、audit_warning=true、applied=unknown、dispatch 1回を検証する。これはSDK error codeとサービスwrapperの組成fixtureであり、実Desktop Commander adapter、実子プロセス、実ネットワークtimeoutを実行した証拠ではない。
- テスト/品質証拠: 親のHEAD一致記録によるとfocused Issue #56 23/23、timeout fixture 1/1、npm run lint exit 0（Markdown 106 files / 0 issues、design-term lint含む）、npm run check exit 0、npm run build exit 0、npm test exit 0（166 total / 155 pass / 11 skip / 0 fail）。レビューでは再実行していない。これらのローカル検証記録は84a3abbに結び付けられている。
- 既存NREV closureの保持: NREV-56-01 (medium) closed、NREV-56-02 (medium) closed、NREV-56-03 (medium) closed。今回の差分はテスト/報告のみでproduction pathを変えず、該当findingを再開する証拠はない。
- 新たなfindingなし。Severity reclassificationなし。

### 今回のカバレッジ処置

- CI failure reproduction / deterministic retry test clock / 1999ms deny / 2000ms allow: checked_no_finding（原因を再現値と比較演算に結び付け、整数時計と明示境界assertionを確認）。
- SDK in-memory RequestTimeout code -32001 / timeout applied unknown / no redispatch: checked_no_finding（SDK-generated timeout errorを用いた実compositionを確認）。
- production source unchanged / 2-second production throttle unchanged: checked_no_finding。
- prior NREV-56-01〜03 identities and severities: checked_no_finding（全件closed mediumを保持）。
- target HEAD local lint/check/build/focused/full npm test evidence: checked_no_finding（提示された実行記録を照合。自ら再実行したとは主張しない）。
- 84a3abb exact-head GitHub CIは後続Windows shard failureで失敗と確定し、その履歴を下記に保持。74923a9 exact-head CI run 37160762875は全job successで完了。
- Real Desktop Commander subprocess/network timeout: held（fixture外）。
- 未探索: なし。

### 新targetのCI状態と判定

- 新HEADに紐付くGitHub Actions run 37159591840を読み取り確認。直近の取得時点でUbuntu jobはlint/typecheck/build/test全てsuccess。Windows shard 1/3・2/3・3/3はtypecheck/build success後、test実行中。workflow run全体はin_progressで最終結果ではない。
- 旧run 37157521297のjobsを再取得: Ubuntu test failure、Windows shards 1/3・2/3・3/3すべてsuccess。旧runは既知の再現可能なfloating-point test fixture失敗を含むため新target CIの代替にしない。
- 84a3abbのコード・focused evidenceから新しいfindingはないが、新run未完了のため今回のverdictも暫定的にincompleteとする。新runの結果が判明した時点でCI証拠を更新する。

### Completeness matrix（CI修正follow-up）

| 対象 | 必要対応 | production/test pathと組成fixture | focused/CI evidence | disposition |
| --- | --- | --- | --- | --- |
| 旧CI失敗の再現修正 | floating-point test timeを避け、境界直前拒否と境界許可を決定的に検証 | process_kill retry test、整数clock 10000、1999ms deny後2000ms allow。production source unchanged | 親提供の旧run diagnosisと今回のtest diff、および算術式の実値を照合 | closed |
| SDK timeout fixture | SDK実エラーcode -32001を生成し、wrapperでunknown/警告/一回dispatchを証明 | Client + McpServer + InMemoryTransport遅延fixtureから得たtimeout errorをDesktop Commander call boundaryへ注入 | timeout fixture 1/1 passの親提供記録。実DC/subprocess/network経路は未検証 | fixture scopeでclosed、実環境はheld |
| 新target CI | 84a3abb一致runの全job結論を確認 | run 37159591840 | 読み取り時点でin_progress、Ubuntu success、Windows 3 shardのtest実行中（typecheck/build success） | held |
| NREV-56-01〜03 | ID/severityを維持して過去閉鎖所見をcarry forward | 前回matrixのproduction paths/composition tests。今回差分はtest/reportのみ | 前回検証済み。今回production変更なし | 全件closed、medium維持 |

### 残るリスクと次の対応

- 新run 37159591840はレビュー時点で実行中。Ubuntuはsuccess、Windows 3 shardはtest実行中であり、最終job結論と新HEAD CI全体の結果は未確認。親が同runを追跡し、失敗があれば診断と別targetのbounded reviewを判断する。
- SDKのin-memory fixtureはSDK RequestTimeout実値を確かめるが、Desktop Commander外部transportが同じエラーへ写像するかは検証しない。実DC subprocess/network timeoutは未検証。
- 次の対応: 新runが全job完了した後、CI結果を本報告へ追記し、成功を確認できた場合に限り今回incompleteを最終判定へ更新する。

## 親による2回目CI失敗の診断・修正

- 対象: run `37159591840` のWindows shard 2/3。failure logはGitHub workflow-job logs connectorで取得。UbuntuおよびWindows shard 1/3・3/3はsuccess。head 84a3abbのsame-reviewer finding closureはNREV-56-01〜03 closed、medium維持、新コードfindingなし。総合verdictはCI未完了によりincompleteだった。
- 診断: `test/regressions.test.ts:933` のNR003/NR004 portable process testが、自然終了後の`process.exit` auditを最大1.5秒（30回×50ms）だけ待っていた。runでは52 tests中51 passし、当該assertionだけ失敗。製品のprocess watcher code pathに対する新たなfindingではなく、Windows shard負荷と固定短期待機の競合。
- 修正: test-only poll budgetを最大10秒（200回×50ms）に変更。status/output polling fallbackなし。Production codeは変更していない。
- 修正後ローカル証拠: 該当NR003/NR004 focused commandは2/2 pass。lint、check、buildもexit 0。full `npm test` は166 tests / 155 pass / 11 skipped / 0 failed。
- 次段階: 親は新しいheadをpushし、同一reviewerの再確認と新head CIの全job完了後に判定を更新する。実Desktop Commander subprocess/network timeout自体は未検証であり、SDK in-memory RequestTimeout fixtureでの境界検証との区別を保つ。

## 2026-10-03 Windows shard wait修正の同一reviewer検証

### 対象と独立性

- レビュー種別: 前回CI修正follow-upのbounded fix verification。同じreviewer identityを保持し、CI run 37159591840の追加失敗、test-only wait増加、および新target CIだけを確認。過去の4709fc6および84a3abb時点の判定は履歴として保持する。
- 今回target: HEAD 74923a938e13ac10ce4dff5095c9c42829ddfea0、親84a3abb6a7a043f30694d0079bd6db5cc6421a19、branch feature/issue-56-shared-todo。treeは確認開始時clean。commit差分はreports/issue-56-fix-verification-20261003220818.md、reports/issue-56-implementation-20261003203851.md、test/regressions.test.ts。src production codeの変更なし。
- Reviewer identity / profile: /root/issue56_normal_reviewerとしてcontinuity維持。元profile gpt-6-luna / medium / fork none。runtime model/roleは観測不能・null相当のまま保持し推測しない。
- NREV-56-01〜03はclosed、original ID/severity mediumを維持し、再分類なし。今回diffで新規コードfindingなし。

### 37159591840の失敗診断と修正レビュー

- Workflow job logをGitHub connectorから取得: Windows shard 2/3 job 111310072979。PR merge-check checkout SHAは6d7ecb1e6f1669e444d387837f507c39d29b59bd（head 84a3abb + base bfe3793）。jobは52 tests中51 pass / 1 fail。失敗はtest/regressions.test.ts:933の NR003/NR004自然終了audit assertion “natural exit must be audited without process status/output polling”のみ。その他の51 testsはpass。run 37159591840ではUbuntuおよびWindows shard 1/3、3/3がsuccess。
- 修正diffはtest/regressions.test.tsのpoll upper boundを30から200へ変更し、固定50ms waitでmax 10sに拡大。production watcher間隔、process handler、audit codeに変更なし。fallback status/output pollingは追加されていない。
- 根本原因説明は対象テストの構造と整合する。自然終了child後のautonomous watcherを最大1.5sだけ待っていたため、負荷が高いWindows shardでeventを観測できない場合がある。10s bounded waitはwatcherが自然にauditする条件を待ち、status/outputからauditを発生させる経路を足さない。レビュー範囲では不要な製品挙動変更や無制限待機を認めない。

### 検証証拠とfixtureの限界

- 親提供のfocused evidence: node --import tsx --test --test-name-pattern='NR003 and NR004: searches return every page' test/regressions.test.ts exit 0、2/2 pass。
- 親提供のtarget 74923a9 local evidence: lint exit 0（Markdown 106 files / 0 issues、terms含む）、check exit 0、build exit 0、npm test exit 0（166 tests / 155 pass / 11 skip / 0 fail）。本レビューではtestを再実行していない。
- 84a3abbから持ち越したIssue #56 timeout fixtureはSDK in-memory client/server transportがRequestTimeout code -32001を生成し、それをDesktop Commander call境界のfixtureへ注入してprocess_kill resultを検証する。fixtureはSDK RequestTimeoutのcodeとRDMCP wrapperのunknown結果の組成を検証するが、実Desktop Commander外部transport、子process、実network timeoutは検証しない。
- issue-56-shared-todoのSDK timeout fixtureとNREV closure pathは今回commitで変更されていない。今回のCI失敗は別の既存regression test wait budgetに限定されている。

### Coverage disposition / closure matrix

| 項目 | 必要条件 | 対象path / fixture | 証拠 | 処置 |
| --- | --- | --- | --- | --- |
| CI失敗の原因同定 | 正確なfail job/logと対象assertionを把握 | run 37159591840 / Windows shard2 job 111310072979 / regressions.test.ts:933 | connector job log: 52 total, 51 pass, 1 fail。UbuntuとWindows shard1/3はsuccess | checked_no_finding |
| 自然終了audit wait修正 | 負荷時も自律watcherだけを待ち、fallback status/output pollingを使わない | regressions.test.ts NR003/NR004: loop 30→200 × 50ms | test diff、親提供focused 2/2 pass | checked_no_finding |
| Production scope | このCI test failure修正でruntimeを変更しない | target diffにsrc変更なし | git show diff/name list | checked_no_finding |
| Issue #56 finding continuity | NREV-56-01/02/03のmedium identityを保持 | 前回closed matrix。今回はtest/report変更のみ | source findingsは再open理由なし | checked_no_finding |
| SDK timeout fixture | SDK request timeout code -32001をwrapperへ渡しapplied unknown/no retry | 84a3abbのin-memory Client/McpServer fixture + injected adapter boundary | 前回fixture 1/1 pass証拠。実DC/networkはheld | checked_no_finding (fixture scope) |
| Target local validation | focused / lint / check / build / full suiteのtarget一致証拠 | HEAD 74923a9 | 親提供記録: focused 2/2、npm test 166/155 pass/11 skip、lint/check/build all success | checked_no_finding (provided evidence) |
| New-head GitHub CI | 最新headの全OS/shardを成功確認 | run 37160762875 | Ubuntu lint/check/build/test success、Windows shards 1/3, 2/3, 3/3のcheck/build/test success。全4 job completed success | closed |
| 実Desktop Commander timeout | 外部transport mappingを検証 | 実DC/process/network | 実行していない | held |

### 新target CI status / verdict

- GitHub commit workflow lookupは74923a938e13ac10ce4dff5095c9c42829ddfea0にPR-triggered run 37160762875を返した。これは新targetに関連付くrunである。
- 最終job state: Ubuntu lint/typecheck/build/test success。Windows shard 1/3、2/3、3/3のcheck/build/test success。全4 job completed success。
- 判定: complete / closed。修正diffに新しいfindingはなく、run 37160762875の全4 job successを確認した。旧run failureは履歴に残す。実Desktop Commander subprocess/network timeoutはfixture外のため未検証riskとして継続。

## KERO-56-001 時計異常後のOFF切替と再有効化の修正検証

### 指摘とRed

- 指摘元: 親keroのPRコメント [5974671360](https://github.com/ssaattww/RemoteDesktopMCP/pull/61#issuecomment-5974671360)。対象既存HEADは `74923a938e13ac10ce4dff5095c9c42829ddfea0`。
- 内容: `todoGate`が強制無効判定前にclock anomalyを拒否し、OFF切替も `performance.now()` 取得に依存するため、異常状態を解除できずOFF自体も失敗し得る。
- Red: 新規3 testを修正前に実行し失敗確認。異常発生後OFF/通常操作、OFF中時計ずれ/再ON、単調時計throw中OFFを対象とする。

### 修正とGreen

- `todoGate`: enforcement OFFを単調時計の読取・時計異常判定より前に成功扱いする。
- `todoSetEnforcement`: OFF遷移では単調時計を読まずに時計異常状態と比較基準を破棄。ON遷移は有限な単調時計の取得に成功した後だけ状態を変更し、`enabledAtMono`と比較基準を再設定する。
- 再ONは切替後5分の猶予を開始し、その後の壁時計/単調時計の乖離を検出してfail-closedする。版番号>0のtimestamp破損検知、owner認可、緊急停止、監査故障時の既存規則には変更なし。
- 設計文書も、OFF中は時計異常を検出・拒否しないこと、OFFで異常記録を解除すること、再ON時に時計基準を再確立することへ同期した。
- 修正後focused: clock anomaly既存2件と切替関連3件で5/5 pass。
- 修正後全体: `npm test` 169 tests / 158 pass / 11 skipped / 0 failed。`npm run lint`、`npm run check`、`npm run build` exit 0。Markdown lintは106 files / 0 issues、design-term lintも成功。
- 同一normal reviewerの限定レビュー: `pass_with_held`、KERO-56-001に新規required findingなし。既存owner、Emergency Stop、監査経路で回帰なし。レビュー記録は `reports/issue-56-normal-review-20261003213135.md`。保留はこの未コミット差分に対するmatching CI。
- 親keroによる独立再確認とGitHub CIは未了。
