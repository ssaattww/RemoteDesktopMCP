# Tailscale Funnel 公開設計

## 目的

RemoteDesktopMCP を固定グローバル IP やルーター／モデムのポート開放なしで、ChatGPT などの外部 MCP クライアントから利用可能にする。
公開経路には Tailscale Funnel を使用し、認証・認可は RemoteDesktopMCP 自身が担当する。

## 設計方針

- 公開入口は Tailscale Funnel の HTTPS エンドポイントだけとする。
- 外部 MCP 用の待ち受けは `127.0.0.1` のみにバインドし、LAN やインターネットへ直接待ち受けない。
- Funnel は認証機構として扱わない。Funnel URL は公開 URL であり、到達者は全員未認証として扱う。
- MCP の認証は OAuth/OIDC で行い、初期版のユーザー本人確認には Google OIDC を使用する。
- 利用を許可する Google アカウントは1件だけとし、許可対象の変更は対象 PC のローカル操作からだけ可能とする。
- Tailscale Funnel の有効化・停止・公開先変更を MCP ツール から実行する機能は提供しない。
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
遠隔実行ノードは Funnel を公開せず、tailnet 内の私設経路で統括ノードと接続する。
統括ノード自身は実行ノードを兼任できる。

統括ノードのノード間通信用待ち受けは Tailscale の私設 IP だけにバインドする。
`0.0.0.0`、LAN IP、公開 IP ではノード間通信を待ち受けない。

複数 PC の役割、要求振り分け、ノード認証は `multi-pc-architecture.md` で定める。

## Tailscale Funnel の責務

Tailscale Funnel は公開 HTTPS URL と対象 PC 上の ループバック HTTP サービスを中継する。
初期版は外部公開ポート 443 を使用し、ローカルの `127.0.0.1:3000` へ転送する。

想定設定:

```bash
tailscale funnel --bg 3000
```

公開 URL の例:

```text
https://remote-desktop.<tailnet>.ts.net
```

`BASE_URL` にはこの公開 URL を設定する。URL は実行時に `Host` ヘッダーから生成せず、ローカル設定値を正とする。

Funnel の DNS 名は端末名と tailnet の DNS 名に依存するため、端末名または tailnet 名を変更した場合は `BASE_URL` と OAuth のリダイレクト URI 設定も更新する。

## ローカル待ち受け

外部 MCP 用の待ち受けは次だけとする。

```text
127.0.0.1:3000
```

`0.0.0.0` や LAN インターフェースにはバインドしない。これにより、同一 LAN 上の端末から Funnel と認証経路を迂回して直接アクセスされる経路を作らない。

複数 PC 構成では、これとは別に統括ノードがノード間通信用の待ち受けを持てる。
この待ち受けは Tailscale の私設 IP だけに限定し、実行ノードからの持続接続だけを受け付ける。

## 認証境界

Funnel は認証済みユーザーだけを通す仕組みではない。公開 URL への到達可否と RemoteDesktopMCP の利用可否を分離する。

RemoteDesktopMCP は全 MCP 要求でアクセストークンを検証し、未認証要求は `401 Unauthorized` と OAuth 保護リソースのメタデータ を返す。

初期版の本人確認は Google OIDC を上流 IdP とし、RemoteDesktopMCP の認可コンポーネントが MCP クライアント向け OAuth エンドポイントを提供する。

```text
MCP クライアント
   | 1. /mcp -> 401
   | 2. OAuth 検出情報 / authorize + PKCE
   v
RemoteDesktopMCP 認可
   | 3. Google OIDC login
   v
Google
   | 4. ID トークン / コールバック
   v
RemoteDesktopMCP 認可
   | 5. 許可ユーザー照合
   | 6. 認可コード -> アクセス/リフレッシュトークン
   v
MCP クライアント
   | 7. Bearer トークン
   v
/mcp
```

Google から得た ID トークンは署名、`iss`、`aud`、`nonce`、有効期限を検証する。許可ユーザーの主キーは Google の `iss` と `sub` の組とし、メールアドレスは表示・確認用の補助情報とする。

## OAuth/MCP エンドポイント

公開する HTTP エンドポイントは MCP と OAuth/OIDC に必要なものへ限定する。

- `POST /mcp`
- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-authorization-server`
- `GET /authorize`
- `POST /token`
- Google OIDC の開始とコールバック用エンドポイント
- MCP クライアント互換性のため必要な場合だけクライアント登録エンドポイント

MCP の認可は認可コード + PKCE (`S256`) を使用する。アクセストークンは短時間で失効させ、継続接続に必要な リフレッシュトークン を発行する。

2026-07-28 MCP 仕様では DCR は非推奨で CIMD が推奨されているため、新規実装では CIMD を優先する。ただし ChatGPT 側との実接続確認で DCR が必要な場合は互換用として限定的に残す。

`redirect_uri` は登録済み URI と完全一致で検証し、オリジン一致だけでは許可しない。

## 許可ユーザー設定

許可ユーザー情報は対象 PC のローカル設定領域に保存する。

最低限保持する値:

- OIDC の発行者
- 許可する Google `sub`
- 表示用メールアドレス

この設定を変更する MCP ツール、HTTP 管理 API、Funnel 経由の管理画面は作らない。設定ファイルはサーバープロセスを実行する OS ユーザーだけが読み書きできる権限にする。

## トークンと失効

アクセストークンは少なくとも次を検証する。

- 署名
- 有効期限
- 発行者
- `aud` が当該 MCP リソースであること
- `scope`
- 許可ユーザーが現在のローカル設定と一致すること

許可ユーザーをローカルで変更した場合、旧ユーザーに発行済みの アクセストークン と リフレッシュトークン は以後拒否する。許可ユーザーの照合をトークン発行時だけでなく利用時にも行い、設定変更後に旧トークンが残存しないようにする。

リフレッシュトークン は長期資格情報として扱い、ログへ出力しない。保存する場合は平文トークンそのものではなく、失効判定に必要な安全な表現を用いる。リフレッシュトークン はローテーション可能な設計とする。

## 公開面の防御

Funnel URL は公開インターネットから到達可能なため、次を必須とする。

- `/mcp` は認証成功前に ツールを実行しない。
- OAuth の `state`、OIDC の `nonce`、PKCE を検証する。
- 認証、トークン、クライアント登録系エンドポイントにレート制限 を設ける。
- エラーレスポンスへ秘密情報、ローカルパス、トークン、スタックトレース を含めない。
- `Host`、`X-Forwarded-*`、接続元 IP を認証根拠にしない。
- 管理設定を変更する HTTP エンドポイントを公開しない。
- `DATA_DIR`、認証設定、監査ログをファイル操作ツール の許可 root に含めない。
- Funnel で RemoteDesktopMCP 以外のローカルサービスを同時公開しない。

Tailscale アカウントと対象ノードは公開経路を変更できるインフラ管理権限として扱う。Funnel の有効化権限は対象ノードへ限定する。

## 起動と復旧

常設運用では RemoteDesktopMCP と `tailscaled` を OS 起動時に開始する。
Funnel は `--bg` で設定し、Tailscale 再起動後も公開設定が復帰する構成とする。

起動順の論理依存は次とする。

1. ネットワークが利用可能になる。
2. `tailscaled` が tailnet へ接続する。
3. RemoteDesktopMCP が `127.0.0.1:3000` で起動する。
4. Funnel が公開 URL からローカルポートへ転送する。

RemoteDesktopMCP が停止中の場合、Funnel 経由の要求は失敗してよい。Funnel 停止中でも RemoteDesktopMCP は ループバック 上で動作可能とする。

運用確認には `tailscale funnel status --json` を使用する。MCP ツール からこの設定を変更する機能は持たせない。

## ログ

既存の監査ログ要件に加え、次を記録する。

- OAuth/OIDC 認証成功・拒否
- Google の発行者と許可ユーザー識別子の照合結果
- トークン発行・更新・失効結果（トークン本体は記録しない）
- 未認証 `/mcp` 要求の拒否
- レート制限による拒否

Funnel の稼働状態は Tailscale 側の運用ログで確認し、アプリ監査ログと混同しない。

## 検証項目

実装後は最低限次を確認する。

1. 外部 MCP 用の待ち受けが `127.0.0.1` にだけバインドしている。
2. 同一 LAN の別端末から `:3000` へ直接接続できない。
3. Funnel の HTTPS URL から OAuth 検出情報 へ到達できる。
4. 未認証 `/mcp` が `401` になる。
5. 許可した Google アカウントだけ認証できる。
6. 別の Google アカウントは認証後も MCP アクセスを取得できない。
7. アクセストークンの期限、`aud`、署名が不正な要求を拒否する。
8. 許可ユーザーをローカル変更すると旧ユーザーの既存トークンを拒否する。
9. Tailscale または PC の再起動後に Funnel が復帰する。
10. モデム／ルーター側に RemoteDesktopMCP 用ポートフォワーディングが不要である。

## 現在の実装との差分

2026-09-17 時点の `src/index.ts` には本設計と異なる点があるため、実装時に別途変更する。

- 現在は `0.0.0.0` にバインドしているため `127.0.0.1` へ変更する必要がある。
- 現在の認証画面はローカル管理のメールアドレス／パスワード方式であり、Google OIDC 委譲へ置き換える必要がある。
- 現在の OAuth クライアント登録 は DCR 前提なので、最新 MCP 仕様と ChatGPT の実挙動を確認して CIMD 優先へ整理する必要がある。
- 現在の リダイレクト URI 検証はオリジン単位なので、登録済み URI の完全一致へ変更する必要がある。
- リフレッシュトークン の発行・更新処理がないため追加が必要である。

この文書では設計のみを定め、上記コード変更は実施しない。

## 参照

- [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel)
- [`tailscale funnel` CLI](https://tailscale.com/docs/reference/tailscale-cli/funnel)
- [Funnel 使用例](https://tailscale.com/docs/reference/examples/funnel)
- [MCP 2026-07-28 仕様リリース](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [ChatGPT MCP アプリ / OAuth 案内](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)

Tailscale Funnel は 2026-09-17 時点でベータであり、公開ポートは 443、8443、10000 に制限されている。本設計では 443 の HTTPS のみ使用する。
