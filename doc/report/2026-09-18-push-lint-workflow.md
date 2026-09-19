# Push lint workflow 導入報告

## 対象

- repository: `ssaattww/RemoteDesktopMCP`
- PR: `#1`
- branch: `feat/tailscale-funnel-design-lint`
- base: `main`
- technical HEAD: `bc371e13a46463633f15730f4c5609963fff1a6e`

## 目的

GitHub への push を契機に、ローカルと同じ lint 設定を実行できるようにする。
失敗原因の調査に必要な標準出力、標準エラー、実行結果、環境情報を artifact として保存する。

## 変更内容

`package.json` の `npm run lint` に設計文書の whitelist 検査を組み込んだ。
これにより、ローカルと GitHub Actions の双方が同じ `npm run lint` を使用する。

`.github/workflows/lint.yml` を追加し、`push` イベントで lint job を起動する。
Node.js 22 と `npm ci` を使用し、依存関係を固定された lockfile から復元する。

## 診断 artifact

workflow は成功・失敗どちらでも `lint-diagnostics-<HEAD SHA>` を保存する。
artifact には次を含める。

- `npm-ci.stdout.log`
- `npm-ci.stderr.log`
- `npm-ci.result.txt`
- `lint.stdout.log`
- `lint.stderr.log`
- `test-results.txt`
- `environment.log`

## ローカル検証

technical HEAD の作成前に次を確認した。

- workflow YAML 構造: pass
- `npm run lint`: pass
- `npm run check`: pass
- `npm run build`: pass
- `npm audit --audit-level=low`: 0 vulnerabilities
- `git diff --check`: pass

`npm run lint` は TypeScript、Markdown 構文、設計文書の whitelist 検査を順に実行する。

## GitHub Actions 検証

push 後、technical HEAD と一致する run のみを確認した。

- run id: `35281429935`
- workflow: `lint`
- event: `push`
- head SHA: `bc371e13a46463633f15730f4c5609963fff1a6e`
- conclusion: `success`
- lint job: `success`
- diagnostic artifact id: `10522638094`
- artifact name: `lint-diagnostics-bc371e13a46463633f15730f4c5609963fff1a6e`

別 SHA の workflow run は検証結果として使用していない。

## 残件と境界

引数なしの `npm run lint:md:terms` は `doc/report/**` も対象とするため、従来どおり別用途の full 用語検査として残している。
通常の `npm run lint` は承認済みの設計文書範囲を whitelist 検査する。

この報告ファイルを追加する後続コミットは report-only であり、push により同じ lint workflow が再実行される。
merge は実施しない。
