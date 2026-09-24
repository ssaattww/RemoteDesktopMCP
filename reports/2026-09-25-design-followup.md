# Design follow-up

## Dispatch

Requested: gpt-6-sol / high. User override. Fresh bounded task; no role override. Applied: unknown; runtime profile unverified. Judgment-heavy design, high criticality, cross-module, sequential dependencies. Owner: design agent.

## Findings and changes

RDMCP-DR-001: `file_transfer_download_begin` は読み取り用の非公開一時複製を確定してから、そのバイト列のサイズとSHA-256を返す。チャンクは複製だけから順番に読み、送信した全バイト列のサイズとSHA-256を照合してから完了を返す。元ファイルが開始後に変わっても複製のバイト列を返す。完了、中断、期限切れで複製を削除する。

RDMCP-DR-002: `overwrite=false` の確定は原子的な置換禁止操作とし、転送先が開始後に作成された場合も上書きせず失敗する。対応する保存領域では同一ディレクトリの一時ファイルから転送先へのハードリンク作成を使える。能力確認ができない場合は転送開始を拒否し、競合時は一時ファイルを削除する。

RDMCP-DR-003: 設定ファイルの親ディレクトリと検索許可ディレクトリが実体パスで親子関係になる構成を拒否する。Desktop Commander に保護対象を含む検索範囲を渡さない。ファイル操作と転送の直接指定でも設定ファイルの実体を拒否する。プロセス実行は既存の同一 OS ユーザー権限モデルを維持する。

稼働可能な最小段階は、1台のPCで統括ノードと実行ノードを兼任するローカル構成とした。1つの `node_id`、ループバック MCP、開発用の既存パスワード認証、セッション、監査、Desktop Commander 委譲、ファイル転送を動作させる。Funnel 公開、Google OIDC、CIMD、更新用トークン、遠隔ノード接続と中継は次段階の要件として残した。

実装分割の提案は、まず単一ノードの認証・セッション・ノード選択・パス制限を共通の入口として固定し、その後に Desktop Commander 委譲と転送を接続する順序である。転送を別担当にする場合は、同じセッション・ノード・パス判定を呼ぶ境界を先に共有する。複数PC接続はこの最小段階の完了とは別に追跡する。

## Evidence and limitations

変更対象: `doc/design/functional-requirements.md`、`doc/design/multi-pc-architecture.md`、`doc/design/tailscale-funnel-architecture.md`、`tools/lint/markdown-whitelist.yaml`。新しい用語は `Windows`、`POSIX`、`ハードリンク` の3件だけを意味付きで追加した。競合試験は元ファイルの同サイズ・同更新時刻の変更と置換、アップロード開始後の同名ファイル作成、保護対象と重なる検索範囲を定義した。

設計文書3件の語彙確認: `node scripts/check-markdown-whitelist.mjs --files doc/design/functional-requirements.md doc/design/multi-pc-architecture.md doc/design/tailscale-funnel-architecture.md` は成功。`npm.cmd run lint:md` は33ファイル、0件で成功。`git diff --check` は成功。

この報告書は既存の英語の `Dispatch` 見出しと記録を保持した。語彙確認はこの既存部分の一般英語を未登録語として扱うため、報告書を含む対象指定では失敗する。設計文書に対する語彙確認と区別して扱う。報告書はリポジトリ全体の語彙確認の既定対象である `doc` の外にあり、全体の語彙検査には含まれない。

文書は実装規則を定義するもので、競合処理と実接続の実行結果は実装完了後に検証する。現在の `src/index.ts` に複数PC、Desktop Commander 委譲、転送が実装済みだとは主張しない。
