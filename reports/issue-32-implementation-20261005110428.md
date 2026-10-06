# Issue #32 実装根拠

## 課題と調査

- Issue #32 は open、未割当で、本文に記載されたコメントはありません。REST API で全文を読み、Issue #32 を関連付けた open PR がないことを確認しました。
- Issue の症状は、長い `process_start` が Code Mode のRPC待機上限に達してタイムアウトすることです。Issue本文では、検索条件を単純化した別の rg 再実行が成功したと報告されています。先の試行がその間に完了したかどうかは、本文から確認できません。
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
- `test/tool-root-contracts.test.ts`: 初期応答に必要な出力がない場合、返された `process_id` で期限付きpollを行い、取得した出力へ既存の内容assertionを適用。
- `README.md`: `timeout_ms` とプロセス実行期限の違い、長時間コマンドの追跡方法を追加。

## TDDと検証

実行環境は `/workspace/RemoteDesktopMCP-issue32`、branch `codex/issue-32-process-start-early-response`、基点 `origin/main` の `1569eb9c7234036d6c71db06ee8549aa3162ff68` です。Node.js `v24.19.0`、npm `11.9.0` を使用しました。

1. **Red** — `node_modules/.bin/tsx --test --test-name-pattern='NR003 and NR004' test/search-process-lifecycle.test.ts`。実装前、`timeout_ms: 60000` の開始応答は 15,079 msかかり、5秒未満のassertionに失敗しました。
2. **Green** — 同じfocused command。最大1000 msの初期待機へ変更後、テストは成功しました。15秒プロセスが開始直後に追跡可能で、running状態確認と終了要求まで成功しました。
3. **監査ゲート回帰** — `node_modules/.bin/tsx --test --test-name-pattern='failed gate audit prevents dispatching an ordinary side effect' test/issue-56-shared-todo.test.ts` は1/1成功。process_start前のTodo監査に失敗するとprocess adapterの開始回数が0であることを確認しました。
4. **型検査** — `npm run check` 成功。
5. **lint** — `npm run lint` 成功。Markdownlintは147ファイル、問題0件。TypeScript lint と design terms lint も成功。
6. **ビルド** — `npm run build` 成功。
7. **全体テスト** — レビュー指摘対応後の `npm test` 成功、226件中215件成功、失敗0件、skip 11件、duration `137743.841368ms`。skipは主にWindows専用テストです。
8. `git diff --check` 成功。

## 通常レビュー指摘対応

- **R75-COV-01 (P3)** — `test/tool-root-contracts.test.ts` の3箇所で、初期 `output` に必要な内容がなければ返却 `process_id` に対して10秒期限・50 ms間隔の `process_output` pollを行い、得た出力へ既存assertionを適用するよう変更しました。Issue 13 fixtureは line-terminated output を1800 ms遅らせ、初期応答だけでは既存assertionが満たされない回帰にしています。Red (`node_modules/.bin/tsx --test --test-name-pattern='published tool descriptions' test/tool-root-contracts.test.ts`) は1件失敗し、実際の初期応答にはPIDと空の初期出力案内だけで、期待文字列がありませんでした。Green (`node_modules/.bin/tsx --test --test-name-pattern='published tool descriptions|Issue 20: root-scoped file operations|Issue 9: sessions require' test/tool-root-contracts.test.ts`) は3/3成功し、ファイル全体も3/3成功しました。Windows shard 3の前回失敗原因とは結び付けていません。
- **R75-DOC-01 (P3)** — Issue本文にない「再試行までに元コマンドが完了した」という説明を除き、本文で確認できる単純化した別 rg 再実行の成功へ訂正しました。
- **Code Mode E2E** — 実際のCode Mode経由E2Eは未実施です。ローカルのMCP fixture / InMemoryTransportおよびDesktop Commander統合テストと混同しません。

R75-COV-01 / R75-DOC-01 対応後の `npm run check`、`npm run lint`（Markdownlint 148ファイル、0 issues）、`npm run build` と `git diff --check` は成功しました。

`npm ci --no-audit --no-fund` は `/tmp/rdmcp-issue32-npm-cache` を指定して成功し、672 packages をインストールしました。`package.json` と `package-lock.json` に差分はありません。

## 残る確認

- Code Mode 側のRPC待機上限値はIssue本文にありません。初期待機を1000 msに制限したローカル統合テストは5秒未満で成功しましたが、Code Mode 側の上限が1秒未満の場合や著しく遅いホストでの応答保証はできません。
- コミット `c83e3379f38cd4b09dd3d88d27cdf282acc3d62f` をpushし、Draft PR [#75](https://github.com/ssaattww/RemoteDesktopMCP/pull/75) を作成しました。PRはopen / draftです。
- 同headの[CI run 37300792243](https://github.com/ssaattww/RemoteDesktopMCP/actions/runs/37300792243)ではUbuntuゲート、Windows割当、Windows shard 1、2、4〜8がpassしました。Windows shard 3は `Test` stepでfailしました。同jobのinstall、型検査、buildはpassです。
- GitHubで同jobのログ取得 (`gh api repos/ssaattww/RemoteDesktopMCP/actions/jobs/111732877498/logs`) と診断artifact取得 (`gh run download 37300792243 --name windows-diagnostics-shard-3-e1f785d4ee223193b5158ef153547b230639619f --dir /tmp/rdmcp-issue32-windows-shard3-diagnostics`) を試みましたが、どちらも `Forbidden` でした。アクセス制限を迂回しないため、失敗したテスト名と原因は未特定です。コード回帰か環境要因か判断できないため、PRはDraftのままです。
- main取り込み時は、Issue #28 の並行変更が `src/index.ts` に触れている点を考慮して差分とCIを再確認してください。#28、#72、#74、Issue #24系列の既存作業を変更していません。

## Node.js 24 CI更新（2026-10-06）

- `.github/workflows/lint.yml` のUbuntu job、Windows割当job、Windows shard job、および `.github/workflows/test-runtime-measurement.yml` のNode.jsを、すべて固定版 `24.20.0` に更新しました。package engine、依存、lockfileは変更していません。
- head `c0e883c1683df533d5d2d51f4673f43441bf41d1` の [CI run 37444575561](https://github.com/ssaattww/RemoteDesktopMCP/actions/runs/37444575561) はUbuntu、Windows shard 1、2、4〜8が成功し、shard 3は `Test` stepで失敗しました。失敗テスト名と原因はjob metadataから確認できません。Node.js 22または24を原因とは判断していません。
- Windows全test fileを各3回測る [measurement run 37444633369](https://github.com/ssaattww/RemoteDesktopMCP/actions/runs/37444633369) は成功し、同head向けartifactのuploadも成功しました。artifact名は `test-runtime-measurement-37444633369-1-c0e883c1683df533d5d2d51f4673f43441bf41d1`、GitHub metadata上のサイズは51,983 bytesです。
- 上記の新規artifactを一度取得しましたが、`gh run download 37444633369 --name test-runtime-measurement-37444633369-1-c0e883c1683df533d5d2d51f4673f43441bf41d1 --dir /tmp/rdmcp-issue32-node24-measurements` はblob取得時に `Forbidden` で拒否されました。以前拒否されたshardログ/artifactも、この新規measurement artifactも再取得していません。署名付きURLのqueryは記録に含めていません。
- artifactの内容を読めないため、測定記録のNode/npm版、30ファイル各3回の記録、candidate fingerprintを独立検証できず、manifestは更新しませんでした。現行manifestはWindows Node.js `v22.23.3` / npm `10.9.9` のままです。Node 24環境とはfingerprintが不一致となるため、schedulerは古い計測値を使わずbaseline割当へfallbackします。Node 24用measurementはartifactの検証が阻まれた状態です。
- PR #75はopen / Draftのままです。shard 3の失敗原因、measurement artifactの内容、Code Mode経由E2Eはいずれも未確認です。
