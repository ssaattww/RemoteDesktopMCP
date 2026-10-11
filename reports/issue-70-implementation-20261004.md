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

- セッション詳細上部の作業一覧を複数行 textarea とし、項目本文・状態・操作を画面幅に合わせて配置。追加/編集/状態変更/削除は既存JSON更新APIを利用する。状態ラベル・select・更新/削除を一列に並べ、タップ高さ44pxと本文相当の文字サイズを保つ。
- 詳細画面のログ更新が成功したら、新着0件の場合を含め同じセッションの作業一覧を取得する。GETを直列化し、続行中の更新は末尾取得予約へまとめる。失敗時は画面状態を保ち、認証終了・画面離脱では応答と予約を破棄する。
- 更新要求中に追加入力があっても成功応答で消さない。版競合は利用者が最新内容を使うか入力を残すか選ぶまで再送せず、別端末で削除された未保存入力は削除済みの下書きとして保持する。
- 強制機能の状態と切替ボタンを同じインライン領域に表示し、既存フォーム・CSRF経路を維持する。追加フォームはaccessibleなネイティブdetails/summaryで初期折りたたみとし、詳細更新後も開閉状態と下書きを保持する。
- 既存のセッション所有・CSRF・版照合APIを継続利用する。

## TDD と検証

初期実装前の回帰試験は4件中3件が期待どおり失敗し、既存APIの改行契約1件は実装前から成功した。失敗は旧HTML入力欄、詳細更新後の作業一覧取得漏れ、JSON保存操作未配線を示した。

親通常レビューは実装HEAD `1cf1985048ea8006add665948cd1425045ad971a` に対してfailし、R70-N01 (High)〜R70-N13 (Medium)を提示した。修正用回帰を加えてこのHEADを基準にした一時worktreeで選択13件を実行し、**12件fail / 1件pass** を確認した。passした遅延GET破棄以外は、SSR共通構造、競合別状態、世代保護、404終端、監査警告などが実装前に失敗した。修正後、R70-N03/N06/N09/N14/N15を狙った回帰6件は **6件fail / 0件pass** となり、追加fixture試験はOrigin不一致403、クライアント試験は追加競合による誤ブロック、secondary choice disabled、focus消失、古い409 snapshotの適用を検出した。修正後の同じ6件はすべてpass。さらに再確認で指摘された `[A,B,C]→[C,B,A]` の中央B移動で、同じindexでもfocus喪失する回帰を単独で再Red（旧処理1 fail / 0 pass）し、実際にfocusされた行をreorder中追跡する修正後は1 pass。重点Todo回帰は元の18件に追加6件を加えて24件を確認した。R70-F01の変更本文/非並替え回帰は修正前に選択位置が末尾37へ移り1件fail、修正後は保存値・focus・選択開始/終了/方向・scroll保持を確認してpass。ユーザーUI依頼ではSSR/CSS契約が実装前にfailし、画像確認後のレイアウト反映と、開いた追加欄/入力途中draftの詳細更新保持を追加回帰で確認した。

レビュー指摘の対応:

- R70-N01 High: dirty rowの基準版と最新server snapshotを分離。再解決前の送信を止め、他行の更新応答もdirty rowを競合扱いにする。
- R70-N02 Medium: SSR/動的行で同一の本文label・`.todo-controls`・操作群構造を使用。
- R70-N03 Medium: 行別と追加欄別に最新snapshotと競合選択を保持し、実際の最新本文/状態を表示。追加欄競合は追加だけを止め、別行の編集・削除を許可。自動再送なし。
- R70-N04 High: 本文/状態それぞれの編集世代を送信世代と比較し、元値へ戻す往復編集を保持。
- R70-N05 Medium: 削除済み下書き状態をrequest busyから独立させ、finally後も保存/削除不可。
- R70-N06 High: 追加欄に別の下書きがある場合、削除済み内容の移動に明示的な置換/保持選択を表示し、二次確認ボタンも削除済み行の確認操作として有効化。FakeElement.clickも実DOM同様にdisabled操作を発火しない。
- R70-N07 Medium: GET/PUTの全await後・副作用前に画面世代と認証/離脱状態を再確認。BFCache復帰時にbusyと操作可否を再計算。
- R70-N08 Medium: snapshot順で行を同期し、同じ版の件数/更新時刻/強制状態も反映。
- R70-N09 Medium: snapshotで行を毎回再appendせず、必要な順序変更だけ行う。reorder中に実際にinsertBeforeされたfocus行を追跡するため、最終indexが不変でもfocus、textarea選択範囲/方向、画面scroll位置を復元。focused rowの削除時は次→前→見出しへpreventScrollで移動し、読み上げ状態を通知。
- R70-N10 Medium: 初期/動的/追加欄を2行textarea・8行相当上限の自動伸長に統一し、selectも44px以上に設定。
- R70-N11 Medium: ログ409後にresyncが成功した経路でもTodo GETを一度実行。
- R70-N12 Medium: Todo 404はsession unavailableとして入力を保ち、以降の読書/更新を止める。認証終了状態とは分離。
- R70-N13 Medium: `audit_warning`と`applied`を表示し、適用済み更新を再送しない。
- R70-N14 Medium: fixtureはlisten後に実際のLoopbackポートから `baseUrl` originを設定。通常ブラウザのOriginでログインできることをcreateApp起動の統合試験で確認。
- R70-N15 Medium: Todo版を後退させる競合解決を拒否。遅れて届いた古い409は新snapshotを上書きせず、row/addの競合状態も現在版を維持。遅延409 JSONとversion 3 GETの交差試験を追加。
- R70-N16 Medium（同内容のR70-F02と同一修正）: 追加成功時と409後のsnapshotから作る動的行について、状態ラベルに`.todo-status`と`span`を付け、状態selectと操作群をSSRと同じ`.todo-controls`構造に揃える。追加・手動更新の各経路にassertionを追加。
- R70-N17 Medium: 削除済みdraftの明示的な「新しい項目として編集」と置換確定でのみ、折りたたみ追加欄を開いてtextareaをresizeしてからfocus。通常更新と「追加欄を保つ」選択は閉状態を維持する回帰を追加。

同じPRに追加された独立final-review指摘とユーザーUI依頼:

- R70-F01 Medium: 本文変更でactive textareaの値が変わったとき、行順が同じでも選択範囲・方向を復元し、focus/scrollも保持。既存N09の行移動追跡は変更せず存続。
- R70-F02 Medium: R70-N16と同内容。動的行の状態欄がSSR/CSS契約と異なる点を追加・409再描画の両方で検証。
- R70-F04 Medium（開発preview独立review）: 保存HTMLに残る緊急停止/ログアウトformと一覧linkがpreviewを離脱またはnative送信できる懸念。preview-only capture bridgeで強制機能toggle以外の全form submitを取消し、submit button clickとfragment以外のlink navigationも取消して通知する。製品route/認証formは編集しない。R70-F04回帰は実装前にcapture handler不在でfailし、修正後にbridge契約テストpass。独立reviewerのfix verification待ち。
- UI依頼: 強制切替を状態右横、状態・select・更新・削除を単一行に配置。コントロールはmin-width/min-height 44px、ボタン文字を本文と同じ継承サイズにする。Todo追加欄は初期折りたたみのネイティブdetails/summaryで、通常refresh中はopen状態と入力draftを保つ。
- 画像 `IMG_6246.jpg` / `IMG_6247.jpg` を確認し、モバイル操作列と強制切替の参照として利用。#71へのコード変更なし。

実装後の最終検証:

- N16/N17までのhead検証: `npm test` は exit 0、254 tests / 243 pass / 11 skip / 0 fail。`npm run check`、`npm run build`、`npm run lint`、`git diff --check` はすべてexit 0。
- 開発preview initial head検証: `npm test` は exit 0、255 tests / 244 pass / 11 skip / 0 fail。`npm run check`、`npm run build`、`npm run lint`（TypeScript ESLint、Markdown lint 145 files / 0 issues、日本語design whitelist）、`git diff --check` はすべてexit 0。`npm run preview:issue70` で成果HTMLを生成。
- R70-F04後のfocused確認: HTML generation + `test/issue70-ui-fixture.test.ts` は2/2 pass。full suite/check/build/lint/new-head CIはこの修正を含むpush後に実施する。
- `npm run check`: exit 0。
- `npm run build`: exit 0。
- `npm run lint`: exit 0。TypeScript ESLint、Markdown lint（144 files / 0 issues）、設計文書の日本語whitelist検査を含む。
- `git diff --check`: exit 0。
- 対象回帰: 元のdirty base保持、本文/状態の往復編集、動的行409、追加409後の別行編集/削除、版順序とmetadata、ログ409 resync、Todo 404、離脱/復帰中の遅延GET/PUT、削除済み下書きの二次確認disabled制御、本文変更で非並替え時のfocus/caret/selection保持、3行並替え、add disclosureのopen/draft保持、320px向けCSS制約、古い409と新GETの交差、fixtureの実Origin login、audit warningを含む。

## 実UIの確認と未完了事項

`scripts/issue70-ui-fixture.ts` が一時データ領域とLoopback限定serverを作り、`createApp`と実user-consoleの認証・SSR・Todo API経路を起動する。実行は `node --import tsx scripts/issue70-ui-fixture.ts`。serverのlisten後、fixtureの `baseUrl` originに実際のポートを設定するため、通常ブラウザのOriginでログインできる。ダミーfixture資格情報で同セッション詳細を開く。実行後はCtrl-Cでserver/dataをcleanupする。認証POST、cookie付き詳細HTTP GET、Todoパネル・2行入力・2項目・共通wrapper・responsive CSSは統合試験で確認済み。

画面幅のviewport計測は未完了。正規cloud browserはlocalhost URLを `ERR_BLOCKED_BY_CLIENT` で拒否したため、別host回避やheadless再試行は行っていない。実画面の320 CSS px/PC幅、改行/長文折返し、操作配置、横overflowは親の正規fixture環境で確認が必要。テストfixture processとtemp directoryは終了・cleanup済み。

## 開発時オフラインHTML preview

- 再生成: `npm run preview:issue70`。成果物: `artifacts/issue70-todo-preview.html`。簡単な操作案内: `doc/dev/issue70-todo-preview.md`。
- 出力は一時Loopback fixtureの合成sessionを用いて、実際の `/user/sessions/:sessionId` 製品routeからHTMLを取得する。生成時にfixture認証を自動処理し、出力後はserverと一時データ領域を終了・削除する。開発者はサーバー起動、ログイン、応答の手動確認をせず、保存HTMLを開けばよい。
- 製品SSR/CSSと `userConsoleClientScript` をそのまま含める。保存HTML内のpreview-only bridgeはTodo GET/PUT、console-state、logs、EventSourceを明示的なメモリfixtureに置換し、強制切替もページ内で完結する。未登録のfetchは例外にして気付けるようにする。製品API/auth経路にはpreview動作を追加しない。
- fixtureは未着手・進行中・完了・長文複数行の合成項目を表示。追加欄は初期折りたたみ、強制機能は無効状態から切替可能。previewの操作はメモリだけに反映し、ログインCSRF値を固定のpreview用文字列に置換、credential/cookieはHTMLへ含めない。
- 出力HTMLを再生成し、テストでSSR CSSと正確な製品client script、各Todo状態、オフラインfetch/EventSource stub、認証値不在、外部URL不在を確認した。通常ブラウザを利用した320 CSS px/desktopの実画面確認は引き続き未完了。

初回レビューのfail判定は履歴として維持する。全指摘の修正をpush後、同一通常reviewerによる再確認待ち。マージしない。

## 変更対象

- `src/user-console.ts`
- `src/user-console-client.ts`
- `test/issue-56-shared-todo.test.ts`
- `test/user-console-client.test.ts`
- `scripts/issue70-ui-fixture.ts`
- `artifacts/issue70-todo-preview.html`
- `doc/dev/issue70-todo-preview.md`
- `package.json`（再生成script）
- `tasks/tasks-status.md`
- `tasks/phases-status.md`
- `reports/issue-70-implementation-20261004.md`

## 証拠の状態

- 検証能力: `local_execution_available`
- 検証能力: `local_execution_available`; branch上の修正ソースに対し実行。
- Push: N16/N17修正を含むcode commit `cc198421f40c8b35e080739ce32cb1e3e2d129ec` を通常push済み。PR #72はDraft維持。
- CI: exact-head run `37242547410` は `cc198421f40c8b35e080739ce32cb1e3e2d129ec` に対し全10 job成功（Prepare、Ubuntu、Windows 8 shards）。
- 開発preview追加とR70-F04修正の新source変更はこのレポート作成時点でfull regression/CIとreviewer fix verificationが未完了。PRはDraft維持、mergeしない。
- 独立final review / merge: 未実施。
