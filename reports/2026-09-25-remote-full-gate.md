# 公開接続の全体検証

## タスクと範囲

公開認証修正後の固定コミットに対して、Node 22 の全体試験、依存インストール、lint、型検査、build、依存監査を実行する。秘密の実設定と実サービスは対象外。

## Dispatch profile

- selection inputs: verification, mechanical, low uncertainty, cross_module, high criticality, sequential_dependencies, fresh context.
- selection source: user_override; 機械的内容 Luna / high。
- requested profile: gpt-6-luna / high / fork_turns none.
- agent role / default-role plan: ツールの既定 role。別 role 指定フィールドなし。
- role config evidence / profile effect: 公開ツール定義の model と reasoning_effort を指定し、別 role による変更設定なし。
- planned runtime profile: gpt-6-luna / high.
- applied profile: null.
- application status: spawn_succeeded_profile_unverified; identity /root/remote_full_gate.
- runtime profile observability: final_profile_hidden.
- approval: not_required; 利用者が明示指定。
- decomposition policy: forbidden; single_agent.
- report persistence mode: normal_persistence.

## 結果

指定された全体ゲートを順に実行した。実行記録は `reference/validation/remote-full-gate-3d676b89d0268c9d41f78251d7a351f232ad4f6f/` にある。開始時のHEADは `3d676b89d0268c9d41f78251d7a351f232ad4f6f`、Nodeは `v24.20.0`。テストは指定どおり Node `v22.23.3` で起動した。実行中に親タスクが修正をコミットしたため、終了時のHEADは `75197bb42085e87e340df6fa5982aab54073014e`。製品・テスト以外の親所有レポート変更も並行していた。したがって各コマンドの出力と終了コードは保存したが、全コマンドが単一の不変treeを検証したとはみなさない。

| コマンド | 終了コード |
| --- | ---: |
| `npm.cmd ci` | 0 |
| `npm.cmd run lint` | 0 |
| `npm.cmd run check` | 0 |
| `npm.cmd run build` | 0 |
| `npx.cmd --yes --package=node@22.23.3 node node_modules/tsx/dist/cli.mjs --test test/**/*.test.ts` | 1 |
| `npm.cmd audit --json` | 0 |
| `git diff --check` | 0 |
| Node 22 version probe | 0 (`v22.23.3`) |

テストは42件で、33 pass、8 fail、1 skip。失敗は `independent-fixes.test.ts` の3件（stale PID委譲、終了待ちのstale/finished、100ページ残存中のowner件数）、`mvp.test.ts` の3件（保護root重複時の期待エラー文との差、その後のOAuthおよびtransferでACL検証失敗）、`regressions.test.ts` の2件（NR003とNR005でMCP request timeout）。テスト所要時間は約337.1秒。実行中にHEADが更新されたため、失敗を開始時の固定HEADだけに帰属させられず、修正後treeだけの結果とも断定しない。

skipはPOSIX permissions検査1件。Windowsでの実行では対象外のためskipされた（POSIX側のLinux実行結果は未確認）。`npm audit --json` はinfo/low/moderate/high/criticalの脆弱性がすべて0。Linux CIの実行・結果も未確認のため、全体gateは未通過として扱う。

追記: 全体実行の終了後、未コミットの作業treeに `src/index.ts` と `test/mvp.test.ts` を含む変更が現れた（内容はこの担当では確認していない）。HEADは 75197bb42085e87e340df6fa5982aab54073014e のままだが、現在のworktreeは開始時HEADとも終了時HEADとも一致しない。これらの編集には本ゲート結果を適用しない。記録後の git diff --check は exit 0。

## 追試: f4b2076d4d026c8710985c0a81f9c9c83617ad41

前回8件失敗の後、厳密なbatch audit、監視順、streaming offset、fixtureの修正とfocused検証を経たHEADに対し、全体ゲートを再実行した。証拠は `reference/validation/remote-full-gate-f4b2076/` に保存した。開始・終了HEADは `f4b2076d4d026c8710985c0a81f9c9c83617ad41` で一致し、実行前にコードやテストの作業差分はなかった。実行時のNodeは `v24.20.0`、テスト用Nodeは `v22.23.3`。終了時に見えた作業差分は親所有のレポートとタスク記録のみ。

| コマンド | 終了コード |
| --- | ---: |
| `npm.cmd ci` | 0 |
| `npm.cmd run lint` | 0 |
| `npm.cmd run check` | 0 |
| `npm.cmd run build` | 0 |
| `npx.cmd --yes --package=node@22.23.3 node node_modules/tsx/dist/cli.mjs --test test/**/*.test.ts` | 1 |
| `npm.cmd audit --json` | 0 |
| `git diff --check` | 0 |
| Node 22 version probe | 0 (`v22.23.3`) |

全テストは42件、40 pass、1 fail、1 skip、所要約235.6秒。唯一の失敗は `regressions.test.ts` の NR005 実HTTP OAuthとMCP操作テストで、約73.5秒後に `MCP error -32001: Request timed out`。skipはPOSIX permissionsテストであり、Linux上の実行結果は未確認。npm auditのinfo/low/moderate/high/critical脆弱性はすべて0。Linux CIも未確認のため、この全体gateは未通過として扱う。

## 追試: 96b10cd8b7026e73512de3c294f67894621709bf

NR005の標準エラーpipe drainと出力上限stub、NR010のoutput guardとbody deadlineを含む修正後のHEADで全体ゲートを実行した。証拠は `reference/validation/remote-full-gate-96b10cd/` に保存した。開始・終了HEADは `96b10cd8b7026e73512de3c294f67894621709bf` で一致。実行前にコード/testの作業差分はなく、終了時に見えた作業差分は親所有レポートだけだった。実行時Nodeは `v24.20.0`、テストはNode `v22.23.3`。

| コマンド | 終了コード |
| --- | ---: |
| `npm.cmd ci` | 0 |
| `npm.cmd run lint` | 0 |
| `npm.cmd run check` | 0 |
| `npm.cmd run build` | 0 |
| `npx.cmd --yes --package=node@22.23.3 node node_modules/tsx/dist/cli.mjs --test test/**/*.test.ts` | 0 |
| `npm.cmd audit --json` | 0 |
| `git diff --check` | 0 |
| Node 22 version probe | 0 (`v22.23.3`) |

テストは43件、42 pass、0 fail、1 skip、所要約153.7秒。skipはPOSIX permissionsテストで、Windows上では未実行。npm auditのinfo/low/moderate/high/critical脆弱性はすべて0。この結果でWindows上の全体ゲートは通過した。Linux CIおよびPOSIX permissionsテストは未確認。
