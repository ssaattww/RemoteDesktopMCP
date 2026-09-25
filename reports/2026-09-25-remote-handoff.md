# 公開接続の引継ぎ

## 対象と完了境界

ChatGPT からこの Windows PC を Google 認証で操作する。複数 PC は後続であり、画面・マウス操作の追加は今回の範囲外。
Google の本人登録は完了し、既存設定の内容を維持して Windows の保存領域保護を移行した。公開 ChatGPT 操作と再起動後の実認証更新はまだ確認していない。

## 保存と運用

秘密を含む `.env` は Git 管理対象外。認証状態は `C:\Users\donabe\RemoteDesktopMCP-data`、ファイル操作の許可範囲は `C:\Users\donabe\RemoteDesktopWorkspace`。設定と認証状態を消さずに再起動する。
Tailscale Funnel は公開 URL `https://fa780.tail8bf1af.ts.net` を loopback ポート3000へ転送する既存設定を利用する。
利用者向けの手順は `doc/remote-setup.md`。Google の秘密を ChatGPT に入力しない。

## 検証と残作業

通常レビューは `reports/2026-09-25-remote-normal-review.md`、試験対応表は `reports/2026-09-25-remote-tests.md`、全体検証は `reports/2026-09-25-remote-full-gate.md`。
`3d676b89d0268c9d41f78251d7a351f232ad4f6f` の修正レビューと Node 22 全体検証を進めている。公開サービスを起動し、公開認証情報の応答と未認証拒否、ChatGPT で `session_open`、`node_list`、`file_read` を確認する。実操作の結果を得るまで接続完了とは扱わない。
独立レビュー、最終提出、同一提出 HEAD の CI は未完了。merge は行わない。

## 作業方法の振り返り

異なる作業には新しい担当を使い、同じ認証修正と同じ指摘の確認だけ担当を継続した。利用者の指定に従い設計・レビューは Sol high、実装は Terra high、機械的全体検証は Luna high とした。
今回の修正確認不足は、既存の `review-worker` が要求する実装経路と組合せ試験の対応を十分に確認できていなかった実行上の不足である。新しい Skill の追加ではなく、既存の必須条件を満たす対応表と実測結果へ修正した。製品固有の ACL と OAuth の欠陥は当該製品の指摘として扱う。
既存の兄弟 Skill リポジトリに今回の製品コードを混在させず、この作業での Skill ファイル更新は不要と判断した。別作業の既存 feedback 記録は変更していない。
