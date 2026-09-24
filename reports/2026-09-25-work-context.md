# 作業の前提と進め方

## 対象

- Repository: `ssaattww/RemoteDesktopMCP`
- PR: <https://github.com/ssaattww/RemoteDesktopMCP/pull/1>
- Branch: `feat/tailscale-funnel-design-lint`
- 開始 HEAD: `83a3de32314edfbcd314f18936b083ac5b1dca9a`
- 実行環境: Windows / PowerShell / `C:\Users\donabe\Project\RemoteDesktopMCP`
- 検証経路: `local_execution_available`
- 開始時の作業ツリー: clean。利用者の未コミット変更はなかった。
- PR の最新コメントから RDMCP-DR-001 / High、RDMCP-DR-002 / Medium、RDMCP-DR-003 / Medium を対象とした。

## 利用者の指定

指摘修正、task 一覧作成、skills のリンク作成を先に行い、その後実装する。
「再試の右舷」は「最小限」の誤変換と仮定した。今回の到達点は単一PCのローカル動作版とする。
複数PCや公開接続まで完了したとは扱わない。

設計とレビューは Sol / high、実装は Terra / high、機械的な確認は Luna / high。
利用可能なモデル識別子から Sol は `gpt-6-sol`、Terra は `gpt-5.6-terra`、Luna は `gpt-6-luna` を使用する。
各呼出しは新しい限定コンテキストを使い、指定を spawn 引数で渡す。
ツールには役割による別モデルへの切替設定がなく、公開されたモデル引数を使用する。
最終的な実行モデルの内部情報は公開されないため、`applied: null`、`spawn_succeeded_profile_unverified` と記録する。

## Skills と権限

`skills` は `..\CodexSkill\skills` へのディレクトリのシンボリックリンクである。
リンク経由で `implementation-executor/SKILL.md` を読み取れることを確認した。
兄弟リポジトリは clean かつ追跡元より1コミット遅れていたため、追跡ブランチへ fast-forward した。
Skill source: `7f99fc4`。対象リポジトリには AGENTS.md がないことを利用者へ通知した。
TDD を必須とするプロジェクト規則はない。実装と対応する競合・認証・結合テストを作成し、結果を記録する。

既存の PR を更新対象とし、コミット・push・CI・レビューを別の状態として記録する。
マージ、公開サービスの有効化、実アカウント設定の変更は今回の作業に含めない。
環境確認と設計修正は書込み対象が独立しているため並行する。実装の分割は設計確定後に判断する。

## 検証と報告

依存関係は `npm.cmd ci` で導入済み。実装後は lint、型検査、build、動作テスト、差分検査を実行する。
ローカルの固定したソースに対する検証を通常レビューへ渡す。GitHub の別 SHA の CI を代用しない。
ソースは対象リポジトリだけを変更する。skills のリンク先にある別プロジェクトの feedback 記録は変更しない。
既存の active feedback は IbisDuck 固有の指示であり、このプロジェクトのモデル指定を上書きしない。
今回のモデル指定はユーザーが明示済みである。

初回の GitHub CLI 読取りは認証未設定で失敗したため、GitHub connector の結果を使用した。
通常の Git リモート読取りは成功している。push の成否は実行時に別途記録する。

## Skill 改善の判断

現時点で今回の製品変更に必要な Skill 改修はない。指定済みの自走・モデル分担は既存の優先順位で扱える。
設計固有の競合処理は製品テストで追跡する。別プロジェクトの未処理 feedback を本作業で完了扱いにしない。
