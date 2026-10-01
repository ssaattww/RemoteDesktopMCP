# 組み込みツール操作詳細ログ 修正確認レビュー

## 対象

- リポジトリ: `ssaattww/RemoteDesktopMCP`
- Issue: #26 `組み込みツール操作の内容を折りたたみ詳細表示できるようにする`
- PR: #33 `#26 組み込みツール操作の詳細ログを表示する`
- モード: fix verification
- 前回レビュー対象 HEAD: `8c925d6e7011721489f64b5f7d671a6fcc9ce39e`
- 前回レビュー報告コミット: `8cb855406ff32741be0f4e7aa8bfde007cb331ad`
- 今回レビュー対象実装 HEAD: `bc6305d8ace9dc0ab30c2b9240a2f9e9209659d0`
- 基準: `origin/main`
- reviewer continuity: 前回通常レビューと同じチャットで継続確認した。

レビュー開始時と報告作成直前に local / remote / PR current HEAD がすべて今回レビュー対象実装 HEAD と一致し、作業ツリーが clean であることを確認した。

## 判定

判定結果: fail

前回4指摘のうち3件は解消確認した。`RDMCP-PR33-REV-001` は入力検証前の生引数を安全に扱う境界が不足しているため、同じ Medium のまま継続する。新しい独立した finding ID は追加しない。

## 前回指摘の確認結果

### RDMCP-PR33-REV-001: 入力スキーマ検証で拒否された操作が監査詳細に残らない

- severity: Medium
- disposition: open
- source severity: Medium
- reclassification: なし

修正により、MCP SDK の入力検証エラー応答を上位 request handler で検出し、`operation.received` と `operation.rejected` を記録する経路が追加された。負数 `offset` の `file_read` を使う新規回帰テストも追加され、対象、読取範囲、入力検証エラーが詳細へ残ることを確認している。

ただし、前回 required action の「入力スキーマ検証エラーも**安全な範囲で**操作監査へ記録する」は未完了である。

現在の拒否経路では、SDK に拒否された未検証 `params.arguments` をそのまま `record` とし、`comment` を `trim()` するだけで `operation.received` / `operation.rejected` の監査フィールドへ保存する。通常のツールスキーマでは comment は最大500文字だが、入力検証に失敗した経路ではこの上限が適用される前の値を保存する。

実行確認では、5001文字の comment と負数 `offset` を持つ `file_read` を既存 fixture から呼び出したところ、拒否イベントの `reason` は `input_validation` になった一方、監査イベントの `comment` は5001文字のまま保存された。

また、`operationDetail` は未検証の `file_patch` の `old_string` / `new_string` を `String(...)` 化して全量 `split` / `map` / `join` し、転送チャンクでは未検証の文字列に正規表現判定や Base64 変換を行う。詳細値自体は最終的に4000文字へ制限されるが、制限前の処理量は入力スキーマの上限に束縛されない。

影響:

- 入力検証で拒否された値だけ、通常スキーマのサイズ制約を迂回して監査ログへ保存できる。
- 大きな未検証本文を、拒否後の監査生成で再処理するため、設計の「検証前に安全に保存できる要求範囲」という条件を満たさない。

required action:

- 入力検証エラーの監査生成では、生引数を直接 `operationDetail` へ渡さず、ツールごとに保存可能な項目を先に長さ制限した安全な投影へ変換する。
- `comment` は少なくとも通常スキーマの最大500文字を超えて監査へ保存しない。
- `file_patch` の変更前後文字列や upload chunk の data など、入力検証前の可変長本文は全量 split / decode せず、先頭の限定範囲だけを処理する。
- 500文字超の comment と、各可変長本文の上限超過入力を使う回帰テストを追加し、監査側の保存長と処理対象が有界であることを確認する。

### RDMCP-PR33-REV-002: upload commit の内容見本が検証済み転送内容に固定されていない

- severity: Medium
- disposition: resolved
- source severity: Medium
- reclassification: なし

`file_transfer_upload_commit` は、ハッシュ検証済みの一時ファイル内容から `committedPreview` を作成し、その後の操作詳細では可変な宛先パスを再読込せず、この保存済み内容見本だけを使用するよう変更された。

新規回帰テストは `transfer.complete` の監査直後に宛先内容を別文字列へ変更し、その後の `operation.succeeded` 詳細が検証済み upload 内容を保持し、変更後の宛先内容を含まないことを確認している。

required action は満たされた。

### RDMCP-PR33-REV-003: 設計書がインラインコード囲みで許可語 lint を回避している

- severity: Medium
- disposition: resolved
- source severity: Medium
- reclassification: なし

設計書の HTML、diff、hex、Base64、UTF-8、TypeScript、lint など、識別子ではない一般技術語から不要なバッククォートが除去された。HTML、diff、hex、TypeScript、lint は説明付きで許可語へ追加されている。

残っているインラインコードは、ツール名、フィールド名、HTML要素名、構造化データの値など、コードまたは識別子として扱う対象であることを確認した。

`npm run lint:md:terms:design` は current HEAD で成功した。`npm run lint` 全体も成功した。

required action は満たされた。

### RDMCP-PR33-REV-004: file_transfer_cancel の詳細に現在位置が含まれない

- severity: Low
- disposition: resolved
- source severity: Low
- reclassification: なし

`file_transfer_status` / `file_transfer_cancel` の詳細生成で、応答に `next_offset` がない場合は保持済み `transfer.offset` を位置として表示するよう変更された。

新規回帰テストは6バイトの upload の先頭3バイトを送信してから cancel し、操作詳細の位置が `3` になることを確認している。

required action は満たされた。

## 変更範囲

前回レビュー報告コミット以降の変更は次の4ファイルに限定されている。

- `src/index.ts`
- `test/regressions.test.ts`
- `doc/design/tool-operation-detail-logging.md`
- `tools/lint/markdown-whitelist.yaml`

コミット順:

- `91d3aa1`: レビュー指摘の回帰テスト追加
- `3708cd7`: 操作詳細レビュー指摘の実装修正
- `bc6305d`: 設計書の用語 lint 回避修正

TDDのRed証拠として、テスト追加 commit `91d3aa199cb35087fb6e65ee001df22c08242ed6` に完全一致する pull_request CI run `36809410482` は failure だった。実装修正 commit `3708cd73a1c9daa83e9399fcab1fdb199d123ea0` の run は後続pushにより cancelled されているため Green 証拠として代用していない。最終実装 HEAD の exact-head CI を Green 証拠として使用した。

## 必須観点の確認

- 要件・設計適合: REV-001 の安全な事前投影だけ未達。REV-002/003/004 は適合確認。
- 正しさ・境界条件: upload commit の競合fixture、部分転送 cancel、SDK 入力検証失敗を確認。未検証可変長入力の有界化が残る。
- スコープ: 4ファイルのレビュー指摘対応に限定され、無関係な製品変更は確認していない。
- 直接依存: MCP SDK の `validateToolInput` が tool handler より先に実行され、エラー応答へ変換する実装を確認した。
- API / データ / 互換性: 既存ツール応答契約は変更せず、監査イベントの詳細生成のみ拡張している。
- エラー処理: SDK入力検証エラーの記録自体は追加されたが、生引数の安全な投影が不足する。
- セキュリティ・秘密情報: 詳細本文の既存伏せ字処理は維持。今回残存指摘はサイズ境界であり、5001文字 comment の未制限保存を実行確認した。
- テスト: 新規3ケースは current HEAD で pass。`test/regressions.test.ts` 全体25/25 pass。
- CI: current HEAD と完全一致する run のみ確認し、全job success。
- 文書 lint: 設計文書の囲み回避は解消し、許可語 lint 成功。
- 保守性: 入力検証失敗だけ別 request-handler 経路になるため、生引数の安全化を一箇所へまとめる必要がある。

## ローカル検証

レビュー対象実装 HEAD `bc6305d8ace9dc0ab30c2b9240a2f9e9209659d0` で実行した。

- `npm run lint`: pass
- `npm run check`: pass
- `npm run build`: pass
- `git diff --check`: pass
- REV-001/002/004 focused tests: pass
- `node --import tsx --test test/regressions.test.ts`: 25 pass / 0 fail / 0 skip
- 5001文字 comment の入力検証拒否 probe: rejected event の `commentLength=5001`, `reason=input_validation`

stdout、stderr、終了コードは `C:\Users\donabe\RemoteDesktopWorkspace\review-artifacts-pr33-rereview-bc6305d` に保存した。これは接続PC上の診断パスであり、リポジトリアーティファクトではない。

## CI

PR current HEAD と run の `headSha` が完全一致する run だけを検証対象にした。

- reviewed implementation HEAD: `bc6305d8ace9dc0ab30c2b9240a2f9e9209659d0`
- run: `36810837765`
- event: `pull_request`
- headSha: `bc6305d8ace9dc0ab30c2b9240a2f9e9209659d0`
- conclusion: success

job:

- Ubuntu: success
- Windows shard 1/3: success
- Windows shard 2/3: success
- Windows shard 3/3: success

全4 job で Test と診断 artifact upload が成功した。run に対応する4件の診断 artifact が未失効で存在することも確認した。

## 診断 artifact workflow

`.github/workflows/lint.yml` は npm ci、lint、check、build、test の結果、標準出力、標準エラーと環境情報を保存し、診断 artifact を upload する構成である。再レビュー開始時点で存在を確認したため workflow 変更は不要だった。

## held / unexplored

- held: なし
- unexplored: なし

## 次の作業

1. `RDMCP-PR33-REV-001` の ID と Medium severity を維持して修正する。
2. 入力検証エラー経路で使用する生引数を、ツール別の有界な安全投影へ変換してから監査詳細を生成する。
3. oversized comment / file_patch 本文 / transfer data の回帰テストを先に追加して失敗を確認し、その後実装する。
4. 新しい technical HEAD を push する。
5. 同じ通常 reviewer で REV-001 とその直接影響だけを再確認する。
6. CI は新しい PR current HEAD と `headSha` が完全一致する run だけを採用する。

マージは行わない。
