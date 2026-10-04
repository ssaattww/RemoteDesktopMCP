# Task 一覧

更新規則: このファイルは `task-breakdown-planner`、`task-consistency-manager`、`progress-sync-manager` を通してのみ更新する。

## 現在の対象

現在の優先作業はIssue #24のP5。R24-05のPR #66は最終レビュー合格・測定記録済みだが、全workflowが180秒を超えるためIssueは未完了。R24-06は8分割のみを変える実装を別枝で行い、TDDとローカル全検証を通過、通常レビュー待ち。通常レビュー後に未適用CI×3、単独測定、manifest適用、適用後CI×3を行う。P4公開接続の記録は維持し、複数実行PCとChatGPTの実操作は対象外。PR #62のfixture-init改善は別branchに保ち、今回の比較に混ぜない。

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

## Issue #24 の継続作業

| ID | Phase | 内容 | 依存 | 規模 | 完了条件 | 状態 |
| --- | --- | --- | --- | --- | --- | --- |
| R24-01 | P5 | PR #42 測定gate修正と実測証跡 | なし | M | 同じPR/head/attemptの成功測定stepと有効artifactだけを既測定扱いし、通常reviewと実測結果をIssue #24へ記録 | 完了。通常review `pass_with_held`、run `37131069186` 成功、16ファイル各3回の中央値をIssue #24へ記録 |
| R24-02 | P5 | 計測に基づく不要なfixture初期化の削減 | R24-01 | S | DR002/NR009の既存assertion・実Commander・ACL・隔離tempを保ったまま重複初期化を省き、試験・review・ローカル/リモート検証を完了。性能効果が比較可能な条件で未確認なら未確認と報告する | 実装・通常review `pass_with_held`・独立最終review `pass_with_held` 完了。PR #62 exact-head CI `37143566328` はUbuntuとWindows 3 shard成功。測定 `37138740545` は48/48 successだが必須CIと一部並行したため因果効果は未確認。manifest未適用。詳細は `reports/2026-10-03-issue24-fixture-init-independent-final-review.md` と `reports/2026-10-03-issue24-fixture-init-pr-ci-measurement.md`。PR #62はdraft/open、未merge |
| R24-03 | P5 | `regressions.test.ts` 29ケースを意味単位へ分割し、実行時間への影響を測る | R24-02 | M | 設計レビュー後にTDDで分割。29ケースがcase名とcallback本体を保って各1回だけ存在し、assertion・実Commander/ACL・ケース隔離/cleanupを維持。分割前後のケース対応・focused/all-suiteテスト・ファイル/CI所要時間を比較可能な条件で検証し、通常reviewと両OS exact-head CIを通し、別branchのdraft PRでIssue #24へ記録 | 作業完了（3分未達の結果を記録）。候補`aec94a9`、29/29 callback本文一致、`npm test` 134件（123 pass/11 skip/0 fail）、focused移動先30件成功、check/lint成功。通常review `pass_with_held`。PR #63 exact-head run `37151708780` attempts 1/2/3 success、workflow全体中央値364秒、最大Windows Test step中央値272秒。測定run `37155306957` は22ファイル×3回66/66成功。Issue #24にrun/job/step秒と個別測定、runner差による因果推定の制限を記録。PR #63はdraft/open・mergeableでbaseから単独統合可能。独立最終review/統合は未実施・未merge |
| R24-04 | P5 | `independent-fixes.test.ts` 8ケースを意味群へ分割し、次のCI律速を短くする | R24-03 | M | 設計レビュー後、TDDでIFR-002履歴2件、IFR-003/006転送2件、IFR-001/004/005プロセス4件を3ファイルへ移す。全8 case名/callback本文/fixture/cleanupを各1回保つ。focused/all-suite/check/lint、両OS exact-head CIを通し、Windows CI 3回中央値と候補全test file×3成功測定を取り、Issueへ記録する。比較中に別runを重ねず、PR #63本体へ混在させない | PR #64で実装・通常review `pass_with_held`・測定を完了。実装 `a36baa5`、最終head `d247550`。8/8 test名/callback AST一致、focused 9/9、全体134件（123 pass/11 skip/0 fail）、check/lint/diff-check成功。必須CI run `37162238897` はattempt 1/2/3すべて同一HEADで成功。required workflow 345/352/337秒（中央値345、最大352）、最大Windows Testは260/262/253秒（中央値260、最大262）。測定run `37165502429` は24ファイル×3の72/72成功、artifact SHAとmanifest medianを照合。別PR #52/#54 runの並行報告があり、repo-wide非並行性・因果効果は認定しない。3分未達。PR #64 draft/open/unmerged。詳述は `reports/issue-24-r24-04-measurement-run-37165502429-validation-20261004045000.md`。 |
| R24-05 | P5 | Windowsを5分割し、正確な測定時間表を使う割当で律速時間を短縮できるか評価 | R24-04 | M | 設計確認後、5分割のみの最小候補を作る。未適用段階で同一候補の必須CIを3回成功させ、基準割当を許容しつつ5分割全体の無重複・全件網羅を確認。全ファイル×3測定→内容確認→時間表登録→新しい完全変更識別子で`applied`確認→同一識別子の必須CI3回成功を行う。Ubuntu全件とWindows全件を維持し、PR #63基準の最大Windows Test中央値から80秒以上の削減を評価する。3分達成は別に各3回の全workflowが180秒以内かで判定。PR #62変更を混ぜない | 5分割実装・通常review・測定72/72・manifest適用後CIを完了。最終候補`3b5f24565dec2fcf21f92ac22286ab8e913efecb`のrun `37176081921`は3 attempts全success/applied。KERO-R24-05-001の時刻定義を訂正し、PR #66は最終レビュー合格。主指標267/266/276秒（中央値267、最大276）、副指標267/267/277秒。Windows Test最大step174/183/176秒（中央値176、最大183）、PR #63との差は観測比較で因果効果未認定。assignment JSONと取得範囲を保存。docs-only修正HEAD `df59c11f4bf9a97f4222d7dd02eddc162fcc8c22`のrequired CI `37178271237`全success。PR #66 draft/open/unmerged。Issue #24未完了。 |
| R24-06 | P5 | P0候補: Windowsの5分割を8分割に増やし、最大試験工程と全体所要への影響を評価 | R24-05 | M | 8分割だけを変える候補を作る。設計レビュー後、未適用/基準割当段階の同一HEAD CIを3回成功させ、8割当の全件・無重複とUbuntu全件を確認。全test file×3をWindows Node 22で測定し、成果物内容を確認後、新時間表を登録。新HEADで適用と8分割を確認し、同一HEAD必須自動確認を3回成功させる。必須CIと測定は重ねない。各回の主指標、副指標、各処理・工程、最後の処理、最大Windows試験工程を個別記録する。8分割採用には最大Windows試験工程中央値<176秒、全体主指標中央値<267秒、全体最大≤276秒をすべて満たす。片方のみ改善なら採用しない。因果効果とは言わない。提案62号を混ぜず、全体主指標3回すべて180秒以内でない限りIssue未完了とする | 設計通常reviewと親最終reviewは合格。erratum `eca2960`でR24-05最大Windows Test範囲を174〜183秒へ訂正。別枝 `issue-24-r24-06-eight-shard-implementation` で8分割wire-upと契約テストをTDD実装。focused test、全体135件（124 pass/11 skip/0 fail）、check/build/lint/Markdown lint/diff-check成功。実装者報告 `reports/issue-24-r24-06-eight-shard-implementation-20261004052941.md`。現在通常レビュー待ち。以降、未適用CI×3、単独測定、manifest適用、適用後CI×3が残る。時間表の現測定値を8分割にLPT再割当した最大推定178.3秒は全体所要の予測ではない。PR #62を比較に含めない。レビュー詳細: `reports/issue-24-r24-06-design-review-20261004060000.md`。 |

S/M/L は相対的な作業規模であり、所要時間の保証ではない。
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
