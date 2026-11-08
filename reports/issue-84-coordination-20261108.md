# Issue #84 再開・統合記録

## 対象と実行環境

- Issue: <https://github.com/ssaattww/RemoteDesktopMCP/issues/84>
- 作業場所: `C:\Users\donabe\Documents\Codex\RemoteDesktopMCP`
- 作業ブランチ: `feat/84-todo-history`。開始時の本流・追跡先と同じ HEAD は `ecc512b9112ec58590e6accfb10210a53b66cc6b`。開始時点の対応 PR はなし。
- 実行主体は最初 `fa780\codexsandboxoffline` だったため停止。利用者のフルアクセス変更後、`whoami` が `fa780\donabe` であることを再確認して再開した。RDMCP、別ユーザーの起動、権限設定変更は行っていない。
- ローカル実行可能。Windows / PowerShell、Node `v24.20.0`、npm `11.19.0`。公開 CI の Node 22 との環境差は残る。
- 開始時の未追跡 `.agents/` を保護。リポジトリ直下に `AGENTS.md` は存在せず、その点を利用者に通知した。

## スキルと参照元

`C:\Users\donabe\Documents\Codex\CodexSkill` は main、変更なし、取得後の `HEAD...origin/main` は左右とも 0。既存 `.agents\skills` は `..\..\CodexSkill\skills` を指すシンボリックリンクで、新しく作り直していない。`development-orchestrator` と `restart-handover-manager` のファイル存在と内容を確認し、再開手順を適用した。自動のスキル一覧には両者が表示されていないため、一覧への登録成功とは扱わない。

旧設計は `C:\Users\donabe\Documents\Codex\2026-11-07\task-3\RemoteDesktopMCP-issue84-local\doc\design\shared-todo-update-history.md` を読み取り専用の参照元として保持。SHA256 は `A831E7BD0689907C5D6834FF424014C971BF8B851FAF323C7981F25BF853CD6A`。旧レビューは同じ日付の `task-3\issue-84-design-review.md`。新しい設計・実装を現行作業場所に作る。

旧参照 checkout の `git status` は、CodexSandboxOffline 所有に対する Git の dubious ownership 判定で拒否された。安全例外登録、所有権変更、再試行による迂回は行っていない。参照ファイルの読み取りは可能であり、現行フォルダの実装には影響しない。

## 開発・検証方針

既存共有 Todo 設計のテスト駆動開発方針に従う。依存未配置による初回エラーは環境失敗として保持し、正式な実装前の失敗試験と区別する。依存は既存 lockfile から導入し、依存定義を変更しない。

実装・関連試験は一人の実装担当、通常レビューは別の担当が行う。並列に変更すると設計・保存・画面の依存が重なるため実装を分割しない。通常レビュー後の全体検証と、独立レビュー・公開・CI の完了状態は別々に扱う。詳細は実装報告とレビュー報告に記録する。

## スキル改善・残作業

現時点の判断は `no skill action needed`。通常ユーザーでの再確認、既存リンクの検査、拒否された旧 checkout を変更しない対応は既存手順で処理できた。今回の機能仕様は製品の設計に記録し、共通スキルには追加しない。共有のフィードバック台帳にある他プロジェクトの記録は変更しない。追加の再発問題を発見した場合は、独立レビュー前に再評価する。

実装・検証・レビュー・コミット・公開・CI は進行中。独立レビューと PR が完了するまでは Issue 完了とは扱わず、マージは行わない。

## 実装前の PR 作成条件

実装開始後に親から、利用者ルールとして「実装前にブランチ・PR を作成し、Issue と紐付ける」条件が共有された。開始時点ではブランチのみ存在し、PR はなかった。追加実装を停止するよう担当に指示し、すでに生じた実装・試験差分を保護した。

今回の準備コミットは設計・計画・本記録だけを含め、未検証の製品・試験差分を含めない。利用者ルールを優先し、通常の実装完了後の PR 手順に先立って Draft PR を用意する。本文に Issue #84 を明示し、PR の正式リンクとブランチを確認してから実装を再開する。機能の実装・検証・レビューが完了したとは表示しない。
