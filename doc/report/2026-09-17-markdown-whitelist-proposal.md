# Markdown ホワイトリスト導入候補

## 状態

- 判定: `needs user review`
- 対象: `doc/design/*.md` の用語検査
- 設定ファイルへの許可語追加は未実施
- `doc/report/` の用語検査除外も未実施
- 構文検査の markdownlint は従来どおり `doc/**/*.md` を対象とする

## 導入済みの仕組み

`yaml` を開発依存に追加し、次の候補抽出・検査スクリプトを追加した。

```text
scripts/check-markdown-whitelist.mjs
```

候補抽出:

```bash
npm run lint:md:terms:candidates
```

本検査は `tools/lint/markdown-whitelist.yaml` が作成された後に次で実行する。

```bash
npm run lint:md:terms
```

## 対象範囲候補

用語ホワイトリストは設計本文の読みやすさを守るために使う。
実行ログや検証結果を記録する `doc/report/` は、英語のコマンド名や結果値が多く、
設計本文とは性質が異なるため用語検査から除外する案とする。

提案する対象は次のとおり。

```text
include: doc/design/**/*.md
exclude: doc/report/**
```

これは用語検査だけの対象設定であり、markdownlint の対象は変更しない。
この除外設定自体も利用者レビュー後に反映する。

## 英語・略語の許可候補

次は製品名、規格名、一般的な技術略語、または固有名称として英字表記を維持する候補である。

```yaml
version: 1
entries:
  - term: RemoteDesktopMCP
    description: このプロジェクトおよび MCP サーバーの名称。
  - term: MCP
    description: Model Context Protocol の略称。
  - term: Tailscale
    description: 公開経路に使用する製品名。
  - term: Tailscale Funnel
    aliases: [Funnel]
    description: Tailscale が提供する公開 HTTPS 機能。
  - term: ChatGPT
    description: MCP クライアントとして利用するサービス名。
  - term: Google
    description: OIDC の本人確認に利用するサービス名。
  - term: OAuth
    description: 認可プロトコルの名称。
  - term: OIDC
    description: OpenID Connect の略称。
  - term: PKCE
    description: OAuth の認可コード横取り対策方式の略称。
  - term: CIMD
    description: Client ID Metadata Documents の略称。
  - term: DCR
    description: Dynamic Client Registration の略称。
  - term: DDNS
    description: Dynamic DNS の略称。
  - term: DNS
    description: Domain Name System の略称。
  - term: HTTP
    description: Hypertext Transfer Protocol の略称。
  - term: HTTPS
    description: TLS で保護された HTTP の表記。
  - term: TLS
    description: Transport Layer Security の略称。
  - term: IP
    description: Internet Protocol の略称。
  - term: LAN
    description: Local Area Network の略称。
  - term: NAT-PMP
    description: NAT Port Mapping Protocol の略称。
  - term: UPnP
    description: Universal Plug and Play の略称。
  - term: CLI
    description: Command Line Interface の略称。
  - term: API
    description: Application Programming Interface の略称。
  - term: OS
    description: Operating System の略称。
  - term: PID
    description: Process ID の略称。
  - term: ID
    description: 識別子を表す一般的な技術略語。
  - term: URI
    description: Uniform Resource Identifier の略称。
  - term: URL
    description: Uniform Resource Locator の略称。
  - term: IdP
    description: Identity Provider の略称。
  - term: tailnet
    description: Tailscale が管理する私設ネットワークの正式用語。
```

単独の `access`、`token`、`bind`、`callback` などは許可候補にしない。
日本語または文脈を持つ技術表現へ修正する。

## カタカナ語の許可候補

現在の設計本文で使われており、技術文書として一般的な表記を維持する候補は次のとおり。
説明はホワイトリスト登録時の `description` として使用する。

```yaml
  - term: アカウント
    description: 認証主体を表す一般的な用語。
  - term: アクセス
    description: リソースへの利用または接続を表す一般的な用語。
  - term: アクセストークン
    description: OAuth で保護リソースへのアクセスに使用する資格情報。
  - term: アプリ
    description: アプリケーションを表す一般的な略称。
  - term: インターネット
    description: 公開ネットワークを表す一般的な用語。
  - term: インターフェース
    description: 接続面または API 境界を表す技術用語。
  - term: インフラ
    description: システム基盤を表す一般的な技術用語。
  - term: エラーレスポンス
    description: エラー時に返す応答を表す技術用語。
  - term: エンドポイント
    description: HTTP などの接続先を表す技術用語。
  - term: クライアント
    description: サービスへ接続する利用側コンポーネントを表す用語。
  - term: グローバル
    description: ローカルに対する公開範囲を表す一般的な技術用語。
  - term: コード
    description: ソースコードまたは認可コードを表す一般的な技術用語。
  - term: コールバック
    description: 処理完了後に呼び戻す接続先を表す技術用語。
  - term: コマンド
    description: プロセスへ実行させる命令を表す技術用語。
  - term: コンポーネント
    description: システムを構成する機能単位を表す技術用語。
  - term: サーバー
    description: 要求を受け付けるサービス実体を表す技術用語。
  - term: サーバープロセス
    description: サーバーとして動作する OS プロセスを表す用語。
  - term: サービス
    description: 継続提供されるソフトウェア機能を表す一般用語。
  - term: スコープ
    description: OAuth の権限範囲を表す技術用語。
  - term: スタックトレース
    description: エラー発生時の呼び出し履歴を表す技術用語。
  - term: セッション
    description: 接続単位または処理単位の状態を表す技術用語。
  - term: テキストファイル
    description: 文字データとして扱うファイルを表す一般的な用語。
  - term: トークン
    description: 認証や認可で使う資格情報を表す技術用語。
  - term: ネットワーク
    description: 通信経路や接続構成を表す一般的な技術用語。
  - term: ノード
    description: Tailscale などのネットワーク参加端末を表す技術用語。
  - term: パス
    description: ファイルや URL の位置表現を表す技術用語。
  - term: パスワード
    description: 本人確認に利用する秘密文字列を表す一般的な用語。
  - term: パッチ
    description: ファイルの部分変更を表す技術用語。
  - term: バインド
    description: サーバーが待受アドレスへ関連付く操作を表す技術用語。
  - term: ファイル
    description: ファイルシステム上のデータ単位を表す一般的な用語。
  - term: プログラム
    description: 実行可能なソフトウェアを表す一般的な用語。
  - term: プロセス
    description: OS 上で動作する実行単位を表す技術用語。
  - term: ヘッダー
    description: HTTP などの付加情報領域を表す技術用語。
  - term: ベータ
    description: 正式提供前の機能段階を表す一般的な技術用語。
  - term: ポート
    description: ネットワーク接続先の番号を表す技術用語。
  - term: ポートフォワーディング
    description: 受信通信を別の接続先へ転送するネットワーク機能。
  - term: メールアドレス
    description: 電子メールの宛先識別子を表す一般的な用語。
  - term: メタデータ
    description: 対象データを説明する付加情報を表す技術用語。
  - term: モデム
    description: 回線接続装置を表す一般的な用語。
  - term: ユーザー
    description: システムを利用する主体を表す一般的な用語。
  - term: リソース
    description: アクセス対象を表す一般的な技術用語。
  - term: リダイレクト
    description: 別の URI へ遷移させる動作を表す技術用語。
  - term: リフレッシュトークン
    description: OAuth でアクセストークンを更新するための資格情報。
  - term: リモート
    description: 対象 PC の外部から操作する形態を表す一般用語。
  - term: ルーター
    description: ネットワーク間で通信を転送する装置を表す用語。
  - term: ループバック
    description: 同一ホスト内で完結するネットワーク経路を表す用語。
  - term: レート制限
    description: 一定時間内の要求数を制限する仕組みを表す用語。
  - term: ローカル
    description: 対象 PC 内または近接範囲を表す一般的な技術用語。
  - term: ローカルサービス
    description: 対象 PC 内だけで提供されるサービスを表す用語。
  - term: ローカルパス
    description: 対象 PC 内のファイル位置を表す用語。
  - term: ローカルポート
    description: 対象 PC 内で待ち受けるポートを表す用語。
  - term: ローテーション
    description: トークンなどを定期的に更新する運用を表す技術用語。
  - term: ログ
    description: 操作や実行結果の記録を表す一般的な技術用語。
  - term: オリジン
    description: Web の scheme・host・port の組を表す技術用語。
```

上記に加え、本文修正後に必要になる次の2語も候補とする。

```yaml
  - term: ツール
    description: MCP が公開する操作単位を表す一般的な技術用語。
  - term: ルート
    description: ファイル探索の基準位置を表す一般的な技術用語。
```

## ホワイトリストへ追加せず本文を直す候補

次の英単語は単独許可すると意味が広すぎるため、ホワイトリストへは追加しない。

- `access`: 「利用」「アクセス権」など文脈に合わせて日本語化する。
- `app`: 「アプリ」にする。
- `audience`: OIDC の claim を指す場合は識別子をインラインコード化する。
- `Authorization Code`: 「認可コード」にする。
- `beta`: 「ベータ」にする。
- `bind`: 「バインド」にする。
- `callback`: 「コールバック」にする。
- `Client ID Metadata Documents`: 本文では `CIMD` を使用する。
- `Dynamic Client Registration`: 本文では `DCR` を使用する。
- `Protected Resource Metadata`: 「保護リソースのメタデータ」にする。
- `discovery`: 「検出情報」など文脈に合わせて日本語化する。
- `Host`: HTTP ヘッダー名としてインラインコード化する。
- `ID token`: 「ID トークン」にする。
- `issuer`: OIDC の claim を指す場合は識別子をインラインコード化する。
- `listen`: 「待ち受ける」にする。
- `loopback`: 「ループバック」にする。
- `nonce`: OIDC のパラメータ名としてインラインコード化する。
- `origin`: 「オリジン」にする。
- `rate limit`: 「レート制限」にする。
- `redirect`: 「リダイレクト」にする。
- `refresh token`: 「リフレッシュトークン」にする。
- `root`: 「ルート」にする。
- `scope`: パラメータ名ならインラインコード化し、概念なら「スコープ」にする。
- `stack trace`: 「スタックトレース」にする。
- `stderr` / `stdout`: ストリーム名としてインラインコード化する。
- `token`: 「トークン」にする。
- `Tool`: 「ツール」にする。
- 参照リンクの `custom`, `examples`, `guidance`, `release`, `specification` は日本語のリンク名へ直す。

## 次の操作

利用者が上記の対象範囲、許可語、本文修正方針を承認した後に、
`tools/lint/markdown-whitelist.yaml` と対象設定を作成し、本文修正と full lint を実施する。
その時点で `npm run lint` に用語検査を組み込む。

## 検証結果

2026-09-17 22:11 JST 時点で、ホワイトリスト設定を除く既存ゲートは成功している。

```text
node --check scripts/check-markdown-whitelist.mjs  pass
npm run lint                                 pass
npm run check                                pass
npm run build                                pass
npm audit --audit-level=low                  0 vulnerabilities
```

設計文書2件を空の許可語集合で候補抽出した結果は 112 語で、
候補が存在するため終了コードは意図どおり 1 となった。
ホワイトリスト本体をまだ作成していないため、用語検査は `npm run lint` へ未接続である。

## 承認反映 2026-09-17 22:27 JST

利用者承認により、提示済み英字候補29件、`root`、提示済みカタカナ語44件を
`tools/lint/markdown-whitelist.yaml` へ登録した。

YAML の説明は短い意味説明に限定し、説明文内に未登録の英字・カタカナ語が
残っていないことを機械確認した。

設計2文書の再抽出では、承認済みカタカナ語と `root` は未許可候補から消えた。
残件は英語表現のみであり、用語検査は終了コード1のままとする。
通常の `npm run lint`、`npm run check`、`npm run build`、依存監査は成功している。
