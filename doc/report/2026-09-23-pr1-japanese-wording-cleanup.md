# PR #1 日本語表現整理

## メタデータ

- リポジトリ: `ssaattww/RemoteDesktopMCP`
- PR: #1
- 作業開始 HEAD: `7804426bb5af74610fe4d97a46f85d2f20456bb2`
- 第1パス technical HEAD: `7ac921c9cf7a7b72a49cb1ff16668f71c64613ca`
- 第2パス technical HEAD: `5b84a9c23a9628a683e6f56199863ac6ba2b3275`
- ブランチ: `feat/tailscale-funnel-design-lint`
- 実行環境: FA780
- 作業ディレクトリ: `C:\Users\donabe\Project\RemoteDesktopMCP-pr1-r4-20260922`

## 目的

設計書に残っていた、意味は通るものの一般的な技術文書では使いにくい直訳調・造語調の日本語を整理した。

今回の優先順位は次のとおり。

1. 人が読んで自然であること。
2. 技術的な意味を変えないこと。
3. lint を通すためだけの不自然な言い換えをしないこと。
4. 一般的な技術用語はホワイトリストへ追加し、そのまま使うこと。

## 主な修正例

次のような表現を、一般的な技術用語または自然な日本語へ変更した。

- 共有秘密情報 → 事前共有鍵（PSK）
- 規約版 → プロトコルのバージョン
- 接続専用鍵 → セッション鍵
- 検証値 → HMAC値
- 送信本体 → メッセージ本文
- 再送攻撃 → リプレイ攻撃
- 私設経路 → tailnet 内の通信経路
- 公開入口 → 外部からの接続先
- 認証境界 → 認証の扱い
- 論理プロセス識別子 → 論理プロセスID
- 原子的に置き換える → 同じロック内で切り替える
- 退役させる → 実行中プロセスの対応表から外す
- 長期資格情報 → 長期間利用される認証情報
- 到達可否 → 接続できるか / 利用できるか
- 機械検証 → 自動テスト
- 制御責務 → 担当する機能
- 許可 root → 許可ディレクトリ
- 要求 → リクエスト

また、次のような硬い表現も本文の意味を維持したまま簡潔にした。

- Desktop Commander への「委譲」は、文脈に応じて「呼び出す」「実行させる」と記述。
- 「正規化する」は、公開APIへの変換を説明する箇所では「RemoteDesktopMCP の形式へ変換する」と記述。
- 「対象未指定」は「`node_id` が指定されていない」と具体的に記述。
- 「所有者」は、プロセス管理の説明では「現在有効な論理プロセスID」を中心に説明し、実装上の識別子 `current_process_owner` だけをコード名として残した。

## 第2パスで追加した修正

第1パス後に全文を読み直し、単語としては間違っていなくても、一般的な技術文書として硬い・不自然な表現を追加で修正した。

主な例:

- 1本の統合出力 → 1つの統合出力
- プロセス出力契約 → プロセス出力仕様
- RemoteDesktopMCP の契約として提供 → MCP ツールとして公開
- 監査ログのひも付け → 監査ログの関連付け
- Tailscale tailnet → tailnet
- 接続を認証済みとする → 接続を許可する
- 結果状態 → 実行結果
- 候補提示 → ユーザーへの候補表示
- 1操作の複数ノード同時実行 → 1回の操作を複数ノードで同時に実行する機能
- Desktop Commander を経由しない実装を別途設計せずに追加しない → Desktop Commander を経由しない理由と安全性を別途設計してから追加する

この第2パスでも、RDMCP-R1〜RDMCP-R8 の設計上の制約は変更していない。

## ホワイトリスト追加候補

自然な文章を優先した結果、第1パスで14語、第2パスで1語を追加候補として抽出した。
いずれも設計書で通常どおり使う価値がある一般的な技術用語と判断し、ホワイトリストへ追加した。

- HMAC
- nonce
- PSK
- エラー
- ディレクトリ
- テスト
- バージョン
- バイト
- ハッシュ
- プロトコル
- メッセージ
- リクエスト
- リプレイ
- ロック
- アドレス

追加後、設計3文書に対して `--list-unknown` を実行し、未許可語が0件であることを確認した。

## 変更ファイル

- `doc/design/functional-requirements.md`
- `doc/design/multi-pc-architecture.md`
- `doc/design/tailscale-funnel-architecture.md`
- `tools/lint/markdown-whitelist.yaml`

製品コードは変更していない。

## 設計内容の維持

今回の変更は表現整理であり、RDMCP-R1〜RDMCP-R8 で追加された設計上の制約は維持した。

特に次は変更していない。

- Desktop Commander をローカル操作の実体として利用する方針。
- `node_id` による対象ノードの明示。
- PSK と HMAC を使うノード間相互認証。
- `desktop_commander_generation` を使う世代管理。
- 同一 PID 再利用時の `current_process_owner` 管理。
- プロセス操作の排他制御。
- stale な論理プロセスIDから PID を Desktop Commander へ渡さない規則。

## 診断 workflow

`.github/workflows/lint.yml` を確認した。

workflow は成功・失敗にかかわらず、次を artifact として保存する。

- npm install の stdout / stderr / 結果
- lint の stdout / stderr / 結果
- 対象 SHA
- Node.js / npm 情報

今回の作業で追加変更は不要だった。

## タスク台帳

`tasks/tasks-status.md` は current worktree に存在しないため更新対象なし。

## ローカル検証

technical HEAD 相当の作業ツリーで次を実行した。

- `npm run lint`: pass
  - markdownlint: 21 files / 0 issues
  - design terminology lint: pass
- `npm run check`: pass
- `npm run build`: pass
- `npm audit --audit-level=low`: pass、0 vulnerabilities
- `git diff --check`: pass
- design `--list-unknown`: 0件
また、旧来の不自然表現として明示的に確認した次の語句が設計3文書に残っていないことを確認した。

- 共有秘密情報
- 規約版
- 接続専用鍵
- 送信本体
- 私設経路
- 公開入口
- 論理プロセス識別子
- 原子的に
- 退役させる
- 長期資格情報
- 到達可否
- 機械検証
- 制御責務
- 最終活動時刻
- 失効予定時刻

## CI

report / handoff を含む最終 publication commit を push 後、
PR current HEAD と workflow run の `head_sha` が一致する run だけを確認する。

一致する run がない場合は exact-HEAD CI 未確認として扱い、別 SHA の run は代用しない。

## 次のアクション

RDMCP-R8 の通常レビュアーによる fix verification では、日本語表現整理による意味の変化がないことも併せて確認する。

## マージ境界

マージは実施しない。
