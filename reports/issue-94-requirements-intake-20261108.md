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
| 初期利用者と将来拡張 | 当初は GitHub アカウント1つで利用できればよい。将来複数利用者になることを妨げず、credential と利用者の対応付けを可能にする。初期版の複数アカウント切替は要求しない |
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
5. 初期は GitHub アカウント1つでよい。将来の複数利用者に備えた credential と利用者の対応付けは必要だが、初期版で複数アカウントを切り替える UI／操作は不要。RDMCP 利用者の範囲と隔離水準は未決定。
6. 「PC 操作をしない」の保証対象はこの専用接続か、dot の他の PC 接続も含むか。サーバー内部の監査保存や secret 保護の I/O と任意操作を区別する。
7. 認証方式、credential 保管、権限・失効、監査の保持と表示、既存 Emergency Stop と Todo の扱い。これらの構成採用は要件整理後に行う。トークン権限の細分化調査はユーザー指示により保留する。

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
- ユーザーは PAT 手動設定と GitHub App 認証を比較し、登録、安全な保管、ログ等への非露出、失効／更新、RDMCP 利用者との紐付けを要件として整理するよう追加した。以下の比較は公式資料からの事実と設計上の含意であり、認証方式の選定ではない。
- 初期は GitHub アカウント1つで利用できればよく、将来の複数利用者に備えた対応付けを可能にする。初期版の複数アカウント切替は要求しない。GitHub App で利用者が token を直接入力せず認可できる利点は検討対象だが、方式は未決定。
- GitHub Issue #94 本文には、branch／PR を作らず実装中として扱わないとする古い記述が残る。後のユーザー承認を受けて branch と Draft PR #95 は作成・正式紐付け済みである。Issue 本文の更新は自動審査で拒否され、リモート本文は未変更。現在の会話方針と合意内容に沿って Issue 本文を更新するかは未処理とする。
- 要件メモのローカル変更は commit `8c05712` に含まれる。push は HTTPS 接続不可で未完了。新 credential、認証設定、権限拡張、製品設計・コードの変更は行っていない。

## 認証候補の要件比較（方式未決定）

| 観点 | PAT を手動登録 | GitHub App の user access token |
| --- | --- | --- |
| 発行・登録 | 利用者が GitHub の設定画面で発行し、RDMCP へ安全に登録する必要がある。入力・貼付け経路で token を履歴、clipboard、例外、監査ログへ残さない要件がある | App registration と callback／認可フローの準備後、利用者本人が GitHub で認可するため、token 文字列を本人が RDMCP に直接入力しなくてよい。server-side confidential client の client secret と token は引き続き安全に扱う必要がある |
| 利用者との紐付け | PAT は GitHub user account に属する。RDMCP 内でも token 所有者と RDMCP principal の対応を登録し、将来複数利用者を扱う場合は credential・cache・監査を分離する必要がある | user access token は認可した GitHub user の代理で動作し、権限・到達 resource は App と本人の共通範囲。RDMCP principal と GitHub user ID を明示して対応させる。初期は1 account でよいが将来複数の対応を阻害しない |
| 保管・ログ | GitHub は PAT を秘密として管理するよう案内する。RDMCP の永続 secret store、暗号化、最小読み取り主体、redaction、バックアップ・削除方針は未決定 | GitHub は private key／client secret／token を安全に保管し、サーバーなら key vault 等を推奨する。access token と refresh token の分離保管も考慮事項。RDMCP の保管基盤は未決定 |
| 期限・更新 | PAT は利用者が設定する期限まで継続する種類があり、期限切れ・失効時は利用者が再発行し、RDMCP に再登録する運用候補 | 期限付き user access token は既定で 8 時間、refresh token は 6 か月。refresh は新しい access／refresh token を返し、使用済み refresh token と旧 access token は無効になる。保管と更新の競合、refresh token expiry 後の再認可が必要 |
| 失効 | 利用者が GitHub の PAT settings から削除できる。RDMCP は認証失敗を検出して使用を停止し、利用者に再登録を求める必要がある | 利用者は GitHub アカウントから App 認可を取り消せる。App は revoke webhook を受けた本人分の API 呼出しを停止し、401 でも停止・再認可へ誘導する必要がある |
| 主な運用負担 | App registration が不要で立ち上げは単純だが、手動共有・更新・失効確認を利用者が担い、長期 secret の漏えい影響を管理する | 初期登録・認可・安全な client secret／refresh token 管理と更新処理が必要だが、GitHub user との帰属や期限付き更新を flow に組み込める |

公式資料は fine-grained PAT の Projects 対応可否や権限粒度の比較には使っていない。ユーザー指示により、その調査は保留する。上表の期限値は GitHub.com 文書にある一般値であり、対象個人 Project #4 の認証・書込み成功を意味しない。

資料: [PAT の作成・管理](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)、[GitHub App のセキュリティベストプラクティス](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)、[user access token の発行](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)、[user token の更新](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)、[期限切れ・失効](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation)。

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
