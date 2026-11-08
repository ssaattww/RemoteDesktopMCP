# Issue #94 作業コンテキスト

## 正式な対応

- repository: ssaattww/RemoteDesktopMCP
- Issue: #94
- Draft PR: #95、base main、Closes #94 を GitHub の closingIssuesReferences で確認済み。
- branch: codex/issue-94-github-projects
- base SHA: 45d73947dc7f2e56546eb3c2e6c028ff1cc54759
- 開始 HEAD: 782c686575dc6cb50dbf0f3af27a2f2d5518280d
- 専用 clone: C:\Users\donabe\Documents\Codex\2026-11-08\task-4\RemoteDesktopMCP-issue94
- execution: runtime_local / Windows / PowerShell、local_execution_available。依存はまだ clone に配置していない。
- remote CodexSkill main と local は 8ee6e9f80a0362a4d066c4ea39fd3e87002fc829 で一致、clean。共有 Skill は更新しない。

## 承認と境界

ユーザーは branch・Draft PR・正式な紐付け・開発開始を承認した。現在は既存 RDMCP Project #4 に登録されている。GitHub 読戻しでは In progress、Priority 未設定だった。Status 変更はこの作業では送信していない。

新規 credential、既存 credential の継続利用設定、権限拡張、実運用設定変更、配備、merge は行わない。実 API の機能試験は mock に限定し、GitHub Issue・PR の開発メタデータ更新と区別する。他担当 checkout・プロセス、Duck #50／#53 を操作しない。

並行上限は実作業中の Issue 2件。ユーザーレビュー・マージ許可待ちは除外するという履歴を確認した。Project の過去の In progress 表示をそのまま現在の実行数とは数えない。本件の子担当は同一 Issue の工程として直列に実行し、別 Issue は開始しない。Duck と並行する #94 の開始は今回明示承認されている。

## ワークフロー

development-orchestrator、work-context-manager、task-consistency-manager、design-doc-maintainer、design-executor、codex-delegation-executor、sub-agent-task-manager、implementation-executor／worker、report-output-manager／writer、markdown-word-checker、progress-sync-manager を適用する。root の AGENTS.md が見当たらないことは通知済み。既存ファイルの文字化けや古い tracking は今回一括修正しない。

設計先は新規 doc/design/github-projects-tools.md。独立した外部 API と認可境界であり既存 Todo 設計への継ぎ足しにはしない。tasks と phases は既存内容を保持して本件の行だけ追加する。設計を先に記録してからコードを変更する。既存方針に明示的な一般 TDD 規定は未確認。新規認可境界は契約テストで先に失敗を確認する方針とし、結果を捏造しない。

## 調査結果と未採用の構成候補

現行 initialize は Desktop Commander の起動を必須とする。構成候補として、Projects 専用の app／factory を PC 実行基盤から分離し、shell・gh・child_process・file ツールを提供しない方法がある。HTTP の認証済み principal に Projects の audience と read／write／admin capability を要求する方法や、既存 PC /mcp で Projects token を拒否する検証を評価する。公開ツールの一覧非表示だけでは保証しない。これらは要件整理後に比較する候補であり、採用済み設計ではない。

GitHub は正本。現行 schema にある typed query／mutation を固定操作として扱い、自由な GraphQL 文や URL の proxy は公開しない。Project／item／field／Status／Priority の読み書きに加え、draft、archive／restore、position、schema、views、status updates、Project lifecycle と管理操作も capability 表で追跡する。現行 API が非対応の機能は理由を示し、PC 操作に回避しない。

認証 verifier と GitHub credential provider を明示注入する構成は候補に留める。実 credential の自動探索や既存 gh 設定の再利用は未承認であり実行しない。factory の本番組込みと実 credential の選定・設定は未決定で、運用完了とは扱わない。

## 委譲

- 着手前確認: issue94_intake、requested gpt-6.1-sol high、fresh。spawn 時点の Skill で選択。applied は親から不可視、未検証。
- 以降の新規調査・実装担当: ユーザーの追加指示に従い Luna を明示指定する。独立レビューの Sol 指定は維持する。進行中担当のモデルが変更されたとは扱わない。
- 固定カテゴリの試験・環境検証・レビューは独立担当で行う。通常の確認は focused local、full gate は最終候補で一度、CI は必要な exact HEAD の pull_request を確認する。

## 状態

ユーザーの最新指示により、要件をユーザーと整理することを優先し、製品設計と実装を先行させない。上記の実装工程と構成案は保留する。コード・製品設計ファイルは未変更。新規の親・実装担当には Luna を明示指定し、設計に必要な場合は Sol を使用する。現在の親ランタイムにモデル変更 API は公開されておらず、設定が Luna に即時変更されたとは主張しない。

commit: 開始記録のみ committed、調査報告は commit_pending。
push: 初期 branch と Draft PR 公開済み。
CI wait: 未実施。機能の validation／review／実運用検証は未完了。
