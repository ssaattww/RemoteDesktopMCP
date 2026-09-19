# PR #1 設計レビュー指摘対応報告

## メタデータ

- リポジトリ: `ssaattww/RemoteDesktopMCP`
- PR: #1
- 作業モード: review follow-up implementation
- ブランチ: `feat/tailscale-funnel-design-lint`
- ベース: `main`
- 初回レビュー対象 HEAD: `4e6a4bac3c8f7823fa24305d2c640f6e0b188b4b`
- 初回レビュー報告コミット: `21407514754c6f34c9e24772aa9f338fe374f3eb`
- 設計修正 technical HEAD: `24af370bee37890d9a3dd3482757cd80a945c206`
- 実行環境: `ibis-ThinkBook-14-G7-IML`
- 作業ディレクトリ: `/home/ibis/CodexProjects/RemoteDesktopMCP`

## 目的

PR #1 の通常設計レビューで指摘された RDMCP-R1〜RDMCP-R3 を、設計の範囲だけで修正する。

対象 finding:

- RDMCP-R1 — High — MCP 接続と RemoteDesktopMCP 独自セッションの境界が未定義
- RDMCP-R2 — High — ノード間相互認証方式が未確定
- RDMCP-R3 — Medium — `node_id` 省略条件が接続状態によって実行対象を変え得る

## 非対象

- 設計に対応する製品コード実装
- 初回レビューで指摘されていない設計の再構成
- 通常レビュアーによる fix verification
- merge

## 根拠

- `doc/report/2026-09-18-pr1-design-review.md`
- PR #1 の設計レビューコメント
- `doc/design/functional-requirements.md`
- `doc/design/multi-pc-architecture.md`
- `.github/workflows/lint.yml`

## RDMCP-R1 対応

`session_id` を MCP の通信セッションや HTTP 接続とは独立した RemoteDesktopMCP 独自の操作単位として定義した。

- `session_open` で暗号学的乱数から生成する。
- ファイル操作とプロセス操作は有効な `session_id` を明示する。
- 別の HTTP 接続からも、同じ認証済みユーザーで有効期限内なら継続利用できる。
- 最終活動から24時間で失効する。
- `session_close` で明示的に終了できる。
- `session_list` の列挙対象と返却項目を定義した。
- 終了、失効、サーバー再起動後の `session_id` は再利用しない。
- セッション終了だけを理由に実行中プロセスを自動停止しない。
- プロセスは起動時セッションへ監査上関連付け、同じユーザーの別の有効なセッションから管理できる。

対応コミット: `edfc1d603795127571127ee78c8f81176d80087d`

## RDMCP-R2 対応

初期版のノード間相互認証方式を具体化した。

- 統括ノードと各実行ノードの組ごとに異なる `32 bytes` の共有秘密情報を使用する。
- `client_nonce` と `server_nonce` を使った `HMAC-SHA-256` の相互所有証明を定義した。
- `HKDF-SHA-256` で接続専用鍵を生成する。
- `connection_id`、方向別 `sequence`、`request_id`、送信本体の `SHA-256` 値を `HMAC-SHA-256` で検証する。
- 古い `sequence`、接続識別子不一致、検証値不一致を拒否し、再送攻撃を防止する。
- 認証完了前の操作実行を禁止した。
- 共有秘密情報と接続専用鍵の保管、ログ禁止、ファイル操作 root からの除外を定義した。
- ローカル登録、更新時の停止と再設定、失効時の削除と既存接続切断を定義した。
- 認証失敗時は要求を実行せず接続を閉じる。

対応コミット: `df2f3877531d83490cf222c449a0cf7c2eebfa13`

## RDMCP-R3 対応

`node_id` の省略可否を接続状態ではなく、構成に登録された実行ノード数で決めるように変更した。

- 登録済み実行ノードが1台だけの場合に限り省略できる。
- 統括ノード自身が実行ノードを兼任する場合も登録台数へ含める。
- 2台以上登録されていれば、接続中が1台だけでも `node_id` を必須とする。
- 明示対象が切断中なら別ノードへ振り替えず失敗させる。
- 2台登録、1台だけ接続中、対象未指定の要求を拒否する検証項目を追加した。

対応コミット: `24af370bee37890d9a3dd3482757cd80a945c206`

## 変更ファイル

- `doc/design/functional-requirements.md`
- `doc/design/multi-pc-architecture.md`

`doc/design/tailscale-funnel-architecture.md`、製品コード、workflow、設定は変更していない。

## focused validation

各 finding の変更直後に次を実行した。

- `npm run lint:md`
- `npm run lint:md:terms:design`
- `git diff --check`

最終的にすべて pass した。

途中で Markdown trailing space 1件、未許可語「コンテキスト」2件、`salt` 1件、「オンライン」1件を検出し、設計内容を保ったまま修正した。
ホワイトリストは変更していない。

## technical HEAD の全ローカル検証

`24af370bee37890d9a3dd3482757cd80a945c206` で次を実行し、すべて pass した。

| コマンド | 結果 |
| --- | --- |
| `npm run lint` | pass |
| `npm run check` | pass |
| `npm run build` | pass |
| `npm audit --audit-level=low` | 0 vulnerabilities |
| `git diff --check` | pass |

## CI と診断 artifact

`.github/workflows/lint.yml` は、成功・失敗にかかわらず `if: always()` で診断 artifact を保存する。
保存対象には lint の結果、stdout、stderr、npm install の stdout/stderr、環境情報が含まれる。

この報告ファイルと handoff を含む最終 publication HEAD は、この報告生成後に commit/push される。
exact-HEAD CI は最終 HEAD と run の `head_sha` が一致するものだけを確認し、結果は PR コメントへ記録する。
別 SHA の run は代用しない。

## finding disposition

| Finding | Severity | 実装担当での状態 |
| --- | --- | --- |
| RDMCP-R1 | High | addressed; fix verification 待ち |
| RDMCP-R2 | High | addressed; fix verification 待ち |
| RDMCP-R3 | Medium | addressed; fix verification 待ち |

severity は初回レビューから変更していない。

## Unknown / remaining risk

- この報告は実装担当による指摘対応記録であり、通常レビュアーの fix verification を代替しない。
- ノード間通信の製品実装と実接続試験はまだ行っていない。
- ChatGPT と CIMD/DCR の実接続互換性は初回レビュー時と同様に未検証である。
- `tasks/tasks-status.md` はこのリポジトリに存在しない。

## 次のアクション

最終 publication HEAD の exact-HEAD CI を確認後、同じ通常レビューチャットで RDMCP-R1〜RDMCP-R3 の fix verification を行う。

## Merge boundary

merge は実施しない。
