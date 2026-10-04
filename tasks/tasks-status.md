# Task 一覧

更新規則: このファイルは `task-breakdown-planner`、`task-consistency-manager`、`progress-sync-manager` を通してのみ更新する。

## 現在の対象

ローカル最小版の完了に続き、ChatGPT からこの Windows PC を遠隔操作する公開接続を作る。
ユーザーの追加指示で単一 PC の公開接続を優先する。複数実行 PC は引き続き後続とする。
前回の独立判定は `reports/2026-09-25-independent-review.md` に保存し、今回の変更は新しい検証工程で扱う。
設計 Sol / high、レビュー Sol / high、実装 Terra / high、機械的な確認 Luna / high。

| ID | Phase | 内容 | 依存 | 規模 | 完了条件 | 状態 |
| --- | --- | --- | --- | --- | --- | --- |
| T01 | P1 | PR #1 の RDMCP-DR-001〜003 の設計修正 | なし | M | 複製の hash、原子的な置換禁止、設定ファイル保護が文書間で一致 | 設計と実装証拠の解消確認完了 |
| T02 | P1 | skills のシンボリックリンクと task 一覧 | T01 | S | リンク経由で SKILL.md が読め、依存と完了条件を一覧化 | 完了 |
| T03 | P2 | 単一PCの認証、セッション、ノード、監査、設定 | T02 | M | loopback 限定、未認証拒否、セッション期限と所有者検証、未知ノード拒否 | 完了 |
| T04 | P2 | Desktop Commander のファイル・プロセス操作への委譲 | T03 | L | 固定版でツール一覧を検証し、検索・読取・部分編集・起動・状態・出力・停止を確認 | 完了 |
| T05 | P2 | MCP の双方向ファイル転送 | T04 | L | 7転送ツール、サイズと hash 検証、競合保護、中断・期限・清掃を確認 | 完了 |
| T06 | P2 | 設定例・起動手順・回帰と結合テスト | T05 | M | 初回起動手順が実行可能、旧 download URL を廃止、3指摘の競合 fixture が合格、Windows/Linux CI に検証を配線 | 24件の回帰試験・両OS CI合格 |
| T06a | P2 | Desktop Commander の依存監査と修正版への限定更新 | T04 | S | sharp と uuid の報告を調査、互換性確認と実接続・audit 再検証 | 完了 |
| T07 | P3 | 通常レビューと指摘修正 | T06 | M | Sol / high による必須観点レビューと修正確認、検証報告が揃う | 完了 |
| T07a | P3 | 設定保護と転送清掃 | T07 | M | DR-003、NR-002、DR-001/002 の不足 fixture を修正・検証 | 完了 |
| T07b | P3 | 検索完了とプロセス出力・終了監査 | T07 | M | NR-003/004 のページ処理、文字列検索、終了結果を実接続で確認 | 完了 |
| T07c | P3 | Node22、OAuth、セッションの契約 | T07 | M | NR-001/005/006、実 HTTP の正常・異常経路を検証 | 完了 |
| T07d | P3 | 再レビューの残存指摘と起動時清掃 | T07 | M | NR-003/004/006/007/008、全検索結果・未照会終了監査・有効セッション一覧・両OS試験・所有証明を確認 | 完了 |
| T07e | P3 | CI で判明した設定実体の置換と委譲失敗 | T07d | M | 再発 DR-003 と NR-009 を修正し、両 OS の同一候補 CI が成功 | 完了 |
| T08a | P3 | 独立指摘の PID 所有者・履歴清掃・上限・終了観測・監査 | T07 | L | MVP-IFR-001〜005 の製品修正と指定された組合せ試験を確認 | 通常 reviewer による解消確認完了 |
| T08b | P3 | 正常な複数チャンク upload の証拠 | T07 | M | MVP-IFR-006 の新規・上書き完了と bytes/hash/清掃を実 MCP で確認 | 完了 |
| T08c | P3 | 設計の固定版表記 | T07 | S | MVP-IFR-007 の0.2.51への一致と文書 lint | 完了 |
| T08d | P3 | Windows ファイル識別番号の精度保持 | T08a | M | bigint 由来の損失のない識別、manifest 検証、設定・転送の衝突回帰が合格 | 通常 reviewer による解消確認完了 |
| T08 | P3 | 独立最終レビューと PR 更新 | T07,T08a,T08b,T08c,T08d | M | 別 reviewer による確認、コミット、push、PR に証拠と未検証範囲を記載 | 通常工程完了。最終判定・提出 HEAD は独立レビュー報告と PR #1 を参照 |
| F01 | P4 | Google OIDC、CIMD、refresh token | T08 | L | 公開用認証設計と一致し、実アカウントとの接続を確認 | 実 Google 本人登録成功、通常コード指摘解消、ChatGPT 認証待ち |
| F01a | P4 | 公開認証の回帰・再起動・拒否試験 | F01 | M | 誤ユーザー、改ざん、再利用、期限、クライアントと対象資源の照合を検証 | 公開16件を含む全体43件中42件成功・POSIX1件除外。実アカウントの接続はF03 |
| F01b | P4 | 設定補助と Windows 起動手順 | F01 | M | 秘密を公開せず設定し、継続起動と停止・再起動を確認 | 実設定・本人登録・保存領域保護・公開起動済み。接続後の実再起動確認はF03 |
| F01c | P4 | 保存領域保護と既存操作の回帰修正 | F01a,F01b | M | 厳密な権限確認を維持し、既存のプロセス・転送・認証試験と Node 22 全体試験が成功 | 96b10cdで全体43件中42件成功・POSIX1件除外・失敗0件。NR010を含む通常コード指摘解消 |
| F01d | P4 | 公開独立指摘の認証制限と文書修正 | F04 | M | REMOTE-IFR-001〜003 の修正、実HTTPでの無効要求後の正常認証、通常・同一独立担当の限定確認 | c58352dで修正・全体43件中42件成功・POSIX1件除外。通常と同一独立担当の確認待ち |
| F02 | P4 | ノード間相互認証・複数PC経路・再接続 | T08 | L | 登録2台以上、切断・世代交代・再送・転送中継の試験が合格 | 後続 |
| F03 | P4 | 単一 PC の Tailscale Funnel と ChatGPT 公開接続検証 | F01,F01a,F01b,F01c | M | 実際の公開経路から認証と操作、再起動後の接続を確認 | 公開起動済み。HTTPSの認証案内と未認証401確認、ChatGPT実操作を利用者へ依頼中 |
| F04 | P4 | 公開接続の通常・独立レビュー | F01a,F01b,F01c | M | Sol / high で公開用変更を確認し、F03 の実運用結果と未検証事項を区別 | 通常10件解消後、3ffd783の独立レビューで追加3件。F01dで対応し同じ独立担当へ限定確認 |
| R54-01 | P5 | PR #54 Windows shard 1/3 の緊急停止・作業ディレクトリ検証競合失敗を調査し、原因が実装なら最小修正 | PR54 HEAD 6b3df248、R54-02 | M | 失敗原因をログ・fixture・本番経路で特定。必要なら縮退fixtureにせずTDDで修正し、対象テストと関連検証を実行 | NR-003の50ms timing oracleを決定的barrierへ修正。新しいWindows未処理I/O失敗（37133047283、NR-004）を調査しtest fixtureを追加修正。全ローカル回帰126件中115 pass/11 skip/0 fail、build・lint成功。修正後Windows CI run 37139053445成功。親のFA780 UI確認待ち |
| R54-02 | P5 | PR #54 の編集summary focus復元とrefresh/save応答順のP2指摘を同一通常レビュアーが修正確認 | R54-01 | S | stable report IDs PR54-NR-001/002で元HEAD・箇所を対応付け、修正HEADのfocused検証とP2 severity維持を記録 | 同一通常レビュアーがPR54-NR-001〜005を確認済み。exact-head Windows CI run 37139053445成功。親のFA780 UI確認待ち |
| R54-03 | P5 | PR #54 の既存編集UI 7ケースの実ブラウザ確認 | R54-01,R54-02 | S | 編集draft/focus、他画面更新、保存待ち追加入力、409二択、相対時刻・詳細開閉の7ケースについて対話ブラウザ成功を確認。UI対象ファイル差分がない後続report-only commitへ証拠を適用し、UI変更時だけ再実施 | 親から7ケース実ブラウザ成功の報告あり。`ce3d394`〜`8b5c5059` にUI製品ファイル差分がなく、既存UI確認は現HEADにも適用。URL/titleの新UI確認はR54-09で実施 |
| R54-04 | P5 | Windows shard 1/3のprocess snapshot fixture終了後に発生する非同期audit ENOENTの原因調査・修正 | R54-01 | S | run 37133047283のexact errorをproduction watcherとtest fixtureに照合。試験対象のスナップショット保証を保った最小TDD修正をし、同reviewer確認と修正後Windows CIで検証 | fixtureを完了processモデルに修正。通常review完了、修正後Windows CI run 37139053445成功 |
| R54-05 | P5 | Windows shard 1/3のIssue 13テスト終了後に発生するprocess watcher ENOENTのサービス終了競合を修正 | R54-01,R54-04 | M | run 37134613123のexact errorをclose/watcher/test cleanup経路と照合。closeでin-flight観測をdrainし再登録を抑止するTDD回帰を追加、同reviewerと修正後Windows CIで検証 | TDD修正済み。focused 4/4・全体130件中119 pass/11 skip/0 fail、check/build/lint成功。watcher拒否時もtransfer/backend cleanupを試行し元エラーを維持。同reviewer再確認で新規指摘なし。修正後Windows CI run 37139053445成功。親のFA780 UI確認待ち |
| R54-06 | P5 | PR #54 independent review のIFR-001/002修正とレビュー履歴の確定 | R54-01〜R54-05 | S | PR本文の非close参照化、決定的access-denial回帰、通常修正確認、同一独立reviewerのfinding closureを記録。旧attestation失敗と撤回を保持し、以後の全Issue実装完了時に新しいfinal境界を設定 | PR本文は `Refs #48`。X_OK拒否PATCH 400/値version不変のTDD試験、通常reviewer IFR-002/P2 checked_no_finding。独立reviewerは `7b44f84` でIFR-001/002を元のP2のままchecked_no_finding、技術判定`pass_with_held`。report-only attestation `2e9b80b` はrun `37143362177` のMD060失敗で撤回（PR comment `5972984838`）。修正commit `8b5c5059` は同一reviewerが報告書MD060修正をchecked_no_finding、Markdown 89 files/0 issues。8b5c5059のexact-head CIは10分待機しても未出現。撤回済みattestationを現行完了証明に使わず、通常開発は継続し、全スコープ後に新しいfinal境界を設定 |
| R54-07 | P5 | PR52共有リンク処理をPR54後編集へ統合する設計・TDD計画 | R54-06 | S | 共有API境界、複合PATCHの原子性、`version` と `linkRevision` 分離、疎な更新、取得リース競合、監査/通知値除外、終了消去、CIDR全面拒否を設計に記録。正常・失敗・競合の合成fixtureをTDDケース化。共有実装を複製しない | 設計とTDD計画を保存し `b2d7695` でpush済み。IANA special-use親範囲と具体的例外を含む全面拒否を採用 |
| R54-08 | P5 | PR54編集APIへのPR52共有リンク処理の統合 | R54-07、PR52共有モジュール公開 | L | `PATCH /api/sessions/:sessionId` がworkdir/purpose/linkを一括更新し、owner/CSRF/active/expiry/stop/versionを再確認。省略・`null`・空文字の意味とcamelCase PATCHからconsole-state snake_caseへの対応を固定。入力不正は部分保存なし。`version` は利用者更新で一度、`linkRevision` はリンク意図変更で一度。取得はcommit後、audit等へ値を出さず終了後に適用しない。 | PR52最新 `b03c72b` の共有 `src/session-links.ts` とテストをそのまま維持。複合PATCH、型不正拒否、URL解除/manual題名保持、空題名再取得、console-stateから内部世代除外、audit rollback中に完了したfetch保持を実装・回帰済み。Issue48 APIケースは統合候補で5/5 pass。 |
| R54-09 | P5 | PR54 console-state・編集UIへのURL/title統合 | R54-08 | M | 所有者の稼働中sessionにURL/title/source/statusを返し、疎な意図差分だけPATCH。manual/fetched表示、安全なhref/textContent/rel/referrer policy、fetch完了中の編集保持、409二択、失敗保持を確認。 | server/client編集フォームへURL/titleを統合。自動更新停止中の `session-link-updated` はrefreshしないPR52最新修正を反映し、回帰追加。Chromium headlessで7ケース確認し、editor/fetched/manual-only/conflict PNGを保存。フォームの横潰れを確認して縦積みの編集レイアウトを追加。 |
| R54-10 | P5 | Issue #48全体の統合回帰・通常レビュー・修正確認 | R54-08,R54-09 | L | 既存workdir/purposeとURL/titleの認可・原子性・非同期競合・監査/終了・表示を合成データで検証。check/build/lint/全体試験、通常レビュー、必要な修正確認を完了し、新しいレビュー候補HEADを確定。 | main `4cd9f8d` を統合しKERO-48-001修正とPR52共有commit `362fc2f` を保持。candidate `4149ff5` で204件中193 pass/11 skip/0 fail、check/build/TS lint/Markdown lint/design terms/diff-check成功。通常レビューPR54-NR-008/P2はTDD修正と同一reviewer focused確認済み。初回独立review RDMCP-48-54-IFR-001/P3がphase/task trackingの状態不一致を指摘し、両一覧の同期とMarkdown確認後、同一通常reviewerがRDMCP-48-54-IFR-001/P3をchecked_no_finding。同じ独立reviewerの限定closure待ち。exact-head CI未実施 |
| R54-11 | P5 | Issue #48完了候補の新しい独立最終レビューとexact-head CI | R54-10 | M | 全Issue受入条件を含む新しいimplementation HEADに対し、通常修正確認後に新規final境界・予約を設定し独立レビュー、報告attestation、正確な最終PR CIを完了。撤回済みattestation/古いreviewを新完了証明として流用しない。PRは利用者の明示指示なしにmergeしない | exact-head local gate後の初回独立reviewは`4149ff5`にRDMCP-48-54-IFR-001/P3を発見（phase/task trackingの状態不一致）。両一覧の同期は同一通常reviewerがRDMCP-48-54-IFR-001/P3をchecked_no_finding。次に同じ独立reviewerへそのfindingだけの限定closureを依頼する。closure pass後に一度だけattestation commit、通常push、attestation HEADのCIを行う |
| T09 | P4 | Issue #55: 長時間実行プロセスの目的・コマンド表示 | T08 | M | 設計レビュー、Red/Green、所有者・認可・マスク回帰、Windows実画面確認手順と証拠、Draft PR | PR #60 `ed4d9b9` がmainに統合済み。Issue #55の設計・実装・レビュー・Windows UI証拠はmainに保持 |
| T10 | P5 | P1 Issue #46: User Console 自動更新と選択保持 | なし | M | 一覧と交差するlive Rangeの間は破壊的更新を保留し、解除後に最新状態を反映。`pagehide` / 認証失効で保留破棄。PR #50日時表示とPR #60の長時間process context/active-firstを併存。通常・独立レビューと統合後CIを完了 | PR #51 `bfe3793` がmainに統合済み。Ubuntu・Windows 3 shard CI、通常/独立レビュー、FA780 UI 9ケースの証跡を保持 |
| T11 | P6 | Issue #56 の共有作業一覧と更新期限制御 | なし | L | 利用者決定（セッション単位・初期有効・有効化後5分猶予）を反映した設計を独立レビューし、合格後にテスト駆動で実装。Todo更新と安全例外、所有境界、期限境界、失敗・時計異常の検証と通常レビューを完了。latest main + PR #60を保持して回帰し、reviewを通す | 設計レビューDREV-56-01/02解消。実装、focused 23/23、TypeScript・lint成功。通常レビューNREV-56-01〜03をTDD修正。main `4cd9f8d` をPR #54のローカルmerge候補へ統合。全体204件中193 pass/11 skip/0 fail、check/build/TS lint/Markdown lint(119 files)/design terms/diff-check合格。通常review PR54-NR-008/P2をTDD修正、同一reviewer focused 12/12で解消確認。RDMCP-48-54-IFR-001/P3のtask/phase追跡修正は同一通常reviewerがchecked_no_finding。同じ独立reviewerの限定closure待ち。exact-head CI未実施 |

S/M/L は相対的な作業規模であり、所要時間の保証ではない。
T11 の設計と現行コードに基づく保存/API/時計/監査/終了確認案は `doc/design/shared-todo-and-stale-update-gate.md` に記載。初回設計レビューDREV-56-01、選択反映後レビューDREV-56-02は修正差分の限定確認で設計上解消し、過去のfail判定は報告に保持した。2026-10-03の利用者決定はセッション単位・初期有効・有効化後5分猶予。有効なTDD Redは `reports/issue-56-tdd-tests-red-evidence-20261003202741.md` を参照。通常レビュー報告 `reports/issue-56-normal-review-20261003213135.md` は対象HEAD `d00909e35028dd7ded72130d317e2d0d41afd60e` に3件のmedium findingを記録し、TDD修正を `8586650` へコミットした。PR #51 merge SHA `bfe3793` とPR #60 merge SHA `ed4d9b9`を含むlatest mainを `origin/main` として統合。統合後focused regression・同一normal reviewerのfix verification・matching CIは未完了。設計確認報告は `reports/2026-10-03-issue-56-design-review.md`。
コードの結合が強いため T03〜T06 は同じ Terra 担当が依存順に実装する。
設計作業の既存レポート: `reports/2026-09-25-design-followup.md`。
環境確認: `reports/2026-09-25-environment.md`。
T01 の severity と finding ID は元レビューから変更しない。
設計レビュー: `reports/2026-09-25-normal-review.md`。`320ddb6` の設計は `pass_with_held`、実装の競合試験による指摘完了確認は T05〜T07 で行う。

## 検証状態

`local_execution_available`。実装検証、review-target commit、push、CI はそれぞれ別に記録する。
初回 `npm.cmd ci` は成功。初回の check、build、lint、3件の結合テストが成功した。
固定版 Desktop Commander の実起動、HTTP MCP の認証、転送競合とプロセス出力を確認した。
個別の境界ケースと後続の修正検証は、通常レビューと実装報告で追跡する。
`4eee364` の通常レビューは fail。Node22 は1件合格・2件キャンセルであり、Node24の3件合格と区別する。
全依存 audit は更新後0件。通常レビューの7件と、元の3件の不足証拠に対応している。

修正後の Node 22.23.3 全体試験は終了コード0、12件合格、失敗・キャンセル・スキップ0。詳細は `reports/2026-09-25-regressions.md` と `reports/2026-09-25-review-fixes.md` を参照する。

`23bd136` の再レビューで DR-001/002/003 と NR-001/002/005 の解消を確認した。
NR-003/004/006 は残存し、NR-007/008 を追加した。12件合格だけでは全件取得や起動時清掃の所有証明を満たさないため、T07d で試験も補強する。

`e66229e` は Windows ローカルで12件合格。PR CI run `36034757381` では Ubuntu が11/12、Windows が10/12で失敗した。
通常レビューは NR-003/004/006/007/008 の定義済み修正を確認したが、DR-003 を再開し、Windows の委譲失敗を NR-009 / High とした。
設定ファイルが起動中に置換される経路と CI 環境の委譲を T07e で修正する。

`230af93` の CI run `36036096436` は Windows が成功、Ubuntu が11/13で失敗した。
設定実体の保護を管理領域内の保持リンクで検証する方式へ変え、再起動と通常ファイルの作成・削除を加えたローカル試験は13/13で成功した。
DR-003 と NR-009 の完了は次候補の両 OS CI と同じ reviewer の確認後に判断する。

最新状態: `2775a65` の通常レビューは pass。DR-001〜003 と NR-001〜009 は元の severity のまま解消確認済み。両 OS の PR CI run `36039277467` も成功した。T08 の最終判定と提出 HEAD は `reports/2026-09-25-independent-review.md` と PR #1 で追跡する。

独立初回の対象 `eed5623` はローカル全検証と両 OS CI run `36039742238` に成功したが、独立レビューは追加7項目で fail。
正式 ID は `RDMCP-MVP-IFR-001〜007`。過去の trust model に関する `RDMCP-IFR-001/002` と区別する。
必須対応と証拠は `reports/2026-09-25-independent-fixes.md` で追跡し、通常の修正確認後に同じ独立 reviewer へ限定確認を戻す。

`6a1c5ab` の修正候補はローカル20/20合格。PR CI run `36042688392` は Windows20/20成功、Ubuntu19/20で設定置換別名の試験が失敗した。
通常の限定レビューでは MVP-IFR-001/003/005/006/007 の修正を確認した。002は設定実体の捕捉と試験の保証範囲を確認し、004は100ページを超える出力を次回監視へ引き継ぐ処理を補修する。

その後の全体試験は21件中20件合格で、通常ファイルが保護対象と誤認される失敗が1件あった。
設計担当の読み取り確認で、この NTFS 上の inode `16888498602727127` が通常の Node stat では `16888498602727128` に丸められ、隣接番号と衝突することを確認した。
失敗した個別 fixture との直接の同一性は未確認だが、識別番号の精度喪失は実在するため T08d で設定・転送の識別を損失のない表現へ修正する。

`0696dee` はローカル23/23合格。PR CI run `36045163545` の Ubuntu は21/23で、再起動時の pin 再試行不足と、更新中の設定パスを比較した digest fixture が失敗した。
004の101ページ出力は解消確認済み。002の更新待ちを有界な backoff で扱い、同じ保持 inode の比較と bigint の試験表現へ統一する。

`00e6939` はローカル24/24、Ubuntu CI24/24成功。Windows CIは23/24で、清掃後の pin 一覧が空にならないと仮定した fixture が失敗した。
製品の起動時清掃は正当なため、fixture が検証用 pin を明示的に捕捉する手順へ修正し、同一候補の両 OS 成功を確認する。

修正候補 `2d5be223ea52af35a8c0f29c7ace74362ff9b1cd` はローカル24/24、PR CI run `36047156609` の Windows/Ubuntu が各24/24成功した。
同じ通常 reviewer は pass とし、MVP-IFR-001〜007を元の severity のまま解消確認した。非最終の報告・引継ぎ・Skill 改善判断を確定し、独立 reviewer の同一担当へ限定確認を戻す。
最終独立判定と報告専用コミット、最終 HEAD の CI は `reports/2026-09-25-independent-review.md` と PR #1 を最終記録とする。この一覧は独立判定を先取りしない。
