# PR #1 RDMCP-R8 指摘対応報告

## メタデータ

- リポジトリ: `ssaattww/RemoteDesktopMCP`
- PR: #1
- 対象 finding: RDMCP-R8
- severity: High
- source reviewed implementation HEAD: `5ee55a9d3f68a1c37efb4d8657697d57d266e18a`
- 作業開始時 PR HEAD: `f9134189c11de927b8b97ff2b0cf2daf17f86819`
- R8 / 用語整理 technical commit: `c8dc97b7b0f0e454573df08a66d038569d54effa`
- lint 表記整理 commit: `aecb261b8edf885fa6c549c6955e83c98b0b5f6e`
- ブランチ: `feat/tailscale-funnel-design-lint`
- 実行環境: FA780
- 作業ディレクトリ: `C:\Users\donabe\Project\RemoteDesktopMCP-pr1-r4-20260922`
- 診断保存先: `C:\Users\donabe\Project\RemoteDesktopMCP-pr1-r8-diagnostics-20260922`

## 目的

RDMCP-R7 で定義した現在所有者の確認と Desktop Commander の PID 操作の間に残る
並行実行の競合をなくす。

同時に、利用者指示に従い次を満たす。

- 読みやすい文章を lint より優先する。
- ホワイトリスト検査を回避するためだけに用語をコード表記や引用符で囲まない。
- 正式名称はホワイトリスト追加候補として明示する。
- リポジトリ全体の `npm run lint` を通す。

## 診断 workflow

`.github/workflows/lint.yml` を current HEAD で再確認した。

- npm install の stdout / stderr / 結果を保存する。
- lint の stdout / stderr / 結果を保存する。
- workflow 対象 SHA、Node.js、npm の情報を保存する。
- artifact upload は `if: always()` で成功・失敗の両方に実行する。

今回も追加の workflow 変更は不要だった。

## RDMCP-R8 対応

### 排他制御の単位

同じ実行ノードかつ同じ `desktop_commander_generation` のプロセス操作を
同時に1件だけ実行する。

排他制御の単位は次とする。

`{ node_id, desktop_commander_generation }`

対象操作は次の4つ。

- `process_start`
- `process_status`
- `process_output`
- `process_kill`

### process_start

`process_start` は Desktop Commander の `start_process` を呼ぶ前に
排他区間へ入る。

排他状態を次まで維持する。

1. `start_process` を呼ぶ。
2. PID を取得する。
3. 同一 PID の旧所有者がいれば `stale` / 状態不明へ遷移する。
4. 新しい `current_process_owner` を登録する。
5. 関連する RemoteDesktopMCP 状態を更新する。

新しい論理プロセス識別子は排他区間を抜けた後にだけ利用者へ返す。

### status / output / kill

PID を Desktop Commander へ渡す `process_status`、`process_output`、
`process_kill` も同じ排他制御に参加する。

排他区間へ入った後で、次を再確認する。

- 対応情報の世代が現在世代と一致する。
- 論理プロセス識別子が `process_key` の `current_process_owner` である。

排他区間に入る前の確認結果は最終判断に使わない。
確認に成功した場合だけ Desktop Commander を呼び出す。

Desktop Commander の呼び出しと、その結果に基づく状態更新が完了するまで
排他状態を維持する。

世代不一致または所有者不一致の場合は PID を渡さない。
特に `process_kill` は `force_terminate` を呼び出さない。

確定済み結果だけを返す `process_status` / `process_output` は
Desktop Commander へ PID を渡さないため排他制御の対象外としてよい。

1つの要求が複数の排他単位を同時確保する設計にはしない。

## 決定的な並行実行検証

実 OS のタイミングや PID 再利用の偶然に依存しない検証項目を追加した。

同じ実行ノード・同じ世代 `G1` で PID `P` の所有者を A とする。

A の `process_status`、`process_output`、`process_kill` について
次の2順序をそれぞれ検証する。

### A が先に排他を取得する場合

1. A が排他区間へ入る。
2. 所有者を再確認した直後、Desktop Commander 呼び出し前の同期点で停止する。
3. 並行して `process_start` B を開始する。
4. A の Desktop Commander 呼び出しと状態更新が完了して排他区間を抜けるまで、
   B が `start_process` を呼べないことを確認する。

### B が先に排他を取得する場合

1. B が `process_start` の排他区間へ入る。
2. B が同一 PID `P` の新しい所有者として登録される。
3. 待機していた A が排他区間へ入る。
4. A が所有者を再確認し、所有者不一致になることを確認する。
5. A が `read_process_output` や `force_terminate` を呼ばないことを確認する。

これにより、所有者の確認後に対象が変わる競合を決定的に検証できる。

## 読みやすさとホワイトリスト方針

過去の設計には、正式名称をホワイトリスト検査から除外するためだけに
コード表記にしていた箇所が残っていた。

今回、この方法を廃止した。
正式名称は通常の文章として記載し、必要な正式名称だけをホワイトリストへ追加した。

追加したホワイトリスト項目:

- Desktop Commander
  - ローカルのファイル操作・プロセス操作を提供する正式製品名。
- Remote Device
  - Desktop Commander の正式なリモート接続機能名。

追加しなかった候補:

- RDC
  - 何を指す略称か文脈で曖昧になるため、設計本文では Desktop Commander と明記した。
- scaffold
  - 日本語の「暫定実装」で自然に表現できるためホワイトリストへ追加しなかった。

また、設計3ファイルを機械的に再確認し、
Desktop Commander / Remote Device / RDC / scaffold を
コード表記にしてホワイトリスト検査を回避している箇所は 0 件であることを確認した。

コード表記は、パッケージ名、ツール名、設定名、状態値など
実際にコード上の識別子であるものに限定する。

## lint 修正

過去レビュー報告の MD036 も解消した。

対象:
`doc/report/2026-09-19-pr1-design-review-fix-verification.md`

判定値を強調だけの行やコード表記で lint 回避せず、
通常文章の「判定: pass_with_ci_pending」とした。

この変更によりリポジトリ全体の Markdown lint も通過するようになった。

## 変更ファイル

- `doc/design/functional-requirements.md`
  - Desktop Commander を通常の正式名称表記へ変更。
- `doc/design/multi-pc-architecture.md`
  - RDMCP-R8 の排他制御と並行検証を追加。
  - 正式名称を通常表記へ変更。
  - RDC / scaffold の曖昧・不自然な表現を整理。
- `doc/design/tailscale-funnel-architecture.md`
  - scaffold を「暫定実装」へ変更。
- `tools/lint/markdown-whitelist.yaml`
  - Desktop Commander / Remote Device を追加。
- `doc/report/2026-09-19-pr1-design-review-fix-verification.md`
  - MD036 を自然な文章で解消。

製品コードは変更していない。

## ローカル検証

最終設計候補で次を実行した。

- `npm run lint`: pass
  - markdownlint: 20 files / 0 issues
  - design terminology lint: pass
- `npm run check`: pass
- `npm run build`: pass
- `npm audit --audit-level=low`: pass、0 vulnerabilities
- `git diff --check`: pass
- 設計3ファイルの `--list-unknown`: pass、未許可語 0 件
- コード表記による検査回避の対象4種を再走査: 0 件

保存済み診断:
`C:\Users\donabe\Project\RemoteDesktopMCP-pr1-r8-diagnostics-20260922`

各検証の stdout / stderr / 結果を保存した。

## タスク台帳

`tasks/tasks-status.md` は現在の作業ツリーに存在しないため更新対象なし。

## 指摘の対応状況

RDMCP-R8 (High) は実装担当として addressed とする。
通常レビュアーによる fix verification は未実施。
重要度 High は元のレビューから変更していない。

## CI

この report / handoff を含む最終コミットを push した後、
PR の current HEAD と workflow run の `head_sha` が一致する run だけを確認する。

一致する run がなければ CI 未実施または確認不能として扱う。
別 SHA の run は代用しない。

## 残るリスク

- R8 は設計修正であり、製品実装は今後の作業。
- 実装時には排他制御と決定的な並行実行テストが必要。
- publication commit 後の exact-head CI は未確認。

## 次のアクション

同じ通常レビューチャットで RDMCP-R8 の fix verification を行う。

## マージ境界

merge は実施しない。
