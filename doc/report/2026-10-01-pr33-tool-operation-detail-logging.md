# PR #33 組み込みツール操作詳細ログ 実装報告

## 対象

- リポジトリ: `ssaattww/RemoteDesktopMCP`
- Issue: #26 `組み込みツール操作の内容を折りたたみ詳細表示できるようにする`
- PR: #33 `#26 組み込みツール操作の詳細ログを表示する`
- ブランチ: `feat/tool-operation-detail-logs`
- 作業開始 HEAD: `960af92ce65553c190a465646edb445d86b2e78c`
- technical HEAD: `b93dbe4576986e12a87bb7594e4b4f4f9eb432ca`
- 作業ディレクトリ: `C:\Users\donabe\RemoteDesktopWorkspace\RemoteDesktopMCP-issue26`

## セッション整理

作業開始時に RDMCP のセッション一覧を確認した。
Issue #25 と PR #30 レビューのセッションは別作業者が利用中のため触れていない。

Issue #26 系は重複していたため、PR #33 / Issue #26 と用途が明示された作業だけを残す方針で整理した。
RDMCP 再起動で既存セッションが失われた後は、次の専用セッションを1本だけ再作成した。

- purpose: `PR #33 / Issue #26 組み込みツール詳細ログ TDD修正・検証・報告`
- session: `TV3OaUXAM3huYpAtD99oyM2sNJ7J3E-Is54qJYcD9D8`

## 診断 artifact workflow

作業開始時に `.github/workflows/lint.yml` を確認した。

既存 workflow は Ubuntu と Windows の検証について、成功・失敗を問わず診断 artifact を保存する。
保存対象には少なくとも次が含まれている。

- lint / check / build / test の結果
- 標準出力
- 標準エラー
- 実行環境ログ

このため workflow への追加変更は不要だった。

## 既存実装の確認

PR #33 には作業開始時点で次が実装済みだった。

- 組み込みファイル操作の構造化された操作詳細
- `file_patch` の差分表示
- `file_read` の対象、読取範囲、本文表示
- 検索操作の検索条件と検索結果
- ファイル転送の対象、状態、内容見本
- 成功・失敗・拒否・停止取消しの終端監査ログとの関連付け
- 使用者画面の折りたたみ表示
- SSE 再描画時の開閉状態維持
- 内容見本の長さ制限、既知秘密情報の伏字、バイナリの16進表示
- UTF-8 の文字境界を分断した内容見本の扱い

## 追加で検出した不具合

`file_transfer_upload_commit` が失敗した場合でも、
転送先に既存ファイルがあると、その既存ファイルを「内容見本」として読み取る経路があった。

特に `overwrite=false` で宛先競合した場合、
commit は失敗しているため新しいファイルは確定していない。
それにもかかわらず既存宛先の内容を失敗操作の詳細へ含める可能性があった。

設計では upload commit の内容見本は「確定後のファイル」を対象としているため、
失敗時に既存宛先を表示する動作は契約外である。

## TDD

### Red

次の回帰テストを先に追加した。

`failed upload commit does not expose existing destination content in operation detail`

テストは次を確認する。

- 既存宛先に識別可能な内容を配置する
- `overwrite=false` で同じ宛先へ upload commit して失敗させる
- 失敗操作には公開エラー詳細が残る
- 「内容見本」項目は存在しない
- 既存宛先の内容が構造化詳細へ混入しない

ローカル Red:

- 1 test
- 0 pass
- 1 fail
- 失敗理由: `failed commit must not preview a pre-existing destination`

Red commit:

- `03783e138f36077a333bcc26ee20a533d451fff4`
- `test: 失敗したアップロード確定の内容見本を禁止`

Red commit の exact SHA に対応する CI run `36795549008` も failure となった。
Ubuntu と Windows shard 1/3 の双方で同じ新規回帰テストが `true !== false` で失敗した。

### Green

`file_transfer_upload_commit` の内容見本生成条件を、
転送情報が存在するだけではなく、成功結果に `resolved_path` が存在する場合へ限定した。

これにより、確定成功時は従来どおり確定ファイルを表示し、
失敗・拒否・停止取消しでは既存宛先を内容見本として読まない。

実装 commit:

- `b93dbe4576986e12a87bb7594e4b4f4f9eb432ca`
- `fix: 失敗したアップロード確定で既存内容を表示しない`

focused Green:

- 新規回帰テスト: 1/1 pass
- 操作詳細の主要3ケース: 3/3 pass
- stderr: なし

## ローカル検証

technical HEAD `b93dbe4576986e12a87bb7594e4b4f4f9eb432ca` で次を確認した。

- `npm run lint`: pass
- `npm run check`: pass
- `npm run build`: pass
- `git diff --check`: pass
- 新規回帰テスト: pass
- 操作詳細関連3ケース: pass

`npm test` は同じ local HEAD で2回実行し、どちらも 98 pass / 1 fail / 1 skip となった。

失敗は今回追加したテストではなく、
既存 `Issue 13: published tool descriptions match session, file-root, transfer, and process boundaries`
終了後の非同期処理が、fixture cleanup 後の一時 `data` ディレクトリへ `lstat` して
`ENOENT` の未処理 Reject を生成したものだった。

同じ Issue 13 テストを単独実行すると 1/1 pass で、この非同期 Reject は再現しなかった。
今回の変更経路は upload commit の内容見本条件だけであり、Issue 13 の `process_start` 経路は変更していない。
範囲外の既存テスト後処理問題は本対応では変更していない。

診断保存先:

- `%TEMP%\RemoteDesktopMCP-pr33-red-failed-commit-preview`
- `%TEMP%\RemoteDesktopMCP-pr33-green-failed-commit-preview`
- `%TEMP%\RemoteDesktopMCP-pr33-focused-operation-detail`
- `%TEMP%\RemoteDesktopMCP-pr33-b93dbe45-final-local`
- `%TEMP%\RemoteDesktopMCP-pr33-b93dbe4-issue13-repro`
- `%TEMP%\RemoteDesktopMCP-pr33-b93dbe45-test-retry`

## CI

technical HEAD `b93dbe4576986e12a87bb7594e4b4f4f9eb432ca` と
run の `headSha` が完全一致する `pull_request` run `36797650008` のみを検証対象にした。

結果は success。

- Ubuntu: success
- Windows shard 1/3: success
- Windows shard 2/3: success
- Windows shard 3/3: success
- 各 job の診断 artifact upload: success

別 SHA の過去 run は technical HEAD の CI 証拠として代用していない。

この report / handoff を追加すると PR HEAD が変わるため、
publication commit 後は新しい final HEAD と一致する run を改めて確認する。

## タスク台帳

`tasks/tasks-status.md` は存在するが、
Issue #26 または今回の組み込みツール詳細ログに対応する項目は見つからなかった。
既存の別タスクを変更していない。

## 変更範囲

今回の追加対応で変更した製品コードは `src/index.ts` の成功判定1条件だけである。
回帰テストは `test/regressions.test.ts` に追加した。

PR #33 全体としては、設計、監査ログ、使用者画面、回帰テストを含む既存commit列を維持している。

## 残件

- local full test で再現する既存 Issue 13 の非同期後処理競合は、本対応の範囲外として未変更。
- technical HEAD の repository CI は全 job success。
- report / handoff publication 後の exact final HEAD CI を確認する。
- マージは行わない。
