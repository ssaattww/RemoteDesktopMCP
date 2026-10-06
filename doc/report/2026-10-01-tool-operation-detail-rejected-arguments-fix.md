# 組み込みツール操作詳細ログ 入力検証拒否境界の指摘対応報告

## 対象

- リポジトリ: `ssaattww/RemoteDesktopMCP`
- PR: #33 `#26 組み込みツール操作の詳細ログを表示する`
- 対象 finding: `RDMCP-PR33-REV-001`
- severity: Medium（レビュー時の severity を維持）
- ブランチ: `feat/tool-operation-detail-logs`
- 対応開始 HEAD: `2db3eb40cd1c5a6f95c95ad116cb593afa095347`
- technical HEAD: `b7bcb1b29db9188f39b660755f835425d454d794`
- 作業ディレクトリ: `C:\Users\donabe\RemoteDesktopWorkspace\RemoteDesktopMCP-issue26`
- RDMCP session: `TV3OaUXAM3huYpAtD99oyM2sNJ7J3E-Is54qJYcD9D8`

## 指摘内容

SDK の入力スキーマ検証で拒否された操作は通常のツール handler に到達しないため、PR #33 では上位 request handler で拒否操作を監査していた。

再レビューでは、この経路が `params.arguments` の未検証値をそのまま扱うため、通常スキーマの制限前に監査処理できることが確認された。

具体例として、5001文字の `comment` を持つ `file_read` が入力検証で拒否された場合でも、拒否イベントへ5001文字のまま保存されていた。また `file_patch` の変更前後本文や `file_transfer_upload_chunk` の data も、別フィールドの検証失敗時には未検証の可変長値が詳細生成へ渡り得た。

## 診断 artifact workflow

`.github/workflows/lint.yml` を再確認した。

既存 workflow は Ubuntu / Windows の検証について、成功・失敗を問わず次を診断 artifact へ保存する。

- lint / check / build / test の結果
- 各工程の標準出力
- 各工程の標準エラー
- 実行環境ログ

このため workflow の追加変更は不要だった。

## TDD

### Red

先に次の回帰テストを追加した。

`schema validation rejection bounds oversized comments before audit persistence`

5001文字の `comment` と負数 `offset` を持つ `file_read` を `callRaw` から送り、SDK入力検証で拒否された後の監査イベントで `comment` が通常スキーマと同じ500文字以下に制限されることを要求した。

結果:

- tests: 1
- pass: 0
- fail: 1
- 実測: `5001 !== 500`
- 診断: `%TEMP%\RemoteDesktopMCP-pr33-rev001-red`

Red commit:

- `2bd5e71eac74b9a8a5cf455a17c764e0bd7ad830`
- `test: bound rejected audit arguments`

Red commit の CI run `36818236014` は、次の実装 push により cancelled となったため成功・失敗の証拠としては使用しない。

### Green

入力検証拒否経路専用に `rejectedArgumentProjection` を追加した。

この投影は生引数をそのまま保存せず、ツールごとに監査・詳細生成に必要な既知フィールドだけを選び、可変長文字列を処理前に有界化する。

主な境界:

- `comment`: 500文字
- `session_id` / `node_id` / `transfer_id` / `process_id`: 128文字
- `root_id`: 500文字
- `relative_path`: 500文字
- 検索 query: 120文字
- `file_patch` の `old_string` / `new_string`: 各4000文字
- upload chunk の data: 4096文字
- `process_start` command: 4000文字
- `session_open` working directory: 4096文字
- `session_open` purpose: 200文字
- SHA-256文字列: 64文字

数値・真偽値は対象ツールで必要な既知フィールドだけを保持する。未知ツール・未知フィールドは自動保存しない。

上位 request handler は、SDK入力検証エラーを認識した後に `rawRecord` をこの投影へ通し、その投影済み `record` だけを次へ渡す。

- `comment`
- connection ID
- 対象概要
- `operationDetail`
- `operation.received`
- `operation.rejected`

通常の検証済み handler 経路は変更していない。

兄弟ケースとして次も追加した。

`schema validation rejection bounds variable-length bodies before detail processing`

別フィールドを意図的に無効化しつつ、10,000文字の patch 本文と upload data を渡し、`operationDetail` が受け取る時点でそれぞれ4000文字、4096文字へ有界化されていることを実経路で確認する。

Green focused result:

- `schema validation rejections persist safe operation detail`: pass
- `schema validation rejection bounds oversized comments before audit persistence`: pass
- `schema validation rejection bounds variable-length bodies before detail processing`: pass
- 3 pass / 0 fail
- 診断: `%TEMP%\RemoteDesktopMCP-pr33-rev001-green`

Green implementation commit:

- `b7bcb1b29db9188f39b660755f835425d454d794`
- `fix: bound rejected audit arguments`

## ローカル検証

### commit前ゲート

Green実装候補で次を実行し、すべて成功した。

- `npm run lint`
- `npm run check`
- `npm run build`
- `git diff --check`
- REV-001 focused tests 3件

診断:

- `%TEMP%\RemoteDesktopMCP-pr33-rev001-precommit`

### repository-defined full local gate

technical HEAD `b7bcb1b29db9188f39b660755f835425d454d794` で次を実行した。

- `npm run lint`: pass
- `npm run check`: pass
- `npm run build`: pass
- `npm test`: exit 1
- `git diff --check`: pass

`npm test` の結果:

- tests: 105
- pass: 103
- fail: 1
- skip: 1

失敗は今回追加した REV-001 テストではない。

既存 `Issue 13: published tool descriptions match session, file-root, transfer, and process boundaries` の終了後に非同期処理が fixture cleanup 済みの `data` ディレクトリへ `lstat` し、`ENOENT` の unhandledRejection を生成したため `test/regressions.test.ts` が失敗扱いになった。

今回追加した3件は full suite 内でも pass している。

診断:

- `%TEMP%\RemoteDesktopMCP-pr33-rev001-full-local`

同じ Issue 13 テストだけを technical HEAD で単独実行すると 1 pass / 0 fail だった。

診断:

- `%TEMP%\RemoteDesktopMCP-pr33-rev001-issue13-isolated`

この既存の非同期後処理競合は REV-001 の入力検証拒否経路とは別であり、本指摘対応では変更していない。

## 変更ファイル

### 製品コード

`src/index.ts`

- 入力検証拒否専用のツール別安全投影を追加
- 生引数を `rawRecord` として分離
- 監査・詳細生成には投影済み `record` だけを使用

### テスト

`test/regressions.test.ts`

- 過長 `comment` の Red / Green 回帰テストを追加
- `file_patch` と upload chunk の可変長本文が詳細生成前に有界化される兄弟ケースを追加

## 意図的に変更していない範囲

- 通常のスキーマ検証済み tool handler
- operation detail の既存成功経路
- upload commit の検証済み内容見本
- transfer cancel 位置表示
- 設計文書の前回レビュー修正
- Issue 13 の既存非同期 fixture cleanup 競合
- 他の作業ツリー・他のRDMCPセッション
- workflow

## CI

technical HEAD `b7bcb1b29db9188f39b660755f835425d454d794` の CI は途中状態であり、最終証拠には使用しない。

本報告と handoff を publication commit として push した後、PR current HEAD と `head_sha` が完全一致する `pull_request` workflow run だけを最終CI証拠として確認する。別SHAのrunは代用しない。

## 残件と次工程

- `RDMCP-PR33-REV-001` の修正は実装・focused検証済み。
- final publication HEAD の exact-head CI を確認する。
- PR #33 へ簡易報告を投稿する。
- 同じ normal reviewer に `RDMCP-PR33-REV-001` の bounded fix verification を戻す。
- マージは行わない。
