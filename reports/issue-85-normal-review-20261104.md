# Sub-agent実行レポート

## タスク

Issue #85 / PR #90 の通常レビュー。

## sub-agentを使う理由

実装者と分離したレビューを実施する。

## 対象範囲

基準 `7e16a666cc30af0f7f58816f38d5459c489a4fd0` から `8cb17c5cbc319df5edb3fecaa3173621981617a7` の全変更、直接依存、承認済み設計、検証記録。

## 対象外

実装修正、マージ、デプロイ。

## Dispatch profile

- selection inputs: review / judgment_heavy / uncertainty medium / cross_module / criticality high / single / fresh
- selection source: user override and sub-agent-task-manager
- observed decomposability: independent_workstreams
- decomposition policy: forbidden; prohibited_by_review_lifecycle; single_agent
- requested: gpt-6.1-sol / high / fork none
- role plan: runtime standard default; spawn schema has no agent_type or role configuration field; no role profile override exposed
- planned runtime profile: gpt-6.1-sol / high
- applied: null
- application status: spawn_succeeded_profile_unverified
- profile observability: final_profile_hidden
- approval: explicit current-task profile; no expensive profile proposed
- Astra: not applicable

## 実行コマンド

実行者は `/root/rdmcp85_normal_review`。指定された work-context-manager、review-worker、report-writer を読み、built-in review behavior による通常レビューを単一担当で実施した。子担当・nested Codex は起動していない。

- 識別・全差分確認: `git rev-parse HEAD`、`git branch --show-current`、`git status --short`、`git log -4`、`git diff --name-status/--stat/--check 7e16a666cc30af0f7f58816f38d5459c489a4fd0 8cb17c5cbc319df5edb3fecaa3173621981617a7`、ファイル別の全差分・本文読取り。
- 指示・依存確認: 対象と上位の指示探索、設計・実装報告・validation/handoff JSON の読取りと構造化照合、認証/CSRF・セッション所有・todoLock・gate・監査・画面取得/送信/再描画・package/tsconfig/CI設定の読取り。
- GitHub読取り: Issue #85、PR #90の本文と双方のコメント、対象SHA指定のworkflow runs、run `41349187431` のjobsをGitHubコネクタで取得。書込みAPIは使用していない。
- 境界再現: `node reference/review-85/reproduce-boundaries.mjs elevated`。製品のビルド済み `userConsoleClientScript` と `applyTodoChanges` / `snapshotTodoItems` を使い、HTTP fetch / EventSourceだけを固定応答にした実Edge描画fixture。最終実行exit 0、ページエラー0。これは問題の再現完了を表し、製品の受入成功を表さない。
- 再現の初回sandbox実行はブラウザー起動30秒timeout。その後の昇格fixtureでページを同じJS contextへ再設定した回は `__name` 再宣言で失敗したため、別ページ世代へ移すfixture修正後に再実行した。製品コードは変更していない。初回環境制約とfixture失敗を最終成功へ上書きしていない。
- 最終同一性確認: `git diff --quiet HEAD -- src scripts test doc/design` はexit 0、HEADは開始時と同一。管理2ファイルと通常報告3ファイル以外の製品差分なし。`reference/review-85` は既存ignore対象。

この担当は既存check/build/lint/関連120件を重複実行していない。検証専任が同じ実行ツリーで行った結果は [検証報告](issue-85-review-validation-20261104.md) と `../evidence/issue-85-validation-20261104-*.json` / stdout / stderrを参照した。

再現の一次記録は実行ツリーの `reference/review-85/boundary-elevated-result.json`、同名stdout/stderr、`reproduce-boundaries.mjs`、`boundary-source.json`。sandbox記録は `boundary-result.json`、中間fixture失敗は `boundary-elevated-harness-failure.json` に保持した。source manifestは対象SHA、実行場所、依存再利用、fixtureの合成範囲と製品src/dist・fixture・結果のSHA-256を記録している。これらはローカル診断資料であり、公開CI artifactと区別する。

## 対象ファイル

固定範囲の変更14ファイルを確認した。

| 分類 | ファイルと確認内容 |
| --- | --- |
| 共通処理 | `src/shared-todo.ts` 全文。スキーマ、旧形式正規化、親先行/兄弟順、循環/深さ、集計、逐次検証と非破壊更新、制約例外の安全な識別 |
| サービス/MCP | `src/index.ts` 全差分と直接依存。todoSnapshot/Get/Update、登録スキーマ、todoLock、session、gate、tool wrapper、監査/停止との関係 |
| HTTP/SSR | `src/user-console.ts` 全差分と認証middleware・CSRF・所有確認・Todo各route。SSRの親先行描画、選択肢除外、エスケープ、携帯幅CSS |
| ブラウザー | `src/user-console-client.ts` 全差分とTodo処理全体、manual refreshとの接続、離脱/認証終了/復帰処理。親選択・展開状態・競合・削除済み入力・応答中の追加入力・フォーカス |
| テスト | `test/shared-todo-hierarchy.test.ts` 全文、`test/issue-56-shared-todo.test.ts` と `test/user-console-client.test.ts` の全差分および既存fixture/直接回帰範囲 |
| ブラウザー検証 | `scripts/verify-shared-todo-ui.ts` 全文。実createApp、認証、一時service、320/1280幅、折り畳み、子追加、親変更中の本文/選択保持、cleanupと結果保存 |
| 設計 | `doc/design/shared-todo-and-stale-update-gate.md` の既存契約と追加親子仕様・受入8項目、設計先行/TDD記録 |
| 実装証拠 | `reports/issue-85-subtasks-implementation-20261102.md`、同validation JSON、同handoff JSON。全体失敗・限定成功・CI・指紋・生成時pendingを分離して照合 |
| 追跡 | `tasks/tasks-status.md`、`tasks/phases-status.md` の固定HEAD差分および親所有の今回の未コミット追記 |

直接依存として `src/session-time.ts`、`src/public-auth.ts` / `src/hash-password.ts` の呼出し契約、`src/private-storage.ts` の試験fixture利用、`package.json` / `package-lock.json` / `tsconfig.json`、`.github/workflows/lint.yml`、既存の共有Todo・監査試験を確認した。依存版、認可範囲、CI workflowに今回の製品変更はない。

さらに親所有の [レビュー継続管理記録](issue-85-review-coordination-20261104.md) と [検証報告](issue-85-review-validation-20261104.md) を読んだ。`TODO-HIER-05` / `TODO-HIER-REVIEW` の追記は今回の再開範囲を示し、旧実装時の「レビュー前停止」を履歴として保持している。固定製品HEADへの混入・製品仕様変更ではない。Dispatch profileは親所有として編集していない。

## 指摘事項

### R85-N01 — medium / P2 / required fix: 折り畳んだ親への移動で編集中の行と競合操作が隠れ、入力位置を失う

- origin: 通常レビュー。新しい階層/折り畳み処理が既存の入力・選択保持契約へ与える回帰。
- location: `src/user-console-client.ts:286` の `refreshTodoCollapse`。適用元は `applyTodoSnapshot` の454行目。
- 問題: 親が折り畳まれているかだけで既存行をhiddenにする。編集中/競合中/現在フォーカス中の行にも適用するため、外部からその行を折り畳み先へ移すと、残すべき編集欄と競合解決操作が見えなくなる。直後のfocus復元ではhiddenな欄を再選択できない。
- 再現: 親Pと子Cを作ってPを折り畳む。別の最上位Rの本文を未保存のまま編集中にし、取得待ちの間にRをPへ付け替えた応答を適用する。実EdgeでRの同一textareaと文字列/選択値自体は残るが、描画後 `hidden: true`、`getClientRects().length: 0`、`document.activeElement: BODY`。競合boxは自身のhiddenがfalseでも親行ごと不可視になる。証拠は `boundary-elevated-result.json / browser.reparent_to_collapsed`。
- 影響: 本文の消去ではないが、入力中に編集箇所と競合回復操作が消え、キーボード操作の位置も失う。設計278行目の入力位置/競合操作保持と、既存192行目の同じ欄への復元に反する。
- 必要対応: snapshot適用で現在の編集/競合/フォーカス行が見えなくなる場合の方針を実装する。必要な祖先を開くか編集行を表示しておく等により、入力と競合操作へ引き続き到達でき、同じ欄のフォーカス・選択・画面位置を保持する。意図して行を畳む操作と外部構成反映を区別する。同一画面からの親変更応答、外部親変更、深い祖先、本文/状態/親選択の未保存入力、既存の折り畳み保持を組み合わせて回帰確認する。
- 頻度判断: 実測頻度は不明。共有編集と新機能の通常操作だけで成立し、特殊な破損・障害・極小時間窓を要しないため、1000人全体で月1回程度以上は起こり得ると推定しrequired fixとする。必須の入力位置保持にも不適合。

### R85-N02 — medium / P2 / required fix: 折り畳まれた枝を削除すると、移動先にhidden/削除予定行を選んでフォーカスを失う

- origin: 通常レビュー。新しくhiddenの子行を保持する実装と、既存の削除時フォーカス移動の直接影響。
- location: `src/user-console-client.ts:376`。hidden行を残す新処理は286行目。削除判定/削除順は434〜441行目。
- 問題: 削除時の移動先を `parentElement` の有無だけで選ぶ。旧配列中には不可視の子と、同じsnapshotで後から削除される行が残るため、実際に表示され続ける行を選べない。
- 再現: P→Cと、その後ろの最上位Rを表示し、Pを折り畳む。取得待ち中にPの折り畳みbuttonへフォーカスし、C→Pの順で削除済みの最新応答（残るのはR）を適用する。P削除時に次のCを移動先にするがCはhiddenかつ削除予定で、最終的に `document.activeElement: BODY`、`active_row: null`。表示中のRは存在する。状態文は「次の利用可能な項目へ移動しました」と成功を告げる。証拠は同JSONの `browser.delete_collapsed_branch`。
- 影響: キーボード/支援技術での継続操作が途切れ、実際には行っていないフォーカス移動を読み上げる。設計188行目・192行目の「次項目、前項目、見出し」の復元契約を満たさない。
- 必要対応: 次snapshotで生存する表示可能な行を基準に移動先を一度決め、DOM削除と折り畳み反映の後に移動を確定する。次→前→見出しの順を保ち、hidden/削除予定行を除外する。移動が成功した位置に対応した案内とする。折り畳み枝全削除、複数隣接行削除、最後の行削除、削除済み入力行が残る場合を実描画で検証する。
- 頻度判断: 実測頻度は不明。エージェントが枝の子を整理して親を削除し、その後に利用者が画面を更新する通常の共有利用で起こる。1000人全体で月1回程度以上は起こり得ると推定。明示された削除時フォーカス契約の回帰としてrequired fix。

### R85-N03 — medium / P2 / required fix: 並べ替えた対象項目の更新時刻が進まない

- origin: 通常レビュー、追加設計への適合確認。基準版のmoveにも同じ非更新動作があり、新設計270行目が追加した「親の変更や並べ替えは対象項目の更新として扱う」契約に対応していない点を指摘する。新規回帰であるとは主張しない。
- location: `src/shared-todo.ts:123`〜126行目。reparentでは120行目で更新するがmove分岐はorderだけを書き換える。
- 問題/根拠: `applyTodoChanges`へ更新前時刻 `2026-11-01T00:00:00Z` の項目と、新しいtimestamp `2026-11-04T00:00:00Z` を渡して実際に順序を変えても、対象の `updatedAt` は旧値のまま返る。同じ処理を使うMCP/HTTPのsnapshotにも旧値が出る。証拠は同JSONの `move_timestamp`。
- 影響: 一覧のversion/last_updated_atは進む一方、移動対象の項目更新時刻が不正になり、公開された項目メタデータを使う利用者/エージェントが変更時点を正しく把握できない。子孫本文/状態を維持しながら対象更新として扱う追加仕様の未対応である。
- 必要対応: 実際に並べ替える対象項目の `updatedAt` を操作timestampへ更新する。子孫の識別子・本文・状態・各更新時刻を不必要に変えないこと、失敗batch/409では対象時刻も保存しないことを確認する。同じ位置へのmove等のno-op方針は既存成功契約と整合させる。
- 頻度判断: 実測頻度は不明だが、通常のmoveごとに決定的に生じる。1000人全体で月1回の並べ替えは起こり得るため基準を満たすと推定。追加設計の必須適合としてrequired fix。

重症度の再分類・転記訂正はなし。上記IDとmedium/P2は以後の同一担当修正確認で保持する。

### 修正確認に必要なcompleteness matrix

初回レビューのため、以下はすべて `incomplete / not_implemented`。修正依頼時に各required actionの製品経路、実際に合成されたfixture、固定修正HEADのfocused結果を埋めること。単体の条件式試験だけで画面全体の保持を閉じない。

| ID | required action | production path | actual composition fixture | focused evidence |
| --- | --- | --- | --- | --- |
| R85-N01 | 親変更後も編集/競合/フォーカス行を表示し入力位置を保つ。外部/自身、深い祖先、各未保存欄、既存折り畳み保持を確認 | 未実装 | 実ブラウザーのclient＋共通snapshotを含む再現は本報告にあり。修正後は実createApp/HTTPを通す合成fixtureも必要 | 修正HEADの結果待ち |
| R85-N02 | 生存かつ表示可能な次/前/見出しへ削除完了後にフォーカスし正しい案内を出す。複数削除/最終行/削除済み入力も確認 | 未実装 | 本報告の実ブラウザー再現あり。修正後の合成fixture待ち | 修正HEADの結果待ち |
| R85-N03 | move対象の時刻更新、子孫保全、失敗/競合の非保存を確認 | 未実装 | 共通関数再現あり。MCPまたは実HTTPを含む契約fixture待ち | 修正HEADの結果待ち |

## 結果

**verdict: fail。required fix 3件。** 技術判定は `reviewed_implementation_head: 8cb17c5cbc319df5edb3fecaa3173621981617a7` のみを対象とする。開始/終了HEADは同一で、対象変動によるunstableではない。

### Work contextと独立性

- repository: `ssaattww/RemoteDesktopMCP`、Issue #85 / PR #90、review mode: `initial normal review`。
- branch: `task/shared-todo-subtasks`、base ref: `main`、range: `7e16a666cc30af0f7f58816f38d5459c489a4fd0..8cb17c5cbc319df5edb3fecaa3173621981617a7`。
- reviewer: `/root/rdmcp85_normal_review`。fresh forkで既存実装/修正を担当していない。今回の通常reviewerであり、独立最終reviewerへの再利用は不可。今後の通常findings修正確認はこの担当が継続する。
- execution: runtime_local、Windows FA780、PowerShell、`C:/Users/donabe/Documents/Codex/2026-11-04/task-6/RemoteDesktopMCP`。親が用意した今回の実行用コピー。製品src/scripts/test/doc/designは対象HEADと同一、管理2ファイルと通常報告はdirtyとして分離。既存ソースのreset/clean/stashなし。
- verification_capability: `local_execution_available`。Node.js `24.20.0`、npm `11.19.0`、同lockの既存node_modulesへのjunction、実Edgeが利用可能。package-lock SHA-256は `F153A51E7F8B4592FCEA9B9C6ECFAA4FD3FC9912BCF7D410A54C7FB39829067D`。新規導入・環境設定変更なし。元ツリーは読取りのみ。
- execution_state: reviewed targetはcommitted / pushed、対象CI waitはcompleted。今回の通常報告/管理追記はcommit_pending / push_pending。full_local_equivalence_gateはこの候補で未実施。以前のtechnical HEAD `2a3b6bec2193820ce9fcb56b2b5191959ca744c6` の全体試験失敗を保持する。
- write boundary: この通常報告の子所有欄とignore対象の診断fixture/ログのみ。実装修正・管理2ファイルの編集・commit/push・PRコメント・merge・配置は実施していない。
- persistence: `normal_persistence`、repository_file `reports/issue-85-normal-review-20261104.md`。`reserved_report_paths` はこの通常報告のみ。独立最終の予約ではない。`initial_independent_reviewed_head: null`、closure reviewed HEADなし、`report_attestation_allowed: false`、`report_attestation_head: null`。

### Coverage disposition

| 必須criterion | disposition | 確認/根拠 |
| --- | --- | --- |
| Issue・設計の範囲/契約 | checked_finding | 同一session、単一親、最大8階層/全200件、状態独立、親削除、順序/集計、非永続/非依存制御を照合。R85-N01〜N03 |
| 共通処理の正しさ/境界 | checked_finding | 親先行化・siblings順・逆順集計・再親化の配下深さ・cycle・不正親・200件・batch後半失敗・元配列非破壊を確認。N03以外にrequired findingなし |
| 全変更/直接依存/無関係変更 | checked_no_finding | 14ファイルと上記直接依存を確認。BOM追加は実行/型検査を妨げず、別機能の書換えなし。親管理追記も読取り確認 |
| API/データ/旧形式互換 | checked_no_finding | addのparent省略/null、reparent必須nullable、moveの兄弟基準、全件snapshot、既存平坦操作の互換を確認。UI本文保存は親を送らない |
| 認証/認可/CSRF/秘密/XSS | checked_no_finding | API login/principal、active owner、same-session parent、origin＋CSRF token、MCP session確認。SSR escape、client value/textContent、制約文に利用者本文を混入しない |
| 原子性/版競合/排他/期限 | checked_no_finding | todoLock内でclone検証→保存。失敗/競合時にデータ/version/期限を進めない。折り畳みは非送信。gate・停止・所有境界の経路は維持。関連回帰120件成功 |
| UI階層/構成操作/入力保持 | checked_finding | 階層/親候補/進捗/追加/親変更/解除/兄弟move/展開を確認。構成保存と本文/状態保存を分け、世代で応答中追加入力を保持。hiddenに関わるN01/N02を再現 |
| エラー/診断/回復 | checked_no_finding | TodoValidationError WeakSet判定、HTTP400 applied:false、409最新snapshot、audit_warning applied:true、404/auth/通信失敗/離脱の保持・非再送を確認。N02の成功案内不正はUI findingへ集約 |
| テスト適切性/TDD | checked_finding | design先行とred/greenをsource指紋付き台帳で確認。19件追加と関連120件は一致。N01/N02/N03の組合せ/メタデータassertionが不足し現試験を通過する |
| 現HEADのCI | checked_no_finding | SHA指定queryでrun41349187431 completed/success、jobsを直接取得し10/10成功を確認。PRコメントも対象HEADとの対応を記録。古い実装CI run41346807464とは分離 |
| 報告/追跡の正確性 | checked_no_finding | 旧全体287/282pass/4fail/1skip、限定3pass、生成時pendingと後の公開コメント、Node22 CIとNode24実機を分離。親所有の今回管理追記は旧停止を改竄せず再開を示す |
| 回帰/保守性 | checked_finding | 共通module化とUI親選択/データの分離は妥当。hidden状態と既存フォーカス経路の組合せ不足はN01/N02 |
| 最終候補全体ゲート | unexplored | 親が通常レビュー収束後に実施予定。本担当では未実施、過去の失敗やfocused成功から全体成功を推定しない |
| 実端末操作を含む未実施受入 | unexplored | 既存ブラウザー記録は320/1280レイアウト、collapse、子追加、親変更中入力保持まで。携帯端末相当で本文入力・状態変更・削除を一連で行った新候補の実描画証拠は未取得。fake DOM/API試験をこの受入の代用としない |
| 配置/マージ/再起動/別session引継ぎ/依存制御 | not_applicable | 明示対象外。実行/拡張なし |

### 検証評価と次アクション

今回の専任検証はcheck/build/lintが各exit 0、関連3ファイル120/120成功、exit 0。初回sandboxの `os.userInfo() / uv_os_get_passwd ENOMEM` は試験起動前の環境制約で、同一内容の昇格再実行が成功している。結果は元の実機全体失敗を取り消さない。過去のブラウザー/TDD/全体ログの生データは台帳に埋め込まれた情報と記録パスを確認したもので、元ファイル全件の再hashを本担当が実施したとは主張しない。

次アクションは別実装者によるR85-N01〜N03の修正、各required actionのcompleteness matrixと固定修正HEADのfocused証拠の提出。この同じ通常reviewerがID別に修正と同種の周辺ケース/新規差分を確認する。必須の未実施受入と最終候補全体ゲートは別に完了させ、失敗原因不明のまま成功扱いにしない。収束後の独立最終レビューは別担当が担当する。今回のfailはマージ許可を意味しない。

## リスク

### held / unknown / unexplored

- H85-01 / held、所有者は親の検証管理: 過去の全体4失敗のうちprocess2件は限定再実行で成功したが、全体時だけの失敗原因は不明。native cache2件は基準版でもspawn UNKNOWNを再現している。今回の差分が原因とも、無関係とも断定しない。頻度不明のため製品の新規required findingへは数えず、最終全体ゲートと原因評価に引き継ぐ。成功の代用にはしない。
- H85-02 / held、所有者は親の証拠管理: 古いCI artifact名の別SHA風suffixの意味、branch protectionのrequired-check設定、元PC全診断ファイルの独立再hashは未確定。対象HEAD指定run/jobrecordと通常レビューのcode確認は可能であり、これらをmerge条件充足の証拠には使わない。
- U85-01 / unexplored、所有者は親/検証担当: 最終修正候補の全体ゲートは未実施。以前の287件中4失敗は解消を確認していない。
- U85-02 / unexplored、所有者は親/受入担当: 携帯端末相当の新候補で本文入力・状態変更・削除を含む一連の実描画受入は未確認。既存320px計測の成功範囲を広げない。
- 再現は実Edgeで製品のclient/common codeを合成したもので、HTTP/auth/EventSourceは固定fixture。認可や実ネットワークのE2E証明ではない。それらは実createAppを通る既存試験/専任検証と区別した。診断資料はローカルignore対象のため、親が必要なログ/fixtureを公開範囲に合わせて保全する。
- required fixの利用頻度は計測値がない。各判断は通常機能の成立条件に基づく推定として記載し、実測や発生件数を捏造していない。基準未満と判明した場合の扱い変更には明示的な再分類記録が必要。
- この担当は通常レビューを実施したため独立最終レビューの独立性条件を満たさない。固定SHA以後に製品/設計/管理報告が変われば、その新HEADへ本判定を自動移転しない。

blocked actionなし。自動承認拒否なし。ブラウザーsandbox制約は許可された昇格で確認できた。実装修正・commit/push・PR投稿・mergeはこのレビュー担当の実行対象外として未実行。
