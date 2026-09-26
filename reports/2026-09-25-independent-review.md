# 独立最終レビューと限定解消確認

## 判定と対象

**判定: pass。必須7指摘は元の severity を保持してすべて closed。**

技術判定の対象 `reviewed_implementation_head` は `74f004b17d25cf545b2787b5ab54313a9f5776ec`。
tree は `85fe00fb694b9fa58eb316efd6b274a6c1d9bae2`、package-lock blob は `9a71dfc60016dcbdb5344fea7fd31b54f935b7d2`。
branch は `feat/tailscale-funnel-design-lint`、base は `759f6c429cdaabb47cbdd16d2e4acda5eaa69041`、対象は [PR #1](https://github.com/ssaattww/RemoteDesktopMCP/pull/1)。

初回独立レビューの対象は `eed5623a6b0cc800565a112436adbfce293e0b26`、判定は fail。
同じ reviewer `/root/independent_final` が1回の全面レビューを完了し、その後は7指摘と修正の直接影響・CI 差分だけを限定確認した。
独立した限定確認の対象 HEAD は上記 `74f004b` の1件。途中候補に別の全面レビューや新しい独立 reviewer を追加していない。

製品・試験の通常レビューは `2d5be223ea52af35a8c0f29c7ace74362ff9b1cd` で pass。
その後の `74f004b` は報告・task・引継ぎの5ファイルだけを変更し、同じ通常 reviewer が外部証拠として pass とした。
製品、試験、設計、package、workflow はこの最後の差分で変わっていない。

## 目的と範囲

PR #1 の設計指摘対応、task 一覧、兄弟 CodexSkill への `skills` symlink に続く、単一PC・loopback のローカル開発用 MCP 最小版を対象とする。
ローカル認証と OAuth 認可コード・S256 PKCE、セッション、監査、固定版 Desktop Commander へのファイル・プロセス操作、双方向ファイル転送を含む。
根拠は `doc/design/functional-requirements.md`、`doc/design/multi-pc-architecture.md`、README と追跡済みの finding。
Google OIDC、CIMD、refresh token、複数PC、Funnel と ChatGPT の公開実接続は F01〜F03 の後続であり、この判定に含めない。

## 指摘ごとの完全性と解消

次の元位置は初回独立対象 `eed5623` に対する根拠、現在位置は `74f004b` に対する根拠である。
詳細な修正経緯と必要対応・製品経路・組合せ fixture の完全性の表は [独立指摘修正記録](2026-09-25-independent-fixes.md) に保持する。

| ID / 元の severity | 初回の事象・影響・必須対応 | 修正経路と実際の組合せ証拠 | 最終状態 |
| --- | --- | --- | --- |
| RDMCP-MVP-IFR-001 / High | 元 `src/index.ts:480-514` は PID の現在の所有者と接続世代を検証せず、再利用された PID の別プロセスを古い論理 ID から操作し得た。設計 `multi-pc-architecture.md:608-638,799-818` に沿い、同じ lock 内で全委譲前に確認し、後継公開前に旧所有者を無効にする。 | 現在 `src/index.ts:502-520` が接続 generation と `node:generation:pid` の所有者を記録し、status/output/kill/watcher の委譲前に検証する。`test/independent-fixes.test.ts:174-218` は同一 PID の A/B と両 lock 順序を強制し、古い ID が adapter 呼出しを起こさないことを確認する。 | closed |
| RDMCP-MVP-IFR-002 / High | 元 `src/index.ts:258,267-279,174-175` の64件制限と起動時だけの清掃により、通常の設定置換で操作や再起動が停止し得た。外部別名の保護を維持し、通常動作中と起動時上限判定前に不要な pin を清掃する。 | 現在 `src/index.ts:224-323` は bigint 由来の正確な識別、sole-link の退役 pin だけの清掃、捕捉履歴保持、20回・約2秒の有界な更新待ちを実装する。`test/independent-fixes.test.ts:36-120` は実 DC 下の70回の制御された置換、既知別名、通常読取、再起動、5回で落ち着く置換と無限置換の拒否を確認する。`test/fixture.ts` の共通 helper が map に存在する検証済み pin を捕捉する。DR-003 fixture は正確な実体、旧 manifest、別名、temp すり替えを確認する。Ubuntu の更新待ち失敗と Windows の空 pin 一覧という試験前提の誤りは、拒否条件を緩めず解消した。 | closed |
| RDMCP-MVP-IFR-003 / Medium | 元 `src/index.ts:430,432` は download だけで active 上限を確認し、upload の handle と artifact が増え続け得た。両方向共通の上限を lock 内で artifact 作成前に適用する。 | 現在 `src/index.ts:481,483` は transferLock 内で共通の20件上限を先に確認する。`test/independent-fixes.test.ts:123-143` は upload10件と download10件で満杯にし、追加 upload が転送状態・root の項目・所有 manifest を変えず拒否されることを確認する。 | closed |
| RDMCP-MVP-IFR-004 / Medium | 元 `src/index.ts:484-509` は停止 timeout 後に watcher を失い、永続的に終了未確認となり得た。重複しない有界な観測を続け、実際の終了だけを一度監査する。 | 現在 `src/index.ts:511-521` は1件の watcher と backoff を維持する。100ページ上限の直接影響も、最後の未読ページまで owner を維持するよう補修した。`test/independent-fixes.test.ts:220-294` は問い合わせなしの遅延終了、1回だけの監査、inactive session と101ページ目の遅い終了マーカーを確認する。 | closed |
| RDMCP-MVP-IFR-005 / Medium | 元 `src/index.ts:480` の開始監査に command と PID がなく、機能要件 `:177-180` の対応付けを満たさなかった。秘密情報の扱いを守り、session・論理 ID と関連付ける。 | 現在 `src/index.ts:506,516` は user/session/node/論理 ID/PID と伏字処理した command を記録する。`test/independent-fixes.test.ts:296-321` は対応付け、設定済み secret/hash の一致値、password/token ラベル、Bearer 値が残らないことを確認する。 | closed |
| RDMCP-MVP-IFR-006 / Medium | 既存の upload commit 試験が拒否経路だけで、設計 `multi-pc-architecture.md:755-760` の正常な双方向転送を実証していなかった。 | `test/independent-fixes.test.ts:145-172` は実 MCP の複数チャンクで新規宛先 `overwrite=false` と既存宛先 `overwrite=true` を完了し、正確な bytes・SHA-256・terminal 状態・temp 除去・所有 manifest 清掃を確認する。 | closed |
| RDMCP-MVP-IFR-007 / Low | 設計 `multi-pc-architecture.md:288` が0.2.50を示し、実際の検証対象0.2.51と不一致だった。 | 現在の同位置は0.2.51で package・lock・README・結合試験と一致する。設計用語 lint と Markdown lint は合格した。 | closed |

初回出力の暫定 ID は既存履歴と衝突したため、同じ独立 reviewer が正式に `RDMCP-MVP-IFR-*` へ訂正した。
過去の `RDMCP-IFR-001/002`、`RDMCP-DR-*`、`RDMCP-NR-*` は変更していない。severity の再分類はない。

## 対象に結び付いた検証

Windows は local_execution_available、Linux は実行可能な WSL/Docker がないため remote_ci_only。
ローカル実行場所は `C:\Users\donabe\Project\RemoteDesktopMCP`、Windows 11 Pro、PowerShell 7.4.20。
通常コマンドの Node は24.20.0、npm は11.19.0。試験は実際の Node22.23.3を明示的に使用した。

| コマンド / 証拠 | 結果 |
| --- | --- |
| `npm.cmd ci` | exit 0。13件の直接依存は lock と一致し drift なし。npm の install-script 承認警告はあったが、実 DC の試験は成功。 |
| `npm.cmd run lint` | exit 0。報告追加前の42 Markdownファイルで指摘0、設計用語・TypeScript lint も成功。 |
| `npm.cmd run check`、`npm.cmd run build` | 各 exit 0。 |
| `npx.cmd --yes --package=node@22.23.3 node node_modules/tsx/dist/cli.mjs --test test/**/*.test.ts` | exit 0、24/24合格、失敗・キャンセル・スキップ0、90.542秒。 |
| `npm.cmd audit --audit-level=low` | exit 0、検出された脆弱性0件。 |
| `git diff --check`、前後の HEAD/tree/lock/作業ツリー | exit 0、同一 HEAD/tree/lock、前後とも clean。 |
| [PR CI run 36047744126](https://github.com/ssaattww/RemoteDesktopMCP/actions/runs/36047744126) | `74f004b` に一致。Ubuntu job `107795382982` は24/24・30.042秒、Windows job `107795383257` は24/24・45.316秒。ともに失敗・キャンセル・スキップ0、全 job 成功。 |

ローカル生証拠は無視対象 `reference/validation/final-gate-74f004b/` の result/log、`final-environment.json`、依存 manifest に保持する。
これらはこのマシンの証拠であり、Gitに含まれるファイルや CI artifact と同一視しない。
独立 reviewer はこれらの凍結済み証拠と現 HEAD/tree/clean/diff-check を直接確認した。CI は親が一致する run/job とログを取得して提供した証拠を使用した。

途中候補 `6a1c5ab`、`0696dee`、`00e6939` の CI 失敗、fixture と製品修正の区別は通常レビューと修正記録に保持する。
`2d5be22` の両OS24/24成功も別候補の証拠であり、上記 `74f004b` の結果に置き換えていない。

## 観点、未確認領域、残る制約

限定対象の要求・設計、正しさ、範囲、直接依存、API/data/config への影響、エラー処理、安全性、試験、文書、回帰、current-HEAD CI はすべて checked_no_finding。
新規 held finding、完了を阻害する unexplored 領域、新しい判定基準はない。
`document-wording-review` は README、固定版表記、修正・通常レビュー報告、task と引継ぎを初回指摘の意味と照合した。
意味、ID と severity の継続性、用語、読みやすさは checked_no_finding、wording 判定は pass。機械的 lint とは別の判定である。

ローカル単一PCと同じ OS ユーザーの信頼境界は維持する。任意コマンドは同じ OS 権限で動き、停止は DC セッションのルート PID を対象とする。
設定保護は現在と捕捉済みの履歴であり、API 外から作った未確認の過去版・コピーの完全な隔離ではない。
command の伏字処理は設定済みの一致値と検証済み形式を対象とする。任意のシェル構文を完全に秘匿する保証ではなく、コマンド自体は機微な運用入力として扱う。

## Reviewer と予約の継続性

独立 reviewer は `/root/independent_final`。設計・実装担当および通常 reviewer とは別の identity で、修正を実装していない。
要求・計画プロファイルは `gpt-6-sol / high`、再利用は `reused_existing_agent_profile`。
実際の内部実行プロファイルは非公開であり、applied profile を検証済みと主張しない。
内容は `independent_workstreams` に分解可能だが、`decomposition_policy: forbidden`、`parallelism_mode: single_agent`、`decomposition_disposition: prohibited_by_review_lifecycle` を保持した。

予約 owner は `review-enforcer`、identity は `rdmcp-pr1-20260925-independent-1`。
パスは `reports/2026-09-25-independent-review.md`。最初の凍結前に1回だけ metadata_only として予約し、初回 fail 後も同じ予約を維持した。
初回と限定確認の間、このファイルは存在せず、独立 reviewer は tracked file を変更していない。
この pass の受領後に初めて、work-context-manager の確定対象と保持証拠を用い、report-writer / report-output-manager の attestation persistence として親が本報告を作成した。

## 報告専用コミットと提出境界

`report_attestation_allowed: true`。本報告は1回の管理上の report-attestation commit のための証拠であり、新しい実装ではない。
`technical_head` と `administrative_parent` は `74f004b17d25cf545b2787b5ab54313a9f5776ec`、この本文作成時は `commit_pending`。
許可される変更は予約済みのこの1ファイルだけで、commit の first parent は上記 HEAD でなければならない。
報告自身の将来の SHA は本文に含めず、作成後に PR #1 の外部 metadata へ記録する。

技術判定は `74f004b` に適用する。報告追加後は final push と、その提出 HEAD に一致する pull_request CI を確認し、結果を PR #1 に記録する。
後続の repository commit や書込み Skill は行わない。後から別の変更が必要になれば完了状態を無効とし、通常の修正確認と同じ独立 reviewer の限定確認へ戻る。
非最終 task・引継ぎ・Skill 改善判断は凍結前に完了している。マージと公開サービスの有効化は行わない。
