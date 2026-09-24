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
| RDMCP-MVP-IFR-002 / High | `src/index.ts:258,267-279,174-175` は64件上限と起動時だけの清掃により、通常の DC 利用統計による設定置換で停止し得る。通常動作中と起動時上限判定前に、安全に不要な保持リンクを除去する。 | 保護設定の identity refresh は同じ mutex 内で、上限判定より先に sole-link の retired pin だけを prune する。外部 hard link を持つ pin は残し、manifest を更新する。 | 実 DC で64版を超え、既知の外部別名リンク保護、通常操作、再起動を確認 | `MVP-IFR-002` は実 DC と70回の controlled atomic replacement で、別名、通常 read、restart を確認して pass。これは usageStats が自然に70回書換えることの主張ではない。 |
| RDMCP-MVP-IFR-003 / Medium | `src/index.ts:430,432` の active 上限が upload に適用されない。両方向共通の上限を lock 内で artifact 作成前に適用する。 | upload begin も download begin と同じ transfer lock 内で active transfer 数を確認し、上限時は path/probe/temp/handle/manifest 作成前に拒否する。 | 混在上限で新 handle・一時ファイル・manifest 行が増えず拒否 | `MVP-IFR-003` は10 download + 10 upload 後の overflow に artifact 非作成を確認して pass。 |
| RDMCP-MVP-IFR-004 / Medium | `src/index.ts:484-509` の停止 timeout 後は観測不能のままになる。重複しない有界な観測を継続し、実際の終了を一度だけ監査する。 | termination timeout でも watcher を止めず、1件だけの observer が指数的に最大5秒まで backoff して再観測する。確認済み終了だけを保存・監査し、timeout 自体は unknown のままにする。 | timeout 後の遅延終了で状態と監査が確定すること | `MVP-IFR-004` は injected timeout 後の遅延 completion と一度だけの exit audit を確認して pass。 |
| RDMCP-MVP-IFR-005 / Medium | `src/index.ts:480` の開始監査に、機能要件 `:177-180` の command・PID がない。秘密情報の扱いを守った表現で session・論理 ID と関連付ける。 | `process.start` に user、session、node、logical process ID、PID と、Bearer/token/password/secret/credential/API key/authorization 値、および設定済み token secret/password hash の一致値を redact した command 表現を記録する。 | command・PID の対応と認証情報・token の非漏えい | `MVP-IFR-005` は command/PID/ID の関連付け、設定済み literal、flag、Bearer の redaction を確認して pass。 |
| RDMCP-MVP-IFR-006 / Medium | upload commit の既存試験はすべて拒否経路で、双方向転送の正常完了の証拠がない。設計 `multi-pc-architecture.md:755-760` の正常な複数チャンク転送を実証する。 | 正常 commit の既存実装を保持した。 | 新規宛先の上書き禁止と既存宛先への上書きで、bytes・hash・terminal 状態・清掃を確認 | `MVP-IFR-006` は MCP 経由の複数 chunk、新規 overwrite=false と既存 overwrite=true、bytes/hash/terminal cleanup を確認して pass。 |
| RDMCP-MVP-IFR-007 / Low | 設計 `multi-pc-architecture.md:288` の固定版0.2.50を package・lock・README・実試験の0.2.51に一致させる。 | Luna 担当が design の固定版を0.2.51へ更新した。 | 文書の識別と scoped lint | Luna の scoped lint・Markdown lint は pass。 |

## 最終的な修正・検証

修正対象は `src/index.ts`、`test/independent-fixes.test.ts`、設計の固定版表記と本修正の報告・進捗記録。
`npx.cmd --yes --package=node@22.23.3 node node_modules/tsx/dist/cli.mjs --test test/**/*.test.ts` は source freeze 後に終了コード0、20/20合格、失敗・キャンセル・スキップ0、67.538秒。
`npm.cmd run check`、build、lint と `git diff --check` も成功した。lint は42 Markdownファイル、指摘0。
終了マーカーを含む出力も残ページを読み切るまでは現在の process owner を保持し、既存の大量出力試験も合格した。
過去の14件合格と両 OS CI 成功は、この7指摘の解消証拠に置き換えない。今回の候補は `commit_pending`、push と対応する CI は次段階。
公開接続と複数PCは引き続き後続作業であり、今回の指摘修正で完了したとは扱わない。
