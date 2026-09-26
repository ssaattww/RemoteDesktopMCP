# PR #1 RDMCP-R4 指摘対応報告

## メタデータ

- リポジトリ: `ssaattww/RemoteDesktopMCP`
- PR: #1
- 対象 finding: RDMCP-R4
- severity: High
- reviewed HEAD: `15e6372f12f390bbcde8bae7e74bf94788c1b063`
- 設計修正 technical HEAD: `87be847e3f4dcd501e3b5b432fcb1cc0f867b2f6`
- ブランチ: `feat/tailscale-funnel-design-lint`
- 実行環境: FA780
- 作業ディレクトリ: `C:\Users\donabe\Project\RemoteDesktopMCP-pr1-r4-20260922`

## 目的

RDMCP-R4 で指摘された、RemoteDesktopMCP と RDC のローカル操作責務の重複を解消する。
基本設計を RDC の代替実装から、RDC を外部へ安全に公開する制御層へ変更する。

## 参照した RDC 実装

GitHub 上の `wonderwhy-er/DesktopCommanderMCP` の次の実装を確認した。

- `src/remote-device/desktop-commander-integration.ts`
- 確認時 blob SHA: `d82e625d8ee71847332d995d8c7b08a5a3f1be9f`

同実装は MCP SDK の `Client` と `StdioClientTransport` を使ってローカル Desktop Commander を起動し、
`listTools()` で能力を取得し、`callTool()` で処理を委譲している。

RemoteDesktopMCP も同じ責務境界を採用する。
Desktop Commander の内部クラスや内部ソースを直接利用するのではなく、MCP を再利用境界とする。

## 採用した責務境界

RemoteDesktopMCP が独自に保持する責務は次とする。

- 外部ユーザーの OAuth/OIDC 認証と認可
- RemoteDesktopMCP の `session_id` 管理
- `node_id` の登録、認証、要求振り分け
- 統括ノードと実行ノードの通信
- `request_id` を用いた監査関連付け
- 公開ツールの許可方針と引数制約
- 複数 PC をまたぐ論理プロセス識別子の管理
- Tailscale Funnel を含む外部公開経路との接続

ファイル探索、ファイル読書き、部分編集、プロセス起動、状態・出力取得、停止は
RemoteDesktopMCP 内で同等機能を再実装せず、各実行ノードの
`@wonderwhy-er/desktop-commander` へ `stdio` MCP 経由で委譲する。

## 公開操作と RDC 委譲

初期版では次の対応を設計した。

| RemoteDesktopMCP | 主な RDC 委譲先 |
| --- | --- |
| `file_search` | `start_search`、`get_more_search_results`、`stop_search` |
| `content_search` | `start_search`、`get_more_search_results`、`stop_search` |
| `file_read` | `read_file` |
| `file_patch` | `edit_block` |
| `process_start` | `start_process` |
| `process_status` | `list_sessions`、`read_process_output` |
| `process_output` | `read_process_output` |
| `process_kill` | `force_terminate` |

RemoteDesktopMCP の公開契約と RDC のツール契約は同一にする必要はない。
委譲層が入力・出力を変換し、外部認可、`session_id`、`node_id`、監査、
RemoteDesktopMCP 固有方針を適用した後だけ `callTool()` を行う。

RDC の全ツールをそのまま外部へ公開しない。
RDC の設定変更ツールや初期版で許可していない操作は公開対象外とする。

## ローカル方針

Desktop Commander のローカル許可範囲と RemoteDesktopMCP の方針の両方を満たす要求だけを実行する。
RemoteDesktopMCP の許可 root や書き込み制約は RDC と同じか、より狭い範囲だけを許可する。

必須 RDC ツールが存在しない場合は対象操作を利用不可とする。
同等処理を RemoteDesktopMCP の独自実装へ自動的に切り替えない。

配備時は検証済みの `@wonderwhy-er/desktop-commander` 版を固定し、
本番運用で自動的に `latest` へ追従しない方針とした。

## RDC にない機能の独自実装

初期版では、RDC が提供しないローカルのファイル操作またはプロセス操作を
RemoteDesktopMCP が独自実装する例外は設けない。

将来例外が必要になった場合は、実装前に次を設計へ追加する。

- 機能名
- RDC で代替できない根拠
- 必要なローカル権限
- 監査方法
- 検証項目

これにより、ローカル操作を理由なく二重実装しない。

## 現在の `src/index.ts` の扱い

現行 `src/index.ts` は最終構成ではなく暫定 `scaffold` と位置付けた。

RDC 委譲実装時の扱いは次のとおり。

- `searchFiles()` と `readdir` / `stat` による探索を削除する。
- ファイル検索は RDC 検索ツールへ委譲する。
- `launch_configured_process` の直接 `spawn` を削除する。
- 固定起動設定を残す場合も方針確認後に `start_process` へ委譲する。
- `create_file_download` と `/downloads/:token` は初期版要件外のため削除対象とする。
- `getRoot()` 等は方針確認に必要な範囲だけ残せるが、ローカルファイル I/O は行わせない。
- OAuth/OIDC、セッション、ノード振り分け、監査など固有責務は本体へ残す。

今回の対応は設計変更であり、`src/index.ts` 自体は変更していない。

## 変更ファイル

- `doc/design/functional-requirements.md`
- `doc/design/multi-pc-architecture.md`
- `doc/design/tailscale-funnel-architecture.md`

製品コード、CI workflow、用語 whitelist は変更していない。

## 検証

今回変更した3設計書に対して次を確認した。

| 検証 | 結果 |
| --- | --- |
| focused markdownlint | pass、3 files / 0 issues |
| `npm run lint:md:terms:design` | pass |
| `npm run lint:ts` | pass |
| `npm run check` | pass |
| `npm run build` | pass |
| `npm audit --audit-level=low` | pass、0 vulnerabilities |
| `git diff --check` | pass |

`npm run lint` の全体実行は今回変更していない既存ファイル
`doc/report/2026-09-19-pr1-design-review-fix-verification.md:91` の
MD036 `no-emphasis-as-heading` で失敗する。

該当箇所は既存レビュー報告の `**pass_with_ci_pending**` であり、
RDMCP-R4 の変更差分には含まれない。
過去のレビュー証跡を本対応で書き換えることはしていない。

## 診断 artifact

既存の `.github/workflows/lint.yml` を確認した。
成功・失敗にかかわらず `if: always()` で artifact を保存し、
次を含むため追加変更は不要と判断した。

- npm install の stdout / stderr / 結果
- lint の stdout / stderr / 結果
- workflow の対象 SHA
- Node.js / npm の環境情報

## finding disposition

RDMCP-R4 (High) は実装担当として addressed とする。
通常レビュアーによる fix verification は未実施である。

## CI

この報告を含む publication commit の push 後、
PR current HEAD と `head_sha` が一致する workflow run だけを確認する。
一致する run が存在しない場合、CI 未実施または確認不能として報告する。
別 SHA の run は代用しない。

## 残件

- RDMCP-R4 の通常レビュアーによる fix verification
- 設計に従った RDC 委譲の製品実装
- 既存レビュー報告由来の MD036 は R4 とは別の既存 lint 課題

## Merge boundary

merge は実施しない。
