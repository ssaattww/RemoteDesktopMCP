# 組み込みツール操作詳細ログ レビュー報告

## レビュー対象

- リポジトリ: `ssaattww/RemoteDesktopMCP`
- Issue: #26 `組み込みツール操作の内容を折りたたみ詳細表示できるようにする`
- PR: #33 `#26 組み込みツール操作の詳細ログを表示する`
- ブランチ: `feat/tool-operation-detail-logs`
- レビュー対象 HEAD: `8c925d6e7011721489f64b5f7d671a6fcc9ce39e`
- 基準: `origin/main`
- レビュー方式: 通常レビュー。製品コードは変更せず、設計、差分、依存実装、テスト、CI、文書 lint 運用を確認した。

レビュー中に HEAD を再確認し、対象 HEAD が変わっていないことと作業ツリーが clean であることを確認した。

## 判定

判定結果: fail

必須修正 3 件、軽微な修正 1 件を検出した。

- Medium: 3 件
- Low: 1 件

## 指摘事項

### RDMCP-PR33-REV-001: 入力スキーマ検証で拒否された操作が監査詳細に残らない

- severity: Medium
- origin: review
- location:
  - `src/index.ts:875-1015`
  - `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:125`
  - `doc/design/tool-operation-detail-logging.md:52`
- description:
  - 操作詳細は `this.tool(...)` の登録ハンドラー内部で `operation.received`、`operation.started`、終端イベントを記録する。
  - MCP SDK は登録ハンドラーを呼ぶ前に `validateToolInput(...)` を実行する。
  - そのため、たとえば `file_read` の負数 `offset`、0 または上限超過の `length` など、入力スキーマで拒否される要求は RDMCP の操作監査ラッパーへ到達しない。
  - 設計は「失敗時も、検証前に安全に保存できる要求範囲とエラーを残す」と定めているが、この経路では要求範囲もエラーも操作詳細として残らない。
- impact:
  - 入力不正時だけ使用者画面の監視履歴から操作が欠落し、Issue #26 の「失敗時も対象、実行内容、エラー内容を追跡できる」要件を満たさない。
- evidence:
  - SDK の通常実行経路は `validateToolInput` の成功後に `executeToolHandler` を呼ぶ。
  - 追加テストの失敗経路は `root_id=missing` であり、入力スキーマ自体は通過するため、この経路を検証していない。
- required_action:
  - 入力スキーマ検証エラーも安全な範囲で操作監査へ記録できる境界を設ける。
  - `file_read` などでスキーマ違反を発生させ、要求値と公開可能な検証エラーが終端詳細に残る回帰テストを追加する。

### RDMCP-PR33-REV-002: upload commit の内容見本が検証済み転送内容に固定されていない

- severity: Medium
- origin: review
- location:
  - `src/index.ts:953-957`
  - `src/index.ts:1055`
  - `doc/design/tool-operation-detail-logging.md:71`
- description:
  - `file_transfer_upload_commit` は一時ファイルを読み、サイズと SHA-256 を検証してから宛先へ確定する。
  - しかし操作詳細生成はハンドラー完了後に行われ、`previewFile(transfer.target, transfer.size)` で宛先パスを改めて開いて内容見本を作る。
  - 詳細生成時点では transfer lock の処理を抜けており、確定後から再読込までの間に別操作や外部プロセスが宛先を変更、置換、削除できる。
- impact:
  - 監査ログの「内容見本」が実際に検証・確定した upload 内容と異なる、または欠落する可能性がある。
  - Issue #26 の目的である「何を転送したか」の追跡証拠として内容見本を信用できない。
- evidence:
  - commit 本体では `readFile(item.temp)` の結果 `bytes` をハッシュ検証しているが、そのバイト列は詳細生成へ引き渡していない。
  - 詳細生成は成功結果の `resolved_path` を条件に、可変な `transfer.target` を再読込している。
- required_action:
  - 内容見本を commit 時に検証済みのバイト列から生成するか、同一ファイル実体・同一ハッシュに固定された状態から生成する。
  - 確定直後に宛先が置換・変更されても、操作詳細が確定した upload 内容から逸脱しない回帰テストを追加する。

### RDMCP-PR33-REV-003: 設計書がインラインコード囲みで許可語 lint を回避している

- severity: Medium
- origin: review
- location:
  - `scripts/check-markdown-whitelist.mjs:98-101`
  - `doc/design/tool-operation-detail-logging.md:13,56,68-69,75,90-91,104,109`
- description:
  - 許可語方式チェッカーは `stripMarkdownNoise` でインラインコード全体を空白化してから英単語・カタカナを検査する。
  - 新しい設計書では識別子や構文だけでなく、`HTML`、`diff`、`hex`、`Base64`、`UTF-8`、`TypeScript`、`lint` といった一般的な技術用語もインラインコードで囲っている。
  - これらの語は `tools/lint/markdown-whitelist.yaml` に登録されていないが、バッククォートで囲われているため検査されない。
- impact:
  - `npm run lint` は成功するが、許可語方式 lint が設計文書の用語統制として機能しない。
  - 今後も未知語をコード表記にするだけで検査を通過でき、設計文書 lint の目的を損なう。
- evidence:
  - `lint:md:terms:design` の対象には `doc/design/tool-operation-detail-logging.md` が含まれる。
  - 一方、チェッカーはバッククォートで囲まれたインラインコードを正規表現で検査前に除外する。
  - 上記の一般技術語は whitelist に未登録である。
- required_action:
  - バッククォートは関数名、フィールド名、コード断片など本当にコードとして扱う対象だけに使用する。
  - 文中の一般技術語は通常表記へ戻し、必要な技術用語を説明付きで whitelist に登録する。
  - 修正後に設計文書用語 lint を実行する。

### RDMCP-PR33-REV-004: file_transfer_cancel の詳細に現在位置が含まれない

- severity: Low
- origin: review
- location:
  - `src/index.ts:961-965`
  - `src/index.ts:1063-1069`
  - `doc/design/tool-operation-detail-logging.md:72`
- description:
  - 設計は `file_transfer_status` と `file_transfer_cancel` について、転送 ID、方向、状態、位置、サイズなどを保存すると定めている。
  - 詳細生成は位置を `output.next_offset` がある場合だけ追加する。
  - `file_transfer_cancel` の戻り値は `{ cancelled: true }` で `next_offset` を含まないため、保持されている `transfer.offset` が詳細に表示されない。
- impact:
  - 取消し時に何バイトまで処理済みだったかを使用者画面から確認できず、設計した監視粒度を満たさない。
- required_action:
  - cancel 詳細では保持済み `transfer.offset` を位置として表示し、途中まで転送してから取消す回帰テストを追加する。

## 設計・実装で確認できた事項

- `file_patch` は変更前後を差分形式で操作詳細へ保存する。
- `file_read` は対象、要求範囲、返却本文を保存する。
- 検索は条件と検索結果を保存する。
- 転送チャンクは Base64 文字列をそのまま表示せず、文字内容または限定した16進内容見本へ変換する。
- 既知の資格情報は伏せ字処理され、可変長本文は4000文字に制限される。
- UTF-8 の文字境界で内容見本が切れる場合の回帰テストが追加されている。
- failed upload commit が既存宛先の内容を漏らさない修正と回帰テストを確認した。
- 使用者画面は詳細を既定で閉じ、差分更新後も開閉状態を維持する。
- サーバー描画は escape、クライアント描画は `textContent` を使用し、詳細本文を HTML として解釈しない。
- 操作詳細は既存の本人別監査イベント境界に含まれ、別 principal のイベントを直接公開する新経路は追加されていない。

## TDD・変更履歴

PR のコミット列から、主要機能、UTF-8 境界、failed upload commit の各修正でテスト追加が実装より先にコミットされていることを確認した。

代表例:

- `ceea8ac`: 組み込みツール操作詳細の契約テスト
- `6d57e07`: 安全性と開閉維持のテスト
- `0f90e14`: 操作詳細ログ実装
- `c1f47e9`: UTF-8 境界テスト
- `960af92`: UTF-8 境界修正
- `03783e1`: failed upload commit 回帰テスト
- `b93dbe4`: failed upload commit 修正

## 検証

### ローカル

レビュー対象 HEAD `8c925d6e7011721489f64b5f7d671a6fcc9ce39e` で実行した。

- `npm run lint`: pass
- `npm run check`: pass
- `npm run build`: pass
- `git diff --check`: pass
- 操作詳細の focused regression tests: pass
- 使用者画面の focused tests: pass
- `npm test`: fail

全体テストの今回のローカル実行は、4件のテスト成功後に Windows のファイル使用競合を示すエラーで終了コード1となった。stderr は空で、テストランナーの完走結果は得られていない。したがってローカル全体テスト成功とは扱わない。

既存の実装報告には、同じブランチで全体テストが2回 `98 pass / 1 fail / 1 skip` となり、既存 Issue 13 の fixture cleanup 後の非同期 `lstat` が原因と記録されている。今回のレビューではこの既存問題を修正していない。

### CI

CI は PR current HEAD と run の `headSha` が一致する run だけを確認した。

- reviewed HEAD: `8c925d6e7011721489f64b5f7d671a6fcc9ce39e`
- run: `36798964947`
- event: `pull_request`
- headSha: `8c925d6e7011721489f64b5f7d671a6fcc9ce39e`
- conclusion: success

job:

- Ubuntu: success
- Windows shard 1/3: success
- Windows shard 2/3: success
- Windows shard 3/3: success

4 job すべてで診断 artifact upload が成功し、artifact が現存することも確認した。

## 診断 artifact workflow

`.github/workflows/lint.yml` は lint、check、build、test について結果、標準出力、標準エラー、実行環境情報を保存し、成功・失敗を問わず artifact を upload する構成になっている。レビュー開始時点で必要な診断 workflow が存在したため、workflow 変更は不要だった。

## レビューで変更しなかったもの

レビュー担当として製品コード、設計、テストは修正していない。マージも行っていない。

## 次の作業

1. `RDMCP-PR33-REV-001` から `003` を必須修正する。
2. `RDMCP-PR33-REV-004` を設計どおり補完する。
3. 修正は TDD で行い、新しい technical HEAD を push する。
4. 修正後の current HEAD と完全一致する CI run だけを確認する。
5. 同じ指摘 ID と severity を維持したまま再レビューする。
