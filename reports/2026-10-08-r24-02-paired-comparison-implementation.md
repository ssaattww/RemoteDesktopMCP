# Sub-agent実行レポート

## タスク

- 目的: R24-02の対象変更2ファイルと未変更対照を、固定した基準commit・候補commit間で同一Windows job内に比較する測定経路を実装する。
- タスク種別: implementation
- task ID: R24-02-C
- target: `ssaattww/RemoteDesktopMCP` PR #76
- branch: `issue-24-r24-02-post-split-main`
- starting HEAD: `6ea1ca5636d909b32fad6199c034b9b1894fef34`
- baseline: `5dac2528e80cba3e3ff5c855f14420075b2da717` (PR creation base)
- candidate under measurement: `6ea1ca5636d909b32fad6199c034b9b1894fef34`
- purpose: isolate the candidate's two fixture-test path changes from the PR-creation base using 29 same-content controls. This comparison does not attribute an effect against current main `d6688b64da23abe5eed03f61b4ca224426fe0212`; current-main and post-integration evaluation remain separate and pending.

## sub-agentを使う理由

- 理由: 承認済み要件から比較runner・workflow・その契約試験を一つの実装単位として作り、実装者自身とは別の親が差分と結果を統合する。

## 対象範囲

- 変更対象: `.github/workflows/test-runtime-measurement.yml`、新規 `scripts/ci-test-paired-comparison.mjs`、新規 `test/ci-test-paired-comparison.test.ts`。
- 変更対象は `test/config-transfer-integrity.test.ts` と `test/session-filesystem-lifecycle.test.ts`。
- 両commitの追跡test inventoryは31件で一致し、候補のpath変更は対象2件のみ。残り29件は同一内容の対照として同じWindows/Node 22 job内で測る。
- 各fileは基準→候補、候補→基準、基準→候補の3組。全sample・平均・中央値・範囲・control調整後改善率を成果物に残す。
- test tree以外の実行・依存・workflow・設定pathに差分があればfail closedにする。現在のbase/candidate間では設計・報告・task trackingのみ文書差分として許し、`package-lock.json`のbyte一致を必須にする。
- 基準はPR作成時のbaseであり、current main `d6688b64da23abe5eed03f61b4ca224426fe0212`との因果比較ではない。current-mainとの差と別統合後評価は未確認として残す。

## 対象外

- 製品コード変更、実行時間manifestの生成/適用、追加依存、認証・権限変更、workflowの認証拡張。
- 新規PR作成、PR #76のmerge、Issue/PRへの投稿、commit/push、Windows計測workflowのdispatch（これらは親が実装レビュー・build確認後に行う）。
- 無関係なR24 task、他PR。対象外の追加test差分はなく、`test/operation-audit-details.test.ts`を含む残り29件は対照。

## Dispatch profile

<!-- Parent-owned. Child must not change this section. -->

- selection inputs: task_kind `implementation`; work_class `bounded_technical`; uncertainty `medium`; change_radius `cross_module`; criticality `ordinary`; repetition `single`; decomposability `sequential_dependencies`; context_need `bounded_history`。
- selection source: explicit user preference in this Issue #24 workflow.
- decomposition policy / disposition: one implementation unit; no parallel decomposition because workflow/script/test share one contract.
- requested profile: `gpt-6-luna`, reasoning `medium`; fork `all`.
- role plan: collaboration call supports explicit model/reasoning, no `agent_type` field; role effect must be preserved as unverified if runtime does not expose it.
- approval: no Sol `xhigh`/`max` or Astra proposed; no approval requested.

## 実行コマンド

- TDD Red: `node --import tsx --test test/ci-test-paired-comparison.test.ts`（新規テストのみ作成しrunner未作成の状態）。`ERR_MODULE_NOT_FOUND`で終了コード1。対象runnerモジュールが未実装であることによる実失敗を確認。
- 先行実装時のTDD/validation記録は下記初回実装時の証跡として保持する。修正後の再検証値は、この節末尾に別記する。
- 修正後 focused contract: `node --import tsx --test test/ci-test-paired-comparison.test.ts`。6件成功、失敗0、終了コード0。一時symlink `/tmp/rdmcp-issue24-public/node_modules`から既存 `/workspace/RemoteDesktopMCP-issue24/node_modules`を参照した。symlinkは後続validation後に除去した。
- 修正後 scheduler invariants: `node --import tsx --test test/ci-test-scheduler.test.ts`。19件成功、失敗0、終了コード0。同じ既存locked依存symlink経由。
- 修正後 `npm run check` と `npm run build` はどちらも終了コード0。Linux x86_64、Node v24.19.0、npm 11.9.0、同じ既存locked依存symlink経由。
- 修正後 `npm run lint` は終了コード0（ESLint成功、markdownlint 156ファイル/0 issue、設計用語lint成功）。初回の未承認語句は設計文を日本語化して解消。
- `git diff --check` は終了コード0。
- 基準差分照合では全repo変更path 9件（reports 5、tasks 2、対象test 2）、test変更は対象2件のみ、追跡inventory 31件、control 29件、実行面の変更2件のみ、package-lock内容一致、全control blob一致を確認。
- 検証環境は`Linux x86_64`、Node `v24.19.0`、npm `11.9.0`。Windows/Node 22のworkflow runnerではなく、Windows動作を検証したとは扱わない。全試験は未実施。
- 初回実装の履歴ではbaseを`d6688b64...`としていたが、通常reviewのNR-001を受け、比較意図に一致するPR作成時baseへ修正した。初回baseの過去実測は今回の比較根拠に使わない。
- リモートworkflow/Actions測定、GitHubへの書込、commit/pushは未実施。

## 対象ファイル

- `.github/workflows/test-runtime-measurement.yml`: manual dispatchの入力を追加し、既定値を従来の`individual`に設定。paired modeだけ全履歴checkoutと専用runnerを選択し、既存個別測定・label起動の動作とread-only権限を維持。paired成果物は成功・失敗いずれでもuploadする。
- `scripts/ci-test-paired-comparison.mjs`（新規）: PR作成時baseと候補の完全SHAを固定し、test inventory・対象のみのtest path差・test blob・全repository execution/runtime path・lock bytes・環境をfail-closed検証する。実行面の許可差分は対象test 2件だけで、文書根は`doc/`、`reports/`、`tasks/`。baseline/candidate detached worktreeでそれぞれ`npm ci`を完了してから、対象2件と同一内容control 29件を同じWindows job上で各3組、B→C/C→B/B→C順に実行する。各実行のJSON、stdout/stderr、生ログ、状態、終了値、時刻、単調経過、run/job・driver/tested commit・runner/Node/npm/lock情報を保存。各sideの平均/中央値/min/max/range、各組のdelta/improvement%、それぞれの平均/中央値、control fileごとの改善率分布（平均/中央値/min/max/range）、およびcontrol調整後target改善率をsummaryへ記録する。manifestは生成・適用しない。
- `test/ci-test-paired-comparison.test.ts`（新規）: 固定SHA、inventory 31/control29、target path変更の完全一致、runtime/source diff fail-closed、順序、paired統計、manual defaultとpaired workflow設定を検査。

## 指摘事項

- Windows固有のworktree作成、`npm.cmd ci`、Windows runner差分はローカルLinuxでは未検証。paired modeのpush/dispatchを親が行うまで実測値や効果は存在しない。
- 設計・task trackingの同期は今回の許可範囲で行い、文書変更のみとした。
- 検証では一時symlinkを作り、validation後にsymlinkのみunlinkした。参照先`/workspace/RemoteDesktopMCP-issue24/node_modules`には変更を加えていない。

## 結果

- initial ordinary review `R24-02-C-NR-001`の修正として、baselineをPR作成時SHA `5dac2528e80cba3e3ff5c855f14420075b2da717`へ同期。current main `d6688b64da23abe5eed03f61b4ca224426fe0212`との効果主張を明確に否定し、別評価待ちとする。
- 修正後のHEAD/workspace candidateは`6ea1ca5636d909b32fad6199c034b9b1894fef34`。これは測定対象fixture treeの固定candidate commitで、今後のdriver commitとは別識別子である。commit/push pending（親が管理）。
- 修正後validation: paired contract 6/6、scheduler invariants 19/19、`npm run check`、`npm run build`、`npm run lint`、`git diff --check`すべて成功。既存locked依存への一時symlinkから実行し、後でsymlinkだけunlink。package manifest/lockに変更なし。
- 最初のpaired run `37772110573` はsample出力前に失敗。workflow logでは両worktreeの`npm ci`完了後にsummaryのstatusだけが出ており、17 files / 5,724 bytesのartifact `11547828726`（SHA-256 `cb33d1c1fef82a08b07979b184f32ad10aee5b8c81ccba30519b1609f6743878`）が作成された。
- このartifactのblob downloadは2026-10-08 11:52 UTC頃にHTTP 403 Forbiddenを1回受け、再試行していない。summary.errorを読めていないため、runの失敗理由は不明。テストsampleは1件も記録されておらず、測定結果として扱わない。
- 診断修正: 失敗summaryに安全化したerror文字列をstderrへ表示し、summary JSONにも保持。baseline/candidate双方の環境objectを環境一致判定より前にsummaryへ保存する。sanitizerの契約testでcommand label保持、絶対path/credentialの秘匿、出力長上限を確認。
- 診断修正のTDD: `formatFailureDiagnostic`をimportした契約testを実装前に実行し、未exportで失敗（SyntaxError、exit 1）。formatter実装後、paired contract 7件すべてpass（exit 0）。Redはこの未実装exportによる失敗であり、依存環境エラーと区別した。
- 最終修正後validation: `node --import tsx --test test/ci-test-paired-comparison.test.ts` 7/7 pass、`npm run check` pass、`npm run build` pass、`npm run lint` pass（ESLint・markdownlint 157 files/0 issues・design whitelist）、`git diff --check` pass。Linux x86_64 / Node v24.19.0 / npm 11.9.0、既存locked node_modulesへの一時symlinkを利用し、検証後unlink。
- 診断修正はrunまたはartifactへのアクセスを行わずローカルで実装・検証した。GitHub/API/Actions操作、認証やworkflow設定変更、commit/pushなし。
- 再開条件: NR-003の通常fix verification `pass_with_held`を取得済み。driver修正をcommit/pushしexact-head CIを通した後、既存許可範囲のpaired manual runでstderrと両environment objectを確認する。失敗run/artifactの再取得は行わない。
- `R24-02-C-NR-003` P2修正: sanitizerが`Authorization: Basic <credential>`のBasic scheme/credentialを残し、空白を含むquoted/unquoted Windows/Unix絶対pathの一部を表示する懸念に対応。Basic authorization値をschemeごと伏字にし、quoted pathを引用符内全体、unquoted pathを`;`または改行まで安全側に伏字にする。通常のcommand label、既存tokenパターン、500文字上限を保持する契約testを追加。通常reviewerのfix verificationは`pass_with_held`で、NR-003解消を確認。Windows/exact-head CIは引き続きheld。
- NR-003 TDD evidence: test-firstのfocused実行は7件中6 pass/1 fail。失敗は`Authorization: Basic ...`のcredentialが残る回帰で、`dXNlcjpwYXNz-secret-marker`が実際の出力に存在することを確認。sanitizer変更後は同じfocused commandで7/7 pass。quoted/unquotedのWindows/Unix pathケースはユーザー名・空白付きsuffix・`#private-fragment`が残らないことを確認する。
- NR-003後のローカル検証: `npm run check`、`npm run build`、`npm run lint`（ESLint、markdownlint 157 files/0 issues、design whitelist）成功。依存環境は既存locked `node_modules`への一時symlink（`/workspace/RemoteDesktopMCP-issue24/node_modules`）、Linux x86_64 / Node v24.19.0 / npm 11.9.0。symlinkは検証後にunlinkし、target側は変更していない。`git diff --check`も成功。Windows runnerではまだ未実行。通常fix verificationは`pass_with_held`。
- workflow_dispatchのpaired-comparison modeは実装済みだが、Windowsでの実走・測定は未実施。統計の結果に基づく効果判定も未実施。
- 次工程: 親が通常fix verification reportを含む変更をcommitし、PR #76へ通常pushする。そのdriver HEADの必須CI完了後、paired modeの新runを起動する。runnerはPR作成時base `5dac2528e80cba3e3ff5c855f14420075b2da717`と固定candidate `6ea1ca5636d909b32fad6199c034b9b1894fef34`を比較し、workflow起動HEADはdriverとして別記録する。失敗は成功値へ含めず、診断記録で調査する。

## リスク

- GitHub artifact/PR comment読み取りがこのsessionで `401 Bad credentials` を返した。認証情報は変更していない。
- paired Windows measurementはpush後のPR CI完了後に親がdispatchする。未検証のCI/measurementをGreen扱いしない。
