# Tailscale Funnel 公開設計

## 目的

RemoteDesktopMCP を固定グローバル IP やルーター／モデムのポート開放なしで、ChatGPT などの外部 MCP クライアントから利用可能にする。
公開経路には Tailscale Funnel を使用し、認証・認可は RemoteDesktopMCP 自身が担当する。

## 設計方針

- 外部からの接続先は Tailscale Funnel の HTTPS エンドポイントだけとする。
- 外部 MCP 用サーバーは `127.0.0.1` だけで待ち受け、LAN やインターネットから直接接続できないようにする。
- Funnel 自体は認証手段として使わない。Funnel URL は公開されるため、そこへ接続してきた時点では未認証として扱う。
- MCP の認証は OAuth/OIDC で行い、初期版のユーザー本人確認には Google OIDC を使用する。
- 利用を許可する Google アカウントは1件だけとし、対象PC上のローカル操作からだけ変更できるようにする。
- Tailscale Funnel の有効化、停止、公開先変更を MCP ツールから実行する機能は提供しない。
- 固定 IP、DDNS、UPnP、NAT-PMP、手動ポートフォワーディングは使用しない。

## 構成

```text
ChatGPT / MCP クライアント
        |
        | HTTPS :443
        v
<device>.<tailnet>.ts.net
        |
        | Tailscale Funnel
        v
tailscaled
        |
        | HTTP ループバック
        v
127.0.0.1:3000
        |
        v
RemoteDesktopMCP
```

## 複数 PC 構成での公開範囲

複数 PC を操作する場合も Tailscale Funnel を公開するのは統括ノード1台だけとする。
遠隔実行ノードは Funnel を公開せず、tailnet 内で統括ノードと接続する。
統括ノード自身は実行ノードを兼任できる。

統括ノードのノード間通信サーバーは Tailscale IP だけで待ち受ける。
`0.0.0.0`、LAN IP、グローバル IP ではノード間通信を待ち受けない。

複数PCの役割、リクエストの振り分け、ノード認証は `multi-pc-architecture.md` で定める。

## Tailscale Funnel の役割

Tailscale Funnel は、公開 HTTPS URL へのアクセスを対象PC上のループバック HTTP サービスへ中継する。
初期版は外部公開ポート 443 を使用し、ローカルの `127.0.0.1:3000` へ転送する。

想定設定:

```bash
tailscale funnel --bg 3000
```

公開 URL の例:

```text
https://remote-desktop.<tailnet>.ts.net
```

`BASE_URL` にはこの公開 URL を設定する。実行時に `Host` ヘッダーから URL を組み立てず、設定ファイルの `BASE_URL` を使用する。

Funnel の DNS 名は端末名と tailnet の DNS 名に依存するため、端末名または tailnet 名を変更した場合は `BASE_URL` と OAuth のリダイレクト URI 設定も更新する。

## ローカルの待ち受け

外部 MCP 用の待ち受けは次だけとする。

```text
127.0.0.1:3000
```

`0.0.0.0` や LAN インターフェースでは待ち受けない。これにより、同一LAN上の端末から Funnel と認証処理を経由せず直接アクセスできないようにする。

複数PC構成では、これとは別に統括ノードがノード間通信用のサーバーを持てる。
このサーバーは Tailscale IP だけで待ち受け、実行ノード側から確立した接続だけを受け付ける。

## 認証の扱い

Funnel に接続できることと、RemoteDesktopMCP を利用できることは別に扱う。Funnel へ接続できても、RemoteDesktopMCP の認証に成功しなければ MCP は利用できない。

RemoteDesktopMCP はすべての MCP リクエストでアクセストークンを検証する。未認証の場合は `401 Unauthorized` と OAuth 保護リソースのメタデータを返す。

初期版では Google OIDC を本人確認に使い、RemoteDesktopMCP が MCP クライアント向けの OAuth エンドポイントを提供する。

```text
MCP クライアント
   | 1. /mcp -> 401
   | 2. OAuth メタデータ / authorize + PKCE
   v
RemoteDesktopMCP 認可
   | 3. Google OIDC login
   v
Google
   | 4. ID トークン / コールバック
   v
RemoteDesktopMCP 認可
   | 5. 許可ユーザー照合
   | 6. 認可コード -> アクセストークン / リフレッシュトークン
   v
MCP クライアント
   | 7. Bearer トークン
   v
/mcp
```

Google から得た ID トークンは、署名、`iss`、`aud`、`nonce`、有効期限を検証する。許可ユーザーは Google の `iss` と `sub` の組で識別し、メールアドレスは表示や確認にだけ使う。

## OAuth/MCP エンドポイント

公開する HTTP エンドポイントは MCP と OAuth/OIDC に必要なものへ限定する。

- `POST /mcp`
- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-authorization-server`
- `GET /authorize`
- `POST /token`
- Google OIDC の開始とコールバック用エンドポイント
- MCP クライアント互換性のため必要な場合だけクライアント登録エンドポイント

MCP の認可には認可コード + PKCE (`S256`) を使用する。アクセストークンの有効期限は短く設定し、継続利用のためにリフレッシュトークンを発行する。

2026-07-28 MCP 仕様では DCR は非推奨で CIMD が推奨されているため、新規実装では CIMD を優先する。ただし ChatGPT との接続テストで DCR が必要と分かった場合は、互換性のために限定して残す。

`redirect_uri` は登録済み URI と完全一致で検証し、オリジン一致だけでは許可しない。

## 許可ユーザー設定

許可ユーザー情報は対象PCのローカル設定に保存する。

最低限保持する値:

- OIDC の発行者
- 許可する Google `sub`
- 表示用メールアドレス

この設定を変更する MCP ツール、HTTP 管理 API、Funnel 経由の管理画面は作らない。設定ファイルは、サーバープロセスを実行する OS ユーザーだけが読み書きできるようにする。

## トークンの有効期限と無効化

アクセストークンは少なくとも次を検証する。

- 署名
- 有効期限
- 発行者
- `aud` が当該 MCP リソースであること
- `scope`
- 許可ユーザーが現在のローカル設定と一致すること

許可ユーザーをローカルで変更した場合、それまでのユーザーに発行済みのアクセストークンとリフレッシュトークンは以後受け付けない。許可ユーザーはトークン発行時だけでなく利用時にも確認し、設定変更後に古いトークンを使えないようにする。

リフレッシュトークンは長期間利用される認証情報として扱い、ログへ出力しない。サーバー側で保存する場合は、トークンそのものではなくハッシュ値など復元できない形式を保存する。リフレッシュトークンは、更新時に新しいトークンへ切り替えられるようにする。

## 公開エンドポイントの保護

Funnel URL はインターネット上から誰でも接続を試みられるため、次を必須とする。

- `/mcp` では、認証が完了するまでツールを実行しない。
- OAuth の `state`、OIDC の `nonce`、PKCE を検証する。
- 認証、トークン、クライアント登録用エンドポイントにはレート制限を設ける。
- エラーレスポンスに秘密情報、ローカルパス、トークン、スタックトレースを含めない。
- `Host`、`X-Forwarded-*`、接続元 IP は認証判断に使わない。
- 管理設定を変更する HTTP エンドポイントを公開しない。
- `DATA_DIR`、認証設定、監査ログは、RemoteDesktopMCP と `@wonderwhy-er/desktop-commander` のどちらの許可ディレクトリにも含めない。
- Funnel で RemoteDesktopMCP 以外のローカルサービスを同時公開しない。

Tailscale アカウントや対象ノードの管理権限を持つユーザーは公開設定を変更できる。このため、これらの権限は管理者だけに限定する。Funnel を有効化するノードも必要な対象ノードだけに絞る。

## 起動と復旧

常設運用では RemoteDesktopMCP と `tailscaled` を OS 起動時に開始する。
Funnel は `--bg` で設定し、Tailscale の再起動後も公開設定が有効になるようにする。

起動順序は次とする。

1. ネットワークが利用可能になる。
2. `tailscaled` が tailnet へ接続する。
3. RemoteDesktopMCP が `127.0.0.1:3000` で起動する。
4. Funnel が公開 URL からローカルポートへ転送する。

RemoteDesktopMCP が停止中の場合、Funnel 経由のリクエストは失敗してよい。Funnel が停止していても、RemoteDesktopMCP 自体はループバック上で動作できるものとする。

運用確認には `tailscale funnel status --json` を使用する。MCP ツールから Funnel の設定を変更する機能は提供しない。

## ログ

既存の監査ログ要件に加え、次を記録する。

- OAuth/OIDC 認証の成功・失敗
- Google の `iss` / `sub` と許可ユーザー設定の照合結果
- トークンの発行・更新・無効化結果（トークン本体は記録しない）
- 未認証 `/mcp` リクエストの拒否
- レート制限による拒否

Funnel の動作状況は Tailscale 側のログで確認し、RemoteDesktopMCP の監査ログとは分けて扱う。

## 検証項目

実装後は最低限次を確認する。

1. 外部 MCP サーバーが `127.0.0.1` だけで待ち受けている。
2. 同一 LAN の別端末から `:3000` へ直接接続できない。
3. Funnel の HTTPS URL から OAuth メタデータを取得できる。
4. 未認証 `/mcp` が `401` になる。
5. 許可した Google アカウントだけ認証できる。
6. 許可していない Google アカウントでは MCP を利用できない。
7. 有効期限切れ、`aud` 不一致、署名不正のアクセストークンを使ったリクエストを拒否する。
8. 許可ユーザーをローカルで変更すると、それまでのユーザーに発行済みのトークンを拒否する。
9. Tailscale またはPCを再起動した後も Funnel を利用できる。
10. モデム／ルーター側に RemoteDesktopMCP 用ポートフォワーディングが不要である。

## 現在の実装との差分

2026-09-17 時点の `src/index.ts` には本設計と異なる点があるため、実装時に別途変更する。

- 現在は `0.0.0.0` にバインドしているため `127.0.0.1` へ変更する必要がある。
- 現在の認証画面はローカル管理のメールアドレス／パスワード方式なので、Google OIDC を使った認証へ置き換える必要がある。
- 現在の OAuth クライアント登録は DCR 前提なので、最新の MCP 仕様と ChatGPT の実際の動作を確認し、CIMD を優先する構成へ整理する必要がある。
- 現在のリダイレクト URI 検証はオリジン単位なので、登録済み URI との完全一致へ変更する必要がある。
- リフレッシュトークンの発行・更新処理がないため追加が必要である。
- 現在のファイル探索は `readdir` / `stat`、プロセス起動は直接 `spawn` を使用しているが、これらは暫定実装とする。実装時に `@wonderwhy-er/desktop-commander` の MCP ツール呼び出しへ置き換え、直接実装は削除する。
- `create_file_download` と `/downloads/:token` は初期版の機能要件に含まれないため、現在の直接ファイル読み出し実装は初期版から削除する。将来必要になった場合は別途設計する。

この文書では設計のみを定め、上記コード変更は実施しない。

## 参照

- [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel)
- [`tailscale funnel` CLI](https://tailscale.com/docs/reference/tailscale-cli/funnel)
- [Funnel 使用例](https://tailscale.com/docs/reference/examples/funnel)
- [MCP 2026-07-28 仕様リリース](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [ChatGPT MCP アプリ / OAuth 案内](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)

Tailscale Funnel は 2026-09-17 時点でベータであり、公開ポートは 443、8443、10000 に制限されている。本設計では 443 の HTTPS のみ使用する。
