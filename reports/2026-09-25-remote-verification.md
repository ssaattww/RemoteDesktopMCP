# 公開接続の検証記録

## 実行環境と対象

Windows / PowerShell、作業場所 `C:\Users\donabe\Project\RemoteDesktopMCP`。
開始 HEAD は `8d72bb8dbc9464e03268bc5be39b72cb929f7e11`。現在は公開認証を実装中の作業ツリー。
前回の24件と CI 成功を今回の変更の検証結果として転用しない。

## 実環境の確認

- Tailscale は接続中で、この PC の公開転送先は loopback port 3000。
- 調査時点では port 3000 の待受なし、`.env` なし。
- Google OAuth クライアントはユーザー回答により未作成。
- ChatGPT の固定 CIMD 文書を HTTPS で取得し、公開クライアント方式 `none`、固定戻り先、更新トークン方式を確認。
- 実ユーザーの Google 認証、ChatGPT からの MCP 操作、公開経路を通す転送、再起動後の実接続は未検証。

その後、利用者が Google クライアントを作成し、ローカル JSON を利用して設定した。
Google の実認証を通す本人登録 CLI は、認証 URL の表示を追加した修正後に成功した（終了コード0）。
許可1人、更新トークン0件、認証 state の広い共有主体への ACL 許可0件を確認した。
これは実 Google の本人確認とローカル登録の証拠であり、ChatGPT 接続・公開 MCP 操作・再起動後の実 refresh は引き続き未確認。

## 文書の確認

`doc/remote-setup.md` は新規のため旧本文なし。Google の作成手順、ローカル本人登録、起動、ChatGPT への登録、障害時の確認を記載した。
認証用の秘密を ChatGPT へ入力する案内と、公開の初回ログインを自動承認する案内は含めていない。
`doc/design/functional-requirements.md` は利用者の追加要求に合わせ、単一 PC の公開を複数 PC より先に進める順序へ変更した。
task と作業前提、設計・実装・試験の各報告は新しいスコープとして作成し、旧独立判定を変更していない。

文書作成者による意味・用語・読みやすさの確認は作業中。CLI の引数と実際の動作を照合してから確定する。
用語追加は利用者の exact 候補承認後に行った。`doc/remote-setup.md` と変更した要件文書の語彙確認は成功。
Markdown lint は48ファイル、指摘0件。これらは製品コードの合格や独立レビューを意味しない。

## 製品コードの検証

実装担当の型検査・コード lint と追加9試験は成功。親の `npm.cmd run build` も成功。
親の `npm.cmd audit --json` は追加した `jose` を含め脆弱性0件。
全体試験は32/33で、既存 NR003/NR004 の試験用実行コマンドが Windows の空白入りパスを引用せず失敗した。
試験担当は Windows の試験用起動を PATH 上の `node` と引用したファイル引数へ修正し、Desktop Commander 経由の当該試験成功を確認した。
修正後の全件確認は通常レビュー後の最終検証で行う。
上記は初回通常レビュー前の途中結果である。その後の通常レビューは9件の必須指摘で fail となり、修正を実施した。独立レビューは未実施。

## 通常指摘の修正後の確認

親担当が Windows / Node 24 で `npx.cmd tsx --test test/public-auth.test.ts test/private-storage.test.ts` を実行した。16件中15件成功、POSIX 専用1件スキップ、失敗0件、終了コード0、実行時間34946ms。公開認証14件と実 Windows ACL をまとめて確認した。
`npm.cmd run lint` も終了コード0。コード lint、Markdown 51ファイル、設計文書の用語検査が成功した。
対象は初回実装 HEAD `2e6ecefef8b0b2b4e0903565a7496b8050e5a443` からの修正差分であり、次の通常修正確認用コミットへ含める。全体 Node 22 gate と公開 ChatGPT 接続は未実施。
