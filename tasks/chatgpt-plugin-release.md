# ChatGPT プラグイン配布の追加タスク

対象: PR #2。PR #1 のレビュー済み HEAD から分岐した配布変更です。
PR #1 の完了判定や `tasks-status.md` は更新しません。

| ID | 内容 | 状態 | 完了条件・証拠 |
| --- | --- | --- | --- |
| CP01 | 利用可能範囲と設定手順 | 実施済み | `doc/chatgpt-setup.md`。公開接続未実装を明示 |
| CP02 | テンプレートと接続 ID 入り ZIP | 実装済み | 専用 builder と13件のローカル試験 |
| CP03 | Actions artifacts と Release assets | 配線済み・実運用未確認 | release published の添付処理。実 Release の検証は未実施 |
| CP04 | GitHub への保存と PR | 別 PR へ提出 | GitHub コネクタ経由。変更対象は配布用ファイルのみ |
| CP05 | 通常・独立レビュー | 未実施 | 既存サーバーのレビュー結果をこの追加変更へ流用しない |
| CP06 | ChatGPT への導入と実接続 | 未実施 | F01〜F03、実アカウント、対象 PC の稼働と操作確認が必要 |

詳細な検証範囲と実行経路は `reports/2026-09-25-chatgpt-plugin-packaging.md` を参照します。
