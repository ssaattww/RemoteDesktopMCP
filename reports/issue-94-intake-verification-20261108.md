# Issue #94 着手前確認

## タスク

- 目的: 正式な紐付け後の要件・作業境界・実装前設計と既存構成を独立確認する。
- 種類: intake verification / architecture investigation

## sub-agentを使う理由

- codex-delegation-executor の固定委譲カテゴリに従う。

## 対象範囲

- Issue #94、Draft PR #95、専用 clone、既存認証・MCP・監査・停止・設計・追跡規則。

## 対象外

- コード変更、credential／権限設定、Duck・他担当作業、実 API 書込、依存導入、merge。

## Dispatch profile

- selection inputs: intake verification, judgment_heavy, high uncertainty, cross_system, high criticality, single repetition, sequential_dependencies, fresh context.
- selection source: sub-agent-task-manager / agent-profile-selection.md。公開 API と認可設計のため Sol high。
- decomposition: allowed; sequential dependency のため1名で確認する。
- requested: gpt-6.1-sol / high / fork_turns none。旧 gpt-5.6-sol は現在未提供のため同 tier の現行 identifier を選択。
- role plan: runtime default。spawn tool は agent_type／追加 role 設定を公開しない。local config は gpt-6.1-sol medium で agents override なし。明示 model／effort を指定。
- planned runtime profile: gpt-6.1-sol high。
- applied: null。
- application status: spawn_succeeded_profile_unverified; agent /root/issue94_intake。
- profile observability: final_profile_hidden。spawn が返した task identity のみを証拠とし、applied を推定しない。
- Astra / expensive Sol approval: not applicable。

## 実行コマンド

- 指定の work-context-manager / implementation-worker SKILL.md と事前作成済み本報告を最初に読み、続いて専用 clone 内を調査した。コード・認証・運用設定への書込み、実 API 書込み、依存導入、製品ビルド・機能テスト、commit・push は実施していない。親の追加指示で文書lintのみ後述の方法で実行する。
- 実行: `git status --short`、`git branch --show-current`、`git rev-parse HEAD`、`git remote -v`、`git diff --stat 45d73947dc7f2e56546eb3c2e6c028ff1cc54759..HEAD`、`rg --files`、対象ファイルの `rg -n` / 範囲読取り。ローカル executor は使用可能。
- 実行環境: Windows / PowerShell、作業場所 `C:\Users\donabe\Documents\Codex\2026-11-08\task-4\RemoteDesktopMCP-issue94`、repository `ssaattww/RemoteDesktopMCP`、branch `codex/issue-94-github-projects`、HEAD `782c686575dc6cb50dbf0f3af27a2f2d5518280d`、base `45d73947dc7f2e56546eb3c2e6c028ff1cc54759`。
- identity 確認時の tracked tree は clean、本報告のみ untracked。base..HEAD 差分は `reports/issue-94-development-start-20261108.md` だけ。技術実装・設計書はまだない。その後に親が要求整理/work-contextとtask/phaseを追記しており、本子による変更とは区別する。
- `node --version`: v24.20.0、`npm --version`: 11.19.0、専用 clone の `node_modules`: なし。CI 指定は Node 22。依存や Node 22 の利用可能性は未確認。親の指示により build/test は実行していないため合格証拠はない。
- `.github/workflows/ci.yml` の読取りは存在せず失敗。実際の入口 `.github/workflows/lint.yml` と `test-runtime-measurement.yml` を確認した。
- 追加文書検査（親の明示指示）: `node reference/validation/issue94-intake/document-check.mjs`、終了1、6ファイル中4件。`reports/issue-94-development-start-20261108.md:5` と `reports/issue-94-requirements-intake-20261108.md:5,7,10` のMD034/bare URL。子の本報告は指摘0。親所有ファイルは変更しない。
- 最終文書検査: 親が上記4件のbare URLを修正した後、同じ6ファイルを同じrunnerで再検査し終了0、`markdownlint: 6 files, 0 issues`。初回失敗はtool出力から `markdownlint.initial.log` へ明示転記して保持し、最終stdout/stderrは `markdownlint.log` に保存。初回失敗を成功へ読み替えない。
- 用語検査: `node reference/validation/issue94-intake/document-check.mjs --terms`、終了1。既存tasks先頭のTask/PR/main等を含む多数の未登録語がある。元checkerは最初200件と残件数を出力する。`package.json` の通常lintは限定designファイルに用語検査を適用しており、今回の6ファイル検査は追加の広い検査として区別する。既存語やwhitelistをまとめて修正しない。
- runnerはclone内の無視対象 `reference/validation/issue94-intake/document-check.mjs` に保存。元checkoutの `node_modules/markdownlint/sync` と `yaml` のみを読み取り専用importし、対象cloneの `.markdownlint.json` / checker / whitelistを使用。対象6件はtask/phase、requirements-intake、work-context、本報告、development-start。stdout/stderrを同directoryの `markdownlint.log` / `terms.log` に保存。製品機能テストとは別の文書検査であり、依存追加/元checkout変更はない。
- GitHub 公式公開ドキュメントをブラウズし現行 API を確認。GitHub アカウントの credential やローカル秘密値は読んでいない。Issue/PR/Project の関連状態は親が正式に読戻した結果を受領し、子が独立に再確認した結果とは区別する。

## 対象ファイル

| 調査対象 | 根拠と意味 |
| --- | --- |
| `src/bootstrap.ts:4–8` | 現行入口は cwd の `.env` を保護検査後ロードし `startFromEnvironment` へ進む。Projects 専用入口として無条件に再利用しない。 |
| `src/index.ts:63,99–127` | RuntimeConfig/configFromEnv が PC roots・DC・既存認証に結合。独立 Projects config が必要。 |
| `src/index.ts:143–173,280–303` | DC 設定を書込み、stdio 子プロセスへ接続。service.initialize は DC を必ず起動。Projects factory はこの service を生成しない。 |
| `scripts/desktop-commander-bootstrap.mjs:14–43,48–70` | profile 差替え、Windows Job / spawn / ownership bridge の PC 専用処理。Projects runtime の依存グラフから除く。 |
| `src/index.ts:533–537,1613,1631–1632,1654–1660,1692,1716` | local/public OAuth と discovery は mcp 固定。/mcp は認証後 user 文字列だけで全PCサーバーを生成する。 |
| `src/public-auth.ts:32,41–46,164–166,173–181,238–282` | refresh record、resource、scope、token admission、発行・更新・検証が mcp 固定。audience だけ変える部分修正では整合しない。 |
| `src/index.ts:1314–1404,1406–1454` | operation audit、stop、Todo gate、SDK 検証拒否の監査、tool metadata を共通化。tools/list は表示情報であり認可ではない。 |
| `src/index.ts:539–613,615–706` | 停止状態永続化、generation、実行中停止、PC process/transfer cleanup。Projects 用にはPC副作用と切り離した policy が必要。 |
| `src/index.ts:339,1129–1140`; `src/admin.ts:55–131` | 既存 audit と秘密値除去、session に結び付く表示。新しい GitHub credential は既存 secret list に自動では入らない。 |
| `src/shared-todo.ts:16–26,96–100`; `doc/design/shared-todo-and-stale-update-gate.md:234` | Todo 200件上限は作業並列数とは別。Projects 操作のために PC session_open を必須化しない。 |
| `test/fixture.ts:12–66`; `test/public-auth.test.ts:436–529`; `test/http-oauth-regression.test.ts:57` | 現行 fixture はPC backendを起動。既存実HTTP/OAuthの回帰を維持し、Projects用はDC不要の別fixtureを作る。 |
| `package.json:9–25`; `tsconfig.json:2–13`; `.github/workflows/lint.yml:17–116,119–279` | Node test/tsx、strict TypeScript、Ubuntu全体検証、Windows8 shard、自動診断保存。新規 test は scheduler の全追跡対象割当に含める。 |
| `tasks/tasks-status.md:3`; `tasks/phases-status.md:3` | 更新は task-breakdown-planner / task-consistency-manager / progress-sync-manager 経由という明示規則。今回は読取りのみ。 |

実装に進む場合の候補ファイルは、新規 `src/github-projects/{contracts,client,service,tools,app,auth}.ts` と独立 `test/github-projects-*.test.ts`。小さな変更ならフラット配置でもよい。必要な共通 policy 抽出だけを `src/index.ts` / `src/public-auth.ts` に限定し、README・API対応表・design・task/phase を所定経路で追随させる。依存追加は不要で、既存 SDK / zod と Node fetch を利用できる。これらは候補であり作成済みの設計書ではない。

## 指摘事項

- 最新ユーザー指示: 要求整理を優先し、製品設計・実装・テストへ進まない。以下の技術案・操作候補・検証案は要求確認の参考となる未採用の選択肢であり、採用済み設計や実装開始の許可ではない。
- 発見事項: 現行認証は `string user` へ情報を落とし、Projects-only を表す principal / scope / resource をPC工具入口へ渡せない。tools/list だけを隠しても、既知の `process_start` / `file_*` を direct tools/call すれば認可境界にならない。
- 推奨経路: Projects-only の独立 exported application factory を作る。依存として署名検証済み principal を返す `Authenticator`、principal ごとの許可対象を解決する policy、`GitHubCredentialProvider`、固定 API client、audit / clock / stop policy を注入する。Projects runtime は `RemoteDesktopService` を生成せず、DC・child_process・PC tools・PC filesystem adapter に依存しない。MCP には型付き固定操作だけを登録し、任意 GraphQL、任意URL、shell、HTTP proxy を公開しない。
- HTTP 境界: Projects 専用 resource（例 `/github-projects/mcp`）と専用 scope（例 `github-projects` または read/write 分離）を厳密に検証し、全 tools/call でも固定 capability と対象owner/project/repositoryを検査する。PC `/mcp` は既存 mcp audience/scope のみ受理し、Projects token を拒否する。逆方向も同様。認証ヘッダーを plain principal として信頼しない。未知scope、両scopeの合成、改変token、誤audience、期限切れ、refresh交差、誤client、node/item/field ID差替えを拒否する。
- 認証方式の選択肢A: `PublicAuthService` を resource/scope 指定可能な別instanceとして利用。変更対象は authorize transaction/code/refresh/issuance/authentication/discovery/consent/admission 全体。既存instanceの mcp 既定と永続stateは維持し、Projects専用state・secretは別途承認待ち。共通stateを暗黙に移行しない。
- 認証方式の選択肢B（先行実装推奨）: 独立 factory が `authenticate(request)` を必須依存とし、厳格な検証結果を policy へ渡す。テストは署名付き合成tokenまたは明示test adapterを注入。実運用の embedding は署名/issuer/audience/scope/expiry/revocation を検証する実装を明示注入する。unsafe デフォルトや principal ヘッダーfallbackは設けない。production credential/provider/identity 設定なしでは公開しない。このfactoryは利用可能な実装単位だが、運用OAuth接続完了とは報告しない。
- credential provider は `getCredential(principal, operation, target)` のような非公開依存とし、caller入力に token・credential名・path を受け付けない。既定は disabled、provider不在は `FEATURE_DISABLED` / `CREDENTIAL_UNAVAILABLE`。gh auth token の自動取得、既存OAuth secretの流用、.env変更、永続保存、scope拡張を行わない。GitHub access token と MCP caller token を混同しない。
- audit/stop: Projects の mutation は受付・認可・監査予約・停止generation確認後に dispatch、完了後もgeneration確認。送信後timeout/停止/監査失敗は applied=unknown を保ち成功や未適用と断言せず、blind retryしない。外部APIのcommitをrollbackできるとは扱わない。監査にはoperationId、principal、操作、対象ID、時刻、結果・requestIdだけを基本とし、token・Authorization・本文・GitHub生エラーを残さない。PC sessionを偽造して既存Todo/stopを通過させない。
- Todo/session: Projectsの作業contextが必要ならPCから独立したcontextを使う。既存PCの5分Todo gateを黙って無効化・流用しない。共通停止を適用する場合はPC cleanupを含まないpolicyを抽出し、本人境界を維持する。どのUIから停止/再開するかと、Projects readへの停止適用は設計決定として明記する。
- 全操作の型付き対応表が必要。現行公式schemaには Project lifecycle、item/draft、archive/unarchive/position、custom fields/value、views CRUD、status reports CRUD、collaborator role更新、repository/team link、template、workflow削除がある。Status/Priorityは通常single-selectのfield/option IDとして扱い、itemのpositionとは区別する。field union、null/未指定、opaque ID、cursor/pageInfo、権限によるredacted contentを保持する。GraphQL field値更新が受け付ける型以外のIssue/PR本体変更は別契約と権限が必要。[公式Projects schema](https://docs.github.com/en/graphql/reference/projects)
- ビューを一律API非対応と記載してはならない。schema確認時、GraphQL view configurationの入力はvisibleFieldIds、updateにはfilterがある。RESTのorganization view作成にはsort/group等もあるが、個人owner #4 にそのまま適用できるとは断言しない。[公式REST view](https://docs.github.com/en/rest/projects/views)
- capabilityは `supported` / `unsupported_by_api` / `forbidden` / `not_configured` を区別し、owner種別・API版・権限・操作に基づく理由を返す。web UIの全機能を包括保証しない。特にworkflow作成/編集、ビューの詳細配置、組織固有権限などは現行公式schema/endpointとの個別照合が必要。利用可能なビュー操作等を便宜上unsupportedへ落とさない。
- operation単位の受入範囲候補: (1) owner/project探索・取得・作成・copy・編集・公開状態・close/reopen・削除、(2) issue/PR参照の追加/削除・draft作成/編集/変換・item取得/列挙・archive/unarchive・位置変更、(3) field列挙/作成/編集/削除・option/iteration/multi-selectとfield value設定/clear、(4) views取得/列挙/作成/編集/削除、(5) status report列挙/作成/編集/削除、(6) collaborator列挙/role変更とNONEによる除去、(7) repository/team link/unlink・template操作・workflowの読取り/提供される削除。各入力/戻り値と個人ownerでの可否は設計時に型表へ確定する。権限不足をAPI非対応と混同しない。
- GitHub認証の選定は保留。公式ガイドはclassic PAT read:project/project、GitHub App tokenと追加repository権限の差を説明しているが、本作業では既存tokenのscope確認や流用設定も行わない。[公式API利用ガイド](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects)

## 結果

- 確認済み要求: GitHub Projectsのread/writeを専用MCPで扱い、任意PC操作を呼出し元へ公開しない。read-only/status専用へ縮小しない。Issue/branch/Draft PRの正式関連は確立済み。最新はユーザーと要求を固める工程。
- 未確定の要求: GitHubを正本とする操作経路か独自Project管理も含むか、対象owner/projectの広さ、破壊操作/公開/権限変更の確認方法、Issue/PR本体変更・views・insights等の範囲、単一/複数利用者、他PC接続まで含む保証か、認証方式とaudit/stop/Todoの期待動作。これらを先に親の要求整理表で確認し、技術候補を採用済みにしない。
- 参照先: [Issue #94](https://github.com/ssaattww/RemoteDesktopMCP/issues/94)、[Draft PR #95](https://github.com/ssaattww/RemoteDesktopMCP/pull/95)、[個人Project #4 RDMCP](https://github.com/users/ssaattww/projects/4)。要求整理の正本候補は親作成 `reports/issue-94-requirements-intake-20261108.md`。
- モデル観測: ユーザーは親のモデルを更新したと説明したが、この子から親の実際の最終runtimeは見えない。local configのSol mediumやdispatch要求はchat実モデルの証明ではない。稼働中intakeの途中切替やLuna適用済みとは主張しない。
- 調査完了範囲: 専用cloneの現行認証・transport・tool登録・bootstrap/DC起動・audit/stop/Todo/session・dependency/test/CI・task/phase規則を実ファイルで確認した。実装・正式設計・自己レビュー判定は行っていない。
- 正式関連は親確認結果: Issue #94 open、Draft PR #95 が closingIssuesReferences で #94 に関連、branch/HEAD/base は上記。personal `ssaattww` Project #4 `RDMCP` が対象。#58 / closed-unmerged PR #59 は labels同期の別機能。Project itemのIn progress表示を実行中Issue数と同一視しない。
- 実作業数規則: 調査したrepository内に「並列2・承認待ち除外」を定義する新しい規則は見つからない。親がtrusted user履歴として確認した2026-10-18の同時2件、2026-10-20の「実際のIssue作業を数え、ユーザーレビュー/merge承認待ちは除外」を適用する。今回認められた実作業はDuck #50と#94。他Issueを開始しない。Todo 200件やProject状態件数で作業数を計算しない。
- TDD根拠: `tasks/tasks-status.md:57,137–140`、`tasks/phases-status.md:12,15`、`doc/design/session-metadata-edit.md:113` は既存作業で明示的に実装前失敗→実装後成功を要求している。これはリポジトリに存在する方法の証拠であり、全将来Issueへ適用する包括規則とは断言しない。#94専用task/designがないため、親は適用skill/受入taskでTDD順序を明示する。Red/Greenは実際のログとsourceに結び付け、今回未実行を合格にしない。
- 推奨Redケース: 無効既定/credentialなしでAPI・DC・spawnが0件、Projects tokenでPC /mcp直呼出拒否、PC tokenで専用入口拒否、Projects tool名をPC入口へ/PC tool名をProjects入口へ送信して拒否、未知tool/余分引数/任意query拒否、owner/project外IDを下流前に拒否。refresh/resource/署名/失効、cross-principal、stop race、audit失敗、secret sentinel、GraphQL HTTP200+errors/partial data、pagination/rate limit/timeout、mutation unknown outcomeも検証する。
- 固定operationごとのrequest変数とresponse mappingをfetch DIで検証。read/write双方を含め、削除・draft変換・権限変更・field option更新の破壊性も検証する。新factoryの実HTTPとSDK in-memoryの両方を用い、既存PC OAuthとroot/ownership/stop/Todoの回帰を維持する。
- 検証コマンド候補: `node --import tsx --test test/github-projects-*.test.ts`（実ファイル明示が必要な環境では列挙）、既存focused、`npm run check`、`npm run build`、`npm run lint`、`npm test`、`git diff --check`。これは予定であり実行結果ではない。全体gateは最終候補1回、内容差分で無効になった場合だけ再実行。Node22・Windows8 shardとUbuntuのexact-head CI、割当成果物と必要diagnosticを確認する。
- CI証拠: この子はcurrent-HEAD CIを照会しておらず、成功/不存在を断定しない。commit/push/CI待ち/full-local-equivalence は本調査では not_required、実装候補のgateは未開始。環境不一致や依存不足を成功として扱わない。
- 変更は本報告の5つの空欄のみ。親所有のDispatch profileと既存見出し順を維持し、既存文字化けの一括再encoding修正はしない。実装・公開・merge・認証設定・Duck/他checkout/processは未操作。

## リスク

- 残る決定: 本調査の推奨は独立factory+DI。親は正式設計でresource/scope、既存OAuthを拡張するか独立verifierを採用するか、stop/Todo/contextとUIの関係、個人owner #4を含むowner別capability表を確定する。credentialの新規作成・既存流用設定・scope拡張・運用認証接続・実API書込み・配備は別のユーザー承認が必要。
- ブロックされているのは実運用credential/auth integrationと実API検証であり、合成依存による型付きread/write開発まで読み取り限定に縮小しない。最新指示により現在は要求整理・追跡文書・許可された文書検査だけに留める。factory実装、正式設計、unit/HTTP/auth境界試験、build/testへは進まない。
- 主な危険: broad mcp tokenの流用、audienceだけ変更してrefresh/codeを結合し損ねる、tools/list/annotationを認可と誤認、user文字列からの暗黙権限昇格、任意GraphQL/URL、他projectのnode ID投入、GraphQL部分成功、mutationのblind retry、既存DC子プロセスへのGitHub secret環境継承、audit/エラーへのsecret流出、停止後に未適用と誤報すること。
- 提案した独立runtimeはPC実行口への依存を断つが、同じOS利用者権限やサーバー管理者への隔離境界ではない。対象はProjects-only MCP callerがPC機能を呼べない保証。将来embeddingがPCサービスを渡したりtrusted authenticatorを不正実装すれば保証を損なうため、公開factory契約と統合試験で固定する。
- 調査はbounded intakeであり、正式設計の独立確認や実装レビューを代替しない。該当AGENTS.mdは親がroot未発見と通知済み、今回 `rg --files -g AGENTS.md` でも対象checkout内には現れなかった。GitHub APIのowner/permission差と未対応UI操作は正式設計で残りを詰める。
