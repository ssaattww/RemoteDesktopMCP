# 単一PC最小版の実装

## Dispatch

Requested: gpt-5.6-terra / high; explicit user override. Fresh context, tool default role with no exposed role override; planned profile equals request, applied null, final profile hidden. Bounded technical implementation following Sol design; cross-module and high-criticality file/auth boundaries; sequential dependencies so one implementation owner. Tasks T03-T06. No mandatory TDD policy; focused meaningful tests required.

## Scope and changes

T03〜T06 の単一 PC ローカル最小版を実装した。src/index.ts は 127.0.0.1 だけで待ち受け、1 人のローカル開発ユーザー、OAuth 認可コード、PKCE S256、短期 Bearer token を実装する。登録済み redirect URI は完全一致で確認し、認可コードは一度だけ使える。

session_open、session_list、session_close、node_list を追加した。セッションは所有者と 24 時間の idle 期限を確認し、不明な node ID と remote role 設定を拒否する。通常の file search、content search、read、部分編集、process 操作は @wonderwhy-er/desktop-commander 0.2.51 の stdio MCP 接続へ委譲する。起動時に listTools で必要な tool を確認し、検索は結果を取得してから search session を停止し、部分編集には edit_block を使う。

Desktop Commander 子プロセスには DATA_DIR 配下の HOME、USERPROFILE、APPDATA を設定する。子の設定は root だけを明示し、get_config の応答で isolated allowedDirectories を確認する。既存ユーザーの設定は変更しない。7 個の file_transfer tool は immutable private snapshot、順序付き chunk、size と SHA-256、private temp file、hard link の atomic no-replace を使う。data directory、config parent、symlink を解決した root 範囲外、config file と同一 inode の hard link は拒否する。成功、拒否、失敗を audit JSONL に記録し、password、token、file bytes は記録しない。

create_file_download と downloads URL route は削除した。README と .env.example は local 起動、環境変数、process_start の同一 OS ユーザー信頼境界を説明する。

## 修正後の validation と source identity

この section は通常レビュー後に更新した。以前の 3 件だけの Node 24 test 結果と、完了済みとしていた DR-001〜003 の記述は最終 evidence ではない。レビューで指摘された Node 22 shutdown、protected config alias、transfer expiry、search/process pagination、PKCE と session metadata を source で修正し、DR-002 の `overwrite=false` は upload begin 前に同じ directory の hard-link capability を確認するようにした。失敗を注入する test 用には `RuntimeConfig.linkNoReplace` を optional seam として追加している。

Windows / PowerShell、`C:\Users\donabe\Project\RemoteDesktopMCP`、branch `feat/tailscale-funnel-design-lint` で確認した。package は Node 22 以上を要求する。source owner が最後に実行した `npm.cmd run check`、`npm.cmd run build`、`npm.cmd run lint:ts` と `npm.cmd run lint` は pass した。regression owner は `npx.cmd --yes node@22.23.3 node_modules/tsx/dist/cli.mjs --test test/**/*.test.ts` が 50.981 秒で 12/12 pass、0 fail/cancel/skip と報告した。これは live Desktop Commander、HTTP MCP、race、expiry、search、process と OAuth fixture を含む。統合 result は `reports/2026-09-25-regressions.md` と parent の immutable review で確認する。

`npm audit --omit=dev` は 0 vulnerabilities で終了した。Desktop Commander 0.2.51 の固定 pin を維持し、transitive `sharp` は 0.35.4、`uuid` は 11.1.1 に override した。override は同じ pinned Desktop Commander live fixture で確認する必要がある。

## Findings matrix

| Finding | Source action | Fixture/evidence owner |
| --- | --- | --- |
| DR-001 | private snapshot、同じ bytes の hash、順序付き chunk と失敗 cleanup | `DR001: downloads use one immutable multi-chunk snapshot and clean failed snapshots` が Node 22 で pass |
| DR-002 | inode-pinned upload temp、same-directory hard-link probe、atomic no-replace | race と injected `ENOTSUP` の 2 fixture が Node 22 で pass |
| DR-003 | hard-link alias preflight、direct-access guard、temp path identity | `DR003: protected config aliases cannot be read, searched, or reached by a swapped upload temp` が Node 22 で pass |
| NR-001 | SDK stdio shutdown を支える bounded referenced close | full Node 22 suite は cancellation なしで pass |
| NR-002〜006 | expiry sweep、bounded search/process、OAuth validation、session state | `NR002`〜`NR006` fixture が Node 22 で pass |

## Limitations and next action

この最小版はローカル開発用である。Google OIDC、CIMD、refresh token、複数 PC、Tailscale Funnel の有効化と公開検証は実装していない。`process_start` は同じ OS ユーザーの任意 command を実行できるため、file root の制限は任意 command のアクセスを隔離しない。

`overwrite=false` は対象 directory が hard link を提供しないと upload begin を拒否する。これは競合 destination を残す no-replace contract を弱めないためである。最終 status は regression result と immutable implementation review を待つ。

## Wording self-check

`skills/document-wording-review/SKILL.md` と decision examples に沿って、旧 validation claim を現在の source/test ownership と結果境界に合わせた。識別子、command と scope の意味を保ち、未受領の test result を pass と表現していない。Result: pass.
