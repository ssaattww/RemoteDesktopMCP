# Issue #70 実装・検証レポート

## 対象

- リポジトリ: `ssaattww/RemoteDesktopMCP`
- Issue / PR: #70 / Draft PR #72
- branch: `feature/issue-70-todo-mobile-refresh`
- base: `main` (`f20c75e1ecd409f0e8573720c0f74b39d8178f93`)
- 作業開始時HEAD: `53bb23a`（PR branch を最新 main へ追従した設計追補）
- 実装方法: TDD。親の通常レビュー初回fail後、R70-N01〜N13を修正。再確認で残ったR70-N03/N06/N09と追加R70-N14/N15も、同一reviewerの指定どおり修正。
- 実行環境: Linux / bash / `/workspace/RemoteDesktopMCP-issue70`。Node.js / npm / Chromium CLI が利用可能。依存・lockfile・権限設定は変更なし。

## 実装内容

- セッション詳細上部の作業一覧を複数行 textarea とし、項目本文・状態・操作を画面幅に合わせて配置。追加/編集/状態変更/削除は既存JSON更新APIを利用する。
- 詳細画面のログ更新が成功したら、新着0件の場合を含め同じセッションの作業一覧を取得する。GETを直列化し、続行中の更新は末尾取得予約へまとめる。失敗時は画面状態を保ち、認証終了・画面離脱では応答と予約を破棄する。
- 更新要求中に追加入力があっても成功応答で消さない。版競合は利用者が最新内容を使うか入力を残すか選ぶまで再送せず、別端末で削除された未保存入力は削除済みの下書きとして保持する。
- 既存のセッション所有・CSRF・版照合APIを継続利用し、既存の強制機能切替経路も維持する。

## TDD と検証

初期実装前の回帰試験は4件中3件が期待どおり失敗し、既存APIの改行契約1件は実装前から成功した。失敗は旧HTML入力欄、詳細更新後の作業一覧取得漏れ、JSON保存操作未配線を示した。

親通常レビューは実装HEAD `1cf1985048ea8006add665948cd1425045ad971a` に対してfailし、R70-N01 (High)〜R70-N13 (Medium)を提示した。修正用回帰を加えてこのHEADを基準にした一時worktreeで選択13件を実行し、**12件fail / 1件pass** を確認した。passした遅延GET破棄以外は、SSR共通構造、競合別状態、世代保護、404終端、監査警告などが実装前に失敗した。修正後、R70-N03/N06/N09/N14/N15を狙った回帰6件は **6件fail / 0件pass** となり、追加fixture試験はOrigin不一致403、クライアント試験は追加競合による誤ブロック、secondary choice disabled、focus消失、古い409 snapshotの適用を検出した。修正後の同じ6件はすべてpass。重点Todo回帰は元の18件に追加6件を加えて24件を確認した。

レビュー指摘の対応:

- R70-N01 High: dirty rowの基準版と最新server snapshotを分離。再解決前の送信を止め、他行の更新応答もdirty rowを競合扱いにする。
- R70-N02 Medium: SSR/動的行で同一の本文label・`.todo-controls`・操作群構造を使用。
- R70-N03 Medium: 行別と追加欄別に最新snapshotと競合選択を保持し、実際の最新本文/状態を表示。追加欄競合は追加だけを止め、別行の編集・削除を許可。自動再送なし。
- R70-N04 High: 本文/状態それぞれの編集世代を送信世代と比較し、元値へ戻す往復編集を保持。
- R70-N05 Medium: 削除済み下書き状態をrequest busyから独立させ、finally後も保存/削除不可。
- R70-N06 High: 追加欄に別の下書きがある場合、削除済み内容の移動に明示的な置換/保持選択を表示し、二次確認ボタンも削除済み行の確認操作として有効化。FakeElement.clickも実DOM同様にdisabled操作を発火しない。
- R70-N07 Medium: GET/PUTの全await後・副作用前に画面世代と認証/離脱状態を再確認。BFCache復帰時にbusyと操作可否を再計算。
- R70-N08 Medium: snapshot順で行を同期し、同じ版の件数/更新時刻/強制状態も反映。
- R70-N09 Medium: snapshotで行を毎回再appendせず、必要な順序変更だけ行う。移動したfocus行のフォーカス、textarea選択範囲/方向、画面scroll位置を保存・復元。focused rowの削除時は次→前→見出しへpreventScrollで移動し、読み上げ状態を通知。
- R70-N10 Medium: 初期/動的/追加欄を2行textarea・8行相当上限の自動伸長に統一し、selectも44px以上に設定。
- R70-N11 Medium: ログ409後にresyncが成功した経路でもTodo GETを一度実行。
- R70-N12 Medium: Todo 404はsession unavailableとして入力を保ち、以降の読書/更新を止める。認証終了状態とは分離。
- R70-N13 Medium: `audit_warning`と`applied`を表示し、適用済み更新を再送しない。
- R70-N14 Medium: fixtureはlisten後に実際のLoopbackポートから `baseUrl` originを設定。通常ブラウザのOriginでログインできることをcreateApp起動の統合試験で確認。
- R70-N15 Medium: Todo版を後退させる競合解決を拒否。遅れて届いた古い409は新snapshotを上書きせず、row/addの競合状態も現在版を維持。遅延409 JSONとversion 3 GETの交差試験を追加。

実装後の最終検証:

- `npm test`: exit 0、250 tests / 239 pass / 11 skip / 0 fail。
- `npm run check`: exit 0。
- `npm run build`: exit 0。
- `npm run lint`: exit 0。TypeScript ESLint、Markdown lint（144 files / 0 issues）、設計文書の日本語whitelist検査を含む。
- `git diff --check`: exit 0。
- 対象回帰: 元のdirty base保持、本文/状態の往復編集、動的行409、追加409後の別行編集/削除、版順序とmetadata、ログ409 resync、Todo 404、離脱/復帰中の遅延GET/PUT、削除済み下書きの二次確認disabled制御、行並替え中のfocus/caret/selection保持、古い409と新GETの交差、fixtureの実Origin login、audit warningを含む。

## 実UIの確認と未完了事項

`scripts/issue70-ui-fixture.ts` が一時データ領域とLoopback限定serverを作り、`createApp`と実user-consoleの認証・SSR・Todo API経路を起動する。実行は `node --import tsx scripts/issue70-ui-fixture.ts`。serverのlisten後、fixtureの `baseUrl` originに実際のポートを設定するため、通常ブラウザのOriginでログインできる。ダミーfixture資格情報で同セッション詳細を開く。実行後はCtrl-Cでserver/dataをcleanupする。認証POST、cookie付き詳細HTTP GET、Todoパネル・2行入力・2項目・共通wrapper・responsive CSSは統合試験で確認済み。

画面幅のviewport計測は未完了。正規cloud browserはlocalhost URLを `ERR_BLOCKED_BY_CLIENT` で拒否したため、別host回避やheadless再試行は行っていない。実画面の320 CSS px/PC幅、改行/長文折返し、操作配置、横overflowは親の正規fixture環境で確認が必要。テストfixture processとtemp directoryは終了・cleanup済み。

初回レビューのfail判定は履歴として維持する。全指摘の修正をpush後、同一通常reviewerによる再確認待ち。マージしない。

## 変更対象

- `src/user-console.ts`
- `src/user-console-client.ts`
- `test/issue-56-shared-todo.test.ts`
- `test/user-console-client.test.ts`
- `scripts/issue70-ui-fixture.ts`
- `tasks/tasks-status.md`
- `tasks/phases-status.md`
- `reports/issue-70-implementation-20261004.md`

## 証拠の状態

- 検証能力: `local_execution_available`
- 検証能力: `local_execution_available`; branch上の修正ソースに対し実行。
- Push: 修正ブランチの最新HEADを通常push済み。PR #72はDraft維持。
- CI: 新修正のpush後にexact-head checksを確認する。
- 独立final review / merge: 未実施。
