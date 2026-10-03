# Issue #48 / PR #54 URL・title後編集の統合計画

## 対象と実行位置

- Repository: `ssaattww/RemoteDesktopMCP`
- Issue / PR: #48 / #54 (`https://github.com/ssaattww/RemoteDesktopMCP/pull/54`)
- Branch: `design/issue48-session-edit`
- 計画作成開始時HEAD: `8b5c5059aeb4190f93866465ae834d662e034213`。開始時worktreeはcleanで、push先branchも同じHEADだった。
- Base: `c0c786a3d696724d780291aed9c8b89cbe2d531e`
- Verification capability: `local_execution_available`。Linux/bashの作業環境、Node依存とnpm scriptが利用可能。
- 作業分類: Issue #48後編集の契約・TDD計画。通常開発を続ける。今回の設計準備では実装テストは追加・実行していない。
- Merge境界: PR #54はDraft/open/unmergedのまま維持し、利用者の明示指示なしにmergeしない。

## 権威ある範囲と履歴

Issue #48は本人のworkdir、用途、URL、titleの後編集と再表示、他人所有sessionの拒否、不正workdirの非破壊拒否、既開始processのcwd維持と更新後に開始するcommandへの適用を求めている。Issue本文は全体の受入条件を満たすまでPR #54を維持するよう指示する。

PR #54のworkdir/purpose部分は実装済みで、決定的X_OK拒否テスト、metadata PATCHの原子性、版競合、process開始時cwd snapshotの回帰がある。既存の7ケース対話ブラウザ成功は親から報告された。`ce3d394` から `2e9b80b`、現在HEAD `8b5c5059` までUI製品ファイル変更がなく、直近差分も独立レビュー報告のみなので、その既存証拠は現HEADの既存UIに適用する。今回の書式回復に既存UIの再確認は不要である。

PR #52には未公開の7ファイル実装がFA780にあり、ユーザーから次の共有API案が示された: `createSessionLink`、`updateSessionLink`、`captureSessionLinkFetchLease`、`applySessionLinkFetchResult`、`fetchSessionLinkTitle`。公開PRには設計があるが、未公開実装の本体・型・関数シグネチャはこの実行環境のcheckoutに含まれていない。共有モジュールの再実装はせず、担当からのhandoff後に契約を照合する。

## 決定した設計

- `version` は利用者のメタデータPATCH全体の比較番号であり、workdir/purpose/URL/titleを一つのcommitで更新する。実際の利用者変更一回につき最大一度増え、同値だけの更新では増えない。
- `linkRevision` はリンク利用者変更に由来する取得世代であり、`version` と別に管理する。URL/title意図が実際に変更されたときだけ一回増やす。取得結果反映はtitle/source/statusだけを更新し、`version` と `linkRevision` のどちらも進めない。
- PATCHは疎な意図差分だけ送る。URL/title項目を省略した場合、編集中に自動取得が完了しても最新のSession値を保つ。明示入力だけが値の変更・解除を表す。
- 題名取得はPATCHのcommit後に始め、session ID・所有者・URL・`linkRevision` の取得リースを使う。Sessionの終了、期限切れ、緊急停止が先なら遅延結果を破棄する。通信・DNS・本文処理で更新lockを待たない。
- 監査、診断、失敗応答、通知、標準出力にURL、title、本文、DNS/接続情報を出さない。Session終了・期限切れ・緊急停止時にリンク値を消し、後着結果で復元しない。
- 特殊用途CIDRは親範囲を全面拒否し、より具体的なglobally-reachable例外も許可しない。NAT64、6to4、Teredo等の変換・トンネル範囲も例外にしない。これはユーザーが選択した保守方針で、追加承認待ちではない。
- 作成時は不正URLを破棄してsession作成を続ける場合がある一方、Issue #48編集PATCHは全項目一括更新である。後編集では共有 `updateSessionLink` が明示された不正入力と省略を区別して返し、不正明示値を含むPATCH全体を拒否できることが必要である。共有APIが区別できない場合はその戻り値契約をPR52担当と調整し、後編集側に検証器を複製しない。

### CIDR拒否範囲の根拠

IANAの[IPv4特殊用途登録簿](https://www.iana.org/assignments/iana-ipv4-special-registry)と[IPv6特殊用途登録簿](https://www.iana.org/assignments/iana-ipv6-special-registry)は、登録範囲と `Globally Reachable` 属性を別に管理する。登録簿では `192.0.0.0/24` と `2001::/23` の集約範囲に対し、より具体的な割当の一部（例: `192.0.0.9/32`、`192.0.0.10/32`、`2001:1::1/128`、`2001:3::/32`）がグローバル到達可能と記載される。登録簿の説明も、登録範囲の到達性を任意のネットワーク文脈で保証しないとしている。題名取得では一般ページに不要な到達先を増やさないというユーザー選択に従い、最長一致で例外を許可せず、親範囲内の具体例外も拒否する。

## TDDケース

これらのケースをPR52共有実装のhandoff後に合成transport/DNSで追加する。各ケースは実装前に期待値との差を記録し、同じケースのGreenを確認する。外部ネットワークへ接続しない。

1. **複合PATCH原子性:** workdir、purpose、URL、titleを一つの成功PATCHで変更し、Session、応答、所有者向けconsole-state、auditの整合を確認する。どれか一項目の検証失敗では全値、`version`、`linkRevision`を不変にし、fetchも開始しない。
2. **自動取得と疎な保存の競合:** editorを版 `v` で開き、別の自動取得でtitle/source/statusを更新してから、リンク項目を省略したworkdir/purpose PATCH (`expectedVersion: v`) を保存する。PATCHが成功し、取得済みtitleを保持することを確認する。
3. **非同期取得の版番号:** fetch成功・失敗で `version` と `linkRevision` は不変、取得statusだけが一度遷移することを確認する。取得反映後の疎なPATCHが無用な409にならず、結果も消さない。
4. **取得リースと `linkRevision`:** URL/title意図変更を旧fetchと競合させ、世代不一致結果が無反映であることを確認する。GET完了がPATCHに先行する順序、PATCHが先行する順序、close/expiry/stopが先行する順序をbarrierで作る。
5. **省略・解除・取得元:** URL/title省略で状態を維持する。URL変更時manual titleは維持し、fetched titleは破棄する。同じfetched文字列の明示入力はmanualへ切り替える。明示空欄はtitle overrideを解除し、URLが有効なら新世代fetchを開始する。リンク意図の同値再送では番号を増やさない。
6. **古い利用者版:** 別タブの利用者変更後、古い `expectedVersion` のPATCHは409で全項目不変、fetchキュー不変とする。既存UIは自動再送せず、二択操作へ最新値を提示する。
7. **非出力・終了消去:** 合成markerをURL/title/bodyに入れ、成功・検証失敗・fetch失敗・監査失敗・通知に漏れないことを確認する。close/expiry/stop後の状態取得から値が消え、遅延取得も値を戻さない。
8. **CIDRと表示:** 公開正例、特殊用途の親・具体例外の境界、private/loopback/link-local、混在DNS、IPv4埋め込みIPv6、NAT64/6to4/Teredoを表形式で確認する。全特殊用途例外を拒否し、各redirect先も再検査し、検査後IPへ接続固定する。titleは `textContent`、URLは検査後の `href`、`noopener noreferrer` と `no-referrer` を確認する。
9. **リンクUI:** URL/title編集・再表示、manual/fetched状態、入力中の非同期完了、保存待ち追加入力、409二択、終了行の編集不可を確認する。旧7ケースは現行UIが変更されない限り再実行しない。

## 次のタスクと停止条件

- R54-07では本計画と更新済み設計を保存する。この作業でPR52共有ロジックや後編集APIは実装しない。
- R54-08ではPR52実装handoffにある型・戻り値・非同期契約を照合し、後編集PATCHの失敗期待TDDテストから実装する。
- R54-09ではリンク項目をconsole-stateと既存編集UIに統合し、リンク専用UI回帰を追加する。
- R54-10でIssue #48全受入条件、Linux/Windows validation、通常review/fix verificationを終え、candidate HEADを作る。R54-11でその後に新しい独立最終レビュー境界とexact-head CIを始める。
- 共有API handoff前に関数シグネチャを推測して実装しない。`updateSessionLink` の不正入力と省略の識別、同時PATCHの一括適用位置、fetch開始タイミング、終了時cleanupの所有者をhandoffで確認する。

## 現レビュー・CI・attestation状態

- IFR-001/002は同一独立reviewerが技術実装HEAD `7b44f84764245a094fe16c5bf345887a16542bf1` に対して元のP2のまま `checked_no_finding`。初回 `ce3d394` のfailはそのHEADの歴史的判定として保持する。
- report-only attestation `2e9b80b52bc25c6a526d2c2543fadb51d54321bf` のCI run `37143362177` はUbuntu Markdown lintのMD060で失敗した。日本語withdrawal comment `5972984838` を投稿済み。通常docs-only recovery `8b5c5059` は同じ独立reviewerが修正を `checked_no_finding`、markdownlint 89 files/0 issues、`git diff --check` 成功。exact-head CIは10分の確認窓に出現しなかった。
- 旧attestationは現行完了証明に使わず、記録履歴は保持する。通常の設計・実装は継続し、全Issueスコープ後に新しいfinal review境界を設ける。

## 今回の検証状態

- 設計/計画/タスク記録を作成済み。製品コード・テストファイルは変更していない。
- `npm run lint:md`: 90 files, 0 issues。`npm run lint:md:terms:design`: 成功。`git diff --check`: 成功。
- TDDテストはまだ作成・実行していない。共有API本体がhandoffされる前の準備段階であり、テスト名・field semanticsはPR52契約との照合が必要。
- 実装後に使うvalidation plan: `node --import tsx --test test/mvp.test.ts test/regressions.test.ts test/user-console.test.ts test/user-console-client.test.ts`, `npm run check`, `npm run lint:ts`, `npm run lint:md`, `npm run lint:md:terms:design`, およびLinux/Windows CI。
- Commit/push: `commit_pending` / `push_pending`。
- Current design-candidate CI: 未実行。この作業は後続実装の候補HEADのための準備で、最終CIではない。

## 変更ファイル

- `doc/design/session-metadata-edit.md`: PR52共有処理との原子統合契約、CIDR決定、TDDケースを追加。
- `tasks/tasks-status.md`: UI既存証拠を更新し、URL/title設計、API統合、UI統合、統合検証、新しいfinal lifecycleを分割して追跡。
- `tasks/phases-status.md`: P5をIssue #48全体の受け入れ条件として定義し直し、旧attestationを再利用しない新しいレビュー境界を記録。
