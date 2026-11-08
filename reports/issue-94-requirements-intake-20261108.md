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
| 認証・認可 | 読み取りと更新を区別し、それとは別に GitHub の認証方式・実権限を確認する |
| 根拠 | 現行 API の対応範囲、未対応、既存 RDMCP との重複・共通基盤を調べ、未確定事項を確定扱いしない |
| 開発手順 | implementation 前に Issue・branch・PR を正式に紐付け、development-orchestrator を入口にする |
| 最新の順序 | ユーザーと要件をまとめることを優先し、製品設計・実装を先行させない |
| 他作業 | Duck #50／#53 と既存担当の checkout・プロセスに干渉しない。並行作業数制約を守る |

## 具体化が必要な機能範囲

これは欠落を防ぐ確認表であり、実装対象を確定した設計表ではない。

| 領域 | 要件として確認する内容 |
| --- | --- |
| Project 本体 | 一覧・詳細・説明編集に加え、作成・複製・close／reopen・削除・公開範囲まで初期範囲に含めるか |
| 項目 | Issue／PR の登録・除去、draft 作成・編集・Issue 化、archive／復元、並び順 |
| フィールド | 値の読み書きだけでなく、schema 作成・編集・削除、選択肢・iteration の管理を含める範囲 |
| Status／Priority | 実際の Project の型と選択肢を使う。Priority 値と項目の並び順は別概念 |
| Issue／PR 関係 | Project への登録と参照に加え、元の Issue／PR の本文・labels・assignees・milestone・関連付け自体も変更するか |
| views | table／board／roadmap、表示列、filter、sort、group 等の取得・保存を求める範囲 |
| その他 | 自動化、status updates、アクセス管理、template、insights／charts、親子 Issue の扱い |

UI のすべてが API から同じように操作できるとは未検証。API 非対応時は未対応と理由を示し、任意 PC 操作や画面操作へ自動的に迂回しないことを要求候補として確認する。

## ユーザーと決める事項

1. 「同等」の対象は GitHub を正本にする操作経路か、RDMCP 内の独立した Project 管理まで含むか。現時点は前者を有力候補としているが確定しない。
2. 初期の対象は既存の個人 Project #4「RDMCP」だけか、他の個人／organization Project にも広げるか。
3. 通常の編集、削除・公開化、アクセス権変更で、操作可能範囲と確認方法をどう分けるか。
4. Issue／PR 本体の変更、views、自動化、可視化等を含めた到達範囲と段階。段階導入であっても最終目的を読み取り専用へ縮めない。
5. 利用者は現在の本人1名か。複数利用者へのデータ・credential 隔離をどこまで要求するか。
6. 「PC 操作をしない」の保証対象はこの専用接続か、dot の他の PC 接続も含むか。サーバー内部の監査保存や secret 保護の I/O と任意操作を区別する。
7. 認証方式、credential 保管、権限・失効、監査の保持と表示、既存 Emergency Stop と Todo の扱い。これらの構成採用は要件整理後に行う。

## 調査済みの事実

- Issue 42件・PR 51件の重複検索で直接一致は見つからなかった。#58／PR #59 は Project と labels の同期、#56／#85／#84 は RDMCP セッションの Todo で異なる。
- 現 main の起動では Desktop Commander が必須。Projects 専用経路の安全境界を成立させるには、単なるツール追加以上の検討が必要。
- 現行 GraphQL Projects schema に Project・item・field・view 等の query／mutation がある。REST にも organization 向けの Projects v2 API がある。個人 Project への対応と credential の組合せは別途実証が必要。
- 以上は資料・コードの読取調査。実 GitHub API で製品機能の write/read-back は行っていない。

## 承認と未実施

branch と Draft PR の作成、Issue の正式リンクは完了した。今後の順序は要件整理→合意した要件の設計→実装・検証とする。

認証設定変更、新規 credential、既存 credential の継続利用設定、権限拡張、新規依存、配備、merge は行っていない。製品コード・製品設計書・テストコードは未変更。機能試験・build・通常／独立レビューは未実施。

新しく起動する親・実装担当は Luna を明示する指示。設計には必要に応じ Sol を使う。既存の intake 担当は指示前に gpt-6.1-sol high を要求して起動済みであり、途中でモデルが変更されたとは扱わない。その後ユーザーから「親のモデルを更新しました」と連絡があった。ローカルの config.toml は gpt-6.1-sol / medium のままだが、チャットの実効モデルの証明には使えないため、実際の適用モデルは未検証として記録する。

## 根拠資料

- [Projects API ガイド](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects)
- [GraphQL Projects schema](https://docs.github.com/en/graphql/reference/projects)
- [REST Projects](https://docs.github.com/en/rest/projects/projects)
- [REST Project views](https://docs.github.com/en/rest/projects/views)

## 追加確定事項（最新要件）

- Project の削除、公開／非公開の切替、メンバーの追加・削除、アクセス権の変更は人間のみが行い、RDMCP の公開ツールに含めない。
- 上記操作をツール一覧の素直さだけに依存させず、サーバー側の許可操作を限定する。広い GitHub 権限が必要になる場合も、任意 GitHub API／コマンドをツールとして公開しない。
- 前述「ユーザーと決める事項」3の削除・公開設定・アクセス管理は未決定ではなく、上記のとおり除外と確定した。通常メタデータの編集、作成・複製、close/reopen は未決定。
- トークン権限の粒度や細分化を調査する作業はユーザー指示で保留した。したがって、ログイン／認証方式の実現可能性は一般の Projects API 操作があることまでを文書で確認した状態であり、このリポジトリのログイン環境・対象個人 Project #4 に対する書込みは未検証。credential の作成・設定・権限変更は行っていない。
- 先の API 機能調査は一般的な読取調査に限られ、新たなトークン権限粒度の調査は実施しない。これを実証済みのログインとは扱わない。
