# 公開接続の引継ぎ

## 対象と完了境界

ChatGPT からこの Windows PC を Google 認証で操作する。複数 PC は後続であり、画面・マウス操作の追加は今回の範囲外。
Google の本人登録は完了し、既存設定の内容を維持して Windows の保存領域保護を移行した。公開サービスは起動済み。ChatGPT 操作と再起動後の実認証更新はまだ確認していない。

## 保存と運用

秘密を含む `.env` は Git 管理対象外。認証状態は `C:\Users\donabe\RemoteDesktopMCP-data`、ファイル操作の許可範囲は `C:\Users\donabe\RemoteDesktopWorkspace`。設定と認証状態を消さずに再起動する。
Tailscale Funnel は公開 URL `https://fa780.tail8bf1af.ts.net` を loopback ポート3000へ転送する既存設定を利用する。
利用者向けの手順は `doc/remote-setup.md`。Google の秘密を ChatGPT に入力しない。

## 検証と残作業

通常レビューは `reports/2026-09-25-remote-normal-review.md`、試験対応表は `reports/2026-09-25-remote-tests.md`、全体検証は `reports/2026-09-25-remote-full-gate.md`。
`96b10cd8b7026e73512de3c294f67894621709bf` は通常コードレビューの必須指摘0件、Node 22 全体43件中42件成功・POSIX1件除外・失敗0件、全必須コマンド成功。公開サービスを起動し、公開 HTTPS の health、Google モード、resource/issuer、CIMD、未認証401を確認した。
起動時 PID は28532、ログは管理ディレクトリの `service.stdout.log` と `service.stderr.log`。今回の非表示プロセス起動は PC 再起動後の自動起動を設定するものではない。
利用者へ ChatGPT で `session_open`、`node_list`、`file_read` による `workspace` 内 `remote-connection-check.txt` の読取を依頼した。実操作の結果を得るまで接続完了とは扱わない。
独立初回は `3ffd783c3fc38b46b54ccbacb97075f8581de41e` に対し、認証要求の制限1件と文書2件の必須指摘で fail。追加修正 `c58352ddd860f3b113c08852bbb28d9946f2eed1` は Node22 全体43件中42件成功・POSIX1件除外・失敗0件、全必須コマンド成功。通常担当と同じ独立担当の限定解消確認、最終提出、同一提出 HEAD の CI はこの記録時点で未完了。最終判定と提出証拠は公開用独立レビュー報告および PR #1 で確認する。merge は行わない。

修正版の反映のため既存PID28532の停止と再起動をまとめて要求したが、自動承認レビューが実行前に拒否した。拒否理由の詳細は返されていない。実サービスは96bの版のままで、検証済みの修正版への再起動が必要である。秘密と本人登録状態は変更していない。起動手順は `doc/remote-setup.md` を参照する。

## 作業方法の振り返り

異なる作業には新しい担当を使い、同じ認証修正と同じ指摘の確認だけ担当を継続した。利用者の指定に従い設計・レビューは Sol high、実装は Terra high、機械的全体検証は Luna high とした。
今回の修正確認不足は、既存の `review-worker` が要求する実装経路と組合せ試験の対応を十分に確認できていなかった実行上の不足である。新しい Skill の追加ではなく、既存の必須条件を満たす対応表と実測結果へ修正した。製品固有の ACL と OAuth の欠陥は当該製品の指摘として扱う。
既存の兄弟 Skill リポジトリに今回の製品コードを混在させず、この作業での Skill ファイル更新は不要と判断した。別作業の既存 feedback 記録は変更していない。
