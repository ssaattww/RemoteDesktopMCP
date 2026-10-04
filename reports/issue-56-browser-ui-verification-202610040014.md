# Issue #56 実ブラウザUI確認

## 実行条件

- 対象コードSHA: `7938d9d0c63bea221b7de4f4db69dcef61c9ec4f`。本確認中にtracked source/testは変更していない。
- 実ブラウザ: Chromium `151.0.7922.173`（Linux）をPuppeteer `25.12.0`からheadlessで起動した。
- 起動対象: `createApp`をloopback一時ポートで起動し、`RemoteDesktopService`へテスト専用session/user/パスワードハッシュをseedしたfixture。dataDirは一時ディレクトリに作成して保護し、service auditを保存したうえで`todo.updated`の一度だけ故意に失敗させた。製品の本番認証設定は変更していない。
- 競合経路: 実際のMCP SDK `Client` / `McpServer`を`InMemoryTransport`で接続し、ブラウザが表示している版番号からTodoを先に更新。続けて古いブラウザフォームを送信した。
- 依存追加・Desktop Commander起動・実ネットワーク接続は行っていない。既存のChromium、Puppeteer、MCP SDKのみを使用した。

## 確認結果

| 操作/表示 | 結果 | 確認内容 |
| --- | --- | --- |
| 詳細ページ上部配置 | pass | 実DOM座標はTodo panel top=75px、session metadata top=469px。画像上でも作業一覧が「セッションの内容」より上に表示される。 |
| 強制OFF / ON | pass | ブラウザの切替ボタンを順に押し、表示が無効・有効へ反映されることを確認。 |
| Todo追加 | pass | フォーム追加後、サーバー応答の再描画と作業項目を確認。 |
| 項目編集 / 状態変更 | pass | 文字列を置換し状態を「進行中」に変更、再描画後の入力値・select値を確認。 |
| 項目削除 | pass | 削除フォーム送信後、Todo行が0件になることを確認。 |
| MCP同時更新との競合 | pass | MCP更新後に古いブラウザ版のフォームを送信。競合案内が表示され、MCP更新は維持、古いフォームの内容は追加されない。 |
| 監査警告 | pass | `todo.updated`監査を一度だけ故意に失敗。作業更新自体は反映され、利用者向け警告と適用済み内容の両方が表示された。 |

最終fixture状態はTodo version 6、3項目（競合前の作業、MCP同時更新項目、監査警告でも適用済み）、enforcement enabled=true。操作はすべて通過した。

## 目視したPNG

- [Todo編集/進行状態と詳細上部配置](issue56-ui-evidence/todo-panel-edit-and-status.png)
- [強制OFF状態](issue56-ui-evidence/todo-enforcement-off.png)
- [古いフォームの競合通知とMCP更新保持](issue56-ui-evidence/todo-conflict-notice.png)
- [監査警告と適用済み内容](issue56-ui-evidence/todo-audit-warning.png)

4枚ともChromiumから保存後、画像を開いて目視確認した。表示崩れ、通知欠落、配置順の問題を認めなかった。

## Desktop Commander timeoutの保証範囲

Issue #56設計が要求する製品契約は、停止要求がtimeoutして成否不明なら`termination_unconfirmed=true`と`applied:"unknown"`を返し、自動再送しないこと、所有者に限った状態確認と2秒経過後の再要求を許すこと。実Desktop CommanderやOS子プロセスを使ったネットワーク障害実証は設計文書の受け入れ条件として定めていない。

既存`test/issue-56-shared-todo.test.ts`の契約fixtureは、MCP SDK in-memory client/serverに短いtimeoutを設定し、SDK自身が生成したRequestTimeout code `-32001`をprocess killのDesktop Commander call境界へ注入する。その上でtimeout応答、適用結果不明、監査警告、dispatch一回のみを本番wrapper経由で確認する。これはSDK timeoutのcodeとRDMCP側wrapperの意味論を保証するが、Desktop Commanderの外部transportが実環境で同じerror codeへ写像すること、または本物の子プロセスがtimeout後に停止したかは保証しない。後者は環境依存の未検証リスクとして残る。

## 制約

この確認はsafe fixtureを使った実Chromium UI実行であり、利用者の本番ブラウザ、実認証設定、実Desktop Commander子プロセスを検証したものではない。通常のHTTP integration testの結果を実ブラウザ確認へ読み替えていない。
