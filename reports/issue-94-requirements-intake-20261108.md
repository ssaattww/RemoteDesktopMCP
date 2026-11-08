# Issue #94 要件整理

## 作成状況

- Issue: <https://github.com/ssaattww/RemoteDesktopMCP/issues/94>
- branch: codex/issue-94-github-projects
- Draft PR: <https://github.com/ssaattww/RemoteDesktopMCP/pull/95>
- base: main、45d73947dc7f2e56546eb3c2e6c028ff1cc54759
- GitHub の closingIssuesReferences に #94 が含まれることを読み戻した。
- Project: <https://github.com/users/ssaattww/projects/4>、登録済み。読戻し時は In progress、Priority 未設定。この作業から状態更新は送信していない。

## 確認済みの要求

| 項目 | 要求 |
| --- | --- |
| 目的 | dot が任意に PC を操作することなく、RDMCP の明示的な専用ツールを通して GitHub Projects を扱う |
| 到達範囲 | GitHub Projects と同等の機能を目指す。読み取りだけ、または Status 更新だけに勝手に縮めない |
| 基本操作 | Project、項目、フィールド、Status、Priority、Issue／PR 参照の読み書きを扱う |
| 安全境界 | 任意コマンド実行をこの機能の操作インターフェースにしない。PC 操作ツールを一覧から隠すだけでは呼出し禁止の保証にならない |
| 人間専用操作 | Project 削除、公開／非公開の切替、メンバー追加・削除、アクセス権変更を RDMCP の公開ツールに含めない。サーバー側でも許可操作を制限し、任意 API／コマンドを公開しない |
| 認証・認可 | 読み取りと更新を区別し、それとは別に GitHub の認証方式・実権限を確認する |
| アカウント対応 | 初期は GitHub アカウント1つで利用する。RDMCP アカウントと GitHub アカウントを一対一に対応させ、credential を他利用者と共有しない。複数連携の仕様・実装は今回決めず、先行しない |
| 根拠 | 現行 API の対応範囲、未対応、既存 RDMCP との重複・共通基盤を調べ、未確定事項を確定扱いしない |
| 開発手順 | implementation 前に Issue・branch・PR を正式に紐付け、development-orchestrator を入口にする |
| 最新の順序 | ユーザーと要件をまとめることを優先し、製品設計・実装を先行させない |
| 他作業 | Duck #50／#53 と既存担当の checkout・プロセスに干渉しない。並行作業数制約を守る |

## 具体化が必要な機能範囲

これは欠落を防ぐ確認表であり、実装対象を確定した設計表ではない。

| 領域 | 要件として確認する内容 |
| --- | --- |
| Project 本体 | Project 削除・公開範囲変更は人間専用と確定。作成・複製・close／reopen・通常のメタデータ編集は未決定 |
| 項目 | Issue／PR の登録・除去、draft 作成・編集・Issue 化、archive／復元、並び順 |
| フィールド | 値の読み書きだけでなく、schema 作成・編集・削除、選択肢・iteration の管理を含める範囲 |
| Status／Priority | 実際の Project の型と選択肢を使う。Priority 値と項目の並び順は別概念 |
| Issue／PR 関係 | Project への登録と参照に加え、元の Issue／PR の本文・labels・assignees・milestone・関連付け自体も変更するか |
| views | table／board／roadmap、表示列、filter、sort、group 等の取得・保存を求める範囲 |
| その他 | 自動化、status updates、template、insights／charts、親子 Issue の扱い。メンバー／アクセス権管理は人間専用と確定 |

UI のすべてが API から同じように操作できるとは未検証。API 非対応時は未対応と理由を示し、任意 PC 操作や画面操作へ自動的に迂回しないことを要求候補として確認する。

## ユーザーと決める事項

1. 「同等」の対象は GitHub を正本にする操作経路か、RDMCP 内の独立した Project 管理まで含むか。現時点は前者を有力候補としているが確定しない。
2. 初期の対象は既存の個人 Project #4「RDMCP」だけか、他の個人／organization Project にも広げるか。
3. 削除・公開設定・メンバー／アクセス権管理は人間専用。通常メタデータ編集、作成・複製、close／reopen を含めるか。
4. Issue／PR 本体の変更、views、自動化、可視化等を含めた到達範囲と段階。段階導入であっても最終目的を読み取り専用へ縮めない。
5. RDMCP アカウントと GitHub アカウントは一対一に対応させる。初期は GitHub アカウント1つでよい。複数連携・アカウント切替の仕様は今回は決めず、先行実装しない。credential はアカウント間で分離する。
6. 「PC 操作をしない」の保証対象はこの専用接続か、dot の他の PC 接続も含むか。サーバー内部の監査保存や secret 保護の I/O と任意操作を区別する。
7. PAT の安全な登録・保管・更新・失効、監査の保持と表示、既存 Emergency Stop と Todo の扱い。PAT の subtype と必要な GitHub 権限は細分化調査の保留が解除されるまで未決定。

## 調査済みの事実

- Issue 42件・PR 51件の重複検索で直接一致は見つからなかった。#58／PR #59 は Project と labels の同期、#56／#85／#84 は RDMCP セッションの Todo で異なる。
- 現 main の起動では Desktop Commander が必須。Projects 専用経路の安全境界を成立させるには、単なるツール追加以上の検討が必要。
- 現行 GraphQL Projects schema に Project・item・field・view 等の query／mutation がある。REST にも organization 向けの Projects v2 API がある。個人 Project への対応と credential の組合せは別途実証が必要。
- 以上は資料・コードの読取調査。実 GitHub API で製品機能の write/read-back は行っていない。

## 承認と未実施

branch と Draft PR の作成、Issue の正式リンクは完了した。今後の順序は要件整理→合意した要件の設計→実装・検証とする。

認証設定変更、新規 credential、既存 credential の継続利用設定、権限拡張、新規依存、配備、merge は行っていない。製品コード・製品設計書・テストコードは未変更。機能試験・build・通常／独立レビューは未実施。

新しく起動する親・実装担当は Luna を明示する指示。設計には必要に応じ Sol を使う。既存の intake 担当は指示前に gpt-6.1-sol high を要求して起動済みであり、途中でモデルが変更されたとは扱わない。その後ユーザーから「親のモデルを更新しました」と連絡があった。ローカルの config.toml は gpt-6.1-sol / medium のままだが、チャットの実効モデルの証明には使えないため、実際の適用モデルは未検証として記録する。

## 最新の会話方針と記録差分

- ユーザーの「RDMCP の方進めませんか」は、製品設計・実装を先行する指示ではなく、未確定要件を音声で一緒に詰める意図と確認された。次は要件の選択肢をユーザーと確認し、合意まで設計・実装を保留する。
- トークン権限の細分化調査は保留。一般 API 操作の存在と、実際の認証・対象個人 Project #4 での read/write 検証を区別する。
- ユーザーは PAT 手動設定と GitHub App 認証の比較後、しばらく本人一人が利用する前提で PAT を直接設定する方式を明示決定した。以下の比較は方式選定の根拠を残すもので、GitHub App は現時点で採用しない。
- 初期は GitHub アカウント1つで利用する。RDMCP アカウントと GitHub アカウントを一対一で結び、credential をアカウント間で分離する。複数連携は今回決めず、先行実装・仕様化しない。
- GitHub Issue #94 本文には、branch／PR を作らず実装中として扱わないとする古い記述が残る。後のユーザー承認を受けて branch と Draft PR #95 は作成・正式紐付け済みである。Issue 本文の更新は自動審査で拒否され、リモート本文は未変更。現在の会話方針と合意内容に沿って Issue 本文を更新するかは未処理とする。
- 要件メモのローカル変更は commit `8c05712` に含まれる。push は HTTPS 接続不可で未完了。新 credential、認証設定、権限拡張、製品設計・コードの変更は行っていない。

## 認証候補の要件比較（PAT を採用）

| 観点 | PAT を手動登録 | GitHub App の user access token |
| --- | --- | --- |
| 発行・登録 | 利用者が GitHub の設定画面で発行し、RDMCP へ安全に登録する必要がある。入力・貼付け経路で token を履歴、clipboard、例外、監査ログへ残さない要件がある | App registration と callback／認可フローの準備後、利用者本人が GitHub で認可するため、token 文字列を本人が RDMCP に直接入力しなくてよい。server-side confidential client の client secret と token は引き続き安全に扱う必要がある |
| 利用者との紐付け | PAT は GitHub user account に属する。RDMCP アカウントと PAT 所有者を一対一で結び、credential をアカウント間で共有しない | user access token は認可した GitHub user の代理で動作し、権限・到達 resource は App と本人の共通範囲。RDMCP アカウントと GitHub user ID を一対一で対応させ、credential を分離する |
| 保管・ログ | PAT は RDMCP の認証済み設定経路から登録し、アカウント ID ごとに暗号化保管する案。secret／UI／HTTP logging の具体策は下記に記録 | GitHub は private key／client secret／token の安全な保管を推奨。App user token は今回は採用しない |
| 期限・更新 | PAT に期限を設定し、期限前の利用者主導の再発行・安全な再登録を要件とする。期限値や更新時期は未決定 | 期限付き user access token は既定で 8 時間、refresh token は 6 か月。GitHub App は今回は採用しない |
| 失効 | 利用者が GitHub の PAT settings から削除できる。RDMCP は認証失敗を検出して使用を停止し、利用者に再登録を求める必要がある | 利用者は GitHub アカウントから App 認可を取り消せる。App は revoke webhook を受けた本人分の API 呼出しを停止し、401 でも停止・再認可へ誘導する必要がある |
| 主な運用負担 | App registration が不要で立ち上げは単純だが、手動共有・更新・失効確認を利用者が担い、長期 secret の漏えい影響を管理する | 初期登録・認可・安全な client secret／refresh token 管理と更新処理が必要だが、GitHub user との帰属や期限付き更新を flow に組み込める |

公式資料は fine-grained PAT の Projects 対応可否や権限粒度の比較には使っていない。ユーザー指示により、その調査は保留する。上表の期限値は GitHub.com 文書にある一般値であり、対象個人 Project #4 の認証・書込み成功を意味しない。

資料: [PAT の作成・管理](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)、[GitHub App のセキュリティベストプラクティス](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)、[user access token の発行](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)、[user token の更新](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)、[期限切れ・失効](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation)。

### 採用方針と具体案（実装・credential 設定は未承認）

- 認証方式は、利用者本人が GitHub で発行した個人 PAT を RDMCP に直接設定する。GitHub App は今回採用しない。RDMCP アカウントと GitHub user account は一対一で結び、credential を他アカウントと共有しない。将来の複数連携・アカウント切替の仕様や実装は今回決めない。
- token の登録場所は ChatGPT／MCP 会話・tool 引数ではなく、RDMCP の認証済み HTTPS 設定画面とする案。画面では password 入力を使い、TLS・認証・CSRF 検証を行う。token を URL、browser storage、画面再表示、response、通常 log、監査、例外、HTTP debug に含めず、登録 request body も記録しない。UI は browser の password 保存を要求しないが、browser 側の保存挙動は完全には制御できないため、token を会話・clipboard・履歴へ残さず安全な入力経路を使う案を確認する。GitHub の `GET /user` で token 所有者を確認して RDMCP アカウントへ一対一で固定する。Project #4 の read/write 権限試験とは分ける。
- PAT はサーバー側のみで扱い、GitHub API の Authorization header にだけ渡す。at-rest は AES-256-GCM で暗号化した credential record とし、暗号鍵は `DATA_DIR` 外のサービス secret store に分離する。既存の `src/private-storage.ts` はファイル ACL／mode と private directory を検査するが、暗号化までは行わないため、DATA_DIR の保護だけを encrypted vault とみなさない。Node 標準 `crypto` を使えば暗号ライブラリ追加は不要。token は子 process・Desktop Commander に渡さず、必要時のみ server memory で復号し、再起動時にも暗号文と別置き鍵から復旧する。鍵の形式・rotation は実装時に検証する。
- token は password manager がフォームを保存しないよう設定し、貼付け履歴や clipboard へ残る可能性は利用者へ説明する。登録成功後は token を再表示せず、監査には RDMCP account ID、GitHub user ID、設定・削除操作、結果、固定 error code のみを記録する。request/response body と Authorization header は既存の監査／operation detail 経路へ送らない。
- 再設定では新 token を server memory で一時検証し、既存の GitHub user ID と一致する場合だけ暗号文を原子的に置換する。認証失敗・429 等で新 token が検証できない場合は既存値を保持し、値を echo しない。削除では保存済み暗号文を消し、memory reference を破棄して以降の API 呼出しを停止する。GitHub 側で PAT を revoke した場合も 401 を検出して自動再試行・別 credential への fallback をせず、利用者に再設定を求める。
- 外部設定は GitHub で本人が PAT を発行し、有効期限を設定すること、RDMCP 運用者が暗号化鍵を `DATA_DIR` 外の secret store に安全に登録すること。token subtype と Projects に必要な権限範囲は、権限粒度調査の保留が解除されるまで選ばない。credential 発行・設定・継続利用・権限変更は操作時の個別確認を得る。

上記は本人の認証方式決定に沿った実装提案であり、設定画面・保存形式の最終設計または実装承認ではない。Project #4 での PAT による read/write は未検証のため、token 設定前に権限粒度調査の再開と検証範囲の確認が必要。PAT の一般的な期限設定・失効動作の根拠は上記 GitHub 公式資料に限る。

## 根拠資料

- [Projects API ガイド](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects)
- [GraphQL Projects schema](https://docs.github.com/en/graphql/reference/projects)
- [REST Projects](https://docs.github.com/en/rest/projects/projects)
- [REST Project views](https://docs.github.com/en/rest/projects/views)

## 追加確定事項（最新要件）

- Project の削除、公開／非公開の切替、メンバーの追加・削除、アクセス権の変更は人間のみが行い、RDMCP の公開ツールに含めない。
- 上記操作をツール一覧の素直さだけに依存させず、サーバー側の許可操作を限定する。広い GitHub 権限が必要になる場合も、任意 GitHub API／コマンドをツールとして公開しない。
- 「ユーザーと決める事項」3の削除・公開設定・アクセス管理は未決定ではなく、上記のとおり除外と確定した。通常メタデータの編集、作成・複製、close／reopen は未決定。
- トークン権限の粒度や細分化を調査する作業はユーザー指示で保留した。したがって、ログイン／認証方式の実現可能性は一般の Projects API 操作があることまでを文書で確認した状態であり、このリポジトリのログイン環境・対象個人 Project #4 に対する書込みは未検証。credential の作成・設定・権限変更は行っていない。
- 先の API 機能調査は一般的な読取調査に限られ、新たなトークン権限粒度の調査は実施しない。これを実証済みのログインとは扱わない。
