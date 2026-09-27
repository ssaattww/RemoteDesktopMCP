# Issue #10 実装報告

## 対象

- repository: `ssaattww/RemoteDesktopMCP`
- branch: `issue-10-profile-environment`
- base: `origin/main` at `a28188f`
- 設計修正 commit: `bed971f23423ebf84ca2c32e2bb92d9ab74425e7`
- 実装 commit: `b944bff706d82fdbc7ff429164da8e198bdcb238`
- merge: 未実施

## 目的

RemoteDesktopMCP 専用の Desktop Commander 設定を隔離したまま、
`process_start` の子プロセスにはサーバー起動ユーザーの
`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`HOME`、`HOMEDRIVE`、`HOMEPATH`
を継承させる。

## 設計

最初に `doc/design/functional-requirements.md` と
`doc/design/tailscale-funnel-architecture.md` を修正し、
`bed971f` として commit / push した。

## 診断 artifact

`.github/workflows/lint.yml` は既に Ubuntu / Windows の両方で、
成功・失敗にかかわらず test results、stdout、stderr、environment log、
command result を artifact 保存するため、workflow 変更は不要だった。

## TDD

### RED

設計 commit `bed971f` の一時 worktree に Issue #10 の回帰テストだけを追加し、
`npx.cmd tsx --test --test-name-pattern="Issue 10" test\\regressions.test.ts`
を実行した結果 fail。
旧実装では Desktop Commander 用隔離 home がユーザープロファイル環境へ上書きされることを確認した。

### GREEN

実装候補で同じ focused test を実行し、1 pass / 0 fail。

## 実装

変更:

- `src/index.ts`
- `scripts/desktop-commander-bootstrap.mjs`
- `test/fixture.ts`
- `test/mvp.test.ts`
- `test/regressions.test.ts`
- `README.md`

固定版 Desktop Commander を管理する場合だけ専用 bootstrap を経由し、
`configManager.configPath` を RemoteDesktopMCP 専用設定へ向ける。
Desktop Commander 読み込みに必要な一時的な環境切替後は元のプロファイル環境を復元し、
後続の `process_start` が起動ユーザーの通常プロファイルを継承するようにした。

## 検証

pass:

- focused Issue #10 test
- `npm.cmd run lint`
- `npm.cmd run check`
- `npm.cmd run build`
- `git diff --check`

差分 fingerprint:

- tracked diff: `7b04e393ed866de95e7f3e89e28f13cfbbc8827d`
- bootstrap: `c5bd28ba91f9c983b136949afc8afd95b78fc1c0`

full test `npm.cmd test`:

- 52 tests
- 50 pass
- 1 fail
- 1 skip

fail は既存の
`NR003 and NR004: searches return every page and portable Node processes retain output/audit`
の
`natural exit must be audited without process status/output polling`。
同じ test は未実装の設計 commit `bed971f` でも同一 assertion で fail したため、
Issue #10 で新規導入された回帰ではない。

## publication

- `bed971f23423ebf84ca2c32e2bb92d9ab74425e7`: design commit、push 済み。
- `b944bff706d82fdbc7ff429164da8e198bdcb238`: technical implementation HEAD、push 済み。
- implementation report commit: pending。

## PR / CI

- PR #11 は OPEN / draft。
- PR current HEAD: `b944bff706d82fdbc7ff429164da8e198bdcb238`。
- pull_request workflow run `36306216816` の headSha は上記HEADと完全一致し、conclusionは success。
- Windows job と Ubuntu job はともに success。
- windows/ubuntu diagnostics artifact の存在と expired=false を確認。

## 受け入れ条件の証拠

1. profile系環境変数: Issue #10 test が USERPROFILE / APPDATA / LOCALAPPDATA / HOME / HOMEDRIVE / HOMEPATH をサービス起動環境と一致比較する。
2. CLI設定/認証状態: 現在接続中の旧RDMCPプロセスで通常ユーザーprofileをプロセス内だけ一時復元すると、gh auth status は ssaattww のログイン済み状態を認識した。認証設定自体は変更していない。
3. RDMCP固有データ: 専用Desktop Commander設定を DATA_DIR 配下へ向けるbootstrapを追加し、通常ユーザー設定を変更しない。
4. 自動テスト: Issue #10 focused testのRED→GREENを確認し、technical HEADのWindows/Ubuntu CIも成功。

## 未確認・残件

- 現在接続中のRDMCPサーバーは変更前プロセスのため、更新版を実運用起動した後の無補正 gh auth status 実機確認はまだ行っていない。コード、自動テスト、CIの証拠とは分けて記録する。
- このreportをcommit / pushした後、その新しいPR current HEADに一致するCIだけを最終確認する。
- 最終CI確認後、変更内容と検証結果の簡易reportをPR #11へコメントする。
- mergeは実施しない。
