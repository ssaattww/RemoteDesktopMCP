# 公開接続の検証記録

## 実行環境と対象

Windows / PowerShell、作業場所 `C:\Users\donabe\Project\RemoteDesktopMCP`。
2026年9月25日の作業開始時の HEAD は `8d72bb8dbc9464e03268bc5be39b72cb929f7e11`。以下の初期確認は、公開認証を実装中だった時点の履歴である。
前回の24件と CI 成功を今回の変更の検証結果として転用しない。

## 実環境の初期確認（2026年9月25日）

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

2026年9月25日の初期確認時には、文書作成者による意味・用語・読みやすさの確認と CLI の引数・動作の照合は作業中だった。以降の検証とレビューの結果は後続の節に記録する。
用語追加は利用者の exact 候補承認後に行った。`doc/remote-setup.md` と変更した要件文書の語彙確認は成功。
Markdown lint は48ファイル、指摘0件。これらは製品コードの合格や独立レビューを意味しない。

## 製品コードの検証

実装担当の型検査・コード lint と追加9試験は成功。親の `npm.cmd run build` も成功。
親の `npm.cmd audit --json` は追加した `jose` を含め脆弱性0件。
全体試験は32/33で、既存 NR003/NR004 の試験用実行コマンドが Windows の空白入りパスを引用せず失敗した。
試験担当は Windows の試験用起動を PATH 上の `node` と引用したファイル引数へ修正し、Desktop Commander 経由の当該試験成功を確認した。
修正後の全件確認は通常レビュー後の最終検証で行う。
上記は初回通常レビュー前の途中結果である。その後の通常レビューは9件の必須指摘で fail となり、修正を実施した。この時点では独立レビューは未実施だった。

## 通常指摘の修正後の確認

親担当が Windows / Node 24 で `npx.cmd tsx --test test/public-auth.test.ts test/private-storage.test.ts` を実行した。16件中15件成功、POSIX 専用1件スキップ、失敗0件、終了コード0、実行時間34946ms。公開認証14件と実 Windows ACL をまとめて確認した。
`npm.cmd run lint` も終了コード0。コード lint、Markdown 51ファイル、設計文書の用語検査が成功した。
対象は初回実装 HEAD `2e6ecefef8b0b2b4e0903565a7496b8050e5a443` からの修正差分であり、次の通常修正確認用コミットへ含める。全体 Node 22 gate と公開 ChatGPT 接続は未実施。

通常修正確認1の `a08343014ac8214e5efeb62156b46fceb5d81e13` では4項目の不足が残った。追加修正後、親が同じ公開認証と ACL のまとめ試験を完了まで待ち、終了コード0、18件中17件成功、POSIX 専用1件スキップ、失敗・中断0件、51961.5453msを確認した。既存秘密ファイルの起動前拒否、通常の親フォルダでの安全な設定作成、生の HTTP 応答の tool metadata と再認可情報、過剰要求の制限、秘密の非出力を追加確認している。

## 全体回帰で見つかった不足

全体検証1は42件中8件失敗、検証2の固定 HEAD `f4b2076d4d026c8710985c0a81f9c9c83617ad41` は40件成功・NR005の1件失敗・POSIX1件除外だった。詳細とログは `reports/2026-09-25-remote-full-gate.md` に保持する。
内容検索の直前の `get_config` 応答待ちを診断で特定し、Desktop Commander の未読 stderr を非保持で読み捨てる修正と、1MiB の出力を伴う試験を追加した。終了待ちの出力取得は REMOTE-NR-010 として修正した。
親の Node22 focused 実行で NR010、NR005、stderr容量の3件は成功。要求受信時間の追加試験は Accept ヘッダ不足による406で失敗し、試験のヘッダを修正して再確認している。この途中の失敗を製品側の成功証拠には含めない。

ヘッダ修正後、親が Node22.23.3 の公開 HTTP 試験を完走し、1件成功・失敗0件・終了コード0、45120.7298msを確認した。1秒ごとの少量送信も絶対15秒の受信期限で拒否し、受信済みの要求は15秒を超える処理でも成功応答を返す。`npm.cmd run lint`（Markdown53件）と `npm.cmd run build` も終了コード0。

| 対応 | 実装経路 | 組合せ試験と証拠 |
| --- | --- | --- |
| REMOTE-NR-010 / P2 | `src/index.ts` の `process_output` が終了待ちかつ実セッション生存中は `observe` を呼ばない | `test/independent-fixes.test.ts` の termination timeout fixture で status/output の未読取・所有者維持・消滅後の単一終了を確認。親 Node22 focused 成功。 |
| NR005 timeout の直接修正 | `DesktopCommander.start` が stderr を秘密の保存・出力なしで読み捨てる | `test/regressions.test.ts` の1MiB stderr fixtureと実 HTTP NR005が親 Node22 focused 成功。 |
| REMOTE-NR-006 の受信期限 | `createApp` の絶対受信期限を end/aborted/close で解除する | `test/public-auth.test.ts` の少量継続送信拒否と長処理成功を同じ実 HTTP 構成で確認。上記45120.7298msの実行で成功。 |

## 独立レビュー後の現在地（2026年9月25日）

固定 HEAD `96b10cd8b7026e73512de3c294f67894621709bf` の全体検証は43件中42件成功、POSIX 専用1件スキップ、失敗0件。全必須コマンドが成功した。詳細は [全体検証記録](2026-09-25-remote-full-gate.md) に保持している。
その後の文書更新を含む `3ffd783c3fc38b46b54ccbacb97075f8581de41e` を対象に独立レビューを行い、認証要求の制限1件と文書2件の必須指摘を得た。追加修正は再検証中であり、先の全体成功を追加修正の検証として転用しない。
公開サービスは起動済みで、公開 HTTPS の health、Google モード、resource/issuer、CIMD、未認証401を確認した。ChatGPT の実操作と再起動後の実 refresh は未確認である。

`RDMCP-REMOTE-IFR-002 / P3` に対し、冒頭の作業ツリーと文書確認の「作業中」は2026年9月25日の初期履歴だと明示した。初期失敗の記録と実 ChatGPT 接続の未確認状態は保持する。

| 独立指摘 / 元severity | 必須対応と経路 | 組合せと確認証拠 |
| --- | --- | --- |
| RDMCP-REMOTE-IFR-001 / P2 | `src/public-auth.ts` の `tokenAdmissionKey` / `consentAdmissionKey` と `src/index.ts` の対応 endpoint で、発行済みcode・署名済みrefresh・cookie付き同意を無効要求と別枠で制限する。状態の本検証と固定容量は維持する。 | port 0 の公開HTTP試験で、無効token要求11件後に正しいcodeとrefreshが200、無効同意11件後に正しい同意が303。担当のfocused試験1件成功・失敗0件、49,046.3432ms。全体検証は追加修正後に別途行う。 |
| RDMCP-REMOTE-IFR-002 / P3 | 本報告の冒頭と文書確認を2026年9月25日の初期履歴と明示する。 | 初期失敗、96bの全体成功、公開起動、実ChatGPT未確認を別の時点と証拠で照合。Markdown lint成功。 |
| RDMCP-REMOTE-IFR-003 / P3 | `remote-tests` 報告のstorage/contextリンクを同じディレクトリからの相対リンクへ修正する。 | 担当がreportsディレクトリ基準で両リンク先の存在を確認。Markdown lint成功。 |
