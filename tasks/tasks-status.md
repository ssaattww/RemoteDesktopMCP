# Task 一覧

更新規則: このファイルは `task-breakdown-planner`、`task-consistency-manager`、`progress-sync-manager` を通してのみ更新する。

## 現在の対象

PR #1 の指摘対応に続き、単一PCでローカル動作を確認できる最小版を作る。
公開運用を含む初期版全体とは区別する。詳細は `doc/design/functional-requirements.md` の段階分けを参照する。
設計 Sol / high、レビュー Sol / high、実装 Terra / high、機械的な確認 Luna / high。

| ID | Phase | 内容 | 依存 | 規模 | 完了条件 | 状態 |
| --- | --- | --- | --- | --- | --- | --- |
| T01 | P1 | PR #1 の RDMCP-DR-001〜003 の設計修正 | なし | M | 複製の hash、原子的な置換禁止、設定ファイル保護が文書間で一致 | 修正済み・レビュー待ち |
| T02 | P1 | skills のシンボリックリンクと task 一覧 | T01 | S | リンク経由で SKILL.md が読め、依存と完了条件を一覧化 | 完了 |
| T03 | P2 | 単一PCの認証、セッション、ノード、監査、設定 | T02 | M | loopback 限定、未認証拒否、セッション期限と所有者検証、未知ノード拒否 | 実装中 |
| T04 | P2 | Desktop Commander のファイル・プロセス操作への委譲 | T03 | L | 固定版で工具一覧を検証し、検索・読取・部分編集・起動・状態・出力・停止を確認 | 未着手 |
| T05 | P2 | MCP の双方向ファイル転送 | T04 | L | 7転送ツール、サイズと hash 検証、競合保護、中断・期限・清掃を確認 | 未着手 |
| T06 | P2 | 設定例・起動手順・回帰と結合テスト | T05 | M | 初回起動手順が実行可能、旧 download URL を廃止、3指摘の競合 fixture が合格 | 未着手 |
| T07 | P3 | 通常レビューと指摘修正 | T06 | M | Sol / high による必須観点レビューと修正確認、検証報告が揃う | 未着手 |
| T08 | P3 | 独立最終レビューと PR 更新 | T07 | M | 別 reviewer による確認、コミット、push、PR に証拠と未検証範囲を記載 | 未着手 |
| F01 | P4 | Google OIDC、CIMD、refresh token | T08 | L | 公開用認証設計と一致し、実アカウントとの接続を確認 | 後続 |
| F02 | P4 | ノード間相互認証・複数PC経路・再接続 | T08 | L | 登録2台以上、切断・世代交代・再送・転送中継の試験が合格 | 後続 |
| F03 | P4 | Tailscale Funnel と ChatGPT の公開接続検証 | F01,F02 | M | 実際の公開経路、メッセージ上限、再起動後の接続を確認 | 後続 |

S/M/L は相対的な作業規模であり、所要時間の保証ではない。
コードの結合が強いため T03〜T06 は同じ Terra 担当が依存順に実装する。
設計作業の既存レポート: `reports/2026-09-25-design-followup.md`。
環境確認: `reports/2026-09-25-environment.md`。
T01 の severity と finding ID は元レビューから変更しない。

## 検証状態

`local_execution_available`。実装検証、review-target commit、push、CI はそれぞれ別に記録する。
初回 `npm.cmd ci` は成功。コードの動作検証はこれから行う。
