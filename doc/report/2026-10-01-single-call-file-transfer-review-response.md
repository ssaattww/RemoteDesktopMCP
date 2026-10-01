# 小容量ファイル転送レビュー指摘対応レポート

## 対象

- リポジトリ: `ssaattww/RemoteDesktopMCP`
- Pull Request: #30 `小容量ファイル転送を1回のMCP呼び出しで完了する`
- 対応開始時PR HEAD: `b8a880e8f7ac5bbaed09ae9f7346e85104cebe65`
- レビュー対象実装HEAD: `60070033c3ec614d69cdc41e47b02351cb29ab68`
- 対応日: 2026-10-01

作業開始時に `.github/workflows/lint.yml` を確認し、テスト失敗時にテスト結果、標準出力、標準エラー、診断ログをartifactとして保存する設定が存在することを確認した。このためworkflowへの追加変更は行っていない。

## 指摘対応

### RDMCP-PR30-NR-001

成功したdownloadで `transfer.complete` が記録されない問題を修正した。

先に `test/regressions.test.ts` へ、単発downloadと最終chunk downloadの両方について、`transfer.complete` の `transferId`、`direction`、`sessionId`、`size`、`sha256` を確認する回帰テストを追加した。現行実装で単発downloadの監査欠落により失敗することを確認した後、`src/index.ts` にdownload共通完了処理 `completeDownload` を追加した。

単発downloadと最終chunk downloadは同じ完了処理を通り、完了状態への遷移、一時snapshotの削除、terminal transfer保持、`transfer.complete` 記録を共通して行う。

- Red: `inline download completion must be audited with transfer metadata`
- Green: Issue 29 focused test 1件成功
- commit: `b799e45` `Fix download completion audit`

### RDMCP-PR30-NR-003

`doc/design/multi-pc-architecture.md` の詳細download/upload節を実装へ同期した。

追加した内容は次のとおり。

- `inline=true` かつ1チャンク以内のdownload単発完了条件
- 単発downloadのSHA-256検証、完了状態、一時snapshot削除、完了監査
- 1チャンクを超える場合のchunked fallback
- 最終download chunkの共通完了処理と完了監査
- upload `data` 指定時のbase64、サイズ、SHA-256、1チャンク上限の検証
- 単発uploadの通常確定処理、`complete=true`、完了監査
- `data` 未指定時の従来chunked flow

markdown whitelist違反を1件検出して表現を修正し、`npm run lint` 成功を確認した。

- commit: `1937e9b` `Align transfer design with inline flow`

### RDMCP-PR30-NR-002

1 MiB、5 MiB、25 MiBについて、upload/download別にtool call数、server処理時間、end-to-end時間を実測できる `scripts/benchmark-file-transfer.ts` を追加し、`npm run benchmark:transfer` で再現可能にした。

測定区間はlocalhost MCP Streamable HTTPで、最初の転送tool call開始から最後の転送tool response受信までである。fixture準備、元ファイル作成、転送後のSHA-256検証はend-to-end時間から除外した。server処理時間は転送toolに対応する `operation.succeeded.durationMs` の合計であり、tool call数と成功監査件数が一致することをスクリプトで確認している。

| 方向 | サイズ | tool call数 | server処理時間 | end-to-end時間 |
| --- | ---: | ---: | ---: | ---: |
| download | 1 MiB | 3 | 3,918 ms | 5,125 ms |
| upload | 1 MiB | 4 | 3,448 ms | 4,804 ms |
| download | 5 MiB | 11 | 9,224 ms | 13,268 ms |
| upload | 5 MiB | 12 | 8,893 ms | 13,035 ms |
| download | 25 MiB | 51 | 37,801 ms | 56,390 ms |
| upload | 25 MiB | 52 | 37,629 ms | 56,745 ms |

旧既定128 KiBで同じサイズを順次チャンク転送する場合の仕様上の呼び出し回数は、downloadが9 / 41 / 201回、uploadが10 / 42 / 202回である。512 KiBではdownloadが3 / 11 / 51回、uploadが4 / 12 / 52回となり、呼び出し回数はdownloadで66.7% / 73.2% / 74.6%、uploadで60.0% / 71.4% / 74.3%減少する。

旧128 KiBの時間値は今回再計測していないため、時間短縮率は算出していない。

現在稼働中のRemoteDesktopMCPサービスには本PRの512 KiB既定値と単発転送実装が未反映であり、ChatGPT connector/Tailscaleを含む実運用経路のend-to-end時間は今回の測定対象外である。サービス更新後に同区間を再計測するまで、実運用経路の待ち時間改善は完了扱いにしない。

- commit: `4e1a8ee` `Add transfer performance benchmark`
- commit: `e656bf1` `Record transfer performance measurements`

## ローカル検証

作業中の診断ログは `reference/validation/pr30-fix` に保存した。このディレクトリは検証用であり、コミット対象にはしていない。

| 検証 | 結果 |
| --- | --- |
| NR-001 focused test Red | 想定どおり失敗 |
| NR-001 focused test Green | 1 pass / 0 fail |
| `npm run benchmark:transfer` | 成功、1/5/25 MiBの6ケース測定完了 |
| `npx eslint scripts/benchmark-file-transfer.ts` | 成功 |
| `npm run lint` | 成功 |
| `npm run check` | 成功 |
| `npm run build` | 成功 |
| `git diff --check` | 成功 |
| `npm test` | 96 tests / 95 pass / 0 fail / 1 skip、終了コード0、455,984 ms |

補助的に性能測定スクリプトを単独 `tsc --strict` でも確認した。新規スクリプト内のSDK応答型エラーは修正済みで、再実行時に残ったエラーは既存 `test/fixture.ts` の `response.content` が `unknown` である2件だけだった。この単独確認は既存のプロジェクト型検査設定とは別であり、正式な `npm run check` は成功している。

## 変更単位

1. `b799e45` — download完了監査と回帰テスト
2. `1937e9b` — 詳細設計のinline flow同期
3. `4e1a8ee` — 再現可能な性能測定スクリプト
4. `e656bf1` — 実測値と測定範囲の記録

各単位でPRブランチへpushし、CI待機は行っていない。最終reportを含むHEADをpushした後、そのHEAD SHAとworkflow runのhead SHAが一致するrunだけを最終CI確認対象とする。

## 残事項

- ChatGPT connector/Tailscaleを含む実運用経路は、本PRを稼働サービスへ反映した後に再計測する。
- 上記実運用測定が終わるまでは、Issue #29の実運用待ち時間改善を完了扱いにしない。
- mergeは実施しない。
