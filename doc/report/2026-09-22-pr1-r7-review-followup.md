# PR #1 RDMCP-R7 指摘対応報告

## メタデータ

- リポジトリ: `ssaattww/RemoteDesktopMCP`
- PR: #1
- 対象 finding: RDMCP-R7
- severity: High
- source reviewed implementation HEAD: `75c50f61ae2855817aacebe739e8e731e7c64f1e`
- 作業開始 HEAD: `2fe4f86bf0ea60095744dc848c6ff3fd0ea3d5df`
- 設計修正 technical HEAD: `28f8fc4a122a61e4b6956991427d0b18ff0ceb84`
- ブランチ: `feat/tailscale-funnel-design-lint`
- 実行環境: FA780
- 作業ディレクトリ: `C:\Users\donabe\Project\RemoteDesktopMCP-pr1-r4-20260922`
- 診断保存先: `C:\Users\donabe\Project\RemoteDesktopMCP-pr1-r7-diagnostics-20260922`

## 目的

同一 Desktop Commander 世代内で PID が再利用された場合でも、
古い logical process ID が新しいプロセスを参照しないよう process ownership を定義する。

## 対象範囲

RDMCP-R7 の required action だけを対象とする。

- 同一 `{ node_id, desktop_commander_generation, pid }` の現在所有者を一意に管理する。
- PID 再利用時は新しい logical ID を公開する前に旧 mapping を失効させる。
- 現在所有者ではない logical ID から PID を RDC へ渡さない。
- 完了済み final snapshot を active PID ownership から外す。
- RDC 再起動なし、同一世代 PID 再利用の検証項目を追加する。

製品コード、RDC 委譲実装、CI workflow、用語 whitelist、過去のレビュー報告は変更しない。

## 診断 workflow

`.github/workflows/lint.yml` を current HEAD 上で再確認した。

- npm install の stdout / stderr / 結果を保存する。
- lint の stdout / stderr / 結果を保存する。
- workflow 対象 SHA と Node.js / npm 情報を保存する。
- artifact upload は `if: always()` で成功・失敗どちらでも実行する。

今回の finding 対応で workflow 変更は不要と判断した。

## RDMCP-R7 対応

`{ node_id, desktop_commander_generation, pid }` を `process_key` と定義した。

統括ノードは実行中または終了未確認の対応情報について、
各 `process_key` の現在所有者となる logical process ID を
`current_process_owner` として最大1件だけ保持する。

新しい `process_start` が既存 owner と同じ `process_key` を返した場合は、
次の順序で処理する。

1. 既存 `current_process_owner` の mapping を `stale` / 状態不明へ遷移する。
2. 旧 mapping から PID を RDC へ渡せる状態を外す。
3. `current_process_owner` を新しい logical process ID へ原子的に置き換える。
4. owner 更新後にだけ新しい logical process ID を外部へ公開する。

logical process ID 自体は `process_start` 完了前に生成してよいが、
owner 更新が完了するまで利用者へ返さない。

## status / output / kill の所有者検証

`process_status`、`process_output`、`process_kill` は次の両方を満たす場合だけ
PID を Desktop Commander へ渡す。

- mapping の `desktop_commander_generation` が実行ノードの現在世代と一致する。
- logical process ID がその `process_key` の `current_process_owner` である。

どちらかを満たさない mapping は `stale` / 状態不明とする。

特に `process_kill` は世代不一致または owner 不一致の場合、
`force_terminate` を呼び出さない。

## generation 変更時

Desktop Commander 接続を失った場合は、旧世代の実行中 mapping を
`stale` / 状態不明へ遷移させる既存規則に加えて、
旧世代の `current_process_owner` 索引を削除する。

新世代で同じ PID が使われても旧 logical ID を復活させない。

## 完了済みプロセス

プロセス終了を確認した場合は final snapshot を保持し、
PID を必要とする active mapping から退役させる。

その logical process ID が `current_process_owner` である場合だけ
owner 索引を削除する。

final snapshot は以後 active PID ownership 判定へ参加しない。
`process_status` / `process_output` は確定結果から返してよく、
`process_kill` は終了済みとして拒否する。

## 追加した検証項目

同一世代 PID 再利用を実 OS の偶然に依存せず再現できるよう、
検証用の委譲実装を使うケースを設計へ追加した。

- Desktop Commander を再起動せず generation `G1` を維持する。
- 2回の `process_start` に同じ PID `P` を順に返す。
- 1回目の終了は RemoteDesktopMCP が未確認のままとする。
- 2回目の logical process ID を公開する前に1回目が `stale` になることを確認する。
- `current_process_owner[{node_id,G1,P}]` が2回目だけを指すことを確認する。
- 1回目の status/output/kill が `read_process_output` / `force_terminate` を呼ばないことを確認する。

これにより RDC 再起動を伴わない同一 generation 内の PID 再利用を検証できる。

## 変更ファイル

- `doc/design/multi-pc-architecture.md`

`doc/design/functional-requirements.md` は R7 で変更不要と判断した。

## ローカル検証

設計修正 technical HEAD 相当の作業ツリーで次を実行した。

- focused markdownlint: pass、1 file / 0 issues
- `npm run lint:md:terms:design`: pass
- `npm run lint:ts`: pass
- `npm run check`: pass
- `npm run build`: pass
- `npm audit --audit-level=low`: pass、0 vulnerabilities
- `git diff --check`: pass
- `npm run lint`: fail

full lint の失敗は既存の
`doc/report/2026-09-19-pr1-design-review-fix-verification.md:91`
MD036 `no-emphasis-as-heading` 1件のみだった。

R7 変更差分由来の Markdown finding はない。

各検証の stdout / stderr / result は
`C:\Users\donabe\Project\RemoteDesktopMCP-pr1-r7-diagnostics-20260922`
へ保存した。

## タスク台帳

`tasks/tasks-status.md` は current worktree に存在しないため更新対象なし。

## finding disposition

RDMCP-R7 (High) は実装担当として addressed とする。
通常レビュアーによる fix verification は未実施である。
severity は source review から変更していない。

## CI

この report と handoff を含む publication commit を push 後、
PR current HEAD と workflow run の `head_sha` が一致する run だけを確認する。

一致する run がなければ CI 未実施または確認不能として扱い、
別 SHA の run は代用しない。

## Remaining risks

- R7 は設計修正であり、製品実装はまだ行っていない。
- 実装後は same-generation PID reuse の focused test が必要。
- full repository lint は既存 MD036 により green ではない。
- final publication HEAD の exact-head CI は publication push 後に確認する。

## 次のアクション

同じ通常レビューチャットで RDMCP-R7 の fix verification を行う。

## Merge boundary

merge は実施しない。
