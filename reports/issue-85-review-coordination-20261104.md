# Issue #85 レビュー継続の管理記録

## 対象と権限

- Issue: [#85](https://github.com/ssaattww/RemoteDesktopMCP/issues/85)
- PR: [#90](https://github.com/ssaattww/RemoteDesktopMCP/pull/90) （Draft、マージ対象外）
- branch: `task/shared-todo-subtasks`
- 再開時 HEAD: `8cb17c5cbc319df5edb3fecaa3173621981617a7`
- base: `7e16a666cc30af0f7f58816f38d5459c489a4fd0`
- 利用者依頼: 通常レビュー、指摘対応、別担当の独立レビューまで。Duck と並行する。
- 指定: 通常・独立レビュー `gpt-6.1-sol/high`、指摘対応 `gpt-6-luna/high`、設計修正が必要な場合 `gpt-6.1-sol/high`。
- 修正目安: 1000人の利用全体で月1回程度以上起こり得る不具合。頻度不明は断定せず、基準未満は保留記録。必須仕様・未実施受入は成功扱いにしない。
- 許可された書込み: 今回の作業用リポジトリ、対象の非mainブランチ、PR日本語コメント。マージ・配置は行わない。

## 実行環境と再開

- Windows FA780、PowerShell、Node.js 24.20.0。
- 作業場所: `C:/Users/donabe/Documents/Codex/2026-11-04/task-6/RemoteDesktopMCP`。
- 元の `C:/Users/donabe/RemoteDesktopWorkspace/RemoteDesktopMCP-subtasks` は同HEADで clean と確認し、読取り専用として維持。
- 元リポジトリから bundle を作り、書込み可能な今回のワークスペースへ clone した。元ツリーの権限・未コミット差分を変更していない。
- この実行ツリーで確認できる生存担当は親と今回起動した担当のみ。別チャットの担当一覧は取得できないため、公開前にリモートHEADを再確認し、通常のfast-forward pushのみ行う。
- 対象ツリーに `AGENTS.md` と `.agents/skills` はない。上位ディレクトリの確認でも該当指示は見つからなかった。必須Skill-first指示の欠落は開始時に利用者へ通知した。
- `ssaattww/CodexSkill` の最新mainから `development-orchestrator` と必要な子スキルを読み込んで実施。既存のレビュー前停止記録を履歴として保持し、TODO-HIER-05で今回の再開範囲を管理する。
- `verification_capability: local_execution_available`。依存lock一致を確認した既存node_modulesを再利用し、新規依存を導入しない。
- 検証結果は実行環境・ソース指紋・stdout/stderr・exit statusと結び付ける。commit、push、CI待ちは別状態として扱う。

## 分担とモデル証拠

- 通常レビュー: `/root/rdmcp85_normal_review`。fresh fork、モデル・effortを実際のspawn引数へ指定。
- 検証: `/root/rdmcp85_validation`、`gpt-6-luna/high`指定。fresh fork、製品コードは書かない。
- 指摘対応: `/root/rdmcp85_fixes`、`gpt-6-luna/high`をspawn引数で指定。通常レビュー3件に限定し、設計契約の変更が必要ならSol high担当へ戻す。公開API・入力保持のため自動選択はSol相当だが、今回の明示モデル指定を優先し差異を記録する。
- 再開: 待機操作がuser cancellationとして終了し旧担当が一覧から消えた後、親から同じIssueの再開指示を受領した。会話上は作業停止の明示指示なし。旧担当への継続連絡を試したが返答はなく、この作業のnode検証プロセスも存在しないことを読取り確認したため `/root/rdmcp85_fixes_resume` を同じLuna high指定で起動し、既存差分・未追跡ファイル・診断ログを引き継いだ。旧担当を速度理由で置換したものではない。
- 再開状態の訂正: 旧担当へのfollowupは遅れて反映された。後の一覧で旧担当と置換候補の両方がrunningと分かった時点で置換候補をinterruptし、旧担当へ一本化した。置換候補には以後の編集・検証停止と実施内容の返却を指示し、旧担当には現在差分への再同定を依頼した。担当一覧からの一時消失だけで旧担当消滅を断定しない。最終証拠は再開後の実際のソースに結び直す。
- レビュー担当は実装修正を行わない。通常レビューは同じ担当で修正確認し、独立レビューは別担当を起動する。
- 観測可能なspawn結果は担当IDのみのため、指定した値を実適用値として断定しない。`applied: null`、`application_status: spawn_succeeded_profile_unverified`、`profile_observability: final_profile_hidden`。
- 各レビューは単一担当。API・UI等は独立した確認経路を持つが、担当の継続性のため分割しない。`decomposability: independent_workstreams`、`decomposition_policy: forbidden`、`decomposition_disposition: prohibited_by_review_lifecycle`。

## 開始時の検証証拠

- 再開HEADのPR CI: [41349187431](https://github.com/ssaattww/RemoteDesktopMCP/actions/runs/41349187431)。コネクタで再読し、completed/success、UbuntuとWindowsを含む10ジョブ成功を確認。
- 以前の全体試験は287件中282成功・4失敗・1スキップ。限定再実行やCIの成功で、この失敗履歴を置き換えない。
- 今回の関連3ファイルは120/120成功。初回sandbox実行はNode.js `os.userInfo()` の `uv_os_get_passwd ENOMEM` で起動失敗し、同じコマンドの昇格再実行で成功した。初回失敗のstdout/stderrも保持。
- 今回の型検査、ビルド、lintは成功。詳細は `issue-85-review-validation-20261104.md`。
- 最終候補HEADの全体ゲートは通常レビュー収束後に実施する。未実施の受入、環境制約、失敗は明示し、完了扱いにしない。

## Skill-gap とフィードバック判断

- 記録起点: 親判断。今回の再開・隔離・サンドボックスとホストの違いを確認。
- 判断: `no skill action needed`。指定と実適用の区別、単一レビュー担当と独立レビュー、元作業ツリーの保持は既存スキルに含まれる。
- 重複グループ: 既存の委譲・実行環境証拠ルールの運用。新規FP追加・既存FP統合なし。
- Skill化状態: 新規Skill・Skill更新は不要。今回の製品Issueを跨ぐ変更を追加しない。
- 次アクション: 本記録と担当レポートをレビュー対象として永続化し、独立レビュー前にすべての通常変更をコミットする。
- 外部Issue作成: なし。既存ルールで扱えるため新しい改善Issueを作らない。active FP ledgerへの変更はない。
- 再開中の親判断追記: 担当一覧への復帰遅延による一時重複を検出し停止した。未知の実行結果を断定せず担当・ソース同一性を再確認する既存ルールの適用事項として記録し、新しいSkill変更・FP行・外部Issueは作成しない。次アクションは旧担当による現在ソースの検証と同一通常reviewerの再確認。この運用記録は独立レビュー前の通常コミットへ含める。
- 独立最終の予約・freeze・レビュー証拠保持・attestation・最終公開は `review-enforcer` が一つのライフサイクルとして所有する。

## 現在の状態

初回通常レビューはfail、R85-N01〜N03の3件（各medium/P2）を指摘対応担当へ渡した。[通常レビューPRコメント](https://github.com/ssaattww/RemoteDesktopMCP/pull/90#issuecomment-6615737501)は投稿後に読み戻した。3件の修正と関連試験・実HTTP/Edge描画の検証結果は [指摘対応報告](issue-85-review-fixes-20261104.md) に記録する。同一通常reviewerが前回のID・重要度・判定を保持して復帰し、固定修正HEADでの再確認を担当する。通常再確認、最終候補の全体ゲート、独立レビューの完了は本記録の作成時点では未確定であり、以後の対応報告とPRコメントを参照する。本記録はマージ許可を表さない。

1回目の修正コミットは `11d085740bd271d8fdbcc4105058ef1032b83a78`。[対応後コメント](https://github.com/ssaattww/RemoteDesktopMCP/pull/90#issuecomment-6616777406) を投稿・読み戻した。同一通常reviewerの [修正確認](issue-85-fix-verification-20261104.md) はN03 closed、N01/N02 partialでfail。元のID・medium/P2を保持し、二重の祖先展開とrevealされた生存行のfocus候補を残対応として同じ実装担当へ戻した。[再確認コメント](https://github.com/ssaattww/RemoteDesktopMCP/pull/90#issuecomment-6616911905) も投稿・読み戻した。失敗報告と追跡を `18c71be56125c007dbb1480149f3e04f87b0f139` に保存し、製品内容は変えずに2回目の対応を開始した。2回目の実装証拠は [残対応報告](issue-85-review-fixes-2-20261104.md) を参照する。
