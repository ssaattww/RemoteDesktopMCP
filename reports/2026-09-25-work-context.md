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

コード側の契約が強く結合するため、T03〜T06 の製品実装は1人の Terra 担当が依存順に進める。
通常レビュー担当は先に固定コミットの設計だけを確認する。
CI の既知コマンド配線は Luna 担当が `.github/workflows/lint.yml` だけを変更する。
これらは書込み対象が重ならず、レビュー開始待ちと CI 設定待ちを短縮できるため並行する。

## 検証と報告

依存関係は `npm.cmd ci` で導入済み。実装後は lint、型検査、build、動作テスト、差分検査を実行する。
ローカルの固定したソースに対する検証を通常レビューへ渡す。GitHub の別 SHA の CI を代用しない。
ソースは対象リポジトリだけを変更する。skills のリンク先にある別プロジェクトの feedback 記録は変更しない。
既存の active feedback は IbisDuck 固有の指示であり、このプロジェクトのモデル指定を上書きしない。
今回のモデル指定はユーザーが明示済みである。

## 通常レビュー後の進め方

`4eee364` に対する通常レビューで、元の DR-003 と NR-001〜006 を修正対象とした。
DR-001/002 は実装の一部を確認できたが、不足していた競合・失敗試験を追加するまで閉じない。
今回は既存の公開 MCP API が固定されているため、コード修正と回帰試験を独立した担当へ分割する。
コード修正担当は `src` と設定、回帰試験担当は `test` だけを変更する。両担当とも利用者指定の Terra / high。
親担当が task と証拠を統合し、同じ Sol / high の通常 reviewer へ戻す。

Node22の初回失敗ログと更新後の全依存監査結果は `reference/validation/node22-initial/` に保存した。
これは無視対象のローカル証拠であり、コミットやCI成功の証拠として置き換えない。

任意のCLI単体検証のPowerShell一括起動・強制終了・清掃は自動ポリシーにより実行前に拒否された。
理由の詳細は返されず、該当する試験プロセスやファイルは作られていない。
また、reviewer の作業フォルダ外の一時試験ディレクトリの再帰削除も拒否された。
`C:\Users\donabe\AppData\Local\Temp\rdmcp-review-tYaCBl` は削除せず保持する。
既存の実ユーザー設定ではなく、その試験だけのデータである。以後の試験は作業フォルダ内で行う。

初回の GitHub CLI 読取りは認証未設定で失敗したため、GitHub connector の結果を使用した。
通常の Git リモート読取りは成功している。push の成否は実行時に別途記録する。

## Skill 改善の判断

現時点で今回の製品変更に必要な Skill 改修はない。指定済みの自走・モデル分担は既存の優先順位で扱える。
設計固有の競合処理は製品テストで追跡する。別プロジェクトの未処理 feedback を本作業で完了扱いにしない。

## OS ごとの検証経路

Windows は `local_execution_available`。Node 22.23.3 で直接検証する。
NR-007 は Ubuntu で Windows 専用の試験コマンドが使われる問題であり、Linux 側の実行証拠も必要とする。
読み取りによる環境確認では、WSL の実行可能なディストリビューションと Docker は見つからなかった。
そのため Linux のみ `remote_ci_only` として、修正候補を push して一致する PR CI を通常レビューの解消確認に用いる。
これは Windows のローカル検証を置き換えない。独立レビュー後の最終 HEAD の PR CI は別途確認する。

## 停止試験の設計確認

追加の停止試験では、無出力の子プロセスが4.5秒で終了する一方、起動要求は最大10秒待っていた。
そのため停止要求を送る前に対象が終了している場合があり、通常の停止拒否とタイムアウトを混同していた。
既存の設計担当を Sol / high のまま再利用し、固定版 Desktop Commander の実装を読み取ってこの原因を確認した。
通信接続そのものの故障は確定しておらず、接続再起動の回避策は採用しない。
セッション専用の停止 API、起動待ち中の終了判定、生存中を確認する試験を使い、再検証する。
同担当は製品コードを変更していない。独立最終 reviewer には別の新規担当を割り当てる。
