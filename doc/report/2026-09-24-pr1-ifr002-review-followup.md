# PR #1 RDMCP-IFR-002 指摘対応報告

## メタデータ

- リポジトリ: `ssaattww/RemoteDesktopMCP`
- PR: #1
- finding: RDMCP-IFR-002
- severity: Medium
- finding の product content target: `1cefa9c701a683c054e0718bab1e009ab6ec32dd`
- 作業開始 HEAD: `eabe5c9d35becc941c9d38f20bf5dfe92f2e7fc1`
- technical HEAD: `972c28a04b22d0832e8f30217e09e45b119408f8`
- ブランチ: `feat/tailscale-funnel-design-lint`
- 実行環境: FA780
- 作業ディレクトリ: `C:\Users\donabe\Project\RemoteDesktopMCP-pr1-r4-20260922`
- 診断保存先: `C:\Users\donabe\Project\RemoteDesktopMCP-pr1-ifr002-diagnostics-20260924`

## 指摘の前提

利用者から、`process_start` は MCP サーバーを起動した OS ユーザーと
同じ権限で実行してよく、そのために別 OS ユーザーや新しい実行隔離機構を
必須にする必要はない、と製品要件が明確化された。

最新の製品観点レビューでは、この要件明確化により RDMCP-IFR-001 / High は
resolved と記録された。

そのうえで、旧IFR-001対応として追加した別 OS ユーザー、専用サービス、
OSアクセス権による分離、分離できない場合の `process_start` 無効化が
現在の要件より強すぎるとして RDMCP-IFR-002 / Medium が発行された。

## 対応した権限モデル

初期版では、RemoteDesktopMCP、Desktop Commander、
`process_start` から起動するプロセスを同じ OS ユーザーで動かしてよいと明記した。

認証済みの許可ユーザーは、`process_start` を通して
RemoteDesktopMCP を起動した OS ユーザーと同等の権限を行使できるものとして扱う。

その OS ユーザーが読み書きできるファイル、設定、環境変数などは、
任意コマンドからも到達できる可能性がある。
これは初期版の権限モデルに含まれる。

この権限が広すぎる環境では、運用者が RemoteDesktopMCP 自体を
より権限の小さい OS ユーザーで起動する。

別 OS ユーザーや OS のアクセス権による追加隔離を導入してもよいが、
初期版の必須条件にはしない。
追加隔離を導入していないことだけを理由に `process_start` を利用不可にはしない。

## file_* と process_start の違い

`file_search`、`content_search`、`file_read`、`file_patch` の
許可ディレクトリは、ファイル操作ツールの操作範囲を制限するための設定である。

この許可ディレクトリは、`process_start` から起動した任意コマンドの
ファイルアクセスを制限するものではない。

検証項目にも、同じ OS ユーザーから読み取れる検証用ファイルを
file tool の許可ディレクトリ外へ置き、`file_read` では拒否される一方、
`process_start` のコマンドからはアクセスできることを確認する項目を追加した。

## 許可ユーザー設定の扱い

許可ユーザー設定は、対象PC上のローカル設定として管理する。

ただし、ここでいう「ローカル設定」は、
RemoteDesktopMCP が設定変更専用の MCP / HTTP API を公開しないという意味である。

`process_start` は OS ユーザー権限で任意コマンドを実行できるため、
その OS ユーザーが設定ファイルを書き換えられる場合は、
認証済みの許可ユーザーもコマンド経由で同じ操作を行える。

これを初期版の権限モデルとして明記し、
「ローカル設定」という表現を任意コマンドに対する隔離保証として扱わないようにした。

## Desktop Commander の実行経路

旧IFR-001対応で追加した必須の実行ワーカー層を削除した。

初期版の基本構成は次とする。

RemoteDesktopMCP
→ `stdio` MCP
→ Desktop Commander
→ `process_start` のコマンド

統括ノード自身が実行ノードを兼ねる場合も同じ構成とし、
RemoteDesktopMCP、Desktop Commander、起動コマンドを同じ OS ユーザーで動かしてよい。

Desktop Commander の再利用方針は維持し、
RemoteDesktopMCP 側へローカル操作を重複実装しない。

## 過剰だったIFR-001対応の整理

現在の製品要件では必須でないため、次を初期版の必須条件から削除した。

- 管理側と実行側を別 OS ユーザーにする要件
- 専用の Windows サービスとして実行ワーカーを起動する要件
- OS のアクセス権で秘密設定を実行側から隔離する必須要件
- 分離を確認できない場合に `process_start` を無効化する要件
- 2ユーザー配備を前提とした execution-boundary fixture

旧IFR-001のために追加していた
`test/execution-boundary/windows/` の4ファイルも削除した。

別 OS ユーザーや OS のアクセス権による追加隔離は、
必要な運用環境だけが選択する任意の防御策として残せる。

## ホワイトリスト

旧隔離設計だけで使用していた次の項目をホワイトリストから削除した。

- Windows
- Administrators
- PowerShell
- Node.js
- インタープリター
- グループ
- シェル
- シェルコマンド
- ジャンクション
- シンボリックリンク
- スクリプト
- ダミー
- ダミーファイル
- デバッグ
- バックアップ
- ハンドル
- リンク
- ワーカー

自然な現在の説明で必要になった次の2語を追加した。

- モデル
- ファイルアクセス

検査を通すためだけのコード表記や引用符への変更は行っていない。

## 変更ファイル

変更:

- `doc/design/functional-requirements.md`
- `doc/design/multi-pc-architecture.md`
- `doc/design/tailscale-funnel-architecture.md`
- `tools/lint/markdown-whitelist.yaml`

削除:

- `test/execution-boundary/windows/Prepare-BoundaryFixture.ps1`
- `test/execution-boundary/windows/Probe-BoundaryFixture.ps1`
- `test/execution-boundary/windows/README.md`
- `test/execution-boundary/windows/Verify-BoundaryFixture.ps1`

製品コード、依存関係、CI workflow、過去のレビュー報告は変更していない。

## 診断 workflow

作業中に `.github/workflows/lint.yml` を再確認した。

workflow は成功・失敗の両方で、npm install / lint の stdout、stderr、結果、
対象 SHA、Node.js / npm の情報を artifact へ保存する。
追加変更は不要だった。

## ローカル検証

technical HEAD と同一内容について次を確認した。

- `npm run lint`: pass
- markdownlint: 27 files / 0 issues
- design terminology lint: pass
- `npm run check`: pass
- `npm run build`: pass
- `npm audit --audit-level=low`: pass、0 vulnerabilities
- `git diff --check`: pass
- design `--list-unknown`: 0件

stdout / stderr / result は
`C:\Users\donabe\Project\RemoteDesktopMCP-pr1-ifr002-diagnostics-20260924`
へ保存した。

report / handoff を追加したpublication候補でも `npm run lint` は
28 files / 0 issuesでpassした。
handoff YAML parse、`npm run check`、`npm run build`、
`npm audit --audit-level=low`、`git diff --check` もpassした。

## finding disposition

RDMCP-IFR-002 / Medium は実装担当として addressed とする。
レビュー元の severity は変更していない。

RDMCP-IFR-001 / High については、
最新の製品観点レビューが利用者による要件明確化を根拠に
resolved と記録している。
この実装担当から独自にseverityや過去判定を変更したものではない。

RDMCP-R8のロック、generation、current owner、PID再利用対策は変更していない。

## CI

technical HEAD `972c28a04b22d0832e8f30217e09e45b119408f8` をpush後に確認した時点では、
同じ SHA の workflow run / commit status はまだ0件だった。

report / handoff を含む publication commit 後は、
その final PR HEAD と `head_sha` が完全一致するrunだけをCI証拠として扱う。
別SHAのrunは代用しない。

## タスク台帳

`tasks/tasks-status.md` は存在しないため更新対象なし。

## 次のアクション

通常レビュアーで RDMCP-IFR-002 のfix verificationを行う。
製品観点レビューで既に問題なしとされた領域を、今回の実装担当が独自に再判定しない。

## マージ境界

マージは行わない。
