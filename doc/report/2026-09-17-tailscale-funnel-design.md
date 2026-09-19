# Tailscale Funnel 設計作業報告

## 対象

- 作業場所: `/home/ibis/CodexProjects/RemoteDesktopMCP`
- 作業日: 2026-09-17
- 対象: RemoteDesktopMCP の公開経路設計
- 方針: Tailscale Funnel を使用する

## 実施内容

- ローカル Git リポジトリを `main` ブランチで初期化した。
- `doc/design/tailscale-funnel-architecture.md` を追加した。
- `doc/design/functional-requirements.md` に公開経路要件を追加した。
- 実装コードは変更していない。

## 主な設計決定

- 固定グローバル IP、DDNS、ルーター／モデムのポート開放は使用しない。
- Tailscale Funnel の HTTPS 443 を公開入口とする。
- RemoteDesktopMCP は `127.0.0.1:3000` のみに bind する。
- Funnel は認証境界として扱わない。
- MCP 側で OAuth/OIDC 認証を必須とする。
- 初期版の本人確認は Google OIDC を使用し、Google `sub` を許可ユーザーの主識別子とする。
- 許可ユーザーと Funnel 設定は MCP Tool から変更できない。

## 現在の実装との差分

現行 `src/index.ts` には設計との差分がある。

- listen 先が `0.0.0.0` であり、loopback 限定ではない。
- 認証はメールアドレス／パスワード方式で、Google OIDC 委譲ではない。
- OAuth client registration は DCR 前提である。
- redirect URI は origin 単位で検証している。
- refresh token の発行・更新処理がない。

これらは設計上の実装課題として記録し、今回の作業では変更していない。

## 確認結果

- Tailscale 公式資料で Funnel が固定 IP、DNS レコード、ポートフォワーディングなしで公開できることを確認した。
- Funnel は `*.ts.net`、TLS、外部ポート 443/8443/10000 に制限されることを確認した。
- `tailscale funnel --bg` の設定が再起動後も復帰する仕様を確認した。
- Google 公式 OIDC 資料で `sub` が Google アカウントの一意で再利用されない識別子であることを確認した。
- MCP 2026-07-28 では DCR が非推奨で CIMD が推奨されることを確認した。
- 設計文書を保存後に全文を読み戻して内容を確認した。

## ローカル状態

- Git branch: `main`
- Git commit: なし
- Tailscale CLI: 未インストール
- push: 未実施
- PR: 未作成

Git 初期化直後のため既存ファイルもすべて untracked である。コミット、remote 設定、push は今回実施していない。
