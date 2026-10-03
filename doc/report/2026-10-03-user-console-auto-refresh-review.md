# 使用者コンソール自動更新 通常レビュー報告

## レビュー対象

- リポジトリ: `ssaattww/RemoteDesktopMCP`
- Issue: #46 `使用者コンソールに新着自動更新の切替を追加する`
- PR: #51 `docs: design user console automatic refresh for issue 46`
- ブランチ: `issue46-user-console-auto-refresh-design`
- レビュー対象 HEAD: `11367c321838d8900c0068d441a05b2dea569e64`
- 基準 HEAD: `ed698f1031e9aafb88d4aa0fa6252636ea2df742`
- レビュー方式: 通常レビュー。製品コードは変更せず、Issue、設計、差分、依存実装、境界条件、テスト、CI、診断 artifact、設計文書 lint 運用を確認した。

レビュー終盤に remote current HEAD を再取得し、レビュー対象 HEAD から変化していないことを確認した。report 保存前の review worktree は clean だった。

## 判定

判定結果: fail

必須修正 2 件、軽微な修正 2 件を検出した。

- Medium: 2 件
- Low: 2 件
- 保留条件: 1 件

## 指摘事項

### RDMCP-PR51-REV-001: 一覧行の再描画で文字列選択と表示位置を保持できない

- severity: Medium
- origin: review
- location:
  - `doc/design/user-console-auto-refresh.md:14`
  - `doc/design/user-console-auto-refresh.md:29`
  - `doc/design/user-console-auto-refresh.md:31`
  - `doc/design/user-console-auto-refresh.md:91`
  - `src/user-console-client.ts:570-591`
  - `test/user-console-client.test.ts:304-337`
- description:
  - Issue #46 は自動更新の ON/OFF にかかわらず、現在の選択状態とスクロール位置を意図せず失わないことを要件としている。
  - 設計も「選択行や文字列の選択」を維持し、更新前に見えていた行または位置を基準に表示位置を保つことを明記している。
  - 現在の `refreshStateFrom` は更新前の `document.activeElement` からセッション ID だけを保存し、`sessionRows.replaceChildren()` で全行を作り直した後、同じセッションの詳細リンクへフォーカスを戻す。
  - 文字列選択の `Selection` / `Range` や一覧の表示アンカー、スクロール領域の位置は保存・復元していない。
  - 既存の `window.scrollTo(...)` は操作履歴・プロセス表示の `renderEvents` 用であり、セッション一覧の `refreshStateFrom` には適用されない。
- impact:
  - 利用者が Connection ID、用途、作業ディレクトリ等を選択している最中に自動状態更新が入ると、選択対象の DOM が置き換えられ、選択状態を維持できない。
  - 更新で一覧行が追加・削除される場合、表示中のセッション行を基準にした位置保持も保証されない。
  - Issue #46 の受け入れ条件と設計の試験計画 6 を満たしていない。
- evidence:
  - `src/user-console-client.ts:570-591` で保存している操作状態は `focusedSessionId` のみである。
  - 同範囲で `sessionRows.replaceChildren()` により既存行を全削除している。
  - `test/user-console-client.test.ts` の状態更新試験はフィルター、件数、内容更新を確認するが、文字列選択または一覧表示位置の保持を検証していない。
  - current HEAD のクライアント試験 25 件は全件成功したため、この要件不足は現行試験では検出されない。
- required_action:
  - 一覧の自動再描画時に、文字列選択と表示中の行・位置を識別可能な形で保存し、同じ対象が残る場合に復元する。あるいは、未変更行を置換しない差分更新方式にする。
  - 行追加・削除を伴う状態更新でも、文字列選択と表示位置が維持される回帰試験を追加する。

### RDMCP-PR51-REV-002: 自動更新 OFF 時に手動更新を使う説明が表示されない

- severity: Low
- origin: review
- location:
  - `doc/design/user-console-auto-refresh.md:19`
  - `src/user-console.ts:262`
  - `test/user-console.test.ts:139`
- description:
  - 設計は、自動更新が無効な場合に一覧を自動反映しないことに加え、「手動更新を使うことを説明文で伝える」と定めている。
  - 現在の一覧画面で追加された表示は `自動更新` のチェックボックスだけで、OFF 時の挙動や手動更新ボタンを使う旨の説明文はない。
  - サーバー側の表示試験も toggle の存在だけを確認している。
- impact:
  - OFF にした利用者は、通知接続は維持される一方で一覧が更新されなくなる理由と、`↻ 更新` が代替操作であることを画面から明確に判断できない。
  - 機能自体は利用可能だが、設計済みの操作案内を満たしていない。
- required_action:
  - OFF 時は自動反映せず `↻ 更新` で手動取得できることを toggle 周辺に説明する。
  - 一覧 HTML の回帰試験で説明文の存在を確認する。

### RDMCP-PR51-REV-003: 古い `/api/console-state` 応答が新しい自動更新結果を上書きできる

- severity: Medium
- origin: review
- location:
  - `src/user-console-client.ts:480-487`
  - `src/user-console-client.ts:623-632`
  - `src/user-console-client.ts:754-755`
- description:
  - 起動時は `void refreshState()` で状態取得を開始した直後に `restartEvents()` で SSE 接続を開始する。
  - 新着通知が先に届くと `automaticCycle()` が別の `/api/console-state` を取得し、その結果を先に `refreshStateFrom()` へ反映できる。
  - 独立した `refreshState()` は `pageGeneration` だけを確認し、同一画面世代内の複数状態要求を順序付ける世代番号や latest-wins 判定を持たない。
  - そのため、起動時の古い状態要求が遅れて完了すると、後から取得した新しい自動更新結果を古いスナップショットで再上書きできる。
- impact:
  - 自動更新で一度最新になったセッション一覧、接続数、実行中件数、停止状態が過去の値へ戻り、次の通知または手動更新まで誤表示が残り得る。
- evidence:
  - review scratch で「初期 state 要求を保留 → SSE 通知で新しい state を反映 → 初期要求を完了」を合成したところ、既存 25 件は pass し、追加した順序競合テストだけが fail した。
  - 失敗時の値は `actual: '1'`, `expected: '5'` で、古い初期応答が新しい自動状態を実際に上書きした。
  - scratch は製品 worktree 外に置き、PR source は変更していない。
- required_action:
  - 全ての `/api/console-state` 取得を単一の調整経路へ直列化するか、状態要求世代を導入して古い要求結果を反映しないようにする。
  - 上記の逆順完了ケースを回帰試験として先に追加する。

### RDMCP-PR51-REV-004: 設計文書の TDD 順序が同一文書内で矛盾している

- severity: Low
- origin: review
- location:
  - `doc/design/user-console-auto-refresh.md:84`
  - `doc/design/user-console-auto-refresh.md:107`
- description:
  - `:84` は「試験を先に追加し、失敗を確認してから製品実装」と定めている。
  - `:107` は完了条件として「試験計画の回帰試験を製品実装後に追加する」と記載しており、試験追加と製品実装の順序が逆になっている。
- impact:
  - 後続修正時にどちらが正式な実装順序か判断できず、リポジトリの TDD 方針と異なる作業順を許容する記述になる。
- required_action:
  - 試験追加は実装前、全試験成功の確認は実装後、という二つの時点を区別する表現へ修正する。

## 保留条件

### RDMCP-PR51-HOLD-001: PR #50 の日時 details との統合確認

PR #50 `Issue #44 使用者日時を相対表示` は本レビュー追補時点で OPEN / draft、current HEAD `fd86a5ab468388d81692195d4d07c7ea27ff06c8` であり、PR #51 の base には含まれていない。

PR #51 の設計は `doc/design/user-console-auto-refresh.md:31` で、PR #50 が追加する作成日時・最終アクセス日時の `details` 開閉状態と操作位置を自動更新後も保つことを明記している。

共通 base `ed698f1031e9aafb88d4aa0fa6252636ea2df742` から PR #50 と PR #51 を `git merge-tree` で三者統合したところ、`src/user-console-client.ts` の状態更新後フォーカス復元箇所で実際の conflict marker が生成された。

- PR #50 側: 日時 `details` の `summary` へ `preventScroll` 付きでフォーカスを戻す。
- PR #51 側: 同じセッションの詳細リンクへフォーカスを戻す。

したがって PR #50 が先に main へ入る場合、PR #51 はその HEAD を取り込んで競合を解消し、日時 `details` の開閉・フォーカス保持と PR #51 の自動更新を同時に回帰確認する必要がある。これは現 base に存在しない sibling PR との統合条件なので、今回の製品 finding とは分けて保留条件とする。

## 確認できた事項

- 自動更新 toggle は `/user` 一覧だけに表示され、個別 `/user/sessions/:sessionId` には追加されていない。
- 初期値は ON で、端末保存やサーバー設定には保存しない。
- OFF 中も EventSource は維持し、通知後のログ取得・状態反映だけを止める構成になっている。
- ON 時は既存 `logs-available` を合図に `/api/logs?after=...` と `/api/console-state` を使い、通知本文へ監査記録本文を追加していない。
- 自動取得と手動取得は同時に走らないように調停され、取得中の通知と重複手動要求はまとめられる。
- 自動取得は 2 秒未満の間隔で連続開始せず、1 列あたり最大 5 ページ、1,000 件に制限される。
- OFF 中の `resync-required` は即時取得せず保留し、手動更新または再有効化で再同期する。
- 非表示化、`pagehide`、BFCache 復帰、遅延応答、認証終了について世代番号と `AbortController` を使った無効化処理を確認した。
- 401/403 と `auth-expired` は自動・手動の継続取得を停止し、認証終了後の遅延結果を反映しない。
- `/api/console-state` に本人範囲の `unassignedOperations` を追加し、一覧の部分更新で表示を更新する。
- 監査イベントの本人境界は `userCanViewAuditEvent` / `ownsAuditEvent` を再利用しており、新しい通知本文公開経路は追加されていない。
- `session.open`、`session.close`、`session.expired`、`sessionAccessAt` を含む操作終端、停止・再開、`process.*` は監査記録を通じて通知対象になることを source で確認した。
- 設計文書のインラインコード表記を全件確認した。今回追加箇所はパス、API、イベント名、関数・クラス名、DOM 要素名等の識別子用途であり、一般用語を囲って許可語 lint を回避している箇所は見つけなかった。

## 変更範囲

レビュー対象差分は 6 ファイル、762 insertions / 30 deletions。

- `doc/design/user-console-auto-refresh.md`
- `package.json`
- `src/user-console-client.ts`
- `src/user-console.ts`
- `test/user-console-client.test.ts`
- `test/user-console.test.ts`

依存 package と lockfile の変更はない。`package.json` の変更は新しい設計書を設計用語 lint 対象へ追加するものだけである。

## 検証

### ローカル

レビュー対象 HEAD `11367c321838d8900c0068d441a05b2dea569e64` で確認した。

- `git diff --check ed698f1031e9aafb88d4aa0fa6252636ea2df742..HEAD`: pass
- `test/user-console-client.test.ts`: 25 pass / 0 fail

専用 detached review worktree には `node_modules` を配置していないため、最初の `node --import tsx --test ...` は `ERR_MODULE_NOT_FOUND: tsx` で実行環境上失敗した。製品試験の失敗としては扱っていない。その後、同一リポジトリの既存 worktree に導入済みの `tsx` 実行ファイルを使い、source と cwd は PR #51 の review worktree のまま再実行して 25/25 成功を確認した。

RDMCP-PR51-REV-003 の順序競合確認では、製品 worktree 外の review scratch に既存25件と追加1件を置き、同じPR sourceを読み込んで実行した。既存25件は全て pass、追加した「古い初期 `/api/console-state` 応答を新しい自動更新後に完了させる」試験だけが fail し、最終表示は `actual: '1'`, `expected: '5'` だった。これにより、古い状態応答が新しい状態を上書きする経路を動的にも確認した。

設計用語 lint の直接再実行も review worktree の依存未配置により `yaml` package が見つからず実施できなかった。代わりに inline-code 箇所を全件静的確認し、exact-head CI の Ubuntu `Run lint` 成功を確認した。

### CI

CI は PR current HEAD と run の `headSha` が一致する run だけを確認した。

- reviewed technical HEAD: `11367c321838d8900c0068d441a05b2dea569e64`
- run: `37076454672`
- workflow: `lint`
- event: `pull_request`
- headSha: `11367c321838d8900c0068d441a05b2dea569e64`
- conclusion: success

job:

- Ubuntu `Lint, check, build, and test`: success
- Windows shard 1/3: success
- Windows shard 2/3: success
- Windows shard 3/3: success

## 診断 artifact workflow

`.github/workflows/lint.yml` は Ubuntu / Windows の双方で診断領域を準備し、test result、各工程の標準出力・標準エラー、実行環境情報を記録する。`if: always()` で `actions/upload-artifact@v4` を実行する構成を source で確認した。

exact-head run `37076454672` でも全 job の `Prepare diagnostics`、`Record environment`、`Upload diagnostics` が success だった。今回 workflow 変更は不要である。

## Coverage disposition

- changed files: 6/6 reviewed
- direct dependencies: `/api/events`, audit notification generation, `/api/console-state`, auth expiry, session state reconstructionを確認
- security/privacy: principal境界、認証終了時の取得停止、背景取得によるidle期限非延長を確認
- concurrency: auto/manual generation、retry、pagehide/BFCacheを確認し、状態応答順序競合を `RDMCP-PR51-REV-003` として検出
- UX state retention: focus復元は確認し、文字列選択・可視位置保持不足を `RDMCP-PR51-REV-001` として検出
- documentation/lint: whitelist追加なし、明白なlint回避なし。OFF説明不足とTDD文言矛盾を `REV-002` / `REV-004` として検出
- sibling PR interaction: PR #50 current HEADとの統合は conflict を再確認し、`RDMCP-PR51-HOLD-001` として held

## レビューで変更しなかったもの

レビュー担当として製品コード、設計、テスト、workflow は修正していない。マージも行っていない。

## 次の作業

1. `RDMCP-PR51-REV-001` を修正し、文字列選択と一覧表示位置を保持する回帰試験を追加する。
2. `RDMCP-PR51-REV-002` の OFF 時説明を追加し、表示試験を補強する。
3. `RDMCP-PR51-REV-003` は逆順完了の失敗試験を製品テストへ追加してから、状態取得の直列化またはlatest-wins制御を実装する。
4. `RDMCP-PR51-REV-004` のTDD順序表現を修正する。
5. PR #50 が先に main へ入った場合は、その main を取り込んで `RDMCP-PR51-HOLD-001` の競合を解消し、日時 `details` と自動更新を組み合わせて検証する。
6. 修正後の PR current HEAD と完全一致する CI run だけを確認する。
7. 再レビューでは同じ finding ID と severity を維持する。

## 再開時追補

2026-10-03 10:10 +09:00 時点で、PR #51 の remote current HEAD は `cec5f7bc5ed98bb5d7157d6e7772cd9cc04e7a17` だった。レビュー対象 `11367c321838d8900c0068d441a05b2dea569e64` 以降の差分は本レビュー report / handoff のみで、製品コード、設計、テスト、workflow の追加変更はない。

同 HEAD 一致の pull_request CI は run `37084614215` が `in_progress` だった。利用者指示により CI 完了待機は行っていない。技術判定は exact-head CI が成功済みのレビュー対象 HEAD `11367c321838d8900c0068d441a05b2dea569e64` に対するものとする。

PR #50 の current HEAD は `f9b60a5ea3fb7b7138efee0a020ba46661b106bb` へ進んでおり、前回確認した `fd86a5ab468388d81692195d4d07c7ea27ff06c8` からの追加差分は `package.json` のみだった。したがって `RDMCP-PR51-HOLD-001` は未解消の保留条件として維持し、PR #50 が先に入る場合は新しい main に対して統合確認をやり直す。
