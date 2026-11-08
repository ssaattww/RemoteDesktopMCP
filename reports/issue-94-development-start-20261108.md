# Issue #94 開発開始記録

## 対象と権限

- Issue: <https://github.com/ssaattww/RemoteDesktopMCP/issues/94>
- branch: codex/issue-94-github-projects
- base: main、45d73947dc7f2e56546eb3c2e6c028ff1cc54759
- ユーザーは専用 branch、Draft PR、Issue との紐付け、開発開始を承認した。
- 本記録は Draft PR を先に作成して正式に紐付けるための開始記録であり、機能の実装ではない。

## 範囲

GitHub Projects v2 の Project・項目・フィールド・Status・Priority・Issue／PR 参照を、任意の PC 操作を公開しない専用 MCP 操作として読み書きする。読み取りだけへの縮小は行わない。対応 API と未対応機能を明示する。

## 制約

新規 credential、既存 credential の継続利用設定、権限拡張、実運用設定変更、配備、merge は行わない。Duck #50 と他担当の checkout・プロセスに干渉せず、同時作業数制約を確認する。開発用の独立した checkout を用いる。

## 開始時点

- Issue #94 は open、Project #4 RDMCP に Backlog として登録済み。
- 直接重複なし。#58／PR #59 は Project と labels の同期で別機能。
- development-orchestrator と必要な子 Skill を適用する。CodexSkill の local と remote main はともに 8ee6e9f80a0362a4d066c4ea39fd3e87002fc829。
- repository root に AGENTS.md が見当たらないことは通知済み。既存 Skill とユーザー指示を用い、実装前に規則を再確認する。
- Draft PR 作成後に Issue・branch・PR の対応を読み戻し、task／phase と設計を更新してからコード変更へ進む。
- 実装、試験、review、CI は未実施。
