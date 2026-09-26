# 複数 PC 接続設計追加報告

## 対象

- repository: `ssaattww/RemoteDesktopMCP`
- branch: `feat/tailscale-funnel-design-lint`
- PR: `#1`

## 追加要件

1つの ChatGPT 接続から複数の PC を操作できる構成を設計した。
統括役と実行役を分離しつつ、統括ノード自身も実行ノードを兼任できることを要件化した。

設計上は固定的な master / slave という呼称ではなく、役割を表す統括ノード / 実行ノードを使用する。

## 設計概要

外部へ公開する MCP 接続先は統括ノード1台だけとする。
実行ノードは複数台登録でき、統括ノード自身も実行ノードとして操作対象にできる。

遠隔実行ノードは Funnel を公開しない。
実行ノードから統括ノードへ Tailscale の私設経路で持続接続し、その接続上で要求と結果を双方向に転送する。

外部 MCP 用待ち受けとノード間通信用待ち受けを分離した。
前者は loopback のみ、後者は Tailscale の私設 IP のみに限定する。

## 操作対象の決定

各実行ノードは一意な `node_id` を持つ。
ファイル操作とプロセス操作には `node_id` を指定できる。

実行可能ノードが複数ある状態で対象指定がない場合は、推測で実行せず失敗として返す。

## セキュリティ

ユーザー認証は統括ノードで行う。
実行ノードへユーザーのアクセストークンそのものは転送しない。

ノード間では Tailscale の暗号化だけに依存せず、RemoteDesktopMCP 自身でも相互に接続相手を検証する。
ノード登録やノード認証設定はローカル操作からだけ変更できる。

各実行ノードは自身のファイル許可 root などのローカル方針を保持し、統括ノードからの要求でもその制約を超えない。

## 図

`doc/design/multi-pc-architecture.md` に次の図を追加した。

- ChatGPT、統括ノード、複数実行ノードの全体構成図
- 統括ノード自身と遠隔実行ノードへ要求を振り分ける要求処理図

## 変更ファイル

- `doc/design/multi-pc-architecture.md`
- `doc/design/functional-requirements.md`
- `doc/design/tailscale-funnel-architecture.md`
- `package.json`

新しい設計書も repository の push lint で用語検査対象になるよう、`lint:md:terms:design` へ追加した。

## 検証

- `npm run lint`: pass
- `npm run check`: pass
- `npm run build`: pass
- `npm audit --audit-level=low`: 0 vulnerabilities
- `git diff --check`: pass

新しい whitelist 語は追加していない。
既存の許可語だけで設計文書の用語検査が成功している。

## 初期版の制約

初期版では次を対象外とした。

- 統括ノードの自動切り替え
- 複数統括ノードの同時稼働
- 1操作の複数ノード同時実行
- PC 間ファイル転送
- ChatGPT からのノード登録・削除

統括ノード停止時は全実行ノードへの ChatGPT 経由操作が停止する。
