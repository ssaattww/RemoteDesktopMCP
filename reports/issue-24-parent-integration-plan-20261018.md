# 親 PR の統合手順

更新日: 2026-10-18

この文書は、Issue #24 の完了条件と性能評価結果を変更せず、親 PR と子 PR の依存関係を記録する。PR 本文および Issue 本文の更新内容の根拠として使う。

## 現在の状態

- 最新 `main`: `b393ffce508f5daaa93bb051de495dd04b21a02f`。
- Issue #77 と #81 は open。#77 の作業 PR は #76。#81 は因果的性能比較の残作業で、現時点で対応 PR はない。
- Issue #78、#79、#80 は `completed` で closed。
- PR #76 は open、base `main`、head `issue-24-r24-02-post-split-main`、HEAD `de0c0295e5158a230b10984f7d6b9b9527ab27d0`。
- PR #62 は open/draft、base `issue-24-ci-phase1`、head `issue-24-runtime-reduction-followup`、HEAD `48013a76839523dafc52997ac33b4fa6350f5cde`。PR #42 は closed。

## ブランチと PR の順序

1. 最新 `main` から `issue-24-parent-integration` を作り、この Issue #24 統合計画を親ブランチへ置く。空変更や無関係な変更は使わない。
2. このブランチを `main` 向け Draft 親 PR とする。親 PR の本文には `Closes #24` と `Closes #77` を記載する。
3. PR #76 の head を変えず、base のみ `main` から `issue-24-parent-integration` へ移す。変更前後で PR の head SHA が維持され、意図しない差分追加・欠落がないことを確認する。
4. #81 の実装・因果的比較は未完了のまま解決扱いにしない。後続 PR は `issue-24-parent-integration` を base とし、結果と採否判断を記録する。
5. #78～80 は完了済みとして参照だけを残す。再 close や追加 PR は行わない。

PR #76 は非既定ブランチを base とするため、そこにある `Closes #77` だけでは #77 の自動 close を期待できない。親 PR にも `Closes #77` を置き、親 PR が最終的に `main` へ入る時点で #77 を解決する。親 PR は #77 と #81 の残作業が完了し、Issue #24 の既存完了条件を確認するまで Draft のままにする。既存追跡表の R24-10 に記載された主指標3回すべて180秒以内という条件を維持する。

## 旧 PR #62 の扱い

PR #62 は古い実装の参照として保持する。base を変更せず、close や rebase を行わない。

PR #62 の旧 `test/regressions.test.ts` 差分にあった DR002 と NR009 の fixture 初期化省略は、PR #76 の main 向け差分では、それぞれ `test/config-transfer-integrity.test.ts` と `test/session-filesystem-lifecycle.test.ts` に移されていることを比較で確認した。現 main 側では旧 `test/regressions.test.ts` が削除されている。PR #62 のそれ以外の固有差分・残差分は全件の移植照合をしておらず、未確認として扱う。

## 比較証跡

| 比較 | 結果 | merge base |
| --- | --- | --- |
| `main` `b393ffce508f5daaa93bb051de495dd04b21a02f` … `issue-24-ci-phase1` `adb4e03cbd11bb47ef90d34a840e2ce6922dc572` | diverged、ahead 17 / behind 9 | `c0c786a3d696724d780291aed9c8b89cbe2d531e` |
| `main` `b393ffce508f5daaa93bb051de495dd04b21a02f` … PR #62 HEAD `48013a76839523dafc52997ac33b4fa6350f5cde` | diverged、ahead 23 / behind 9 | `c0c786a3d696724d780291aed9c8b89cbe2d531e` |
| `main` `b393ffce508f5daaa93bb051de495dd04b21a02f` … PR #76 HEAD `de0c0295e5158a230b10984f7d6b9b9527ab27d0` | diverged、ahead 32 / behind 2 | `5dac2528e80cba3e3ff5c855f14420075b2da717` |
| `main` `b393ffce508f5daaa93bb051de495dd04b21a02f` … 旧 `issue-24-main-integration` `93cd8e19a6df040e34f5e083ab32249211b164ee` | diverged、ahead 54 / behind 5 | `8d9c77a49d342e15f7ce63802d3a1550eb158930` |

旧統合ブランチはいずれも current `main` と分岐しているため再利用しない。親 PR の base は `main` とし、head は新しい `issue-24-parent-integration` とする。

## 自動クローズ対象

Closes #24

Closes #77
