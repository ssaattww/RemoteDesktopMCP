# Issue #84 通常レビュー指摘修正

## タスク

R84-N01 と R84-N03 の必須受入条件に直接関係する修正。元レビュー対象は `ea5c56337f593615b3ae4f48b40fcf8d60f121fc`。

## sub-agentを使う理由

同じ実装担当が限定された原因と組み合わせを修正し、元の通常レビュー担当が別に確認する。

## 対象範囲

応答待機中の最新選択維持、宣言した所有者・保存範囲内の終了済み履歴の画面導線、その回帰試験と証拠。

## 対象外

頻度不明の任意強化 R84-N02、追加の頻度調査、他作業、マージ。

## Dispatch profile

- selection inputs: review_followup / judgment_heavy / cross_module / criticality high / sequential_dependencies
- selection source: CodexSkill main、同じ実装担当の継続
- requested profile: original gpt-6.1-sol / high / fork none
- application status: reused_existing_agent_profile
- applied profile: null
- runtime profile observability: final_profile_hidden
- role plan: 元の実行時既定を保持。新たなモデル・role・高額設定・Astra の要求なし。
- decomposition policy: forbidden。限定した順次修正を一人が担当。

## 実行コマンド

`review_followup` として、作業前に `whoami` と `git rev-parse HEAD` を確認した。実行者は `fa780\donabe`、端末は `FA780`、Windows / PowerShell、作業場所は `C:\Users\donabe\Documents\Codex\RemoteDesktopMCP`。対象ブランチは `feat/84-todo-history`、開始時と完了時の基準HEADは `ea5c56337f593615b3ae4f48b40fcf8d60f121fc`。Node v24.20.0 と既存依存で実行でき、`verification_capability` は `local_execution_available` である。

指定された `work-context-manager`、`implementation-executor`、`implementation-worker` と通常レビュー報告の全文、直接依存、既存試験、設計を確認した。通常レビューと旧失敗の証拠は読み取りだけに使用した。許可された製品・試験・設計と本報告以外を編集していない。親管理の進捗・通常レビュー報告・調整報告は変更していない。

証拠保存先は `reference/issue84-review-fixes/`。各接頭辞に `.stdout.log` と `.stderr.log` を分け、失敗も保持した。

- `npx --no-install tsx --test --test-name-pattern='R84-N01' test/user-console-client.test.ts`: 実装前4件失敗、終了値1（`red-n01.*.log`）。取得待機・本文読み込み待機の双方で、残る版・範囲外の版を再現した。
- `npx --no-install tsx --test --test-name-pattern='R84-N03' test/shared-todo-history.test.ts`: 実装前1件失敗、終了値1（`red-n03.*.log`）。履歴APIは200だが初期HTMLが404であった。失敗時の入力は `red-source.diff` と `red-inputs.txt`。
- `npx --no-install tsx --test --test-name-pattern='R84-N01|history arrows' test/user-console-client.test.ts`: 修正後5件成功、終了値0（`green-n01.*.log`、最終は `final-n01.*.log`）。
- `npx --no-install tsx --test --test-name-pattern='R84-N03|authenticated HTTP and SSR' test/shared-todo-history.test.ts`: 修正後2件成功、終了値0（`green-n03.*.log`、最終は `final-n03.*.log`）。新試験内で終了後と再起動後を両方検証した。
- 最初の `npm run check` と `npm run build` は型の不一致 `TS2345` で終了値2（`check.*.log`、`build.*.log`）。経路引数の文字列判定を加えてから再実行し、両方終了値0（`final-check.*.log`、`final-build.*.log`）。
- `npm run lint` は修正前後とも終了値0（`lint.*.log`、`final-lint.*.log`）。最終の全体Markdown構文検査は168ファイル、問題0件。
- 設計書を明示指定した `node scripts/check-markdown-whitelist.mjs --files doc/design/shared-todo-update-history.md` は終了値0（`design-terms.*.log`）。構文と差分の最終確認は下記の結果へ集約する。

最初の修正状態は `green-source.json` と `green-source.diff` に保存し、入力指紋は `c7de452c2467162a78b5f1215d162495ec0e28124aa9017bb8f556ad13da710c`。型の入口判定を追加した最終状態は `final-source.json` と `final-source.diff` に保存し、入力指紋は `6b23129c9fc200a987479a5cf7797f594ac3a875b49145fb32fcdfeb2ec38dda`。全製品・試験のTypeScriptと対象設計、依存固定・検査設定の56ファイルを対象とし、親管理の報告・進捗は除外する。未コミット差分を含む入力に結び付けており、基準HEAD単独の検証とは扱わない。

## 対象ファイル

- `src/user-console-todo-history.ts`: 選択版の読み取りを応答反映の直前へ移動。画面離脱の判定や復帰処理は変更しない。
- `src/user-console.ts`: 通常画面の履歴表示を共通の `todoHistoryMarkup` へ抽出。一覧に対象がない場合は共通取得で本人を確認し、履歴だけの画面を返す。開始日時・作業場所・用途は合成しない。
- `test/user-console-client.test.ts`: 実際の `userConsoleClientScript` を使う遅延取得・遅延本文の4つの回帰。要求後の前後移動、版残存・範囲外、未送信入力と現在版の不変を検証。
- `test/shared-todo-history.test.ts`: 終了済み対象と501件の別接続、再起動前後を実HTTPで検証。本人のAPIと初期HTML、別人・未知IDの拒否、監査と接続の不変、不明な属性を表示しないことを確認。
- `doc/design/shared-todo-update-history.md`: 応答反映時の最新選択、一覧500件と履歴の所有・保持範囲を分ける画面契約を追記。
- `reports/issue-84-review-fixes-20261108.md`: 指定された子担当欄だけを記入。親のDispatchと見出し順は保持。

`src/admin.ts` の一覧上限、`src/index.ts` の履歴認可・保存形式、依存・設定、R84-N02の復帰処理は変更していない。

## 指摘事項

全指摘の重大度は P2 を保つ。採否は重大度と別に記録する。実運用の母数・頻度資料がないため、いずれも頻度は `unknown`。「1000人の利用全体で月1回程度以上」を満たすとは断定せず、再現試験の件数を発生頻度へ読み替えない。

R84-N01 / P2 / `required`: 履歴更新の要求を送り、取得または本文読み込みを待つ間に矢印で別版を選ぶと、要求開始時の版へ戻る。読み進めていた本文・状態が意図せず切り替わる影響がある。発生条件は遅延中の矢印操作であり、運用頻度は不明だが、元設計の「選択済みの版が残る場合は選択を保つ」への直接の不一致であるため必須修正。原因は非同期処理前の選択保存であり、取得と本文読取の両方を終えた後の選択に変更した。兄弟ケースとして、残存版と範囲外の版、前後の往復、現在の未送信入力と版の不変を検証した。

R84-N03 / P2 / `required`: 実行中の対象がなく、その成功履歴の後に501件の別接続が監査へ記録されると、20,000件の索引・対象の最新50件に履歴が残っていても、一覧500件から落ちて画面が404となる。MCPと履歴APIでは読める本人履歴を画面で読めない影響がある。接続蓄積に依存し頻度は不明だが、宣言した保持範囲で終了後も画面から履歴を確認する元の必須受入条件への直接の不一致であるため必須修正。原因は一覧の表示範囲を詳細画面への入口条件にもしていたことである。一覧外の場合は同じ `todoHistory` で認可し、履歴だけを表示する。不明な開始日時や属性を作らず、別人・未知IDと現在Todoの拒否、終了・再起動後の読み取り専用を検証した。

R84-N02 / P2 / `held` / 非阻害: 保存された画面への復帰後に履歴更新を受け付けない任意強化である。頻度は不明で、利用全体の月間基準を満たす根拠はない。親が元必須受入への直接の不一致とは採用しない方針を指定したため、今回の修正対象にせず追加の頻度調査も行わない。重大度を下げたり、修正済みとしたりはしない。

## 結果

要求された実装経路と実際の組み合わせを次のとおり検証した。状態は実装とfocused試験の結果であり、同じ通常レビュー担当による閉鎖確認は親の後続工程である。

| 指摘・重大度 | 必須対応 | 製品経路 | 実際の組み合わせ試験 | focused証拠 | 状態 |
| --- | --- | --- | --- | --- | --- |
| R84-N01 / P2 | 応答反映時の最新選択を保つ | `initializeTodoHistory` の取得・本文読取完了後の選択取得 → 版照合 → 表示。生成は `src/user-console-client.ts` の実スクリプト | 遅延取得と遅延JSONの双方で、要求後に前→後→前と操作し、版1が残る応答を適用。未送信入力・現在版・状態も不変 | `red-n01.*.log`: 4件失敗。`final-n01.*.log`: 新4件＋既存矢印1件の計5件成功 | 修正・focused成功、閉鎖確認待ち |
| R84-N01 / P2 | 最新選択が範囲外なら通知して最新記録を選ぶ | 同じ応答適用処理の不一致分岐と通知 | 同じ実生成スクリプトで待機中に選んだ版1を応答から除外し、版3と範囲外通知、矢印の端を確認 | `final-n01.*.log` の `retained=false` 各待機2ケース成功 | 修正・focused成功、閉鎖確認待ち |
| R84-N03 / P2 | 一覧外でも同じ所有・保存範囲で画面を返す | 認証済み `GET /user/sessions/:sessionId` → 一覧外 → 共通 `todoHistory` → `todoHistoryMarkup` → 初期HTML。通常画面も同じ表示関数 | 終了して実行中一覧から削除した対象＋501件の別接続、同じ保存先から再起動したサービスを実HTTPで照合。APIは1版・索引切り捨てなし、画面の埋め込み履歴はAPIと一致。実生成スクリプトを含む | `red-n03.*.log`: API200・画面404で失敗。`final-n03.*.log`: 新試験と既存認証・通常SSRの計2件成功 | 修正・focused成功、閉鎖確認待ち |
| R84-N03 / P2 | 他人・未知IDを拒否し、状態や監査を変えない | 同じ共通認可の失敗は404。履歴専用画面は現在Todoや推測の接続属性を作らない | 再起動前後で本人API/画面200、他人と未知IDの両経路404、現在Todo404。監査ファイルと接続Mapの前後一致、接続0件、不明な開始日時・作業場所を表示しないことを確認 | `final-n03.*.log` の新規実HTTP試験成功 | 修正・focused成功、閉鎖確認待ち |
| R84-N02 / P2 | 今回は必須対応なし | 保存画面からの復帰処理 | 元レビューの再現証拠を保持し、今回の追加試験・製品変更なし | 通常レビュー報告と元の `ui-reproducer.*` | `held`、非阻害、頻度不明 |

最終のcheck・build・必須lintはすべて終了値0。設計・本報告の明示指定Markdown構文検査、設計の用語検査、最終 `git diff --check` の結果は同じ保存先の `final-focused-md.*.log`、`design-terms.*.log`、`final-diff-check.*.log` に保存する。用語検査の対象外である本報告への追加の厳格検査は `skip` とし、設定変更は行わない。

コミット・送信・統合は行っていない。全面検証とCI待ちは未実施であり、focusedの成功を全面成功や独立レビューの判定へ読み替えない。

## リスク

R84-N02 / P2 は頻度不明の非阻害の保留のままであり、保存画面からの復帰に関する追加強化は含めていない。発生頻度の実測や長い調査は行っていない。

実際の生成スクリプトは試験のDOMで実行し、画面の所有境界は実HTTPと初期HTMLで検証した。実ブラウザーの保存画面・画素描画や運用頻度を検証したとは主張しない。Windows / Node24での局所検証であり、後続の全面検証・対象HEADの公開検証・同じ通常レビュー担当の閉鎖確認は親に残る。

一覧の500件上限は維持する。一覧外の既知の詳細URLは共通の履歴認可が成功する場合に履歴だけを表示し、開始日時・用途・作業場所のない対象を通常接続として復元しない。導入前、保存未確認、最新50件・監査20,000件の範囲外など、既存設計の履歴不足の制約は変えない。

## V84-01 全体検証後の契約試験整合

本節は上記の実装・局所検証履歴に追加する後続記録である。元の重大度はすべてP2のまま、親から通知された通常レビューの後続結果は `0309e0b` に対して `pass_with_held`、R84-N01とR84-N03は `closed`、R84-N02は `held`・非阻害である。過去の閉鎖確認待ちという記述は当時の記録として残す。本節でそれらの重大度や採否を変更しない。

最終候補 `75fb1d16ee784829f772c0907204f11574ae4e01` に対する全面ゲートは、305件中302件成功・2件失敗・1件skip、`npm test` 終了値1であった。`test/tool-root-contracts.test.ts:162` の公開ツール契約では期待一覧に `todo_history` がなく、`test/search-process-lifecycle.test.ts:145` では `killed.state` が許容状態であるという条件に失敗した。この初回結果は `reference/issue84-full-gate/results.json` と `test.stdout.log` に保持しており、本節の成功結果で上書きしない。

親が取得したCIの証拠も、`ea5c563` の実行42434947724と、同じ候補 `75fb1d16ee784829f772c0907204f11574ae4e01` の実行42436335657について、UbuntuとWindowsの区画4で同じ期待一覧漏れを示す。証拠は `reference/issue84-full-gate/prior-ci-ea5c563-failed.log` と `ci-75fb1d1-failed.log`。同候補のCIではプロセス試験の失敗表示がないと親から通知されたが、それを理由にローカル初回失敗を否定しない。

V84-01の発生条件は、新しく公開した `todo_history` を登録した一方、公開一覧・注釈の必須契約を検証する期待一覧を更新していないことである。影響は必須ゲートの失敗と、この新ツールの公開契約を当該試験で網羅できないことである。運用頻度は `unknown` とし、「1000人の利用全体で月1回程度以上」を満たすとは断定しない。今回は利用頻度の推測ではなく、必須の公開ツール契約に直接関係する検証不足の整合として採用した。

変更した試験入力は `test/tool-root-contracts.test.ts` の `expected` へ `todo_history: [true, false, false]` を1項目追加しただけである。製品の登録・認可・注釈・OAuthメタデータ・操作説明要件を変更していない。公開一覧の完全一致、全ツールの注釈、OAuthの両メタデータ、必須 `comment` の既存assertionはすべて保持した。既存のプロセス試験も変更していない。

| 必須対応 | 製品登録（変更なし） | 実際の組み合わせ試験 | focused証拠 | 結果 |
| --- | --- | --- | --- | --- |
| 公開済み履歴ツールを期待一覧へ含め、読み取り専用の注釈を検証する | `src/index.ts:1497` の `todo_history`、`readOnlyHint: true`、`destructiveHint: false`、`openWorldHint: false` | 実際のMCP `tools/list` を認証メタデータの包み込みごと取得。公開一覧の完全一致、全ツールの注釈、OAuth両メタデータと必須commentを従来どおり照合 | 全面ゲート・同候補CIの失敗を正式な実装前証拠とし、`inventory.*.log` で対象1件成功、終了値0 | 1項目追加で局所成功。全面再検証は未実施 |
| 未変更のプロセス試験を単独で1回だけ確認する | 製品処理・`test/search-process-lifecycle.test.ts` とも変更なし | 指定のNR003/NR004の名前だけを単独で選び、実際の検索・Nodeプロセスと監査を従来のfixtureで実行 | `process-single.*.log`、親ケースと子ケースの計2件成功、終了値0、実行回数1 | 単独成功。初回全面失敗の原因・実値は未確定のまま |

検証の保存先は `reference/issue84-tool-inventory/`。各接頭辞に `.stdout.log`、`.stderr.log`、`.result.json` を分け、実行時刻・終了値を保存した。

- `npx --no-install tsx --test --test-name-pattern='published tools explicitly distinguish' test/tool-root-contracts.test.ts`: 1件成功、終了値0、`inventory.*`。
- `npx --no-install tsx --test --test-name-pattern='NR003 and NR004' test/search-process-lifecycle.test.ts`: 単独1回、親子2件成功、終了値0、`process-single.*`。追加の再試験・計測は行っていない。
- `npm run check`、`npm run build`、`npm run lint`: それぞれ終了値0、`check.*`、`build.*`、`lint.*`。必須の全体Markdown構文検査は168ファイル、問題0件。
- 追記後の本報告を明示指定した構文検査と `git diff --check` は `report-md.*`、`diff-check.*` に保存する。設定対象外の報告用語検査は追加せず、設定変更も行わない。

開始時の実行者は `fa780\donabe`、端末は `FA780`、Windows / PowerShell、Node v24.20.0。基準HEADは `75fb1d16ee784829f772c0907204f11574ae4e01` で、開始前の56入力は全面ゲートの指紋 `6b23129c9fc200a987479a5cf7797f594ac3a875b49145fb32fcdfeb2ec38dda` と一致した。修正後の56入力の指紋は `bfe3203634a608f402bd21e721822ce756951f253895be4c6b150eac94e97951`。この中の差分は期待一覧を持つ試験ファイル1件だけであり、製品・プロセス試験・設定・設計は変わっていない。`environment.start.json`、`source-fingerprint.json` と `source.diff` に入力と環境を保持した。親管理の進捗2ファイル、通常レビュー報告の保護用ハッシュも開始時に保存した。

初回プロセス失敗の実値は出力されておらず、単独成功やCIで失敗表示がないことだけで、今回の変更と無関係とも、偶発的な失敗とも断定しない。初回全面ゲート失敗の評価は保持し、原因は `unknown` のままである。任意修正、長時間の原因調査、追加の再試験は実施していない。

本節の局所成功は、旧候補の全面ゲート失敗を成功へ変えるものではない。製品変更、正常レビュー報告や親管理の進捗の編集、依存・設定変更、全面ゲートの反復、コミット、送信、統合は行っていない。次の候補での全面ゲートと同じ通常レビュー担当による確認は親の後続工程である。
