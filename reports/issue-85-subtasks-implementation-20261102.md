# 共有Todoのサブタスク実装レポート

作成日: 2026年11月2日。時刻は、特記しない限り日本標準時です。

## 実装結果と検証の要点

共有Todoに親子関係を追加し、MCPと利用者画面の両方から子の追加、親の変更・解除、兄弟の並べ替えができるようにしました。親子孫を含む構成、直属の子の完了数、配下の未完了件数を取得できます。画面では子を折り畳んでも共有データを保持し、構成だけを変更するときに未保存の本文や状態を送信しないようにしています。

関連する3ファイルのテストは120件すべて成功しました。追加したテストは19件です。実ブラウザーでも幅320px・1280px、深さ8の表示と操作を確認しました。実装コミットに一致するCIは10ジョブすべて成功しています。

公開した実装HEADでの最終ローカル全体試験は、287件中282件成功・4件失敗・1件スキップ、終了コード1でした。続く同じHEAD・同じソース識別値でのプロセス限定再試験は、対象2件と内側のkill試験1件を合わせて3件すべて成功しました。限定再試験やCIの成功によって、全体試験の4失敗を成功へ置き換えてはいません。原因は未確定です。出典は[検証台帳](issue-85-subtasks-validation-20261102.json)の各実行記録です。

一方、初回のローカル全体試験は287件中279件成功、7件失敗、1件スキップでした。失敗を調査し、今回導入した監査処理の回帰を修正しました。Windowsのプロセス起動に関する5件は、独立して依存関係を導入した変更前の基準版でも同じエラーを再現しています。この履歴を、関連テストやCIの成功によって取り消してはいません。公開した実装コミットでの全体再試験の結果は、後述の専用節に記録します。

## 対象と実行環境

| 項目 | 内容 |
| --- | --- |
| リポジトリ | [ssaattww/RemoteDesktopMCP](https://github.com/ssaattww/RemoteDesktopMCP) |
| 対応Issue | [#85](https://github.com/ssaattww/RemoteDesktopMCP/issues/85) |
| PR | [#90](https://github.com/ssaattww/RemoteDesktopMCP/pull/90)、ドラフト |
| 作業ブランチ | `task/shared-todo-subtasks` |
| ベース | `main`、`7e16a666cc30af0f7f58816f38d5459c489a4fd0` |
| 設計を先行更新したコミット | `e1ef7c550087c7ba324c334d46f87d8da208b125` |
| 実装を公開したコミット | `2a3b6bec2193820ce9fcb56b2b5191959ca744c6` |
| 実行PC | FA780、Windows |
| 作業ディレクトリ | `C:/Users/donabe/RemoteDesktopWorkspace/RemoteDesktopMCP-subtasks` |
| 基準版の確認場所 | `C:/Users/donabe/RemoteDesktopWorkspace/RemoteDesktopMCP-subtasks-base` |
| ローカルの実行環境 | Node.js `24.20.0`、npm `11.19.0` |
| CIの実行環境 | Node.js `22`、UbuntuとWindows |
| 検証経路 | 接続PCで実行可能。ローカル検証、コミット、push、CI確認を別の状態として記録 |
| 公開状態 | 実装をコミット・pushし、ドラフトPRを作成済み |
| レビュー状態 | 正式レビューは未開始 |

このレポートは実装作業と検証結果の記録です。レビューの承認や、マージ・配置の許可を表すものではありません。

## 仕様確認と設計を先に行った経緯

利用者の「実装前に一度仕様を提示する」という指示に従い、仕様案の確認で作業を区切りました。承認後は「設計書の更新、失敗するテストの確認、実装」の順で進めました。

設計コミットでは `doc/design/shared-todo-and-stale-update-gate.md`、`tasks/tasks-status.md`、`tasks/phases-status.md` を更新しました。設計書のMarkdown検査と用語検査を実行した後、設計コミットを作成しています。その後に、MCPの契約、画面操作、HTTPとサーバー側描画のテストを追加し、機能が未実装の状態で失敗することを確認しました。

### 採用した仕様

| 項目 | 内容 |
| --- | --- |
| 管理範囲 | 同じセッションの共有Todo内で親子関係を作る |
| 親と階層 | 親は1つ。最上位を含めて最大8階層 |
| 件数上限 | 親・子・孫を合わせて200件 |
| 構成の取得 | 全項目に親を表す `parent_id` を返し、親先行の並びと兄弟内の `order` で復元可能にする |
| 操作 | 子の新規追加、既存項目の親変更、親解除、兄弟内の並べ替え |
| 親の移動 | 移動した項目の子孫、識別子、状態を保持する |
| 不正な構成 | 自分自身・子孫・存在しない項目・別セッションの項目を親にする操作を拒否する |
| 状態 | 未着手・進行中・完了を項目ごとに保持し、親子へ自動で連動させない |
| 進捗表示 | 直属の子の総数・完了数と、配下全体の未完了件数を分ける |
| 削除 | 子がある親は削除できない |
| 一括更新 | 操作の途中で失敗した場合、先に処理した操作も保存しない |
| 同時更新 | 版の競合を検出し、最新の親子構成を返す |
| 折り畳み | 画面表示だけを変更する。MCPは折り畳み状態によらず全件を返す |
| 既存データ | 親を持たない従来の項目と、従来の追加・編集・状態変更・並べ替え・削除を扱える |
| 入力保持 | 外部更新や構成変更があっても、既存の未保存入力と競合解決の操作を維持する |

セッションを跨ぐ親子関係や、GitHubのIssueとの同期は今回の変更に含めていません。

## 変更したファイルと役割

| ファイル | 主な変更 |
| --- | --- |
| `src/shared-todo.ts` | 追加。更新入力の定義、親子関係の検査、兄弟順の正規化、原子的な一括更新、進捗集計を共通化 |
| `src/index.ts` | 共有Todoの取得・更新とMCPの入力定義に共通処理を接続。既知の制約エラーの識別方法を修正 |
| `src/user-console.ts` | HTTPの共有Todo操作、親先行の初期描画、親選択、階層・進捗表示、構成操作、幅に応じた表示を追加 |
| `src/user-console-client.ts` | 親子構成の復元、折り畳み、子追加、親変更・解除、兄弟移動、入力とフォーカスの保持、制約エラーの表示を追加 |
| `scripts/verify-shared-todo-ui.ts` | 追加。試験専用サーバーとブラウザーによる画面検証を再実行できるようにした |
| `test/shared-todo-hierarchy.test.ts` | 追加。MCPを通した親子構成、上限、循環、同時更新、一括更新、従来操作の契約テスト |
| `test/issue-56-shared-todo.test.ts` | HTTP更新、拒否時の原子性、競合、サーバー側描画と文字のエスケープを検証 |
| `test/user-console-client.test.ts` | 構成操作、折り畳み、入力保持、競合解決、制約エラーを検証。既存テストの要素取得方法を新しい見出し構造に合わせた |
| `tasks/tasks-status.md`、`tasks/phases-status.md` | 設計と実装の進捗を記録 |
| `doc/design/shared-todo-and-stale-update-gate.md` | 設計コミットで、仕様と操作契約を先行更新 |

全項目を同じ一覧の直下に保持することで、既存の入力欄と競合表示を再利用しています。本文・状態の保存と構成の保存は別の操作にしました。親変更のために、画面に残っていた古い本文や親情報を別の更新へ混ぜないようにしています。

## TDDと関連テスト

追加した19件の内訳は、MCPの契約8件、HTTP・サーバー側描画2件、画面操作9件です。制約エラーのHTTP応答については、既存の追加テストを拡張して失敗を確認した後に対応しています。次の結果は、実際に実行した各段階の結果です。ラベルに `green` と付いた途中の実行でも、失敗した結果は成功として扱っていません。

| 段階・診断ラベル | 結果 | 内容 |
| --- | --- | --- |
| `core-red` | 8件中8件失敗、終了コード1 | MCPの親子構成と保護ルールが未実装であることを確認 |
| `ui-red` | 8件中8件失敗、終了コード1 | 初期の画面操作テストを実装前に確認 |
| `http-red` | 2件中2件失敗、終了コード1 | HTTPとサーバー側描画を実装前に確認 |
| `core-green` | 4件成功・4件失敗、終了コード1 | 実装途中の結果。上限や拒否条件を追加修正 |
| `core-http-green` | 39件すべて成功、終了コード0 | MCP・既存共有Todo・HTTP・初期描画を確認 |
| `ui-green` | 79件成功・1件失敗、終了コード1 | 新しい見出しより前の要素位置を前提とする既存テストを修正 |
| `http-error-red` | 対象1件失敗、終了コード1 | 制約エラーの応答を確認するテストを先行実行 |
| `ui-error-red` | 追加1件失敗、終了コード1 | 制約エラーの表示と入力保持を実装前に確認 |
| `focused-green` | 120件すべて成功、終了コード0 | 関連3ファイルをまとめて実行 |
| `focused-final` | 120件すべて成功、終了コード0 | 監査回帰などの修正後、同じ関連範囲を再実行 |

関連テストの実行コマンドは次のとおりです。

```text
node --import tsx --test test/shared-todo-hierarchy.test.ts test/issue-56-shared-todo.test.ts test/user-console-client.test.ts
```

公開前の `npm run check`、`npm run build`、`npm run lint` は、いずれも終了コード0でした。診断ラベルはそれぞれ `prepublish-check`、`prepublish-build`、`prepublish-lint` です。

## 実ブラウザーで確認した内容

再実行用のコマンドは次のとおりです。

```text
node --import tsx scripts/verify-shared-todo-ui.ts
```

試験専用のデータ領域、認証情報、セッションと一時サーバーを作り、既存の稼働サービスや他のセッションを変更せずに検証しました。終了時には試験用ブラウザー、サーバー、サービスを閉じ、一時データ領域を削除します。

| 確認対象 | 確認内容 |
| --- | --- |
| 画面幅320px・1280px | 深さ8、長い本文、長い親表示でも、文書全体と本文欄が横にはみ出さない |
| 初期描画 | 親から子孫へ並ぶ9項目を復元できる |
| 折り畳み・展開 | 7件の子孫を非表示にしても9行を保持し、共有Todoの項目と版は変わらない。再展開できる |
| 子追加 | 画面から追加した子が同じサービスの共有Todoへ反映され、全体が10件になる |
| 親変更 | 構成変更だけを送信し、共有済みの本文を上書きしない |
| 未保存入力 | 親変更の応答時に、同じ本文欄、未保存の本文、フォーカス、選択範囲を保持する |
| 実行時エラー | 最終のブラウザー試験で、ページの実行エラーとコンソールエラーがない |

初回のブラウザー試験には失敗記録があります。修正後の `browser-final` と、再実行用スクリプトへ整理した後の `browser-reproducible` は終了コード0です。失敗時の記録も `reference/subtasks/browser-label-red.*` に残しています。

画面画像は `reference/subtasks/mobile.png` と `reference/subtasks/desktop.png`、ブラウザー検証の結果は `reference/subtasks/browser-smoke-result.json` に記録しています。

## ローカル全体試験の失敗と調査

### 初回全体試験

`full-suite` として `npm test` を実行し、287件中279件成功、7件失敗、1件スキップ、終了コード1でした。この実行は約361秒かかりました。結果は `reference/subtasks/full-suite.stdout.log`、標準エラーは同名の `.stderr.log`、実行対象ソースは `.source.json` に記録しています。

失敗した7件は、既存の監査テスト1件、検索・プロセスの統合テスト1件、WindowsのJob起動に関するテスト5件でした。

### 今回導入した監査処理の回帰

既知のTodo制約エラーを識別するための `instanceof` が、外部から渡された例外のプロトタイプに触れ、取得時に例外を投げるProxyを扱う既存の監査テストに回帰を生みました。

Todo制約エラーを生成時に `WeakSet` へ登録し、その集合への所属で識別する形へ変更しました。例外のプロトタイプをたどらずに、利用者へ返せる既知の制約エラーだけを判定します。既存の `terminal audit survives a throw from an error-name prototype proxy` は、修正後の `audit-fix-green` で1件成功、終了コード0となりました。既存の監査テストを除外して通したものではありません。

### 変更前の基準版との比較

基準版 `7e16a666cc30af0f7f58816f38d5459c489a4fd0` を別の作業場所に用意し、独立した `npm ci` の後で対象のテストを実行しました。

| 比較対象 | 変更後の再試験 | 基準版の試験 | 判定できる範囲 |
| --- | --- | --- | --- |
| 監査Proxyのテスト | 修正後に成功 | MCP接続が `Connection closed` で終了 | 基準版では本来の検証点へ到達できず、同じ条件での比較はできない。変更後の修正確認は既存テストの成功を根拠とする |
| 検索・プロセスの統合テスト | 再試験で成功 | MCP接続が `Connection closed` で終了 | 基準版との同等比較はできない。候補版の再試験が成功したことのみを確認 |
| WindowsのJob起動5件 | `spawn UNKNOWN` で失敗 | 5件とも `spawn UNKNOWN` で失敗 | 同じPC・Node.jsの基準版でも再現する。原因を特定した、または修正したとは扱わない |

候補版の `candidate-failure-recheck` は、8件中3件成功・5件失敗、終了コード1でした。基準版の指定範囲は7件中0件成功・7件失敗です。このうち2件はMCPの接続終了であり、WindowsのJob起動5件と一括して「既存の同じ失敗」とは扱っていません。

### 公開した実装HEADでの全体試験

実行対象は `2a3b6bec2193820ce9fcb56b2b5191959ca744c6`、ソースの識別値は `03fa36f4a2a4af7b18ee2173b2dddb6a20586ce72685d5403765a30c38e95213` です。実行コマンドは `npm test` です。

`full-final` は287件中282件成功・4件失敗・1件スキップ、終了コード1でした。試験時間は約359秒です。実行時刻は2026年11月2日05:30:37.785〜05:36:37.563（日本標準時）です。この最終全体試験は失敗として記録しています。

| 失敗した試験 | 観測された理由 | 追加確認と限界 |
| --- | --- | --- |
| `NR003 and NR004: searches return every page and portable Node processes retain output/audit` | `Process id is stale or finished.` | 同じHEAD・ソース識別値の限定再試験で成功。全体実行で失敗した原因は未確定 |
| `Issue 10: process_start inherits the service user profile environment` | `TODO_OPERATION_OUTCOME_UNKNOWN`、`applied: unknown`、`Process start failed.` | 同じHEAD・ソース識別値の限定再試験で成功。全体実行で失敗した原因は未確定 |
| `a corrupted cached runner is recompiled and receives a matching digest manifest` | `spawn UNKNOWN` | 基準版で同じエラーを再現したWindows Job起動5件のうちの1件。原因未特定 |
| `an interrupted cache write is recovered on the next initialization` | `spawn UNKNOWN` | 同じ基準版比較の5件のうちの1件。原因未特定 |

全体試験後、コードを変更せず、`final-process-recheck` として次の限定コマンドを実行しました。

```text
node --import tsx --test "--test-name-pattern=NR003 and NR004|Issue 10: process_start" test/search-process-lifecycle.test.ts
```

実行時刻は2026年11月2日05:40:12.750〜05:41:03.351（日本標準時）です。対象のプロセス試験2件と、`local only: kill request returns promptly` の内側の試験1件を合わせて3件成功・0件失敗、終了コード0でした。実行HEADは同じ `2a3b6bec2193820ce9fcb56b2b5191959ca744c6`、ソースの識別値も同じ `03fa36f4a2a4af7b18ee2173b2dddb6a20586ce72685d5403765a30c38e95213` です。この限定結果は全体試験の再実行や、その成功を意味しません。

引き継ぎ形式の `full_local_equivalence_gate.state` には `failed` が定義されていないため、形式上は `unknown` とし、拡張項目に `actual_result: failed`、実行済み、終了コード1、件数を保存しています。未実行や成功を意味する値としては扱いません。

診断ファイルは実行PCの作業ディレクトリ内に保持しています。以下のSHA-256は供給された診断マニフェストの値であり、この報告整形でPC上の原ファイルを再読・再計算したものではありません。

| 診断ファイル | SHA-256 |
| --- | --- |
| `reference/subtasks/full-final.result.json` | `7c0f241567cf5c3354daa19ca370e08f7a9d1144059a7acc3c9e36536f3dfcc1` |
| `reference/subtasks/full-final.source.json` | `0cadf67da6be5a85332b690c42b36e20e470608121831fede9bc75fe955a61e6` |
| `reference/subtasks/full-final.stdout.log` | `946404109e6076878439bfbd0d0db7230c07daa59dfa19062b17fb982d262cf7` |
| `reference/subtasks/full-final.stderr.log` | `f1945cd6c19e56b3c1c78943ef5ec18116907a4ca1efc40a57d48ab1db7adfc5` |
| `reference/subtasks/final-process-recheck.result.json` | `8d519af79685a98b604dd26b72e74f0561351ee75450c643991f00564f4cd814` |
| `reference/subtasks/final-process-recheck.source.json` | `0cadf67da6be5a85332b690c42b36e20e470608121831fede9bc75fe955a61e6` |
| `reference/subtasks/final-process-recheck.stdout.log` | `59eb0c91d074e893131954f2e58deac471380ddb10a0eac02082752fc06797fd` |
| `reference/subtasks/final-process-recheck.stderr.log` | `f1945cd6c19e56b3c1c78943ef5ec18116907a4ca1efc40a57d48ab1db7adfc5` |

## 対象SHAに一致するCI

runの一次メタデータでは、ワークフロー名は `lint`、定義ファイルは `.github/workflows/lint.yml`、イベントは `pull_request`、実行回数は `1` です。取得した値を検証台帳に保存しています。

[CI run 41346807464](https://github.com/ssaattww/RemoteDesktopMCP/actions/runs/41346807464) の `headSha` は `2a3b6bec2193820ce9fcb56b2b5191959ca744c6` です。状態は `completed`、結果は `success` で、10ジョブすべて成功しています。

| ジョブ | 結果 |
| --- | --- |
| Windowsのテスト割り当て作成 | 成功 |
| Ubuntuの文書検査・型検査・ビルド・テスト | 成功 |
| Windowsの分割実行1〜8 | 8ジョブすべて成功 |

CIではNode.js 22、ローカルではNode.js 24.20.0を使用しており、実行環境は同一ではありません。CI成功を、FA780での失敗原因が解消した証拠としては扱いません。診断アーティファクトの詳細は、同じ実装SHAに紐付く実行の情報として検証記録へ記載します。 一覧の10件は、主担当がrun `41346807464` 固有のartifactsエンドポイントから取得した結果です。名前に含まれる `10a7b2e85909a8194e8ad163d6061168740f8fd6` の意味は断定せず、ID・名前・取得URLを原文どおり台帳に保存しています。

このCI結果の対象は実装コミットです。後続の報告用コミットによってPRのHEADが変わった場合は、その新しいHEADのCIを別に確認する必要があり、この実行を新しいHEADの実績として代用しません。

## 証拠とソースの対応

ローカル検証の多くは設計コミットをHEADにした未コミットの実装に対して実行しています。そのため、GitのHEADだけでは実行対象を識別できません。各診断の `.source.json` とソースの識別値を使い、実行した内容を区別しています。

| 診断ラベル（同じHEAD・ソース識別値の組） | Git HEAD | ソースの識別値 |
| --- | --- | --- |
| `design-markdown`、`design-terms` | `7e16a666cc30af0f7f58816f38d5459c489a4fd0` | `1f2b38d45732be0d85a19c32bde2865482084c0af43f06db5e817a8ededa2dfc` |
| `core-red` | `e1ef7c550087c7ba324c334d46f87d8da208b125` | `650177bc15dd9b9e3c2c90c72db4a8d18a38b731ffaac7695db3381c1fc52a65` |
| `ui-red` | `e1ef7c550087c7ba324c334d46f87d8da208b125` | `dfe5254c35ef2e4f5fb68be98f7843a1a1b3331a6c29f4a27bca672d79cf10b9` |
| `http-red` | `e1ef7c550087c7ba324c334d46f87d8da208b125` | `3e0630cd3da14c9d5866f723f71f1b63a5b98009d714d60335da6a3141d515a2` |
| `core-green` | `e1ef7c550087c7ba324c334d46f87d8da208b125` | `90c225d982f9fa18aabf3d22d803664ea00d665814b41ecc1183b3be13d500f2` |
| `core-http-green` | `e1ef7c550087c7ba324c334d46f87d8da208b125` | `4cf0e0ec80afd6e224e4135568da762212075b0404c2387ba4639630cee78e19` |
| `ui-green` | `e1ef7c550087c7ba324c334d46f87d8da208b125` | `49603ea89f7faf9b324ed357efcf89c1b0358f33c6ee332b97fa559a1f2198b1` |
| `http-error-red` | `e1ef7c550087c7ba324c334d46f87d8da208b125` | `716ac5dcaee9ff480d783847e35b88f918cf446d729c26c83896e2aa0f38cd92` |
| `ui-error-red` | `e1ef7c550087c7ba324c334d46f87d8da208b125` | `b34973859913927441aa48669e59718abfc5b3a348dcd306577ce2d0cb0d85c5` |
| `focused-green`、`full-suite`、`browser-label-red` | `e1ef7c550087c7ba324c334d46f87d8da208b125` | `7309507f3819f80bfb09cb9fc856beccf3fecff4b62ea0c31453cf464af5adca` |
| `audit-fix-green`、`browser-final`、`focused-final` | `e1ef7c550087c7ba324c334d46f87d8da208b125` | `65222706e4d9cb3d0409aca129989a4e3d4abbed94a280e45ae9caff6fde4385` |
| `prepublish-check`、`prepublish-build`、`prepublish-lint`、`browser-reproducible`、`candidate-failure-recheck` | `e1ef7c550087c7ba324c334d46f87d8da208b125` | `03fa36f4a2a4af7b18ee2173b2dddb6a20586ce72685d5403765a30c38e95213` |
| `baseline-independent-comparison` | `7e16a666cc30af0f7f58816f38d5459c489a4fd0` | `eb2989cc24b463f5fa4f4c469591c7a6d2a56b65e2c7f2325a7acd4052f97245` |
| `full-final`、`final-process-recheck` | `2a3b6bec2193820ce9fcb56b2b5191959ca744c6` | `03fa36f4a2a4af7b18ee2173b2dddb6a20586ce72685d5403765a30c38e95213` |

ログの保管場所は作業PC上の `reference/subtasks` です。各診断ラベルの標準出力・標準エラー・ソース記録を保持しています。CIの診断アーティファクトと、このPC上のログは別の取得先です。

報告用コミットでは、次の記録を保存する予定です。

- `reports/issue-85-subtasks-implementation-20261102.md`: この実装レポート。
- `reports/issue-85-subtasks-validation-20261102.json`: コマンド、結果、ソース識別値、診断記録、CIの詳細。
- `reports/issue-85-subtasks-handoff-20261102.json`: 次の担当へ引き継ぐ対象と状態。

報告用コミットのSHAは、作成後にPRの報告へ記録します。この本文の中へ、まだ存在しないコミットSHAを記載してはいません。

## 残る確認事項と終了範囲

最終ローカル全体試験は287件中282件成功・4件失敗・1件スキップ、終了コード1のまま記録しています。失敗したプロセス試験2件は、同じHEAD・ソース識別値で内側のkill試験を含む限定再試験3件が成功しましたが、全体実行での失敗原因は未確定です。全体試験で失敗したWindowsのキャッシュ再生成2件は、基準版でも `spawn UNKNOWN` を再現した5件に含まれます。これらの原因を特定・修正したとは扱いません。基準版のMCP接続が終了した別の2件については、基準版との同等比較ができていません。実装HEADに一致するCI10ジョブの成功と、これらのローカル実績を分けて引き継ぎます。

正式レビューは開始していません。今回の作業範囲は、仕様確認、設計、実装、検証、ドラフトPR作成、結果報告までです。マージと稼働環境への配置は行っておらず、レビュー・マージ・配置の前で停止します。

報告生成時点では、報告・追跡の5ファイルを保存する管理用コミット、push、その新しいHEADのCI確認は未完了です。技術的な実装HEADと管理用コミットの親はどちらも `2a3b6bec2193820ce9fcb56b2b5191959ca744c6` として記録し、管理用コミットのSHAとCI結果は実行後のPRコメントで追記します。独立最終レビュー後の証明用コミットではないため、`report_attestation_head` は `null` です。次の担当は最新HEAD・CI・権限・作業場所を再確認する必要があります。
