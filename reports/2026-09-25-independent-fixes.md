# 独立レビュー指摘の修正記録

## 対象と識別

独立初回の実装 HEAD: `eed5623a6b0cc800565a112436adbfce293e0b26`。
Reviewer: `/root/independent_final`、判定 `fail`。独立した全面レビューは1回完了し、以後は同担当による指摘と CI 差分の確認に限定する。
このファイルは通常の修正記録であり、予約済みの最終独立レビュー報告ではない。
予約 `rdmcp-pr1-20260925-independent-1` とパス `reports/2026-09-25-independent-review.md` は維持し、合格まではそのファイルを作らない。

初回出力の暫定 ID は既存履歴と衝突したため、reviewer が次表の `RDMCP-MVP-IFR-*` へ正式に訂正した。
過去の `RDMCP-IFR-001/002`、`RDMCP-DR-*`、`RDMCP-NR-*` の識別子・severity は変更しない。
ユーザー指定により製品修正・回帰試験は Terra / high、機械的な版表記修正は Luna / high。
既存担当を再利用し、要求プロファイルと内部情報が非公開の実行プロファイルを区別する。

## 完全性の表

| ID / severity | 必須対応と元の根拠 | 製品・文書の変更 | 組合せ試験 | 証拠・状態 |
| --- | --- | --- | --- | --- |
| RDMCP-MVP-IFR-001 / High | `src/index.ts:480-514` の論理 ID は PID の現在の所有者・接続世代を検証しない。設計 `multi-pc-architecture.md:608-638,799-818` と一致させ、PID 再利用時に古い ID が新しいプロセスを操作しないよう、同じ lock 内で全委譲前に検証する。 | Desktop Commander 接続ごとにランダムな generation を作り、`node:generation:pid` ごとの current owner を保持する。B を公開する前に同じ key の A を stale にし、status/output/kill と watcher が lock 内で再検証してから delegate する。 | 同じ PID の A/B と両 lock 順序で旧 A から新 B への読取・停止委譲がないこと | `MVP-IFR-001` は adapter の呼出し記録で両順序を確認して pass。 |
| RDMCP-MVP-IFR-002 / High | `src/index.ts:258,267-279,174-175` は64件上限と起動時だけの清掃により、通常の DC 利用統計による設定置換で停止し得る。通常動作中と起動時上限判定前に、安全に不要な保持リンクを除去する。 | 保護設定の identity refresh は同じ mutex 内で、上限判定より先に sole-link の retired pin だけを prune する。外部 hard link を持つ pin は残し、manifest を更新する。link-first の各 verified pin を保持し、DC の atomic replacement が続く間は10→20→40→80→100ms の backoff、20回か約2秒の上限で再取得する。config pin と upload 所有証明は bigint stat からの正確な10進 identity を使い、数値丸めによる別 inode の一致を避ける。旧数値 manifest は安全な整数で private pin/一時ファイルに厳密一致する場合だけ移行し、不明な既存 state は削除せず起動を止める。 | 実 DC で64版を超え、既知の外部別名リンク保護、通常操作、再起動を確認。5回超の置換後に収束する構成と、収束しない構成が上限内に fail closed すること。隣接する unsafe NTFS inode の数値 key 衝突でも通常ファイルを拒否しないこと。 | 70回の controlled atomic replacement の既存 evidence は保持する。settling/churn と精度修正の focused evidence は次候補の test owner 結果を追記し、全体結果を待つ。 |
| RDMCP-MVP-IFR-003 / Medium | `src/index.ts:430,432` の active 上限が upload に適用されない。両方向共通の上限を lock 内で artifact 作成前に適用する。 | upload begin も download begin と同じ transfer lock 内で active transfer 数を確認し、上限時は path/probe/temp/handle/manifest 作成前に拒否する。 | 混在上限で新 handle・一時ファイル・manifest 行が増えず拒否 | `MVP-IFR-003` は10 download + 10 upload 後の overflow に artifact 非作成を確認して pass。 |
| RDMCP-MVP-IFR-004 / Medium | `src/index.ts:484-509` の停止 timeout 後は観測不能のままになる。重複しない有界な観測を継続し、実際の終了を一度だけ監査する。 | termination timeout でも watcher を止めず、1件だけの observer が指数的に最大5秒まで backoff して再観測する。各 observer pass は `outputDrained` を明示し、100-page drain が残る間は marker の有無にかかわらず current owner を維持する。inactive session による終了推測は drained pass の後だけ行い、最後の page を確認してからだけ状態・監査を確定する。timeout 自体は unknown のままにする。 | timeout 後の遅延終了で状態と監査が確定すること | 初回 candidate `6a1c5ab` の review が100-page tail を指摘した。source 修正後の deterministic 101-page fixture は focused pass。全体・CI・reviewer の結果は後述する。 |
| RDMCP-MVP-IFR-005 / Medium | `src/index.ts:480` の開始監査に、機能要件 `:177-180` の command・PID がない。秘密情報の扱いを守った表現で session・論理 ID と関連付ける。 | `process.start` に user、session、node、logical process ID、PID と、Bearer/token/password/secret/credential/API key/authorization 値、および設定済み token secret/password hash の一致値を redact した command 表現を記録する。 | command・PID の対応と認証情報・token の非漏えい | `MVP-IFR-005` は command/PID/ID の関連付け、設定済み literal、flag、Bearer の redaction を確認して pass。 |
| RDMCP-MVP-IFR-006 / Medium | upload commit の既存試験はすべて拒否経路で、双方向転送の正常完了の証拠がない。設計 `multi-pc-architecture.md:755-760` の正常な複数チャンク転送を実証する。 | 正常 commit の既存実装を保持した。 | 新規宛先の上書き禁止と既存宛先への上書きで、bytes・hash・terminal 状態・清掃を確認 | `MVP-IFR-006` は MCP 経由の複数 chunk、新規 overwrite=false と既存 overwrite=true、bytes/hash/terminal cleanup を確認して pass。 |
| RDMCP-MVP-IFR-007 / Low | 設計 `multi-pc-architecture.md:288` の固定版0.2.50を package・lock・README・実試験の0.2.51に一致させる。 | Luna 担当が design の固定版を0.2.51へ更新した。 | 文書の識別と scoped lint | Luna の scoped lint・Markdown lint は pass。 |

## 最終的な修正・検証

修正対象は `src/index.ts`、`test/independent-fixes.test.ts`、設計の固定版表記と本修正の報告・進捗記録。
候補 `6a1c5ab58edab6fff603b418c9f4e5d5e9691a7a` の `npx.cmd --yes --package=node@22.23.3 node node_modules/tsx/dist/cli.mjs --test test/**/*.test.ts` は source freeze 後に終了コード0、20/20合格、失敗・キャンセル・スキップ0、67.538秒。
`npm.cmd run check`、build、lint と `git diff --check` も成功した。lint は42 Markdownファイル、指摘0。
同候補は commit と push 済み。PR CI run `36042688392` は Windows job `107778487028` が20/20成功、Ubuntu job `107778486920` が19/20で設定置換別名の試験に失敗した。
通常の限定レビューは001/003/005/006/007を解消確認し、002は CI 証拠待ち、004は100ページを超える未読出力の早期終了を残した。
既存の大量出力試験の合格だけでは100ページ上限を超える監視処理を証明できず、追加 fixture と実際の drain 状態による終了判定で補修する。
過去の14件合格と両 OS CI 成功は、この7指摘の解消証拠に置き換えない。各結果は上記の候補に紐付け、次候補の commit・push・CI は独立した証拠として追記する。
公開接続と複数PCは引き続き後続作業であり、今回の指摘修正で完了したとは扱わない。

## 残存2件の追加対応

MVP-IFR-002 / High の CI 確認では、A は既存の保護用 pin、B は成功した link hook の pin から別名を作り、それぞれ dev:ino の一致を明示的に検証する。
B の手動置換前は Desktop Commander を閉じ、未観測の非同期置換との混同を除く。既知の A/B、再起動後の拒否、通常ファイル、upload temp のすり替えの検証を維持した。
これは過去の Ubuntu 失敗の原因を断定するものではない。別の live pin-race fixture は残し、実際の競合捕捉も確認する。

MVP-IFR-004 / Medium は出力の実際の drain 状態を保持し、inactive な PID でも未読ページがあれば owner を次回の監視へ引き継ぐ。
101ページの fixture は最後のページだけに終了マーカーを置き、100ページの上限後も owner を保持し、末尾を受信してから一度だけ終了監査することを確認した。
上記2件の Node22 focused fixture は2/2合格、9.735秒。次候補の全体試験・CI・reviewer の解消確認は別途記録する。

## Windows の識別精度

追加修正後の全体試験は21件中20件合格、1件失敗、68.753秒だった。失敗は別の pin-race fixture における通常ファイルの誤拒否であり、成功として記録しない。
設計担当 Sol / high の読み取り確認で、既存ファイル `package.json` の bigint inode は `16888498602727127`、通常の数値 stat は `16888498602727128` となった。
この番号は安全な整数範囲外であり、隣接 inode と同じ数値 key になることを確認した。失敗した一時ファイルそのものの衝突を確認したわけではないが、設定 pin と転送の所有証明に共通する精度の欠陥は実在する。
T08d で config pin と upload ownership の比較を bigint stat に由来する損失のない10進文字列へ統一した。旧数値 manifest は safe integer かつ保持物との厳密一致だけを移行し、unsafe な旧 state は起動を止めて推測削除しない。
丸め衝突を起こす隣接番号の key 分離と実ファイルの保護・通常読取、safe/unsafe manifest の検証を含む focused 5件は23.688秒で合格した。
識別修正後の最初の全体試験は23件中22件合格、75.846秒。残る NR-008 fixture 自体が旧形式の数値で upload 所有 manifest を生成していた。
fixture を bigint stat の10進文字列へ変更して新規 manifest の契約に合わせ、所有証明が一致する一時ファイルだけを清掃する検証を維持した。NR-008 focused は1/1合格、7.138秒。

上記の source と fixture を確定した後の Node22.23.3 全体試験は終了コード0、23/23合格、失敗・キャンセル・スキップ0、73.234秒。check、build、lint と diff-check も成功した。
この結果を含む候補 `0696dee9261b72875d3797d238464fe6b595f057` は commit・push 済み。
PR CI run `36045163545` は Windows job `107786810053` が23/23成功、Ubuntu job `107786809530` が21/23で失敗した。
通常 reviewer は004の修正を解消確認し、002は再起動時の連続設定置換による4回の即時 retry 上限を残した。
別の DR-003 digest fixture は更新される設定パスを比較していたため、保持した同じ実体の検証へ修正する。dev:ino の試験表現も bigint に統一する。
README では安全な旧数値 upload 所有 record の不一致と、不正・unsafe manifest による起動停止を区別した。

## 設定更新が落ち着くまでの有界な確認

設定 mutex を保持して検証済み pin を記録し、更新中または一時的な link エラーでは10〜100msの backoff を挟む。最大20回・約2秒で打ち切り、更新が続く場合は拒否する。
各上限確認前に外部別名を持たない sole-link の退役 pin だけを清掃する。起動前の未作成状態以外では設定の消失も retry または拒否となる。
有限回の置換後の起動成功と、無限に置換する hook に対する有界な拒否を別 fixture で確認する。
source 確定後の focused 3件は21.102秒で合格した。70版の履歴試験も初期別名を検証済み pin に由来させ、bigint の実体一致を確認する。
5回の置換後には起動して既知の A/B を拒否し、無限置換では準備完了を公開せず有界時間内に失敗した。temp すり替え試験は同じ保持対象の内容が不変であることを確認した。
全体の Node22.23.3 試験は終了コード0、24/24合格、失敗・キャンセル・スキップ0、75.635秒。型チェック・build・lint も成功した。
