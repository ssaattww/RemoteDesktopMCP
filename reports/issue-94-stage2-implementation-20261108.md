# Issue #94 第2段の実装記録

## 対象

- PR: [#97](https://github.com/ssaattww/RemoteDesktopMCP/pull/97)
- Issue: [#94](https://github.com/ssaattww/RemoteDesktopMCP/issues/94)
- branch: `codex/issue-94-stage2-fields-views`
- base: `main` / `eef14f804c7a0ade43b65fccef66b8ef743f470e`
- 作業開始 HEAD: `ae4e6a1395e59e495f79cbe4c10b0e65b6ceea6b`
- 実装の初回 HEAD: `5bbaa3e18bd72c73fc3f1ddad83e486a90c46b7c`。独立レビューで GraphQL 契約の誤り2点を見つけ、修正中の差分は未コミット。

## 内容

既存の専用 Projects MCP に、Project の独自欄定義と view の一覧・作成・編集・削除を追加した。欄定義は text、number、date、single-select、multi-select、iteration を扱う。選択肢の色・説明と既存 ID、iteration の既存 ID を読み戻して更新内容を確認する。view は GraphQL が受け付ける名称、layout、filter、表示欄を扱い、並べ替えや分類の編集は公開しない。

更新前に対象 Project の本人所有、欄／view の対象所属、表示欄 ID を確認する。GraphQL 操作は固定し、任意クエリ・URL・コマンド実行を公開しない。Issue／PR 本体や labels 等は変更しない。Project 自体の削除、公開設定、メンバー・アクセス権変更は引き続き対象外。欄削除の結果には既存値が失われる可能性を示す。

API の入力と戻り値は [GitHub GraphQL Projects reference](https://docs.github.com/en/graphql/reference/projects) にある欄定義、選択肢、iteration、view の契約に合わせた。view 更新は `configuration.visibleFieldIds` と GraphQL の `TABLE_LAYOUT` 等を用いる。

## 検証

- `npm run check`: 成功。
- `npm run build`: 成功。
- `npm run lint`: 成功。
- Projects API/MCP/HTTP テスト17件: 成功。
- iteration の既存 ID 保持と更新後読み戻しをモックで確認。
- 実 credential の登録、GitHub への接続、実 Project の読み書きは未実施。
- 全体 `npm test`: 328件中326件成功、1件 skip、1件失敗。Projects API/MCP/HTTP の変更に関するテストは成功。失敗は `test/search-process-lifecycle.test.ts` の既存プロセス終了タイミング検査で、全体実行時にプロセス状態の assertion が外れた。単独再実行では同ファイル5件が成功したため、Projects の変更に関連する失敗とは確認できていない。
- 独立レビューの GraphQL 指摘2点（view 作成入力に存在しない filter、union の ID を直接選択）は修正し、追レビューでも解消を確認。GitHub GraphQL 公式資料で照合したが、実 GitHub によるスキーマ実行は未実施。
- PR #97 は Open / Draft。修正前 HEAD の CI は Ubuntu と Windows の2 check が実行中。追修正の commit/push とそれを対象にした CI 結果は未確認。

## 残り

check/build/lint、Focused Projects tests、差分検査は追修正後も成功。修正を既存 PR #97 branch に commit/push し、更新後の PR HEAD と CI を読み戻す。全体テストで残った既存タイミング依存失敗は別記のとおり。#94 は複数段の継続 Issue として open のままにする。認証情報の設定、実 GitHub 書き込み、merge はこの作業で行わない。
