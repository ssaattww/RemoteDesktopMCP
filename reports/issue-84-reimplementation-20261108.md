# Issue #84 再実装報告

## タスク

共有Todoの更新履歴。Issue: <https://github.com/ssaattww/RemoteDesktopMCP/issues/84>

## sub-agentを使う理由

認可・監査保存・MCP・画面にまたがる変更を一人の実装担当にまとめ、親が統合とレビューを管理する。

## 対象範囲

既存設計の参照保持、共有Todo履歴、矢印切替、サブTodo案内文削除。

## 対象外

RDMCP利用、CodexSandboxOfflineでの実行、他作業の変更、マージ、依存追加。

## Dispatch profile

- selection inputs: implementation / judgment_heavy / uncertainty high / cross_module / criticality high / sequential_dependencies / bounded_history
- selection source: CodexSkill main sub-agent-task-manager
- observed decomposability: sequential_dependencies
- decomposition policy / disposition: one implementation worker; parallel work has blocking design dependencies
- requested profile: gpt-6.1-sol / high / fork none (available Sol model; skill's 5.6 runtime unavailable)
- agent role / default-role plan: runtime default; collaboration API exposes no role override; local config has no agents role section
- planned runtime profile: gpt-6.1-sol / high
- applied profile: null
- application status: spawn_succeeded_profile_unverified
- runtime profile observability: final_profile_hidden
- approval status: ordinary Sol high; expensive profile and Astra not requested

## 実行コマンド

実行者は `fa780\donabe`、端末は `FA780`、シェルは PowerShell、作業場所は `C:\Users\donabe\Documents\Codex\RemoteDesktopMCP`。初回と再開時に `whoami` を確認した。ローカル検証が可能である。

- `npm ci` は終了値0。既存の依存固定を使用し、依存固定ファイルは変更していない。標準出力・標準エラーは `reference/issue84-validation/npm-ci.*.log`。
- 正式な失敗確認: `npx --no-install tsx --test test/shared-todo-history.test.ts --test-name-pattern='history'` は6件失敗、終了値1。未実装の履歴取得・HTTP経路を検出した。同じ保存先の `red-contract.stdout.log`、`red-contract.stderr.log`、`red-contract-source.diff`、`red-contract-inputs.txt` が証拠である。
- 画面の失敗確認: `npx --no-install tsx --test --test-name-pattern='history arrows' test/user-console-client.test.ts` は1件失敗、終了値1（`red-ui.*.log`）。実装後は1件成功、終了値0（`green-ui-first.*.log`）。
- 最初の依存不足による `ERR_MODULE_NOT_FOUND` は `red.*.log` に保存し、正式な失敗確認には数えない。
- 最初の契約再実行は5件成功・1件失敗、終了値1（`green-contract-first.*.log`）。MCP説明入力の自動付加が原因であり、修正前の失敗証拠として残す。
- 関連6ファイルの試験は `focused-tests.*.log`。`npm run check`、`npm run build`、`npm run lint:ts` はすべて終了値0で、`check.*.log`、`build.*.log`、`lint-ts.*.log` に保存。
- 設計書の明示指定による構文検査と `node scripts/check-markdown-whitelist.mjs --files doc/design/shared-todo-update-history.md` は終了値0（`design-lint-final.*.log`、`design-terms-final.*.log`）。用語設定は変更していない。

正式な失敗確認の基準HEADは `ecc512b9112ec58590e6accfb10210a53b66cc6b`。準備前に開始した差分は保持したまま親の指示で一時停止し、[Draft PR #93](https://github.com/ssaattww/RemoteDesktopMCP/pull/93) と課題 #84 の正式紐付け後に再開した。再開後の基準HEADは `2933873c75d6f27022448604269229ebfaa277d4`。この親コミットは文書と進捗管理のみで、製品と試験の差分は未コミットである。

最初の関連試験の入力は `reference/issue84-validation/focused-source.json` と `focused-source.diff` に保存（指紋 `b9761a8cb17af3a20cc482db6509feafba8f907bd440f33caf7a46ea6b26637f`）。修正後の最終入力は `final-source.json` と `final-source.diff` に保存（指紋 `23fe2c7edaa61095150837518d8449bd45cc0c0ed97aa40a33014d947d1fce61`）。両者とも全製品・試験のTypeScriptファイル、設計書、依存と検査設定の56ファイルを含み、親管理の報告・進捗管理を含まない。結果は基準HEAD単独ではなく、この未コミット差分と指紋に対応する。

## 対象ファイル

- `src/index.ts`: 更新ロックと既存監査保存を使う差分記録、試行分類、本人限定の読み取り専用取得、MCP経路。
- `src/todo-history.ts`: 保存形式の検証、確定状態の差分、画面と初期HTMLで共有する日本語表示。
- `src/user-console-todo-history.ts`: 版の前後移動と履歴だけの再取得。現在の編集領域とは独立。
- `src/user-console.ts` と `src/user-console-client.ts`: 認証済みHTTP経路、初期HTMLと画面処理、利用者画面の更新元記録、子項目の案内文だけを削除。
- `test/shared-todo-history.test.ts`: 項目差分、試行、保存警告、所有境界、終了・期限切れ・再起動、取得上限、読み取り専用の回帰。
- `test/user-console-client.test.ts`: 矢印の端、選択版の保持、未送信入力と現在版の不変。
- `test/issue-56-shared-todo.test.ts`: 案内文がないことを期待し、既存の親別開閉の検証は維持。
- `doc/design/shared-todo-update-history.md`: 現在の実装契約、保持範囲、保存失敗時と読み取り専用の境界。

旧設計は読み取り専用の参考として保持した。親が確認した旧ファイルのSHA256は `A831E7BD0689907C5D6834FF424014C971BF8B851FAF323C7981F25BF853CD6A`。旧作業場所、設定、他課題、依存固定ファイルは変更していない。

## 指摘事項

適用された版の全項目と、本文・状態・親・兄弟順序の確定前後を記録する。同じ要求内の中間値は保存せず、兄弟の再採番も値が変わった項目として含める。追加・削除は片側が存在しない形で表す。

履歴は既存の非公開監査保存と最新20,000件の索引を使い、本人・対象接続の最新50件を返す。成功版と未適用試行は別配列とし、導入前、保存失敗、取得範囲外を推測で埋めない。現在版との差と版の欠落、上限をMCPと画面の両方に示す。

保存失敗時は既存契約を保ち、適用済み状態を戻さず `applied: true`、`history_recorded: false` を返す。後者は保存成功が確認できなかったことを表す。競合、入力拒否、適用前の失敗は固定理由だけを保存し、拒否本文・生の要求・例外全文は含めない。

MCP履歴取得は認証済み利用者を使い、通常の操作説明入力は要求しつつ保存せず、操作監査の共通処理を通さない。正常・不正形式の取得とも現在状態、鮮度判定、接続寿命、監査ファイルを変更しない。終了後は取得範囲内の本人の成功記録も所有証明となる。別人の試行だけでは所有証明にしない。

## 結果

関連6ファイルの一括実行は150件中148件成功・2件失敗、終了値1であった。既存の同値契約と必須説明入力を保つよう修正し、成功応答に追加した `history_recorded: true` は取り除いた。保存警告時だけ `history_recorded: false` を追加する。既存試験を弱めず、修正の影響を受ける対象だけを再実行した。

- `npx --no-install tsx --test test/shared-todo-history.test.ts`: 7件成功、終了値0（`final-history.*.log`）。実際のMCP更新と認証済みHTTP更新の更新元も確認した。
- `npx --no-install tsx --test test/issue-56-shared-todo.test.ts`: 31件成功、終了値0（`final-issue56.*.log`）。
- `npx --no-install tsx --test --test-name-pattern='every tool requires a comment' test/user-console-audit-process.test.ts`: 1件成功、終了値0（`final-comment.*.log`）。
- `npm run check`、`npm run build`、`npm run lint`: すべて終了値0（`final-check.*.log`、`final-build.*.log`、`final-lint.*.log`）。全体のMarkdown構文検査は167ファイル、問題0件。

一括試験の他の成功結果は修正前の指紋に対応し、修正後の全面再実行とは扱わない。最終の変更は成功応答形式・履歴ツールの入力契約・その回帰試験と設計追記であり、上記の再実行に対応する。

補助的に実施した報告書全体の用語検査は終了値1（`report-terms.*.log`）。親所有のDispatch記述、既存見出しなどの未登録語を含む。これは必須の `npm run lint` と分けた、設定対象外の厳格な補助検査の失敗として保持する。構文の裸URLはリンクに直した。用語設定、親のDispatch内容、見出し順は変更していない。

最終の設計書・本報告の明示指定構文検査、設計書の明示指定用語検査、全体Markdown構文検査、`git diff --check` は終了値0（`final-focused-md.*.log`、`final-design-terms.*.log`、`final-all-md.*.log`、`final-diff-check.*.log`）。最終の56ファイルの指紋を再計算し、検証入力から変わっていないことを確認した。報告の用語検査対象本文も `report-terms-source.md` に保存する。

全面検証、独立確認、コミット、追加送信、公開、統合はこの実装担当では行っていない。

## リスク

全期間の完全な履歴は保証しない。監査の最新20,000件と応答の最新50件の外側、導入前、保存未確認の版は取得できない可能性がある。削除項目や終了・期限切れ・再起動後の履歴も、取得範囲内にある間だけ参照できる。監査保存先の自動削除期限は既存実装にないが、無期限の参照は保証しない。

監査書き込み後の確認失敗では、記録が存在しても保存警告が返る場合がある。既存の適用後監査契約を保ち、適用の取り消しや自動再試行は行わない。試行記録自体の保存失敗も完全性の保証外である。

親から伝達された旧参照作業場所のGit操作は、所有者が `CodexSandboxOffline` のため拒否された。例外設定、所有権変更、再試行、迂回をせず、設計ファイルだけを読み取った。RDMCPや別エージェントは使っていない。全面検証と独立確認は親の後続工程に残る。
