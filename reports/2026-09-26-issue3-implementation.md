# Issue #3 実装レポート

## メタデータ

- Repository: `ssaattww/RemoteDesktopMCP`
- Issue: #3 「ファイル操作・転送のフォルダ制限を撤廃する」
- Pull Request: #5 `Remove file-root restrictions from file and transfer tools`
- Branch: `issue-3-unrestricted-file-paths`
- Base: `main` / `865f6cd65763f36e0b48f39e1f3d402e696c8308`
- Technical HEAD: `a73c30dde708f4400b22ecf6ecc1daec82fd1621`
- Execution environment: FA780 / Windows / `C:\Users\donabe\RemoteDesktopWorkspace\RemoteDesktopMCP-issue3`
- Verification capability: `local_execution_available`

## 目的と範囲

Issue #3 に従い、ファイル読み込み、検索、部分編集、アップロード、ダウンロードについて、
事前登録した許可フォルダに限定する RemoteDesktopMCP 独自の制約を撤廃した。

ファイル系 MCP ツールは `root_id` と `relative_path` の組ではなく、対象 PC 上の絶対 `path`
を受け取る。アクセス可否の基準は、RemoteDesktopMCP を起動した OS ユーザーの権限とする。

一方で、許可フォルダ制限とは別のサービス内部保護として、`DATA_DIR` と、サービスが
追跡している Desktop Commander 設定実体はファイル API の対象外のままとした。
認証、転送の SHA-256 整合性確認、上書き指定、プロセス実行の権限モデルは維持した。

## TDD

実装前に `test/mvp.test.ts` へ新仕様の試験を追加し、Red を確認した。

Red の主な失敗:

1. `configuration does not require a file-root allowlist`
   - `FILE_ROOTS_JSON must contain valid JSON.`
2. `file and transfer tools accept absolute OS paths while service state stays protected`
   - `node_list` が旧仕様の `root_ids` を返していたため失敗。

診断:

- `reference/validation/issue3-diagnostics/red.stdout.log`
- `reference/validation/issue3-diagnostics/red.stderr.log`

これらは `reference/` 配下の作業用診断であり、リポジトリにはコミットしていない。

## 実装内容

### ファイル API

`src/index.ts`:

- `RuntimeConfig.roots` と `FILE_ROOTS_JSON` の読み込みを削除。
- `node_list` から `root_ids` を削除。
- `file_search` / `content_search` / `file_read` / `file_patch` の入力を絶対 `path` に変更。
- `file_transfer_download_begin` / `file_transfer_upload_begin` の入力を絶対 `path` に変更。
- Desktop Commander の `allowedDirectories` を `[]` に固定。
- 起動中も Desktop Commander 設定が `allowedDirectories: []` のままであることを検証。
- `DATA_DIR` 配下と追跡済み設定実体へのファイル API アクセスを拒否。
- upload 所有 manifest から `rootId` 依存を削除し、絶対パスと file identity で管理。

### 設定 CLI

`src/remote-auth-cli.ts`:

- `configure` の `--root` 引数と `FILE_ROOTS_JSON` 出力を削除。
- `DATA_DIR` の既存既定値 `~/RemoteDesktopMCP-data` は維持。
- 新仕様を示す完了メッセージへ更新。

### 試験

- 旧 `root_id` / `relative_path` 呼び出しを絶対 `path` へ移行。
- 許可フォルダ外相当の通常ファイルについて、read / patch / search / upload / download を確認。
- `DATA_DIR` の直接読み取り拒否を確認。
- 絶対パス必須を確認。
- protected-config の置換 fixture を `allowedDirectories: []` に更新。
- symlink / junction 経由の絶対パス回帰を維持。
- upload 所有 manifest の新形式を確認。

### 文書

以下を新仕様へ同期した。

- `.env.example`
- `README.md`
- `doc/remote-setup.md`
- `doc/design/functional-requirements.md`
- `doc/design/multi-pc-architecture.md`
- `doc/design/tailscale-funnel-architecture.md`

過去のレビュー・実装レポートは履歴証拠のため変更していない。

## コミット

- `11489ce911cd10c7f13911a5ac92214587a4229d` — `refactor: accept absolute file paths`
- `df8b557c1311d87079312c0d40a72b307bb72c57` — `test: align config fixtures with unrestricted access`
- `a73c30dde708f4400b22ecf6ecc1daec82fd1621` — `docs: align unrestricted file path configuration`

## ローカル検証

### 診断 workflow

`.github/workflows/lint.yml` は作業開始時点ですでに Ubuntu / Windows の両ジョブで、
テスト結果、stdout、stderr、コマンド結果、環境ログを `ci-artifacts` として保存していた。
そのため Issue #3 では workflow 変更を行っていない。

### focused MVP

`node_modules\.bin\tsx.cmd --test test\mvp.test.ts`

結果:

- tests: 5
- pass: 5
- fail: 0

診断:

- `reference/validation/issue3-diagnostics/green.stdout.log`
- `reference/validation/issue3-diagnostics/green.stderr.log`

### lint

`npm.cmd run lint`

最初の実行では、新規設計文中の whitelist 未登録語により失敗した。
設計文を既存ルールに適合する表現へ修正した後、再実行は成功。

最終診断:

- `reference/validation/issue3-diagnostics/lint2.stdout.log`
- `reference/validation/issue3-diagnostics/lint2.stderr.log`

### type check

`npm.cmd run check`

結果: exit code 0。

診断:

- `reference/validation/issue3-diagnostics/check2.stdout.log`
- `reference/validation/issue3-diagnostics/check2.stderr.log`

### build

`npm.cmd run build`

結果: exit code 0。

診断:

- `reference/validation/issue3-diagnostics/build.stdout.log`
- `reference/validation/issue3-diagnostics/build.stderr.log`

### full test

`npm.cmd test`

最終結果:

- tests: 44
- pass: 43
- fail: 0
- skipped: 1
- cancelled: 0

skip は Windows 実行時に対象外となる POSIX 権限試験。

診断:

- `reference/validation/issue3-diagnostics/full-test2.stdout.log`
- `reference/validation/issue3-diagnostics/full-test2.stderr.log`

最終全体試験では、以前の実行で欠落した検索ページング試験
`NR003 and NR004: searches return every page and portable Node processes retain output/audit`
も成功した。

## 検証対象の同一性

lint / check / build / full test を行った未コミット差分の fingerprint:

`1bbfb24aee8f13b9bb3b496565393bc08d28cbd4`

この差分をそのまま `a73c30dde708f4400b22ecf6ecc1daec82fd1621` としてコミットした。
`df8b557c..a73c30d` の committed diff fingerprint も
`1bbfb24aee8f13b9bb3b496565393bc08d28cbd4` と一致し、検証後の内容変更はない。

## CI

このレポートを保存するコミット後の PR current HEAD を最終対象とし、
その HEAD SHA と workflow run の `head_sha` が一致する run だけを CI 証拠として採用する。
別 SHA の run は代用しない。

レポート作成時点では、レポート保存後の最終 HEAD はまだ存在しないため、
CI 結果は未記載とする。最終 HEAD と一致する run の確認結果は PR コメントへ記録する。

## 未変更・非対象

- 認証方式および Google OIDC の基本契約
- transfer の最大サイズ、チャンク順序、SHA-256 検証
- overwrite / no-replace の確定動作
- `process_start` の OS ユーザー権限モデル
- 複数 PC 機能そのものの実装
- 過去の `reports/` / `doc/report/` 記録

## 残存リスク

- `file_search` / `content_search` は、保護対象を検索結果へ出さないため、
  指定した検索ディレクトリ配下に `DATA_DIR` または追跡済み設定実体が含まれる場合、
  Desktop Commander へ検索を渡す前に要求全体を拒否する。
- OS が拒否するパスでは Desktop Commander または Node のファイル操作が失敗する。
- `process_start` は同じ OS ユーザー権限の任意コマンドを実行できるため、
  ファイル API のサービス管理領域除外はプロセス実行に対するサンドボックスではない。

## Merge 境界

この作業では merge を行わない。merge は利用者が行う。
