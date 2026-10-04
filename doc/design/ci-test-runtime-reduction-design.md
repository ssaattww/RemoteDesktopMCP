# テスト実行時間を短くする設計

## 状態と対象

本書は変更要求42の第1段階を実装する設計である。製品実装と自動処理手順は、本書で確定した契約に従う。認証、認可、HTTP、転送権限、ファイル操作、プロセス、MCP、Windowsを含むOS検証を削除したり、開発者の端末だけで動く確認へ移したりしない。現行の必須OSで実行するテストをすべて残す。重いテストを端末側へ移す第2段階は対象外である。

約3分は目標であり、実測結果ではない。達成は条件を満たす実測値で判定する。既存実行37015529019はUbuntuの静的検査失敗を含むため、性能比較の成功記録として扱わない。

## 必須確認と実行時間

[必須確認の定義](../../.github/workflows/lint.yml)では、Ubuntuが静的検査、型確認、生成、全試験を行い、Windowsの各分割処理が型確認、生成、試験を行う。Ubuntu側の全件実行を維持する。Windows側の分割試験では、組込分割機能を使わず、割当規則が決めたファイル名を個別に実行器へ渡す。認証、認可、HTTP、転送権限の試験を含め、集合Uの全件を両OSで実行する。

必須確認の主指標は自動処理の作成から全確認の完了までとする。副指標は実行開始から全確認の完了までとし、待ち行列を除いた経過として併記する。基準と変更後は同じ定義で成功実行をそれぞれ3回取得し、中央値と最大値を比較する。各回の所要時間と最大値も記録し、中央値だけを根拠に約3分の目標達成や課題完了を判定しない。3回すべての主指標が180秒以内であることを目標達成条件とする。失敗実行は原因調査に保存するが成功記録や実行時間表には使わない。処理単位の時間の合計や試験器単体時間と区別する。必須確認とは別に動かす測定用自動処理の所要時間は独立して記録し、必須確認の時間に含めない。基準実行が3回揃うまでは短縮率を報告しない。

## 試験準備の監査と候補

現行の共通準備処理は一時領域に一意な場所を作り、サービスを初期化し、保護領域を用意し、パスワード照合値を計算する。各準備処理には個別の作業場所があり、終了時に後片付けする。共有される親の検証場所はあるが、並列試験の書込先は分離されている。独自準備を持つ試験も同じ監査対象とする。該当箇所は[共通準備処理](../../test/fixture.ts)と[独自準備試験](../../test/mvp.test.ts)である。

準備時間と後片付け時間を同じ環境で測り、遅い処理だけを検討する。共通準備で毎回生成していた試験用パスワードの照合値は、検証済みの固定値へ置き換える。固定値を使う場合も、正しい試験用パスワードを照合でき、誤ったパスワードを拒否することを試験し、認証試験を維持する。通常サービスを起動した直後に別設定のサービスへ置き換える試験や、別のプロセス処理設定でサービスを作り直す試験では、明示した設定で最初のサービス初期化を省略できる。共通準備処理の既定動作は従来どおり初期化し、各試験の作業場所、データ領域の保護、終了処理を維持する。サービス、認証状態、ファイル状態を試験間で共有しない。並列利用、後片付け失敗、プロセス残存、環境変数汚染、生成物の競合を先行試験で確認する。試験単体の前後測定と必須自動確認の実測で短縮効果を確かめ、短縮しない変更は採用しない。

## テスト集合とファイル名の契約

Uは版管理対象の`test/**/*.test.ts`全ファイルを正規化して昇順に並べた集合とする。未追跡ファイルを加えず、Uが空なら失敗とする。名前の区切りを/へ揃える。許可する名前は作業場所からの相対名で、同じ指定形式に一致し、実在する通常ファイルであること。絶対名、装置名付き絶対名、逆斜線、空要素、.または..の要素、許可外の場所や拡張子、重複、作業場所外を指すシンボリックリンクを拒否し、理由を記録して実行前に失敗する。

割当の生成時と各分割での実行前に、名前の正規化、許可範囲、重複、Uとの全体一致、分割同士の重複なし、全ファイル各一度を検証する。実行時に再検索してファイルを加えず、明示された名前だけを渡す。分割数は正整数とする。対象が空の分割は許可し、試験を起動せず、空であることを記録する。Uが空である状態とは区別する。

### 回帰試験の意味単位への配置

`test/regressions.test.ts` の29件は、次の7ファイルへ意味単位で分ける。この整理ではテスト集合U、テスト名、関数本体、検証項目、実際の`Commander`使用、各テストのサービス、MCP接続、一時領域、後片付けを変えない。各テストは移動先に一度だけ置き、旧ファイルには残さない。共有する可変状態を導入しない。

| 新しいファイル | 移動する既存テスト | 維持する境界 |
| --- | --- | --- |
| `test/tool-root-contracts.test.ts` | `Issue 13: published tool descriptions match session, file-root, transfer, and process boundaries`; `Issue 20: root-scoped file operations expose their canonical path when the session CWD differs`; `Issue 9: sessions require a working directory and purpose, and commands start there` | 公開ツールの仕様、rootと作業場所が異なるときのパス、接続開始時の作業場所と目的 |
| `test/operation-audit-details.test.ts` | `built-in file tools persist structured operation details for user monitoring`; `failed upload commit does not expose existing destination content in operation detail`; `schema validation rejections persist safe operation detail`; `schema validation rejection bounds oversized comments before audit persistence`; `schema validation rejection bounds variable-length bodies before detail processing`; `successful upload commit detail is pinned to verified upload bytes`; `file transfer cancel detail includes the transferred position`; `long UTF-8 transfer previews remain text when the byte limit splits a code point`; `Issue 29: small transfers complete in one MCP call while large transfers keep the chunked fallback` | 操作記録の個人情報保護と関連付け、転送操作の詳細、単一呼出しと分割転送 |
| `test/config-transfer-integrity.test.ts` | `DR001: downloads use one immutable multi-chunk snapshot and clean failed snapshots`; `DR002: no-replace commit preserves a winner and removes the losing temp`; `DR002: upload begin fails safely when the destination lacks atomic no-replace support`; `DR003: protected config aliases cannot be read, searched, or reached by a swapped upload temp`; `DR003: a config replacement during pin linking preserves known history and the final config`; `DR003: exact bigint identity keys distinguish adjacent unsafe ids while preserving ordinary reads`; `DR003: protected identity manifests accept safe legacy values and fail closed on unsafe numeric values` | 変更不能な転送状態、上書きなしの原子的な確定、保護対象の設定識別、整数精度と一覧の検証 |
| `test/session-filesystem-lifecycle.test.ts` | `NR009: canonical allowed roots work through a symlink or Windows junction`; `NR002 and NR006: expiry sweeps cancel transfers, clean files, and list session state`; `NR008: startup preserves unowned lookalikes and removes only manifest-owned orphan artifacts` | Windowsの`junction`と`symlink`を介した正規root、接続と転送の期限切れ、所有元を確認する起動時清掃 |
| `test/search-process-lifecycle.test.ts` | `NR003 and NR004: searches return every page and portable Node processes retain output/audit`; `Issue 10: process_start inherits the service user profile environment`; `Desktop Commander stderr is drained before repeated get_config calls can block MCP` | 検索結果の全件、外部プロセスの出力・終了・監査、環境引継ぎ、実際の`Commander`の標準エラー読出し |
| `test/http-oauth-regression.test.ts` | `NR005: real HTTP OAuth validates PKCE, scope, redirect, replay, claims, and MCP file operations` | 実際のローカルHTTP接続、`OAuth`と`PKCE`、再利用・要求情報の検証、認証後のMCP操作 |
| `test/config-correlation-regression.test.ts` | `configuration rejects resolved overlap and traversal aliases`; `REV001: operation correlation ownership only accepts active owned sessions`; `REV001: accepted and rejected operations preserve safe correlation contracts` | 設定の重複・上位移動の拒否、有効な接続が所有する操作の関連付け |

分割時は対象版のテスト名一覧を基準に、29件すべてが正確に一度ずつ存在し、各関数の内容が保持されていることを機械的に照合する。R24-03当時の必須自動処理（Windows 3分割）の実行を確認する。分割前後の測定は次の手順で行い、結果を区別して記録する。

1. **同じ環境でのファイル実行時間**: Windows・Node 22の測定処理で、分割前の`test/regressions.test.ts`と分割後の7ファイルを各々明示して実行する。分割後は各ファイル3回の成功値の中央値を求める。分割前の基準値も同じ方法で3回取得する。比較値は、旧ファイル1個と新7ファイルの各中央値、および旧ファイルの中央値と新7ファイル中央値の合計とする。後者は逐次実行時の仕事量の比較であり、並列実行の所要時間とは呼ばない。失敗値は成功値の集計に含めず、別に記録する。環境識別値、`package-lock.json`の照合値、テスト起動方法が一致しない結果は比較しない。
2. **Windows必須自動処理の並列所要時間**: 同一の成功実行における全Windows分割の試験工程経過時間の最大値を並列試験の壁時計指標とする。実行開始から全必須確認完了までの時間は別指標として記録する。分割時間の合計やファイル時間の合計を壁時計値として扱わない。新旧それぞれ最低3回の成功実行の中央値を比較し、各実行の対象変更識別子、実行番号、開始・終了時刻、各分割の試験工程時間を保存する。既存の基準版`adb4e03cbd11bb47ef90d34a840e2ce6922dc572`には成功実行`37128379698`が1回あるため、これを基準標本の一つとして保持し、比較を完了する前に基準版で成功実行をあと2回取得する。1回ずつしか揃わない場合は参考値としてのみ報告し、改善の確証とはしない。
3. **実行順と同時実行の回避**: 基準版の成功実行を3回揃えた後、同じ版の測定処理を起動し、成功候補の記録を保存する。分割後も候補版の必須自動処理を3回成功させた後に測定処理を起動し、全7ファイル各3回の成功記録を得る。各段階で前の処理が完了したことをGitHub上の実行状態で確認してから次を起動する。必須自動処理と測定処理は同時に実行しない。測定処理は開始前に対象変更識別子と追跡済みファイル集合を確認し、実行記録および成果物の変更識別子が予定値と一致することを確認する。比較可能な基準記録が不足する間は速度改善を確定しない。

既存の基準版の測定実行`37131069186`は成功し、必須実行`37128379698`完了後に開始したため、同時実行のない基準測定記録として利用できる。ただし、これだけではWindows必須自動処理の3回比較条件を満たさない。新しい`test/**/*.test.ts`の集合には新しい照合値を用い、旧ファイル集合の実行時間表は再利用・適用しない。

### 独立修正試験の意味単位への分割（R24-04）

R24-03後も3分目標は未達である。提案63号候補の測定では、`test/independent-fixes.test.ts`の個別実行中央値は219.570秒（3回は210.849 / 219.570 / 228.065秒）だった。必須自動確認の第3再試行におけるWindows第2分割の試験工程は263秒で、同ファイルの8試験について出力に記録された`duration_ms`の合計は258.798秒だった。最長の単一試験はIFR-003の転送上限確認75.170秒である。この結果は同じ分割の一回の観測であり、他試験の同時実行や実行環境の違いを除いた因果測定ではない。3分到達を約束する予測値とは扱わない。

`TDD`で8試験を次の3ファイルへ移す。テスト名、`callback`本文、検証、実際のMCP/`ACL`経路、試験ごとの一時領域と`finally`後片付けを変更しない。共有の可変状態を新設しない。

| 移動先 | 既存試験 | 第3再試行の各試験`duration_ms`合計（参考） |
| --- | --- | ---: |
| `test/independent-config-history.test.ts` | IFR-002の履歴上限・保護、および保護設定の再試行の2試験 | 約83.325秒 |
| `test/independent-transfer-lifecycle.test.ts` | IFR-003の同時転送上限、およびIFR-006の複数分割送信の2試験 | 約104.078秒 |
| `test/independent-process-ownership.test.ts` | IFR-001のPID再利用、IFR-004の終了待ちと残存100頁排出、IFR-005の開始監査の4試験 | 約71.396秒 |

上表は一回の自動確認で記録された試験時間を意味単位ごとに足した参考値で、ファイルの経過時間や並列実行の壁時計値ではない。試験ごとの環境差、準備時間、子プロセス競合を含む候補実装の効果は、別の測定で判断する。R24-03と同じく試験名と`callback`本文の機械的な一対一照合を失敗・成功の証拠にし、各移動先の個別試験、全体試験、`check`、`lint`を実行する。

候補は提案63号の先端を基点とする別作業枝で維持し、R24-03単独の統合可能性を損なわない。提案62号の共通準備変更と`.github/test-duration-manifest.json`の導入は含めない。候補先端で必須自動確認を3回成功させ、その後に測定用自動処理を起動して、新3ファイルと全追跡試験ファイルそれぞれ3回の成功記録を取得する。必須自動確認と測定用自動処理は重ねず、現行候補の3回中央値（全体364秒、最大Windows試験工程272秒）を比較基準として保存する。新候補の実行時間表は対象ファイル集合の照合値が一致しないため再利用せず、実行時間表の適用は別作業とする。結果が3分目標に届かない場合、課題 #24は未完了のままにする。

### Windows 5分割の評価結果（R24-05、過去の構成）

R24-05ではR24-04候補`d2475500a5bcf1c7192c9619f3f367180063699d`を基点に5分割を評価した。必須自動確認`37162238897`は3分割・時間表なしの1回の観測であり、全体345秒、Windows試験工程260秒・218秒・195秒だった。この一回は最適化割当の証拠として扱わず、5分割の実測と混同しない。

時間表候補を測定・登録した後、最終候補の変更識別子`3b5f24565dec2fcf21f92ac22286ab8e913efecb`における必須実行`37176081921`は同一の変更識別子による3回すべてが成功し、時間表適用を確認した。主指標は267/266/276秒（中央値267秒、最大276秒）、副指標は267/267/277秒だった。各回の最大Windows試験工程は174/183/176秒（中央値176秒、最大183秒）。詳細は[R24-05測定検証報告](../../reports/issue-24-r24-05-measurement-validation-20261004034000.md)に記録した。

当時の80秒短縮基準（最大Windows試験工程の中央値が272秒から192秒以下）は176秒で満たした。3分目標は主指標が3回とも180秒を超えたため未達であり、課題24号も未完了である。R24-05で採用した5分割は履歴であり、R24-06の8分割が現行構成を置き換えている。5分割の基準割当、時間表、測定値は8分割の実行や採用判定に流用しない。

当時の測定で扱った提案62号の共通準備変更は別作業枝に留めた。`d247550`でのDR002・NR009全体の所要（約21.479秒、28.140秒）やNR008（約10.413秒）、`Desktop Commander`標準エラー試験（約16.403秒）は個別の起動費用ではなく、5分割の短縮原因を示す値ではない。これらの観測から因果的な改善とは結論しない。

### Windows 8分割の評価結果（R24-06、採用済み現行構成）

本節の3分割と5分割はR24-03とR24-05で行った過去の評価段階を指す。R24-06で採用した現行のWindows自動確認は8分割である。変更はWindowsの分割数、`matrix`、処理の表示名、`dispatch`、および分割数を確認する契約試験に限った。他の自動確認手順、必須OS、集合U、Ubuntu全件試験、各Windows分割の依存導入・型確認・生成・試験、認証・認可・HTTP・転送、`ACL`、プロセス、`MCP`境界は変えていない。R24-03/05の試験集合と測定値は当時の履歴・比較基準であり、現行の分割には使わない。

R24-06では、時間表登録前の候補の先端`SHA` `d434163103d72a2bd3631344641ee083606bd11f` で必須確認 `run` `37181068931` の実行回1/2/3が成功した。各実行回の成果物で8分割、全24追跡対象試験ファイルの無重複・全件割当、`baseline` と `fingerprint-mismatch` を確認した。その後、単独測定用`run` `37181912085` でWindows Node 22上の全24ファイルを3回ずつ測定し、72/72の成功記録、成果物の`digest`、全24中央値を検証した。この測定用`run`内の取得時の`sourceCommit` はGitHubが作成した統合`commit`の`SHA`であり、`PR`の`head`とは別の識別子である。

検証済み時間表を登録した`HEAD`は `e06cdcd77b03779284560f8eb76c5e47ec2e572c`、`PR #68`である。`manifest`の`fingerprint`は `fb3cfd123cbc57402e720eec0df9ed3b878803a789636bce77098f5ba3943957`。時間表のJSON形式、適用条件、基準割当への切替、失敗条件は変えていない。有効で環境が一致する時間表はWindows上で `optimized/applied` として選択された。時間表がない、古い、または照合値が不一致の場合、全分割が同じ基準割当へ切り替える。形式不正、安全でないパス、集合の不足・重複、自動確認情報の取得・検証失敗、適用対象環境の不一致は、定義済みのとおり実行前に失敗する。適用後の必須確認成果物3件（実行回1/3/4）は`fingerprint`一致、8分割、24/24ファイルの完全・無重複割当を確認した。実行回2も必須の全処理が成功し、計画成果物の送信成功を処理記録で確認したが、後続の再実行後にGitHubからその成果物ファイルを取得できなかったため内容照合には使っていない。実行回1/3/4の同一`HEAD`で成功と成果物検証を採用判定の3標本とし、実行回2の成功も補足記録する。

## 適用後の必須確認結果

所要時間は各実行回APIの `created_at` から、その実行回で最後に完了した処理の `completed_at` までを主指標とする。副指標は `run_started_at` から同じ処理の完了までである。実行記録の `updated_at` は主指標に用いない。各Windows `Test`時間は当該分割処理の`Test`工程開始から完了までで、各実行回の最大値を取る。最後に完了した処理と最大`Test`工程は別々に識別する。時刻はGitHub APIのUTC時刻を秒単位で計算した。

| 必須確認の実行回 | 主指標 (秒) | 副指標 (秒) | Windows `Test` 1〜8 (秒) | 最大Windows `Test` (秒) | 最後に完了した処理 |
| ---: | ---: | ---: | --- | ---: | --- |
| 1 | 249 | 249 | 162 / 141 / 133 / 133 / 91 / 92 / 102 / 74 | 162 | 分割1 |
| 3 | 251 | 252 | 164 / 156 / 135 / 97 / 113 / 90 / 81 / 84 | 164 | 分割1 |
| 4 | 248 | 249 | 160 / 153 / 130 / 123 / 114 / 105 / 111 / 93 | 160 | 分割1 |
| 中央値 | 249 | 249 | — | 162 | — |
| 最大 | 251 | 252 | — | 164 | — |

選定した3回は同じ`HEAD` `e06cdcd77b03779284560f8eb76c5e47ec2e572c` で、いずれもUbuntu全件処理、Windows分割処理1〜8、必須確認の全処理が成功した。適用後必須確認 `run`は `37185526999`。この`run`の実行回2も成功し、主指標245秒、副指標246秒、最大Windows `Test`147秒だったが、対応する成果物ファイルは後続の再実行後に取得不能となった。上の3標本は成果物ファイルの内容を実際に検証できた実行回1/3/4で固定し、実行回2を含めた場合の結論も記録する（4回の主指標中央値は249秒、最大251秒。最大Windows `Test`中央値は161秒、最大164秒）。

8分割の採用条件を判定する。

| 条件 | 必要値 | 実測値 | 判定 |
| --- | ---: | ---: | --- |
| 最大Windows `Test`中央値 | `<176秒` | 162秒（最大164秒） | 合格 |
| 全体主指標の中央値 | `<267秒` | 249秒 | 合格 |
| 全体主指標の最大値 | `≤276秒` | 251秒 | 合格 |

以上からR24-06では8分割を採用済み現行構成とする。`PR #68`は`draft`/`open`/`unmerged`で、統合していない。R24-05最終値（主指標267/266/276秒、最大Windows試験工程174/183/176秒）との観測差は、実行環境と負荷が統制されていないため因果的な改善証明とは呼ばない。測定表から`LPT`で算出した最大分割推定158.053秒も実測ではなく、実際の`Test`工程または自動確認全体の所要時間の予測として扱わない。

## 3分目標と課題24号の状態

8分割採用と課題24号の完了は別々に判定する。上記3回の主指標はいずれも180秒を超えるため、3分目標は未達である。したがって課題24号は未完了のままとし、全体主指標3回すべてが180秒以内という条件を弱めない。3分目標を満たさないことを理由に8分割採用閾値を変更せず、採用済みの8分割も過去の3/5分割へ戻さない。

## 割当計画と分割間の一致

計画生成はWindowsの前段に置く単一の準備処理で一度だけ行う。共通入力は完全な変更識別子、追跡済み対象一覧と内容照合値、実行時間表、対象環境、および同じ自動処理実行記録の`created_at`である。準備処理は`GITHUB_REPOSITORY`と`GITHUB_RUN_ID`から実行記録を取得し、`head_sha`、`run_attempt`、`created_at`を検証する。取得や検証に失敗した場合は割当計画を作らず失敗する。全Windows分割処理には同じ成果物を渡し、各処理はその内容を検証した後にのみ自身の明示されたファイル一覧を実行する。

有効な表がない、古い、または照合値が不一致であることによる基準方式への切替は、共有情報だけから判断する。準備処理は現在のファイル内容を表に記録された環境値と組み合わせて照合し、内容一致なら最適化方式を維持する。準備処理が動作した環境の差だけを理由に基準方式へ切り替えない。表が有効な場合は、表に記された対象環境を全分割が期待値として用いる。各分割は実環境とファイル内容から照合値を再計算し、表の期待値と照合する。不一致なら別方式へ切り替えず、試験前に明示して失敗する。これにより準備処理と分割処理の環境差を共有計画へ混入させず、実環境差で一部の分割だけ最適化方式となることを防ぐ。実行時間表がない場合は、共有されたUだけから基準方式を決める。

割当計画の生成とWindows分割間の受け渡しは必須経路である。準備処理は一度だけ計画を生成し、実行ID・再試行番号・変更識別子に結び付けた成果物として保存する。8つのWindows分割はその同一成果物を取得し、独立に再計算せず、試験開始前に共通計画と自分の実環境を検証する。計画生成、成果物の保存・取得・検証にかかる時間も必須自動確認の所要時間に含める。各分割は`shard-diagnostic.json`へ、計画照合値、方式、自身の番号とファイル一覧、全体検査結果、環境照合結果、構造化した安全な失敗理由を保存する。全体検査と環境照合はそれぞれ`success`、`failure`、`not_applicable`を区別し、基準割当では環境照合を`not_applicable`とする。診断ファイルを各分割の準備時に初期化し、割当処理前の失敗でも安全な初期状態を残す。診断成果物は`always()`でアップロードし、成功・失敗のどちらでも取得可能にする。失敗理由には固定コードだけを記録し、例外文字列や秘密値、環境の生値は記録しない。別OSでの全件実行は維持する。

## 割当方式と記録形式

基準方式は正規化したファイル名順で並べ、順番を分割数で割った余りに応じて固定配分する。

最適化方式は測定済み時間の長いファイル順に並べ、同じ時間ならファイル名順にする。現在の合計時間が最小の分割へ順に配り、同じ合計なら小さい分割番号を選ぶ。見積時間は各分割に配ったファイル時間の合計とする。記録上の各分割のファイル名は昇順にする。並べ替えは実行環境に依存しない文字順を使う。

割当記録はUTF-8のJSONとする。実装の検証関数が受理する完全な形式例を次に示す。この例は状態の組合せ、照合値、8要素の配列を実際の検証関数へ渡して確認した合成例である。説明を簡潔にするためUを1ファイルとしているので、7分割は空である。実際のR24-06では分割数は8、追跡済み試験ファイルは24件であり、全件を重複なく各一度割り当てる。

```json
{
  "schemaVersion": 1,
  "sourceCommit": "0123456789abcdef0123456789abcdef01234567",
  "workflowRunId": 123456,
  "runAttempt": 1,
  "shardCount": 8,
  "generatedAt": "2026-10-02T12:00:00Z",
  "fingerprint": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "mode": "baseline",
  "manifestStatus": "fingerprint-mismatch",
  "assignments": [
    { "shardId": 1, "files": ["test/example.test.ts"], "estimatedDurationMs": 0 },
    { "shardId": 2, "files": [], "estimatedDurationMs": 0 },
    { "shardId": 3, "files": [], "estimatedDurationMs": 0 },
    { "shardId": 4, "files": [], "estimatedDurationMs": 0 },
    { "shardId": 5, "files": [], "estimatedDurationMs": 0 },
    { "shardId": 6, "files": [], "estimatedDurationMs": 0 },
    { "shardId": 7, "files": [], "estimatedDurationMs": 0 },
    { "shardId": 8, "files": [], "estimatedDurationMs": 0 }
  ],
  "planDigest": "f8055b4a2ab1203aa42c5d3c1fb1220142cb775f7c06c2ebec2ab3112892980b"
}
```

Windowsの分割実行より前に、割当記録を一度だけ生成する準備処理を単独で実行し、`workflowRunId`、`runAttempt`、完全な変更識別子を含む名前で成果物として保存する。全Windows分割処理は同一の成果物を取得し、個別に計画を再計算しない。各処理は形式、完全な変更識別子、実行ID、再試行番号、全対象集合、分割間の重複なし、全ファイル各一度、全体ハッシュ値を試験前に検証する。検証後は自身の分割に記録されたファイル名だけを試験器へ明示して渡す。成果物の取得または検証に失敗した処理は試験を成功扱いしない。空の分割では試験器を起動しない。

最適化を選んだ場合、各Windows処理は実行前に作業場所の内容と自身の実環境から照合値を再計算し、計画に記録された`fingerprint`と一致することを確認する。不一致なら試験前に失敗し、個別に基準方式へ切り替えたり計画を再生成したりしない。基準方式を選んだ計画では実行環境照合を行わない。共有計画の全体ハッシュ値は全項目から決定的に計算し、変更や破損を試験前に検知する。

文字列値の許可集合は次のJSON値で表す。

```json
{
  "mode": ["baseline", "optimized"],
  "manifestStatus": ["applied", "missing", "stale", "fingerprint-mismatch"]
}
```

この例は各項目に設定できる文字列値を示す。生成日時は共通取得した当該実行記録の`created_at`をUTC日時として記録する。全体ハッシュ値はその欄自身を除く全項目を、宣言順のキー、UTF-8、空白なしのJSON表現でSHA-256計算した値とする。分割は番号順に並べ、各分割内のファイル名は正規化名の昇順とする。各分割はすべての項目と全体ハッシュ値を独立に計算して比較し、一致しない場合は試験開始前に失敗する。実環境との照合結果など、分割ごとの実測値は全体ハッシュ値に含めない。記録は各分割の診断用領域へ保存する。

## 実行時間表の形式、照合、適用規則

実行時間表は`.github/test-duration-manifest.json`で管理する。測定処理は候補を成果物として作るが、自動の変更登録や枝の更新はしない。採用時は親が確認できる変更として表を更新する。`sourceCommit`は生成元の情報に限り、現行の変更識別子との一致や祖先関係を適用条件にしない。適用判断は照合値、鮮度、形式、対象環境で行う。

表の項目名と構造は次のJSON例に示す。

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-02T12:00:00Z",
  "sourceCommit": "0123456789abcdef0123456789abcdef01234567",
  "fingerprint": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "environment": {
    "runnerLabel": "windows-latest",
    "runnerOS": "Windows",
    "process.platform": "win32",
    "process.arch": "x64",
    "os.release": "10.0.26100",
    "nodeVersion": "v22.20.0",
    "npmVersion": "10.9.3",
    "packageLockSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  },
  "files": [
    { "path": "test/example.test.ts", "medianDurationMs": 125 }
  ]
}
```

環境情報は実行環境の識別値、`nodeVersion`、`npmVersion`、`packageLockSha256`を含む。前二者は実行Nodeと測定npmの正確な版である。`packageLockSha256`は対象`package-lock.json`の生バイト列に対するSHA-256であり、整形した依存一覧のハッシュではない。これら三つの値は環境の識別情報にも含める。

照合値はSHA-256とする。対象一覧はU、試験内の準備処理、製品コード、`package.json`、`package-lock.json`、割当・測定処理、関連する自動処理定義の追跡済みファイルとする。各ファイルの内容のSHA-256を名前順に並べ、ファイル名と内容値を`NUL`で、項目を`LF`で区切る。これに表に記録された対象環境を固定順で加える。固定順は`runnerLabel`、`runnerOS`、`process.platform`、`process.arch`、`os.release`、`nodeVersion`、`npmVersion`、`packageLockSha256`とする。`packageLockSha256`は依存定義ファイルの生バイト列から求める。秘密値や環境変数全体を含めない。

表は次の順で検証する。

1. 形式、項目の型、日時、照合値、対象環境の形式、重複名、許可範囲、有限かつ正の実行時間を検査する。不正な値や許可外の場所は表が古くても失敗とする。
2. 現行作業場所の内容と表に記録された対象環境から照合値を計算する。`sourceCommit`は生成元情報として保持し、現在の版との一致や祖先関係は要求しない。
3. 表がない、当該実行記録の`created_at`から表の`generatedAt`までが30日を超えた、または照合値が異なる場合は、全分割が基準方式を選ぶ。日時はUTCとして比較し、`generatedAt`が`created_at`より後なら未来日時として失敗する。経過時間が30日と等しい場合は有効、30日を超えた場合は古い表とする。期限判定は各処理の現在時刻や実行機の時計でなく、共通取得した同一実行記録の`created_at`を使うため、開始時刻の差によって方式が分かれない。古い表の名前は許可された相対名であることを確認する。許可外名、絶対名、親方向への移動、シンボリックリンク、形式不正は常に失敗とする。形式上合法でも現行Uにない古い名前は、照合値不一致による基準方式への切替対象である。
4. 照合値が一致する表は、ファイル一覧が現行Uと完全一致し、各ファイルの正の実行時間が一つずつあることを確認する。不足、余分、重複があれば失敗とする。通常の試験追加、削除、改名による照合値不一致は基準方式へ切り替わり、現行U全体を実行する。

形式不正と危険な名前は失敗させる一方、変更により古くなった合法な表は安全に切り替える。照合値が一致しているのに完全性が壊れている表を、基準方式へ黙って切り替えない。

## 測定処理と記録

手動起動の測定用自動処理を追加する。必須判定にはせず、必須自動処理から依存させず、通常の必須確認時間へ反復測定を加えない。必須確認との同時実行は実行環境の待ち行列へ影響するため、比較測定中は避ける。

測定環境はWindows・Node 22とし、必須のWindows実行環境と同じ試験起動方法を使う。各測定回でUの全ファイルを一つずつ明示して実行し、各ファイルを合計3回成功させる。起動から終了までを単調時計で測り、割当の見積りに使う。実行順は各回で回転させる。全ファイル3回の成功、同じ対象環境、記録保存を満たさなければ候補を作らない。各ファイル3値の中央値を候補時間とする。

1回のファイル実行につき1つのJSON記録を保存する。必須項目のJSON名を含む記録例は次のとおり。

```json
{
  "schemaVersion": 1,
  "status": "success",
  "file": "test/example.test.ts",
  "startedAt": "2026-10-02T12:00:00Z",
  "finishedAt": "2026-10-02T12:00:01Z",
  "monotonicDurationMs": 1000,
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "workflowRunId": 123456,
  "workflowJobId": 123456789,
  "runnerOS": "Windows",
  "runnerLabel": "windows-latest",
  "nodeVersion": "v22.20.0",
  "npmVersion": "10.9.3",
  "packageLockSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "schedulerArtifactVersion": 1,
  "exitCode": 0
}
```

記録にはさらに`nodeVersion`、`npmVersion`、`packageLockSha256`、`schedulerArtifactVersion`を含む。前の三項目は実行時間表と同じ意味である。`schedulerArtifactVersion`は割当成果物自身の`schemaVersion`を参照する正の整数で、初版は1とする。測定記録は独自の`schemaVersion`を持ち、両形式の版は別々に管理する。

```json
["success", "failure", "timeout", "cancel"]
```

所要時間は単調時計で測り、UTCの日時と混ぜない。成功以外の記録も診断用に残すが、候補時間には使わない。環境情報が異なる記録群を混ぜない。成果物名に実行番号、再試行番号、変更識別子を含める。秘密情報、接続識別情報、試験データを記録しない。

親の確認後に追跡対象の実行時間表へ反映するまでは、候補時間を必須分割へ適用しない。

## 先行試験、書式検査、受入

割当処理の必要最小の試験を先に作る。基準方式と最適化方式の同点処理、記録形式、ファイル名の正規化、安全でない場所と重複名の拒否、全件各一度の確認、空集合失敗と空分割成功を確認する。古い表でも項目型・実行時間・危険な場所の不正は失敗させる。テストの追加、削除、改名後は照合値が不一致となり、合法な古い表から基準方式へ切り替わって現行U全体を実行することを確かめる。照合値が一致する表の不足、余分、時間欠落は失敗させる。

分割間の試験では、異なる実行環境を模擬しても同じ共有入力なら同じ方式と全割当になることを確認する。一方の実環境だけが表の期待値と違う場合、その分割は方式を変えず試験開始前に失敗すること、表がない場合は両環境とも同じ基準割当になることを確認する。共通の`created_at`を引数として明示的に注入し、30日境界、未来日時、API取得失敗、応答の識別子不一致を試験する。各処理の現在時刻を進めても方式が変わらないこと、同じ入力から全割当と全体ハッシュ値が一致することも確認する。測定試験では実作業時間と待ち行列込みの時間を両方記録する。準備処理の変更では並列利用、後片付け失敗、プロセス残存、環境変数汚染、生成物競合を確認する。固定した失敗判定や実装を重複する模擬処理だけで、先行試験の失敗を作らない。

設計文書も既存の文書書式検査と用語検査の対象にする。一般説明は自然な日本語で記述する。固有名詞は辞書登録済みかを確認する。実際のJSON項目名やプログラム識別子を残す場合は、必要最小の候補と意味を親へ提示し、確認後にだけ辞書へ登録する。書式や引用で未承認語を検査対象から外さない。未追跡の保全証跡は変更せず、ローカル検査への影響と自動検査環境との差を報告する。

実装後はU全体をUbuntuで1回、Windowsの全分割で重複なく各一度実行し、必須OSでの検証を維持した証跡を得る。必須自動確認の全処理単位が最終変更で完了し、実行記録の`head_sha`が完全な変更識別子と一致することを確認する。実作業時間と待ち行列込みの時間を同条件で比較し、約3分の達成、表を更新できる条件、未達理由を分けて記録する。実測前に短縮達成を主張しない。

## 第2段階の境界

第2段階は別承認であり、本書の対象外である。必須自動確認の認証、認可、HTTP、転送権限、ファイル操作、プロセス、MCP、OS検証を削除しない。移動を提案する場合は、対象試験、代替実行先、失敗検知能力と第1段階の同一条件比較を別途確認する。

## 第1段階の実装要件

1. 実行時間表と割当記録の形式、照合値、検証順序、切替条件、失敗条件を実装する。
2. Windows分割に先行する単一の準備処理で計画を生成し、実行ID・再試行番号・変更識別子を含む名前の成果物として共有する。各Windows分割は同じ成果物を取得し、同一計画の検証後に自分のファイルだけを実行する。各分割で計画を再計算しない。Ubuntuの全件試験を維持する。
3. 手動起動の測定用自動処理と候補成果物を追加する。必須処理単位から分け、自動で変更登録しない。
4. 共通準備処理の改善は先に計測し、試験集合と隔離境界を維持できる先行試験付きの変更だけにする。
5. 設計文書を既存の書式検査と用語検査の対象にする。未追跡の保全証跡は変更せず、ローカル検査と自動検査環境の差を報告する。

### 現行枝統合後の律速再選定と`user-console.test.ts`診断（R24-10）

R24-08の統合後、測定処理 `37199719246` は2026-10-04 11:43:52 UTCに作成され、変更識別子 `f20c75e1ecd409f0e8573720c0f74b39d8178f93` を対象に実行された。必須確認 `37199241250` の全10処理単位成功後に単独で起動し、Windows Node 22で版管理対象の全試験ファイルを3回測定した。連続した3回の各回は、追跡ファイル一覧で開始位置を1つずつずらし、同じ測定処理内で個別ファイルを直列に実行した。成果物では全27ファイル×3回の81記録について、同一の変更識別子・実行識別子・環境値と各試行の成功を照合した。環境値と追跡入力から1回計算された`fingerprint`は時間表候補と独立に再計算し、一致を確認した。結果を採用する前に実行状態、成果物の変更識別子、全ファイル集合、各試行の成功と時間を照合した。

先行する同じ内容の必須確認 `37198481953`（`PR #69`の先端 `93cd8e19a6df040e34f5e083ab32249211b164ee`、GitHub統合変更 `1956d890e5a498bea0f4e03e50f673d4763eb156`）は成功した。割当成果物は当時追跡されていた27ファイルを8分割で全件・重複なしに割り当てたが、時間表の照合値は不一致だった。計画は`baseline`、`fingerprint` `4d087dc9d6516bea1e31c483f05cbbf4e5a8231b3f9fb7dabd9cfc560d60060f`。Windows各分割の試験工程時間と割当は次のとおり。

| 分割 | Windows試験工程（秒） | 実割当ファイル |
| ---: | ---: | --- |
| 1 | 81 | `test/admin.test.ts`; `test/fixture-runtime.test.ts`; `test/private-storage.test.ts`; `test/user-console-client.test.ts` |
| 2 | 245 | `test/ci-test-scheduler.test.ts`; `test/http-oauth-regression.test.ts`; `test/public-auth.test.ts`; `test/user-console.test.ts` |
| 3 | 65 | `test/config-correlation-regression.test.ts`; `test/independent-config-history.test.ts`; `test/search-process-lifecycle.test.ts`; `test/windows-job.test.ts` |
| 4 | 181 | `test/config-transfer-integrity.test.ts`; `test/independent-process-ownership.test.ts`; `test/session-filesystem-lifecycle.test.ts` |
| 5 | 93 | `test/desktop-commander-ownership.test.ts`; `test/independent-transfer-lifecycle.test.ts`; `test/session-links.integration.test.ts` |
| 6 | 21 | `test/emergency-stop-backend.test.ts`; `test/issue-56-shared-todo.test.ts`; `test/session-links.test.ts` |
| 7 | 50 | `test/emergency-stop-windows.test.ts`; `test/mvp.test.ts`; `test/session-time.test.ts` |
| 8 | 160 | `test/emergency-stop.test.ts`; `test/operation-audit-details.test.ts`; `test/tool-root-contracts.test.ts` |

最長の分割2には`test/user-console.test.ts`（240.6秒）と`test/public-auth.test.ts`（134.4秒）が含まれ、分割4は181秒、分割8は160秒だった。これは成功した一度の実行記録であり、3回中央値でも因果効果の推定でもない。 分割2/4/8で割当ファイルの最大個別値240.6/178.8/156.9秒に対し試験工程は245/181/160秒であり、単回の観測上は最大ファイルが各工程時間に近い。一方で、分割内の個別値の合計は壁時計時間を大きく上回る。ファイル内をさらに分割すれば並行度を上げる可能性があるが、並列数・起動費用・環境変動の効果をこの1回から分離できず、短縮幅は推定しない。

次表は各割当成果物の試験名と`TAP`の`duration_ms`を対応づけて集計した単回の試験ファイル別時間寄与である。分割工程の壁時計時間ではなく、個別時間の合計から割当変更後の所要時間や効果を推定しない。

| 試験ファイル | 分割 | 試験時間合計（秒、単回） |
| --- | ---: | ---: |
| `test/user-console.test.ts` | 2 | 240.6 |
| `test/config-transfer-integrity.test.ts` | 4 | 178.8 |
| `test/operation-audit-details.test.ts` | 8 | 156.9 |
| `test/independent-process-ownership.test.ts` | 4 | 148.7 |
| `test/public-auth.test.ts` | 2 | 134.4 |
| `test/emergency-stop.test.ts` | 8 | 97.3 |
| `test/session-filesystem-lifecycle.test.ts` | 4 | 96.0 |
| `test/tool-root-contracts.test.ts` | 8 | 92.9 |
| `test/independent-transfer-lifecycle.test.ts` | 5 | 90.2 |
| `test/admin.test.ts` | 1 | 78.7 |
| `test/search-process-lifecycle.test.ts` | 3 | 63.3 |
| `test/independent-config-history.test.ts` | 3 | 55.7 |
| `test/mvp.test.ts` | 7 | 47.8 |
| `test/session-links.integration.test.ts` | 5 | 47.2 |
| `test/http-oauth-regression.test.ts` | 2 | 46.1 |
| `test/emergency-stop-windows.test.ts` | 7 | 40.3 |
| `test/private-storage.test.ts` | 1 | 34.5 |
| `test/config-correlation-regression.test.ts` | 3 | 32.8 |
| `test/emergency-stop-backend.test.ts` | 6 | 18.1 |
| `test/issue-56-shared-todo.test.ts` | 6 | 17.6 |
| `test/fixture-runtime.test.ts` | 1 | 4.8 |
| `test/windows-job.test.ts` | 3 | 3.6 |
| `test/user-console-client.test.ts` | 1 | 2.1 |
| `test/ci-test-scheduler.test.ts` | 2 | 1.5 |
| `test/session-links.test.ts` | 6 | 0.3 |
| `test/desktop-commander-ownership.test.ts` | 5 | 0.1 |
| `test/session-time.test.ts` | 7 | 0.0 |

未丸めの合計は1730.351秒（小数第1位で1730.4秒）。表の各行を個別に小数第1位へ丸めてから足すと1730.3秒となるため、0.1秒差が生じる。

### R24-10 Windows Node 22単独測定結果と候補選定

単独測定実行 `37199719246` は成功し、成果物 `11303901085`（`test-runtime-measurement-37199719246-1-f20c75e1ecd409f0e8573720c0f74b39d8178f93`、SHA-256 `8e03755d6ea88c078fa1c2391d5e10c8921dba59352931a1394a2ee2221a6957`）を取得した。81件すべての記録が成功し、27個すべての試験ファイルに記録が各3件あった。全記録の変更識別子は`f20c75e1ecd409f0e8573720c0f74b39d8178f93`、実行識別子は`37199719246`、作業単位識別子は`111428729714`である。環境値は全件一致し、Windows `windows-latest`（`Windows Server 2025` 10.0.26100、x64、Node `v22.23.3`、npm `10.9.9`、`package-lock.json` SHA-256 `f153a51e7f8b4592fcea9b9c6ecfaa4fd3fc9912bcf7d410a54c7fb39829067d`）だった。

成果物内の時間表候補と81件の個別記録から、候補生成関数で27件の中央値を独立に再構成した結果は完全一致した。候補の`fingerprint` `4d087dc9d6516bea1e31c483f05cbbf4e5a8231b3f9fb7dabd9cfc560d60060f`は、Windowsの改行表現を含む入力から再計算した値、および先行必須確認 `37198481953` の同じWindows内容の割当`fingerprint`と一致した。これは測定用候補の証跡である。追跡ファイル集合が時間表と一致せず`fingerprint-mismatch`だった現行必須確認には、この時間表を適用していない。中央値順の値を次に示す。

| 試験ファイル | 3回中央値（秒） |
| --- | ---: |
| `test/user-console.test.ts` | 163.6 |
| `test/operation-audit-details.test.ts` | 123.4 |
| `test/config-transfer-integrity.test.ts` | 108.4 |
| `test/public-auth.test.ts` | 90.1 |
| `test/independent-process-ownership.test.ts` | 84.5 |
| `test/independent-transfer-lifecycle.test.ts` | 77.6 |
| `test/emergency-stop.test.ts` | 64.8 |
| `test/tool-root-contracts.test.ts` | 64.2 |
| `test/admin.test.ts` | 58.3 |
| `test/search-process-lifecycle.test.ts` | 52.3 |
| `test/session-filesystem-lifecycle.test.ts` | 51.3 |
| `test/independent-config-history.test.ts` | 43.9 |
| `test/session-links.integration.test.ts` | 35.6 |
| `test/mvp.test.ts` | 28.7 |
| `test/config-correlation-regression.test.ts` | 22.8 |
| `test/emergency-stop-windows.test.ts` | 22.6 |
| `test/private-storage.test.ts` | 21.9 |
| `test/http-oauth-regression.test.ts` | 21.0 |
| `test/issue-56-shared-todo.test.ts` | 11.3 |
| `test/emergency-stop-backend.test.ts` | 10.2 |
| `test/windows-job.test.ts` | 3.5 |
| `test/user-console-client.test.ts` | 2.1 |
| `test/fixture-runtime.test.ts` | 1.4 |
| `test/ci-test-scheduler.test.ts` | 1.0 |
| `test/desktop-commander-ownership.test.ts` | 0.5 |
| `test/session-links.test.ts` | 0.4 |
| `test/session-time.test.ts` | 0.2 |

同一の変更識別子・Windows環境での測定では、`user-console.test.ts`の中央値163.6秒が最長で、次点の`operation-audit-details.test.ts`の123.4秒より40.2秒（32.6%）長かった。この反復測定は同ファイルを次候補にする根拠を強める。R24-10の推奨候補は上記4意味群へ試験をそのまま分割する変更である。分割後の必須確認の短縮幅は予測・保証しない。`TAP`の群別合計と測定用の全試験ファイル時間は異なる測定量であり、この成果物に`fixture`準備各段階の内訳はない。`fixture`初期化の削減は、明示的に有効化する段階診断を別候補として実施し、全試験の隔離・実際の`Commander`・MCP・`ACL`・後片付けを維持できると設計確認してから選び直す。

同じ実行の`TAP`内訳では`user-console.test.ts`が16件・合計240.6秒で最大の試験ファイルだった。14件は専用の`fixture`を使い、2件（`custom Desktop Commander launcher`、`Google callback`）は使わない。試験を除外・簡略化したり、意図的な`SSE heartbeat`待ちを短縮したりせず、次の意味群へのファイル分割を第一候補として比較する。

| 候補ファイル群 | 既存の試験 | 1回の時間集計（秒、参考） |
| --- | --- | ---: |
| `test/user-console-audit-process.test.ts` | `every tool requires a comment that is retained in operation audit history`; `Issue 55: running process details stay ahead of completed details and missing metadata never borrows another process`; `Issue 22: user log API pages owner-scoped persisted events and exposes SSE notifications without bodies`; `Issue 22: SSE stays open through its heartbeat`; `user console lists each active connection's working directory and purpose for its owner` | 103.4 |
| `test/user-console-auth.test.ts` | `user console authenticates the principal, applies CSRF checks, and hides another principal's logs`; `custom Desktop Commander launchers remain bootstrap-managed`; `Google user login binds callback cookie at the callback path and rechecks approval` | 19.8 |
| `test/user-console-stop-lifecycle.test.ts` | `emergency stop persists per principal, terminates known processes, and requires a new connection after resume`; `Issue 48: emergency stop is accepted while a session working directory is being validated` | 33.1 |
| `test/user-console-session-metadata.test.ts` | `Issue 48: session metadata edits require owner and CSRF, compare versions, and reject unsupported states and fields`; `Issue 48: a fetched title does not advance the edit version or get erased by a stale sparse PATCH`; `Issue 48: explicitly clearing an empty failed title retries the fetch`; `Issue 48: a fetched title survives rollback of an unrelated audit failure`; `Issue 48: metadata audit rollback cannot restore session links after emergency stop`; `session edit and process start use one ordering boundary and preserve each start snapshot` | 84.4 |

上記の群別時間は実行 `37198481953` の各試験`TAP`出力にある`duration_ms`を4群に分類した合計であり、丸め前は103.4282、19.7545、33.1095、84.3508秒、総計240.643秒だった。ファイル内時間合計240.6秒との差は小数表示の丸めによる。これは1回の出力からの分類であり、実行時間や改善の保証ではない。再割当の再現可能な根拠が揃うまで、割当変更後の分割時間を推定しない。ファイルを増やすとUの照合値が変わり、現行時間表を適用できない。候補は新しい照合値に対する基準割当から始め、8分割を維持して割当成果物の全件・重複なしを検査する。

今回のR24-10候補は試験ファイルの意味群への分割だけとし、`fixture`初期化削減や段階計測用の新しい処理を含めない。`fixture`準備が後続の律速候補として必要になった場合は、別の候補として設計・承認してから扱う。その別候補ではWindows Node 22において`fixture`を使う試験ごとに安全な時間値を記録し、一時領域作成、`ACL`保護、`service.initialize`の総時間と内側の`DesktopCommander.start`、MCP試験用補助処理の接続/切断、`service.close`、一時領域削除を別々に測る。`DesktopCommander.start`は`service.initialize`の内数として扱い、重ねて総時間へ加算しない。パス、認証情報、試験入力、環境変数値は記録しない。その別候補も診断を明示的に有効化した場合だけ動かし、通常の自動確認の挙動・記録量を変えず、並列試験間で可変状態を共有しない。実際の`Commander`、MCP接続、`ACL`、各試験専用`fixture`と終了処理を省かず、試験集合・試験名・関数本体の保持を機械照合する。

候補選定では、完了した測定処理 `37199719246` の検証済み成果物を使った。`user-console.test.ts`は中央値163.6秒で27ファイル中最長であり、次点の`operation-audit-details.test.ts`（123.4秒）を40.2秒上回ったため、16試験を4つの意味群へ分ける案を次候補に選んだ。この単一測定結果は変更後の実行時間や改善を保証しない。成果物には`fixture`準備段階の時間内訳がないため、今後それを調べる場合は診断対象を絞り、分割だけで十分か、`fixture`準備変更を別候補にするか判定する。診断値だけから短縮を主張しない。

候補を実装するときは、設計確認後に試験本文・名称・検査内容・`fixture`隔離・後片付けを維持し、機械照合する。新しいファイル集合の時間表未適用段階で、同一の完全な変更識別子に対する8分割の必須自動確認を3回実行する。Ubuntu全件試験とWindows 8分割の割当成果物について、追跡対象全ファイルが各回に一度ずつ割り当てられ、3回ともすべて成功したことを確認する。この3回が完了してから、必須自動確認と重ねず、追跡対象全試験ファイルをWindows上で3回測定する。測定の変更識別子・成果物・全対象名・成功値を照合してから新しい時間表を登録する。時間表の登録後は別の完全な変更識別子で時間表が適用されたことと全件割当を確認し、同一の変更識別子に対する必須自動確認を3回実行して、各回の全必須処理成功と割当成果物を検証する。これらの各段階で必要な実行を行い、同じ段階の実行を重複起動しない。全体の主指標3回すべてが180秒以内という課題完了条件は維持する。単回観測や`LPT`見積もりだけで効果を認定しない。

R24-10の実際の順序逸脱: 新しい候補の先端 `f01940217de6e1dc60833de7617298b1187d62ca` では、時間表未適用の必須自動確認が1回だけ成功した時点で、単独測定 `37206964800` が開始された。これは必要な3回成功の条件を満たさない。開始済み測定は取り消さず、結果を保存して検証する。ただし、測定結果を3回成功要件の充足や時間表の採用根拠として確定しない。測定完了後、同一の実装・先端・実行環境で不足する2回を追加し、3回すべての成功を確認してから時間表候補の採用評価へ進む。実装・実行対象・Windows Node 22環境・依存版・固定ファイルの値が一致することを確認し、順序の差は記録する。時間表を適用した後も同一の完全な候補先端で必須自動確認を3回成功させる。全体3回の180秒目標はこの比較用確認回数とは別の受入条件として維持する。必須自動確認 `37206614291` は、同一候補先端 `f01940217de6e1dc60833de7617298b1187d62ca` の再実行1/2/3が必須処理10個すべて成功した。GitHub API `/actions/runs/37206614291/attempts/{attempt}` の各 `created_at` を主指標の起点とし、再実行ごとの `/jobs` から最大 `completed_at` を終点にした。自動処理全体を示すAPIの `created_at` は再実行後も初回時刻のままなので、2回目/3回目の起点には使わない。副指標は同じAPI経路の `run_started_at` から最後の必須処理完了までとする。| 再実行 | `created_at` (UTC) | `run_started_at` (UTC) | 最終処理完了 (UTC) | 主指標 | 副指標 | 最大Windows `Test` | 割当成果物 |
| ---: | --- | --- | --- | ---: | ---: | ---: | --- |
| 1 | 2026-10-04T13:43:09Z | 2026-10-04T13:43:09Z | 2026-10-04T13:48:11Z | 302秒 | 302秒 | 219秒 | `11305265805` |
| 2 | 2026-10-04T18:22:29Z | 2026-10-04T18:22:28Z | 2026-10-04T18:27:51Z | 322秒 | 323秒 | 232秒 | `11311521283` |
| 3 | 2026-10-04T18:32:34Z | 2026-10-04T18:32:33Z | 2026-10-04T18:37:59Z | 325秒 | 326秒 | 228秒 | `11312010635` |

3回とも同じ先端、30追跡対象ファイル、8分割の無重複・全件割当で成功した。各成果物の内容確認と公式計画の照合値の再計算が一致したことを確認した。主指標の中央値は322秒、最大325秒。これらは基準3回であり、分割変更の因果効果を単独で示さない。

順序逸脱後に完了した測定処理 `37206964800` は成功した。成果物 `11306340866` の圧縮ファイルSHA-256は `7e1ac1f5f3de9fa0ac324f6eb2e5fea9c6bf3991c5e2927619a60dafde63c1c2`。測定記録90件はすべて成功・終了値0で、同じ処理識別子・作業識別子・変更識別子・環境を持ち、30個の追跡対象試験ファイルそれぞれ3件を含む。成果物と候補の生成元識別子 `5abc4e112d0277da43b05b309583d7e6a27d6c67` は `f20c75e1ecd409f0e8573720c0f74b39d8178f93` と `f01940217de6e1dc60833de7617298b1187d62ca` の統合履歴である。環境はWindows 10.0.26100 x64、Node `v22.23.3`、npm `10.9.9`、`package-lock.json` SHA-256 `f153a51e7f8b4592fcea9b9c6ecfaa4fd3fc9912bcf7d410a54c7fb39829067d`。候補の照合値 `fafc5c8bd7075164a5f9693edf7505b03706cb6e896d4cbf4652a9f26e095d4b` は、固定変更の追跡内容とこのWindows改行形式から独立再計算され、同じ候補先端の基準割当成果物 `11305265805` の照合値とも一致した。90記録から再生成した時間表候補は成果物内のJSONと一致した。

| 分割後の試験ファイル | 個別測定中央値（秒） |
| --- | ---: |
| `test/user-console-audit-process.test.ts` | 57.3 |
| `test/user-console-auth.test.ts` | 11.8 |
| `test/user-console-stop-lifecycle.test.ts` | 19.3 |
| `test/user-console-session-metadata.test.ts` | 50.6 |

これは一つのWindows上で個別試験ファイルを直列実行した測定処理における3回中央値である。必須自動確認全体の所要時間や分割前後の因果比較ではないため、速度改善や3分目標達成の証拠として扱わない。時間表未適用の基準必須確認が1回成功した後、必要な3回成功より前に単独測定 `37206964800` が開始された順序逸脱は残る。測定完了後に再実行2/3を同一実装・同一先端で行い3回成功を満たしたが、これは時系列上の逸脱を遡って解消するものではない。測定結果を保ったうえで、この順序逸脱を明記して候補評価へ進むことをユーザーが承認した。実測候補の時間表を `.github/test-duration-manifest.json` に登録した。適用後の必須確認はこの登録後にできる新しい完全な変更識別子で3回すべて成功させる必要があり、初回確認の結果は後続の同一完全変更識別子での確認と併せて記録する。3分目標は全体主指標3回すべてが180秒以内という条件を維持する。
