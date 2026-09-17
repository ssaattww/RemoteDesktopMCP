# Lint 導入レポート

## 対象

- 作業日: 2026-09-17
- 作業環境: `ibis-ThinkBook-14-G7-IML`
- 作業ディレクトリ: `/home/ibis/CodexProjects/RemoteDesktopMCP`
- ブランチ: `main`
- Git HEAD: 初回コミット前のため未存在
- Git remote: 未設定

## 目的

RemoteDesktopMCP に TypeScript と Markdown の lint を導入し、
ローカルで一括検査できるようにする。

## 変更内容

- ESLint を TypeScript の lint として追加した。
- `typescript-eslint` の推奨ルールを有効にした。
- `markdownlint` を Markdown の lint として追加した。
- `npm run lint` で TypeScript と Markdown を一括検査可能にした。
- Markdown の裸 URL を通常の Markdown リンクへ修正した。

## 設定上の判断

Markdown の `MD013`（1行80文字制限）は無効化した。
日本語の設計文書や長い技術識別子では可読性改善につながらないためである。
その他の markdownlint ルールは既定値を使用する。

Markdown 検査はリポジトリ内を再帰検索し、次のディレクトリを除外する。

- `.git`
- `dist`
- `node_modules`
- `reference`

当初 `markdownlint-cli2` を試したが、依存する `smol-toml` に
high severity の既知脆弱性が検出されたため採用しなかった。
最終構成では `markdownlint` ライブラリを直接利用している。

## 変更ファイル

- `package.json`
- `package-lock.json`
- `eslint.config.js`
- `.markdownlint.json`
- `scripts/lint-markdown.mjs`
- `doc/design/tailscale-funnel-architecture.md`

## 検証結果

- `npm run lint`: exit 0
  - ESLint: 問題なし
  - markdownlint: 問題なし
- `npm run check`: exit 0
- `npm run build`: exit 0
- `npm audit --audit-level=low`: exit 0、0 vulnerabilities

検証は上記 ThinkBook 上の現在の未コミット作業ツリーに対して実行した。
初回コミット前のため、検証結果を Git SHA へ紐付けることはできない。

## 未実施

- commit
- push
- PR 作成
- CI

Git remote が未設定であり、現在の依頼範囲ではローカル lint 導入までとした。

## GitHub 側の確認

GitHub connector で `ssaattww/RemoteDesktopMCP` が存在することを確認した。
リポジトリは private、既定ブランチは `main` で、現時点の repository size は 0 である。
ローカル Git には remote を追加しておらず、GitHub 側への書き込みも実施していない。
