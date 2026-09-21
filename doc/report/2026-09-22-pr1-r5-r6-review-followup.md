# PR #1 RDMCP-R5 / RDMCP-R6 指摘対応報告

## メタデータ

- リポジトリ: `ssaattww/RemoteDesktopMCP`
- PR: #1
- 対象 finding: RDMCP-R5, RDMCP-R6
- severity: High / High
- source reviewed implementation HEAD: `71d039f0ea2d3b0d57bc5a3d4e4c6ba4d0a59ed8`
- 作業開始 HEAD: `3b097d7d4dabeed3cdd01b9d0f27c9bca951559d`
- 設計修正 technical HEAD: `d519baa744bcc43d688b9a65f7987263495f5173`
- ブランチ: `feat/tailscale-funnel-design-lint`
- 実行環境: FA780
- 作業ディレクトリ: `C:\Users\donabe\Project\RemoteDesktopMCP-pr1-r4-20260922`
- ローカル診断: `C:\Users\donabe\Project\RemoteDesktopMCP-pr1-r5-r6-diagnostics-20260922`

## 目的

RDMCP-R4 の RDC 委譲設計を維持したまま、RDC 0.2.50 の実際のプロセス契約に合わせて
RDMCP-R5 と RDMCP-R6 を解消する。

## 診断 workflow

`.github/workflows/lint.yml` を current HEAD 上で再確認した。
成功・失敗にかかわらず `if: always()` で診断 artifact を保存し、次を含む。

- npm install の stdout / stderr / 結果
- lint の stdout / stderr / 結果
- workflow 対象 SHA
- Node.js / npm 環境情報

今回の finding 対応に追加 workflow 変更は不要と判断した。

## RDC 0.2.50 の実機確認

FA780 の Remote Desktop Commander `get_config` で version `0.2.50` を確認した。
また stdout と stderr へ別々の識別文字列を出す検証用プロセスを起動し、
`read_process_output` で読み戻した。

結果として両方の識別文字列は同じ出力列に含まれ、
各行が stdout / stderr のどちら由来かを示す情報は返らなかった。
完了状態と終了状態情報は返された。
このため RDMCP-R5 は、RDC に存在しない出所情報を RemoteDesktopMCP 側で推測するのではなく、
初期版の公開契約を RDC が提供可能な統合出力へ合わせる方針を採用した。

## RDMCP-R5 対応

初期版の process output 契約を次へ変更した。

- `process_output.output`: RDC が保持する単一の統合出力
- `process_output.state`: 実行中、終了、状態不明などの RemoteDesktopMCP 状態
- `process_output.exit_code`: RDC から取得できた終了コード。実行中または不明なら `null`
- 個別の `stdout` / `stderr` 欄は初期版では提供しない
- 統合出力から stdout / stderr の出所を推測して付与しない

機能要件の「stdout および stderr を取得」を、
「Desktop Commander が保持する単一の統合出力を取得」へ変更した。

初期版の RDC 検証基準を `@wonderwhy-er/desktop-commander` 0.2.50 と明記した。
配備版を変更するときは process output 契約を機械検証する。
検証用プロセスから stdout / stderr の両方へ識別文字列を出し、
両方が統合出力に含まれること、終了状態と取得可能な終了コードを得られること、
RemoteDesktopMCP が出所情報を生成しないことを確認する。

この検証を満たさない版へは更新しない。

## RDMCP-R6 対応

論理プロセス対応情報を少なくとも次の世代付き identity とした。

`{ node_id, desktop_commander_generation, pid }`

`desktop_commander_generation` はローカル Desktop Commander 接続ごとに
暗号学的乱数から生成する `16 bytes` の不透明な値とし、旧接続の値を再利用しない。

- 初回 Desktop Commander 接続確立時に新しい世代を生成する
- Desktop Commander 子プロセスまたは stdio 通信接続を再生成したら新しい世代を生成する
- 統括ノードとの通信だけが再接続し、同じ Desktop Commander 接続を継続する場合は世代を維持する
- 実行ノード自体が再起動した場合も新しい世代を生成する
- 実行ノードは現在世代を統括ノードへ通知する
- 統括ノードは再接続時に世代差を検出すると旧世代の実行中 mapping を `stale` / 状態不明へ遷移させる

`process_start` 成功時に現在世代と PID を論理プロセス ID へ対応付ける。
`process_status` / `process_output` / `process_kill` は mapping の世代と現在世代が一致する場合だけ
PID を Desktop Commander へ渡す。

世代不一致時は新しい Desktop Commander へ PID を渡さない。
特に `process_kill` では `force_terminate` を呼び出さない。

Desktop Commander 接続喪失時は、その世代の実行中 mapping を即時に `stale` / 状態不明へ遷移させる。
新世代で同じ PID が現れても旧論理 ID を再対応付けしない。

## 完了済みプロセスの扱い

プロセス終了を確認できた場合は、次を RemoteDesktopMCP 側の確定結果として保持する。

- 終了状態
- 取得済み統合出力
- 取得できた終了コード

その後、PID を必要とする active mapping から退役させる。
確定済みの `process_status` / `process_output` は確定結果から返してよい。
`process_kill` は終了済みとして拒否する。

終了確認前に Desktop Commander 接続を失った場合は、終了したと推測せず状態不明とする。

## 追加した検証項目

- pinned RDC version で stdout / stderr 両方の識別文字列が統合出力に含まれ、
  出所情報を推測しないこと
- 世代 `G1` の論理 ID を保持した状態で RDC を再起動して `G2` にし、
  `G2` で同一 PID が存在しても旧 ID の status/output/kill が RDC tool を呼ばないこと
- 終了確認済み mapping が active PID mapping から退役し、
  確定結果から status/output を返し、kill を拒否すること

## 変更ファイル

- `doc/design/functional-requirements.md`
- `doc/design/multi-pc-architecture.md`

製品コード、CI workflow、用語 whitelist、過去のレビュー報告は変更していない。

## 検証結果

設計修正 technical HEAD 相当の作業ツリーで次を実行した。

| 検証 | 結果 |
| --- | --- |
| focused markdownlint | pass、2 files / 0 issues |
| `npm run lint:md:terms:design` | pass |
| `npm run lint:ts` | pass |
| `npm run check` | pass |
| `npm run build` | pass |
| `npm audit --audit-level=low` | pass、0 vulnerabilities |
| `git diff --check` | pass |
| `npm run lint` | fail |

full lint の失敗は既存の
`doc/report/2026-09-19-pr1-design-review-fix-verification.md:91`
MD036 `no-emphasis-as-heading` 1件のみだった。

各コマンドの stdout / stderr / result は
`C:\Users\donabe\Project\RemoteDesktopMCP-pr1-r5-r6-diagnostics-20260922`
へ保存した。

## finding disposition

- RDMCP-R5 (High): addressed; fix verification 待ち
- RDMCP-R6 (High): addressed; fix verification 待ち

severity は source review から変更していない。

## Unknown / remaining risk

- RDC 委譲の製品実装はまだ行っていない。
- R6 の世代失効は設計済みだが、実装後に同一 PID 再利用条件を含む focused test が必要。
- full repository lint は既存 MD036 により green ではない。
- current publication HEAD の exact-HEAD CI は report/handoff commit push 後に確認する。

## 次のアクション

report/handoff を publication commit として保存後、
PR current HEAD と一致する workflow run のみを CI 証跡として確認する。
その後、同じ通常レビューチャットで RDMCP-R5 / RDMCP-R6 の fix verification を行う。

## Merge boundary

merge は実施しない。
