# Phase 一覧

更新規則: このファイルは `task-breakdown-planner`、`task-consistency-manager`、`progress-sync-manager` を通してのみ更新する。

| Phase | 内容 | 対象 | 完了条件 | 状態 |
| --- | --- | --- | --- | --- |
| P1 | 指摘修正と実装前準備 | T01,T02 | 3設計修正、skills リンク、task 一覧 | 設計レビュー合格・準備完了 |
| P2 | 単一PCの最小動作版 | T03〜T06a | 設定と起動、認証、委譲、転送の回帰・結合試験と依存監査を確認 | 完了 |
| P3 | レビューと提出 | T07,T07a〜T07e,T08,T08a〜T08d | 通常・独立レビュー、ローカル検証、PR 更新 | 通常工程完了。最終独立判定・提出は独立レビュー報告と PR #1 を参照 |
| P4 | 単一 PC の公開接続、後続の複数PC | F01〜F04 | 先に Google 認証・Funnel・ChatGPT から1台への実接続と公開用レビューを確認。複数PCはその後 | 実 Google 本人登録・公開起動・通常レビュー・全体検証済み。ChatGPT実操作未確認。独立指摘3件をF01dで修正・全体検証成功、解消確認待ち |
| P5 | Issue #24 Windows CI実行時間の改善 | R24-01〜R24-06 | 必須テスト集合・各ケースの意味・実Commander/ACL/隔離/cleanupを保ち、設計レビュー、TDD実装、通常レビュー、両OS CI、比較可能な実測で所要時間の変化を確認。約3分目標を実測し未達ならIssueを閉じない | R24-03のPR #63は3分未達。R24-04のPR #64のCI3回と測定72/72完了。測定時に別PR #52/#54が並行したとの報告があるためrepo-wide非並行・因果効果は認定しない。R24-05のPR #66は5分割・manifest適用後CI3回を完了。候補`3b5f24565dec2fcf21f92ac22286ab8e913efecb`のrun `37176081921`は全success/applied、主指標267/266/276秒、最大Windows Test step174/183/176秒。3分目標未達。R24-06のPR #68は未適用CI3回（run `37181068931`）と単独Windows Node22測定（run `37181912085`、72/72 success、24 files×3）を完了し、検証済みcandidate manifestを登録。次はローカル全検証と新HEAD適用後CI3回。採用閾値の判定とIssue完了は保留。PR #62は除外。 |

現在の位置: P1〜P3の最小動作版とP4公開接続工程を記録済み。P5のR24-03〜R24-05は記録済みだが3分目標未達。R24-04では別PR #52/#54並行の報告があるため因果効果は認定しない。R24-05最終候補`3b5f245`のrun `37176081921`は3 attempts全success/applied、主指標267/266/276秒、Windows Test step174/183/176秒。PR #66はdraft/open/unmerged。R24-06設計レビューと通常レビューは通過、実装PR #68はdraft/open/unmerged。未適用候補HEAD `d434163103d72a2bd3631344641ee083606bd11f`のrun `37181068931`は3 attempts全successし、全24 tracked test filesを8 shardで網羅。単独測定run `37181912085`はWindows Node22で72/72 success、24 files×3、artifactとmanifest中央値を検証。検証reportは`reports/issue-24-r24-06-measurement-validation-37181912085-20261004071445.md`、candidate manifestを`.github/test-duration-manifest.json`へ登録済み。現在はローカル全検証、その後の新HEADでapplied確認とrequired CI×3が残る。閾値判定・採用およびIssue完了は保留。PR #62を含めず、マージなし。
最小動作版の独立判定と提出証拠は `reports/2026-09-25-independent-review.md` と PR #1 を参照する。
公開用の通常指摘は `reports/2026-09-25-remote-normal-review.md` で追跡し、ChatGPT の実操作と公開用の独立レビューは未完了。複数PCの F02 は後続であり、単一 PC 接続の完了条件には含めない。
