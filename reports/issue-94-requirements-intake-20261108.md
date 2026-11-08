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
| 設定の手間 | 通常利用のたびに token を再入力させない。PAT が revoke／expire した例外時は自動復旧できない場合があることを区別し、繰り返し催促せず、操作を停止して一度だけ理由と復旧方法を案内する |
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
| 発行・登録 | GitHub で本人が PAT を発行し、RDMCP の既存 `.env` に一度だけ設定する案。ChatGPT／MCP 引数／shell history に token を置かない | App registration と callback／認可フローの準備後、利用者本人が GitHub で認可するため、token 文字列を本人が RDMCP に直接入力しなくてよい。App は今回は採用しない |
| 利用者との紐付け | PAT は GitHub user account に属する。RDMCP アカウントと PAT 所有者を一対一で結び、credential をアカウント間で共有しない | user access token は認可した GitHub user の代理で動作し、権限・到達 resource は App と本人の共通範囲。RDMCP アカウントと GitHub user ID を一対一で対応させ、credential を分離する |
| 保管・ログ | `.env` は既存 ACL／mode で保護されるが、暗号化されず平文。PAT を子 process、admin config、log へ渡さない変更が必要 | App secret／token を key vault 等に置く必要がある。App は今回は採用しない |
| 期限・更新 | PAT に自動 refresh はない。通常利用の再入力を避けるため期限なし classic PAT を候補にするが、1年間未使用・revoke・policy block の例外は残る | 期限付き user access token は既定で 8 時間、refresh token は 6 か月。GitHub App は今回は採用しない |
| 失効 | 利用者が GitHub settings で revoke できる。revoke／expire 後の PAT は復活できず、新しい token が必要。通常利用では再入力を求めないが、例外時に再登録を完全にはなくせない | 利用者は GitHub アカウントから App 認可を取り消せる。GitHub App は今回は採用しない |
| 主な運用負担 | App registration が不要で立ち上げは単純だが、手動共有・更新・失効確認を利用者が担い、長期 secret の漏えい影響を管理する | 初期登録・認可・安全な client secret／refresh token 管理と更新処理が必要だが、GitHub user との帰属や期限付き更新を flow に組み込める |

公式資料では fine-grained PAT は user-owned Projects に対応しないとされる。これは API 対応制約の確認であり、トークン権限の細分化調査はユーザー指示により保留中。上表の期限値は GitHub.com 文書にある一般値であり、classic PAT による対象個人 Project #4 の認証・書込み成功を意味しない。

資料: [PAT の作成・管理](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)、[GitHub App のセキュリティベストプラクティス](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)、[user access token の発行](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)、[user token の更新](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)、[期限切れ・失効](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation)。

### 採用方針と具体案（実装・credential 設定は未承認）

- 認証方式は、利用者本人が GitHub で発行した個人 PAT を RDMCP に直接設定する。GitHub App は今回採用しない。RDMCP アカウントと GitHub user account は一対一で結び、credential を他アカウントと共有しない。将来の複数連携・アカウント切替の仕様や実装は今回決めない。
- 既存 `.env` は OS ACL／file mode で読取りを制限するが、secret は平文でディスクにある。期限なし classic PAT の保管先としては、ファイル ACL だけを安全策とする案を既定にしない。
- 保管方式の比較：Windows DPAPI の CurrentUser 保護は OS が鍵を管理し、アプリ独自の暗号鍵設定や追加 npm 依存を避けられる。対象ホストの同じ Windows 利用者でサービスを常時実行できる場合に適するが、プロファイル・アカウント・ホストの移行や破損では復号できず PAT の再登録が必要になる。Credential Manager も OS 管理だが、現行コードに連携がなく API／運用を新設する必要がある。Linux の Secret Service はログインセッション上の keyring に保管できる一方、headless／自動起動環境で D-Bus サービスや unlock が利用可能かを確認できていない。暗号化ファイルと鍵を同じ `.env` に置く案は、両方のファイルを取得された場合に復号され、今回の目的への改善が限定的である。
- 実用的な最小案は、運用先が現在の Windows PC であることを確認したうえで、PAT を DPAPI CurrentUser で暗号化した versioned blob として `DATA_DIR` 内に保存し、既存 `createPrivateFile`／private ACL と原子的なファイル更新を併用すること。復号権限を持つ Windows 利用者とサービスの実行主体を一致させる。DPAPI はファイル ACL の代替ではなく補完であり、同じ利用者権限で実行される悪意あるプロセスや管理者権限からは秘匿できない。RDMCP が Linux 等で稼働する場合は Secret Service が実際に利用可能かを確認するまで、平文 `.env` にフォールバックせず起動時に未対応として失敗させる案とする。
- PAT の登録入力には既存 `remote-auth-cli` を使う候補だが、現行 `ask()` は通常の readline で入力を隠さない。実装する場合は秘密入力を画面表示せず、PAT をコマンド引数・shell history・MCP 会話・ログに載せない経路を設ける。保管後は server process 内でのみ復号し、GitHub API の Authorization header にだけ使う。child process、admin `get_config`、audit／operation detail／error へ渡さない。実行中の同一プロセス侵害に対する秘匿は保証しない。
- PAT は server process 内だけで復号し、GitHub API の Authorization header に限って渡す。PAT を環境変数に置かず、`src/index.ts` の admin `get_config` に保存情報を出さない。API body、Authorization header、PAT を audit／operation detail／error に残さず、既存の固定 error code を用いる。既存 child environment filter は Google client secret 等を除外するが、PAT 保管・復号機能は未実装。
- 一対一対応は PAT 登録時の GitHub user ID を検証して記録する案。GitHub `GET /user` の owner check は Project #4 の read/write 権限検証とは別。今回の初期運用対象は一 account のみとし、複数利用者用 UI・mapping・切替を追加しない。
- 401 が返ったら GitHub Projects 操作を止め、繰り返し retry/prompt しない。credential を自動削除・自動更新せず、一度だけ利用停止と原因を知らせる。403 は権限または org policy による拒否の可能性を示し、token 再設定を促さない。PAT の失効・期限切れ後に GitHub が復活を許さないため、例外時の再発行は利用者が明示的に再開を選んだ場合だけ案内する。
- 外部設定は GitHub で本人が PAT を一度発行し、実装時に承認された安全な登録手順で保管すること。期限なしの classic PAT が選べ、利用元の組織ポリシーにも反しない場合は、通常の期限切れ再入力を避ける運用候補。ただし classic PAT は fine-grained PAT より広く、GitHub は本人がアクセスできる repository を広く扱えると注意している。実際の範囲は付与 scope にも依存するが、必要 scope の選定は権限粒度調査の保留対象であり、今回は確定しない。fine-grained PAT は personal Project #4 を含む user-owned Projects に使えないという現行資料上の制約がある。classic PAT の広い access を許容できるかは残る協議事項。
- 期限なし PAT でも放置すれば無期限に有効とは限らない。GitHub は PAT を1年間未使用の場合に自動削除する。通常の Projects 操作を使う間は token 使用が継続する想定だが、長期間 RDMCP を使わなかった後の再開では新 token が必要になる可能性を残す。
- 組織リソースについて、組織 owner は classic／fine-grained 両 PAT を拒否できる。fine-grained PAT は管理者承認必須にもでき、期限ポリシーに合わない token はその組織への API 呼出し時に拒否され得る。これらは organization resource へのアクセス制限であり、個人 Project #4 の利用可否とは分けて扱う。将来 organization Project を対象にするときは、organization／enterprise policy・SSO・承認状態の確認が必要。
- credential 発行・設定・継続利用・権限変更は操作時の個別確認を得る。

上記の DPAPI／Secret Service 案、非表示入力、PAT env support、GitHub ID owner check、secret exclusion、401/403 分類はいずれも未実装。Windows 運用先であること、サービス実行主体と DPAPI profile の一致、再起動・バックアップ復元・アカウント移行時の動作、Linux の secret store 可用性は未検証である。通常利用で token の再入力を求めない方針は確定したが、PAT の失効後または DPAPI 鍵を利用できなくなった後に再入力なしで復活できると約束することはできない。PAT が期限切れまたは revoke された場合 GitHub は復活を許さず、新しい PAT が必要と明記している。よって「例外時も絶対再設定なし」と「PAT 直設定」は両立しない。

## 根拠資料

- [Projects API ガイド](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects)
- [GraphQL Projects schema](https://docs.github.com/en/graphql/reference/projects)
- [REST Projects](https://docs.github.com/en/rest/projects/projects)
- [REST Project views](https://docs.github.com/en/rest/projects/views)
- [PAT の作成・管理と user-owned Projects の制約](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [PAT 期限切れ・失効](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation)
- [組織の PAT policy](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization)
- [Windows DPAPI による保護と復旧制約](https://learn.microsoft.com/en-us/windows/uwp/security/data-protection)
- [Windows ProtectedData／DPAPI の platform・profile 依存](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata?view=netframework-4.7.2)
- [freedesktop Secret Service API と login-session / unlock の前提](https://specifications.freedesktop.org/secret-service/latest-single/)

## 追加確定事項（最新要件）

- Project の削除、公開／非公開の切替、メンバーの追加・削除、アクセス権の変更は人間のみが行い、RDMCP の公開ツールに含めない。
- 上記操作をツール一覧の素直さだけに依存させず、サーバー側の許可操作を限定する。広い GitHub 権限が必要になる場合も、任意 GitHub API／コマンドをツールとして公開しない。
- 「ユーザーと決める事項」3の削除・公開設定・アクセス管理は未決定ではなく、上記のとおり除外と確定した。通常メタデータの編集、作成・複製、close／reopen は未決定。
- トークン権限の粒度や細分化を調査する作業はユーザー指示で保留した。したがって、ログイン／認証方式の実現可能性は一般の Projects API 操作があることまでを文書で確認した状態であり、このリポジトリのログイン環境・対象個人 Project #4 に対する書込みは未検証。credential の作成・設定・権限変更は行っていない。
- 先の API 機能調査は一般的な読取調査に限られ、新たなトークン権限粒度の調査は実施しない。これを実証済みのログインとは扱わない。
