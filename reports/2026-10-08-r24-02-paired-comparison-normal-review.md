# R24-02-C 通常レビュー報告

## 対象

- repository: `ssaattww/RemoteDesktopMCP`
- branch: `issue-24-r24-02-post-split-main`
- base: `d6688b64da23abe5eed03f61b4ca224426fe0212`
- reviewed implementation HEAD: `6ea1ca5636d909b32fad6199c034b9b1894fef34`
- review range: baseから候補HEAD、および未commitのpaired workflow、runner、契約test、design、task tracking、implementation report
- mode: initial ordinary review
- reviewer: `/root/r24_02c_normal_review`（実装担当とは別。独立最終レビューではない）
- verdict: `fail`

## 要件と確認範囲

基準と候補を同じWindows/Node 22 job内で比較し、対象2 test file、共通内容のcontrol 28 file、対象外の既知test差分、順序、実測値、統計、失敗記録を検証する設計を確認した。manifest適用、新依存、権限拡張、PR作成・mergeは範囲外。

確認対象は`.github/workflows/test-runtime-measurement.yml`、`scripts/ci-test-paired-comparison.mjs`、`test/ci-test-paired-comparison.test.ts`、設計書、task tracker、implementation reportおよび直接関連するworkflow metadata処理。repository rootに`AGENTS.md`は見つからなかった。

## 必須coverage

| 項目 | 処置 |
| --- | --- |
| 要件・設計との適合 | `checked_finding` |
| 正しさ・端条件 | `checked_finding` |
| scope・変更ファイル | `checked_finding` |
| 直接依存・workflow影響 | `checked_no_finding` |
| 失敗処理・診断 | `checked_no_finding` |
| 秘密情報・権限 | `checked_no_finding` |
| test・validation | `checked_no_finding`（報告されたLinux検証に限る。Windowsはheld） |
| 現HEAD CI | `held` |
| report・trackingの正確性 | `checked_finding` |
| 回帰・保守性 | `checked_finding` |
| 未調査 | なし（Windows実測・CIは未検証項目としてheld） |

## Findings

### R24-02-C-NR-001 — P2 — 基準と候補の製品コード差分が比較結果を交絡する

- origin: initial ordinary review
- location: `scripts/ci-test-paired-comparison.mjs` のinventory/diff検証（334行付近）
- 内容: runnerは`test/`以下の変更path、control test blob、lockfile byte一致を検証するが、実行コード全体の差分を制約しない。指定commit間では`src/index.ts`も変更されている（`git diff --name-status d6688b64da23abe5eed03f61b4ca224426fe0212..6ea1ca5636d909b32fad6199c034b9b1894fef34 -- src test package.json package-lock.json`）。また`test/operation-audit-details.test.ts`にも別差分がある。
- 影響: unchanged control testsも異なる製品コード上で走る。control adjustmentだけではfixture初期化2変更のruntime effectを帰属できない。
- 根拠: 差分は実装HEAD上で直接確認。別途、PR作成時base `5dac252`から候補への比較では、追跡`src`、`package.json`、`package-lock.json`に差分がないことを親が読み取り確認した（これはレビュー指摘を解消する可能性のある代案であり、基準変更の承認ではない）。
- 必要処置: 意図したfixture変更以外の実行コードが一致する基準を選び、固定SHA・設計・contract test・runnerのfail-closed検証を同期させる。または交絡のない比較方針を定義し検証する。基準SHAの変更はユーザー判断待ち。

### R24-02-C-NR-002 — P3 — task trackingが実装前と記録

- origin: initial ordinary review
- location: `tasks/tasks-status.md`のR24-02-C行
- 内容: workflow、runner、契約test、報告済みlocal validationが存在する一方、進捗欄が「実装前」と記載されている。
- 影響: task状態と実際の作業状態が一致しない。
- 必要処置: 実装・validation済み、レビュー不合格、基準選択待ちとして正確に更新する。

severity reclassification: なし。

## Validation assessment / held

- 実装報告のlocal証拠: paired contract 4/4、既存scheduler workflow invariants 19/19、`npm run check`成功、`npm run build`成功。環境はLinux x86_64 / Node 24.19.0。
- レビュアーはこれらを再実行していない。
- Windows worktree、Windows Node 22、PR exact-head CI、paired measurementは未実施。
- 現在のGitHub APIは`401 Bad credentials`を返し、PR/API読み取り・artifact読取も利用不可。認証設定は変更していない。
- 性能効果・Issue #24完了・3分到達は未認定。

## 次の手順

1. 基準SHAの方針を確定する。候補案`5dac252`への変更をユーザーへ提示済みで回答待ち。
2. `R24-02-C-NR-001`に対し、基準SHAをrunner・design・test・trackerで同じ値へ固定し、実行コードの差分が対象fixture testに限定されることをfail-closed検査する。
3. `R24-02-C-NR-002`を訂正し、レビュー修正を再レビューする。
4. レビュー通過後にbuild・必要なlocal gateを確認し、PR #76へ通常pushする。exact-head required CI成功後に一度だけpaired Windows measurementをdispatchし、artifactと統計を独立検証する。

独立最終レビュー、freeze、attestation、mergeは開始していない。レポート永続化は通常のreview reportであり、attestationではない。
