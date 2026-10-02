# CI テスト実行時間短縮設計

## 状態
本書はPR42のPhase1実装前設計である。実装、workflow変更、CI測定は未実施。Phase1ではCIフィードバック時間を短縮するが、認証・認可、安全境界、MCP、filesystem、process、OS検証を削除しない。目標はCI wall time概ね3分程度で、達成は同一定義の実測で判定する。Phase2の重試験local分離は対象外。

## テスト集合とscheduler
入力集合Uは発見された全test対象ファイル集合とする。empty Uは失敗とし、未検出を成功扱いしない。shardは正整数。shard側のemptyは許容するが、実行結果へ記録する。

全shard集合について union=U、pairwise disjoint、exactly-once を保証する。

実行時はschedulerが決定したファイルpathだけをargvへ渡す。node --test --test-shardは使用しない。

scheduler出力artifactはdispatch入力として固定する。schemaはversion、sourceCommit、shardCount、generatedAt、assignmentsを必須とする。assignmentsはshardId、files、estimatedDurationMsを持つ。dispatchはartifactのfilesのみをargvへ渡す。

artifact生成時とdispatch入力時の両方でrepo相対path正規化、許可ディレクトリ・拡張子確認、重複確認、union=U確認を行う。検証失敗時は実行せず失敗終了とする。

optimized mode:
- duration降順、path昇順で並べる。
- 現在合計duration最小shardへ割当。
- 同値はshard番号昇順。

baseline mode:
- 正規化path昇順。
- index mod shard数で固定割当。

## manifest
manifestは最適化データ適用可否を判定する。sourceCommitは生成元情報であり、HEAD一致だけで判定しない。

fingerprint対象:
test、fixture、product source、lockfile、workflow、runner設定、OS、Node、dependency version。

hard fail:
- schema不正
- duplicate
- 許可されないpath
- 非有限値または0以下duration
- identity不足
- 未来timestamp

safe fallback:
- 30日超の古い測定
- fingerprint不一致
- manifest不足

fallbackではtestを省略しない。path拒否時はargvへ渡さず理由を記録する。

## measurement
専用measurement jobのみで測定する。全Uを各3回成功させることを完了条件とする。

measurement record artifactは1実行1レコードとする。必須項目:
- status: success、failure、timeout、cancel
- startedAt、finishedAt
- monotonicDurationMs
- commit
- workflow run/job id
- runner OS、Node、dependency version
- scheduler artifact version
- exit code

環境差異がある場合は同一条件比較対象外として記録し、別環境の結果を混在させない。failure、timeout、cancelのrecordは保持するが、最適化manifest更新には使用しない。

3回値のmedianを候補durationとする。成功3回、同一環境情報、証跡artifact保存を満たした場合のみmanifest更新候補となる。

## fixture隔離とTDD
fixture共有による並列実行影響を防止する。監査対象は以下とする。
- test配下fixture生成処理
- 一時ファイル生成先
- 環境変数変更処理
- process起動・終了管理
- filesystem共有状態
- global singletonまたはmodule state

回帰caseとして、同一fixtureを利用するtestの並列実行、fixture cleanup失敗、process残存、環境変数汚染、生成ファイル競合を検証対象にする。実装時はfixture境界、mutable state不存在、並列時期待結果、union/disjoint/exactly-onceを検証する。

## 固定finding履歴
独立reviewで確認された指摘を対応履歴として固定する。

|ID|Severity|対応節|検証|
|-|-|-|-|
|CI-REBUILD-001|Medium|テスト集合とscheduler|artifact schema、dispatch mapping、path validation|
|CI-REBUILD-002|Medium|measurement|record status、artifact、環境差異、証跡|
|CI-REBUILD-003|Low|fixture隔離とTDD|fixture監査範囲、回帰case|

## Phase2 gate
Phase2は別承認。CI必須検証を削除しない。移動対象、代替実行方法、失敗検知能力を記録し、Phase1測定結果と比較する。

## 要件対応表
|要件|対応|
|-|-|
|CI短縮|測定|
|全test維持|集合検証|
|empty契約|scheduler検証|
|path安全|拒否検証|
|manifest分類|hard fail/fallback検証|
|証跡|artifact確認|
|fixture隔離|TDD|
|Phase2分離|review|

## 未実施
実装、workflow変更、CI実測、manifest生成、lint実行、性能達成確認は未実施。
