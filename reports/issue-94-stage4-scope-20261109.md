# 課題 #94 第4段の作業範囲

## 目的

課題 #94 に残る項目操作とプロジェクトの案内文編集を、専用MCP経路に追加する。第3段の変更を土台にした子プルリクエストで進める。

## 対象

- プロジェクト内の下書き項目の作成・編集・課題への変換。
- 項目の保管と復元、項目をプロジェクトから取り除く操作。
- プロジェクトの案内文の取得・通常編集。
- 既存の固定GraphQL操作、プロジェクトと項目の所属確認、更新結果の読み戻しを再利用する。

項目の除去は、紐づく課題やプルリクエスト本体の削除とは別の操作として実装する。本体の内容編集は対象外。

## 境界

プロジェクト自体の削除、公開・非公開の変更、参加者の構成やアクセス権の変更、任意のGraphQL呼び出しやコマンド実行は公開しない。実認証情報の作成・設定・権限変更、および実プロジェクトへの書き込み試験も行わない。

## API仕様の確認

GitHub公式のGraphQL API定義には、`addProjectV2DraftIssue`、`updateProjectV2DraftIssue`、`convertProjectV2DraftIssueItemToIssue`、`archiveProjectV2Item`、`unarchiveProjectV2Item`、`deleteProjectV2Item` と `updateProjectV2` が掲載されている。`updateProjectV2` の入力には案内文と、別途人間に限定する公開状態・終了状態が同居するため、実装では案内文だけを引数として公開し、人間専用の値をツール入力へ渡せない形にする。

参照: [GitHub GraphQL APIの公式定義](https://docs.github.com/en/graphql/reference/projects)

## 検証境界

ローカルの型検査・自動テストで確認できる範囲を検証する。実GitHub接続、認証情報の利用、実プロジェクト上の変更は未検証として扱う。
