# Issue #32 実装根拠

## 課題と調査

- Issue #32 は open、未割当で、本文に記載されたコメントはありません。REST API で全文を読み、Issue #32 を関連付けた open PR がないことを確認しました。
- Issue の症状は、長い `process_start` が Code Mode のRPC待機上限に達してタイムアウトすることです。再試行時にはコマンドが完了していたため成功しており、ユーザーから見た再試行は実行結果確認ではなく、長い初期応答待ちを繰り返していました。
- 固定依存 `@wonderwhy-er/desktop-commander@0.2.51` の `dist/terminal-manager.js` を確認しました。`executeCommand` は子プロセスを登録した後、`timeout_ms` で初期応答を解決し、タイムアウト時にも PID と出力を返します。この値はコマンドの実行期限ではありません。子プロセスは別途追跡できます。
- Issue #32 の対応PRや実装は見つかりませんでした。open PR #28 は Issue #25 の複数ノード作業で、プロセス関連実装を含みますが、Issue #32 の初期待機時間を制限する変更ではありません。#28 のブランチには手を加えていません。Issue #24 のCI系列、#72、#74も変更対象外です。Issue #31には触れていません。
- 対象repoには `AGENTS.md` と `.agents/skills` はありませんでした。Project 4 の priority/status は確認できていないため記載していません。

## 要件と変更

- `process_start` は、長時間動くコマンドの実行を続けたまま速やかに `process_id` を返し、`process_status` / `process_output` で追跡できること。
- 既存の `timeout_ms` 入力範囲（100〜60000 ms）を維持し、Desktop Commander に渡す初期出力待ちだけを最大 1000 ms に制限しました。プロセスの実行期間は制限しません。短いコマンドは待ち時間内に完了すれば、従来どおり初期出力・完了情報を返します。
- MCP tool description と README に値の意味、1000 ms の上限、返却されたIDによる追跡方法を記載しました。
- Todo の operation/audit gate とプロセス起動の順番は変更していません。新規依存、manifest、lockfile の変更はありません。

## 変更ファイル

- `src/index.ts`: Desktop Commander と process adapter へ渡す初期出力待ちを最大1000 msに制限し、ツール説明を更新。
- `test/search-process-lifecycle.test.ts`: 15秒動作するプロセスを `timeout_ms: 60000` で開始し、開始応答が5秒未満であること、実行中の状態と終了要求が引き続き機能することを確認。
- `README.md`: `timeout_ms` とプロセス実行期限の違い、長時間コマンドの追跡方法を追加。

## TDDと検証

実行環境は `/workspace/RemoteDesktopMCP-issue32`、branch `codex/issue-32-process-start-early-response`、基点 `origin/main` の `1569eb9c7234036d6c71db06ee8549aa3162ff68` です。Node.js `v24.19.0`、npm `11.9.0` を使用しました。

1. **Red** — `node_modules/.bin/tsx --test --test-name-pattern='NR003 and NR004' test/search-process-lifecycle.test.ts`。実装前、`timeout_ms: 60000` の開始応答は 15,079 msかかり、5秒未満のassertionに失敗しました。
2. **Green** — 同じfocused command。最大1000 msの初期待機へ変更後、テストは成功しました。15秒プロセスが開始直後に追跡可能で、running状態確認と終了要求まで成功しました。
3. **監査ゲート回帰** — `node_modules/.bin/tsx --test --test-name-pattern='failed gate audit prevents dispatching an ordinary side effect' test/issue-56-shared-todo.test.ts` は1/1成功。process_start前のTodo監査に失敗するとprocess adapterの開始回数が0であることを確認しました。
4. **型検査** — `npm run check` 成功。
5. **lint** — `npm run lint` 成功。Markdownlintは147ファイル、問題0件。TypeScript lint と design terms lint も成功。
6. **ビルド** — `npm run build` 成功。
7. **全体テスト** — `npm test` 成功、226件中215件成功、失敗0件、skip 11件。skipは主にWindows専用テストです。
8. `git diff --check` 成功。

`npm ci --no-audit --no-fund` は `/tmp/rdmcp-issue32-npm-cache` を指定して成功し、672 packages をインストールしました。`package.json` と `package-lock.json` に差分はありません。

## 残る確認

- Code Mode 側のRPC待機上限値はIssue本文にありません。初期待機を1000 msに制限したローカル統合テストは5秒未満で成功しましたが、Code Mode 側の上限が1秒未満の場合や著しく遅いホストでの応答保証はできません。
- コミット `c83e3379f38cd4b09dd3d88d27cdf282acc3d62f` をpushし、Draft PR [#75](https://github.com/ssaattww/RemoteDesktopMCP/pull/75) を作成しました。PRはopen / draftです。
- 同headの[CI run 37300792243](https://github.com/ssaattww/RemoteDesktopMCP/actions/runs/37300792243)ではUbuntuゲート、Windows割当、Windows shard 1、2、4〜8がpassしました。Windows shard 3は `Test` stepでfailしました。同jobのinstall、型検査、buildはpassです。
- GitHubで同jobのログ取得 (`gh api repos/ssaattww/RemoteDesktopMCP/actions/jobs/111732877498/logs`) と診断artifact取得 (`gh run download 37300792243 --name windows-diagnostics-shard-3-e1f785d4ee223193b5158ef153547b230639619f --dir /tmp/rdmcp-issue32-windows-shard3-diagnostics`) を試みましたが、どちらも `Forbidden` でした。アクセス制限を迂回しないため、失敗したテスト名と原因は未特定です。コード回帰か環境要因か判断できないため、PRはDraftのままです。
- main取り込み時は、Issue #28 の並行変更が `src/index.ts` に触れている点を考慮して差分とCIを再確認してください。#28、#72、#74、Issue #24系列の既存作業を変更していません。
