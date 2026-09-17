# RemoteDesktopMCP 初期実装・設計・lint 導入報告

## 対象

- repository: `ssaattww/RemoteDesktopMCP`
- base: `main`
- branch: `feat/tailscale-funnel-design-lint`
- technical HEAD: `5bebe38144857dc2bdff5e6edaf375fb44139d56`
- PR: `#1`

## 実施内容

RemoteDesktopMCP の初期実装、機能要件、Tailscale Funnel 公開設計、TypeScript と Markdown の lint を追加した。
Markdown の用語検査では、利用者が承認した英字・カタカナ語だけを `tools/lint/markdown-whitelist.yaml` に登録した。

認証・公開経路の設計では、RemoteDesktopMCP を `127.0.0.1` にのみバインドし、外部公開を Tailscale Funnel に限定する方針を記録した。
認証境界は Funnel ではなく RemoteDesktopMCP 側の OAuth/OIDC とした。

## 用語検査

追加許可した英字には `PC`、`stdout`、`stderr` を含む。
また、英語から置き換えたベータ、バインド、コールバック、ループバック、メタデータ、レート制限、リフレッシュトークン、スタックトレース、ツール、オリジン、スコープ、リリースを許可した。

設計文書中の未許可英語は、識別子として必要なものをインラインコード化し、それ以外は承認済みの日本語・カタカナ表現へ置き換えた。

focused 用語検査対象:

- `doc/design/functional-requirements.md`
- `doc/design/tailscale-funnel-architecture.md`

focused 用語検査は未許可語 0 件で成功した。

## 検証

- `npm run lint`: pass
- focused terminology lint: pass
- `npm run check`: pass
- `npm run build`: pass
- `npm audit --audit-level=low`: 0 vulnerabilities
- `git diff --check`: pass

## 保留事項

`npm run lint:md:terms` を引数なしで実行すると `doc/report/**` まで用語検査対象になるため失敗する。
レポートを用語検査対象から除外する案はあるが、対象範囲変更は未承認なので実施していない。
通常の markdownlint は `doc/report/**` を含めて成功している。

GitHub Actions workflow は現時点で存在しないため、この HEAD に対応する CI run はない。
別 SHA の run を代用していない。

## Git 状態

技術変更は `5bebe38144857dc2bdff5e6edaf375fb44139d56` として push 済み。
この報告ファイルを含む後続コミットは報告用であり、技術変更の判定対象 HEAD は上記 SHA とする。
merge は実施しない。
