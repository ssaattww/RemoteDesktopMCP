# 複数 PC 実行ノード追加・登録 設計レビュー報告

## 対象

- Repository: `ssaattww/RemoteDesktopMCP`
- PR: `#28`
- 関連 Issue: `#25`
- 対象ブランチ: `issue-25-design`
- Reviewed HEAD: `9908eb6e5ff198bfb8cea85f5a4386856767bd52`
- レビュー日時: 2026-10-01 13:42 JST
- レビュー種別: 通常の設計レビュー
- 判定: **fail**

PR の current HEAD を固定して、要件、設計、作業手順、直接依存文書、対応する実装・試験、CI 証拠を確認した。
レビュー中に対象 HEAD は変化していない。

## 対象範囲

主対象:

- `doc/design/functional-requirements.md`
- `doc/design/multi-pc-architecture.md`
- `doc/workflow/multi-pc-executor-registration-workflow.md`

直接依存として確認:

- `doc/design/file-paths-and-live-logs.md`
- `doc/design/tailscale-funnel-architecture.md`
- `doc/design/user-console-emergency-stop.md`
- `.github/workflows/lint.yml`
- `src/index.ts`
- `src/node-cluster.ts`
- `src/node-config.ts`
- `src/node-config-cli.ts`
- `src/node-registry.ts`
- `src/node-transport.ts`
- `test/multi-pc*.test.ts`

実装は設計契約の裏付けとして参照しただけで、レビュー側から製品コード・設計修正は行っていない。

## 指摘

### RDMCP-25-DR-001 — High — 遠隔ダウンロードは応答喪失後に同じ転送を再開できない

- Origin: introduced_by_change
- Location:
  - `doc/design/multi-pc-architecture.md:614`
  - `doc/design/multi-pc-architecture.md:644-646`
  - `doc/design/multi-pc-architecture.md:674-680`
  - `doc/design/multi-pc-architecture.md:974`
- Classification: correctness / reconnect / transfer state machine

設計は、同じ `executor_generation` のまま TCP 接続だけ再接続した場合、
`file_transfer_status` で次の位置を確認して既存転送を継続できるとしている。

一方、ダウンロードのチャンク処理は「次に送る位置と一致する要求だけ」を受け付け、
チャンクを処理すると転送位置を前進させる契約である。
最後のチャンクまで処理すると完了扱いとなり、読み取り用複製も削除する。
ノード間通信は、要求送信後に接続が失われて応答を確認できなければ
`NODE_OUTCOME_UNKNOWN` とし、旧接続の応答を採用せず自動再送もしない。

この組合せでは、実行ノードがチャンクを読み出して転送位置を前進させた直後、
`response` が統括ノードへ届く前に TCP 接続だけ失われると復旧できない。

1. 実行ノード側では次位置まで進んでいる。
2. 統括ノード側は当該チャンクのバイト列を受信していない。
3. 再接続後の `file_transfer_status` は失ったチャンクより後の位置を返す。
4. 失った位置を再要求すると「次に送る位置」と一致しないため拒否される。
5. 最終チャンクの応答を失った場合は、読み取り用複製まで削除済みになり得る。

したがって、設計に記載された「位置を再確認して継続できる」は、
ダウンロードの応答喪失ケースでは成立しない。
開始時 SHA-256 と受信済みバイト列を照合すれば不完全な結果の検出はできるが、
失ったチャンクを同じ転送から回収する手段は定義されていない。

Required action:

- ダウンロードチャンクの応答喪失を再実行可能にする状態遷移を設計する。
- 例えば、最終確認済みチャンクを再送できるよう保持する、明示 ACK 後に送信位置を確定する、
  または固定複製からオフセット指定で冪等に再読込できる方式のいずれかを定義する。
- 最終チャンクの応答喪失でも複製を早期削除せず復旧できる完了条件を定義する。
- 中間チャンクと最終チャンクについて、
  「実行ノード側で状態更新済み・応答だけ喪失・TCP 再接続」の故障注入試験を作業手順へ追加する。
- 復旧後の受信全バイト列と開始時 SHA-256 が一致することまで確認する。

### RDMCP-25-DR-002 — Medium — `node_list` の `session_id` 要否が直接依存文書と矛盾する

- Origin: introduced_by_change
- Location:
  - `doc/design/functional-requirements.md:31`
  - `doc/design/functional-requirements.md:254`
  - `doc/design/multi-pc-architecture.md:804`
  - `doc/design/multi-pc-architecture.md:1072`
  - `doc/design/file-paths-and-live-logs.md:15-17`
- Classification: documentation contract / API compatibility

複数 PC 設計では、操作対象 `node_id` を選択するため
`node_list` を `session_open` より前に呼び出せることを明示している。
`session_id` は必須ではなく、互換目的で任意指定された場合も有効性と所有者だけを確認し、
一覧をセッションのノードへ絞り込まない契約である。

現実装もこの新契約に一致している。
`src/index.ts` の `node_list` は `session_id` を optional とし、
`test/multi-pc-mcp.test.ts` にはセッション作成前に引数なしで呼ぶ試験がある。

しかし、直接依存文書 `doc/design/file-paths-and-live-logs.md` は
`node_list` の `roots` / `path_base` 契約を説明した直後に
「認証と本人の有効なセッションという既存の条件を維持する」と記載している。
この文書だけを実装根拠にすると、有効なセッションを `node_list` の前提へ戻してしまい、
複数 PC でセッション作成前にノードを発見するフローと両立しない。

Required action:

- `doc/design/file-paths-and-live-logs.md` を新契約へ合わせる。
- `node_list` は認証を必須とするが、有効な `session_id` は必須にしないことを明記する。
- 任意の `session_id` を受け付ける場合は、有効性・所有者だけを検証し、
  ノード一覧を絞り込まないことを同文書にも記載する。

## 検証結果

### 設計文書

- `npm.cmd run lint:md`: pass
  - markdownlint: 62 files, 0 issues
- `npm.cmd run lint:md:terms:design`: pass
- 設計文書だけの `git diff --check origin/main...HEAD`: pass
- 設計文書の Issue 番号を名称・見出し・識別子へ使う表記: 該当なし

### 直接対応する実装・試験

- `npm.cmd run check`: pass
- `node --import tsx --test test/multi-pc.test.ts test/multi-pc-registry.test.ts test/multi-pc-transport.test.ts test/multi-pc-mcp.test.ts`: pass
  - 23 tests
  - 23 passed
  - 0 failed

既存試験には RDMCP-25-DR-001 の
「実行ノードがダウンロード位置を前進させた後に応答だけを失う」故障注入がないため、
上記成功は DR-001 の解消証拠にはならない。

### 失敗診断 artifact

`.github/workflows/lint.yml` には Ubuntu / Windows の両方で、
テスト結果、標準出力、標準エラー、環境情報を `actions/upload-artifact@v4` で
`if: always()` により保存する処理が既に存在する。
今回のレビューで追加変更は不要。

### CI

PR #28 の reviewed HEAD
`9908eb6e5ff198bfb8cea85f5a4386856767bd52`
と `headSha` が一致する workflow run は確認できなかった。

確認できた直近の成功 run `36806648645` は
`e0c85779fe44a40f46a7972604cc4d229217be1f` に対する run であり、
reviewed HEAD と一致しないため CI 証拠として代用していない。
この reviewed HEAD は **CI 未実施** と扱う。

## 設計判定外として記録した current PR の状態

次は current PR で確認したが、今回の設計判定には含めない。

- PR 全体の `git diff --check origin/main...HEAD` は exit code 2。
  - `src/node-transport.ts:831`: new blank line at EOF
  - `test/multi-pc-mcp.test.ts:320`: new blank line at EOF
  - `test/multi-pc.test.ts:287`: new blank line at EOF
- PR 本文は「コード実装はこのPRの対象外」と記載しているが、
  current HEAD にはノード設定、CLI、登録状態、ノード間通信、セッション固定、
  遠隔ファイル操作の実装・試験コミットが含まれている。
  最終レビュー前に PR の現在スコープと本文を一致させる必要がある。

## 結論

設計レビュー判定は **fail**。

修正必須は次の2件。

1. `RDMCP-25-DR-001` — High
2. `RDMCP-25-DR-002` — Medium

設計修正後は同じ finding ID を維持して再レビューする。
レビュー側では製品・設計修正や merge は行わない。
