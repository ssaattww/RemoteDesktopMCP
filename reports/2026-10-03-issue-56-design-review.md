# Sub-agent実行レポート

## タスク

- 目的: Issue #56 の候補未決設計と既存実装照合内容を独立レビューし、設計上の指摘、根拠、代替案を記録する。
- タスク種別: 設計レビュー
- レビュー対象 HEAD: `b8749ae9d1a65aa1ce979b2f43cde7c5cbfa5b4f`
- Issue / PR: [Issue #56](https://github.com/ssaattww/RemoteDesktopMCP/issues/56) / [Draft PR #61](https://github.com/ssaattww/RemoteDesktopMCP/pull/61)
- レポート状態: reviewer の確認結果を記入する前の親作成済み通常報告

## sub-agentを使う理由

- 理由: 設計案の執筆者と別の reviewer に判断の独立性を持たせるため。親の自己確認で代用しない。

## 対象範囲

- 対象: 課題要件、`doc/design/shared-todo-and-stale-update-gate.md`、`doc/design/functional-requirements.md`、関連する現行 API・session 所有・監査・process 監視実装、タスク追跡。
- 特に確認する点: 適用範囲・初期値・有効切替後の猶予を未決のまま保てているか、保存と API 名、時計異常、監査失敗、実行中 process の終了確認が具体的か。例外が循環を防ぎ、通常 tool への無制限な迂回路にならないか。

## 対象外

- 対象外: 製品実装、テスト追加・実行、Issue/PR への直接コメント、適用範囲・初期値・猶予の選択。レビュー対象以外のファイルは変更しない。

## Dispatch profile

<!-- この節は親の所有。reviewer は書換えない。 -->

- selection inputs (parent, pre-dispatch): Judgment-heavy な設計契約レビュー。security、互換性、時計、状態管理、例外経路を含む。
- selection source (parent, pre-dispatch): `sub-agent-task-manager` profile selection contract と現在のユーザーの明示指定を適用。
- observed decomposability (parent, pre-dispatch): `independent_workstreams`。保存/API、時計/監査、process 例外は個別の証拠確認が可能。
- decomposition policy / disposition (parent, pre-dispatch): `forbidden` / `prohibited_by_caller_policy`。ユーザーは一人の別 reviewer による設計レビューを指定。
- proposed profile (parent, pre-dispatch if applicable): なし。
- approval status / evidence (parent): ユーザーが本タスクで `gpt-6-luna`, `medium`, `fork_turns none` を明示指定。
- Astra eligibility / prior-attempt and blocker evidence / expected benefit (parent, if applicable): 対象外。
- Astra cost notice / baseline / evidence date / unknown actual cost (parent, if applicable): 対象外。
- Astra grant ID / mode / status / explicit approval evidence (parent, if applicable): 対象外。
- Astra task / scope / completion conditions / parent context / agent binding (parent, if applicable): 対象外。
- Astra per-operation ID / work unit / target HEAD / grant usage and pre-submission consumption / outcome (parent, if applicable): 対象外。
- Astra revocation / expiry / invalidation reason and preserved grant history (parent, if applicable): 対象外。
- complete `astra_authorization` schema version 1 extension (parent; not applicable for ordinary non-Astra work): 対象外。
- requested profile (parent, pre-dispatch): `model: gpt-6-luna`, `reasoning_effort: medium`, `fork_turns: none`。
- agent role / default-role plan (parent, pre-dispatch): spawn API に agent_type / role 指定欄がない。effective default role は観測不可。
- role config evidence / profile effect (parent, pre-dispatch): runtime role 設定を照会する機能がなく、role と profile effect は観測不可。ユーザーはこの点を理由に dispatch を止めず、未観測を記録するよう明示。
- planned runtime profile after known role constraints (parent, pre-dispatch): role profile 未観測につき確定不可。要求値は上記のとおり設定する。
- applied profile (parent, post-runtime exact evidence only; null when unverified): `null`。spawn 成功と要求値の指定は確認できるが、runtime の実効 profile は確認できない。
- application status (parent, post-runtime evidence only): `spawn_succeeded_profile_unverified`。
- runtime profile observability (parent, post-runtime): `final_profile_hidden`。
- reviewer continuity (parent, if applicable): 新規 reviewer。
- fork policy (parent): `none`。
- reasons / constraints (parent): Reviewer はレビュー結果を本ファイルに記載する。子 agent はこのタスクを内部委譲しない。製品候補の選択、実装作業を行わない。レポート以外は書き換えない。

## 実行コマンド

- `pwd; git status --short --branch; git rev-parse HEAD; git show --stat --oneline --decorate --no-renames b8749ae9d1a65aa1ce979b2f43cde7c5cbfa5b4f` — repository `/workspace/RemoteDesktopMCP-issue56`、branch `feature/issue-56-shared-todo`、HEAD は指定 SHA と一致。開始時の未追跡ファイルは本レポートのみ。
- `cat skills/work-context-manager/SKILL.md; cat skills/review-worker/SKILL.md; cat skills/design-doc-maintainer/SKILL.md` — 指定された3 Skillを確認。初回レビューとして実施。
- `git diff b8749ae^ b8749ae -- doc/design/shared-todo-and-stale-update-gate.md tasks/phases-status.md tasks/tasks-status.md` — 設計案と tracking の差分全体を確認。
- `nl -ba doc/design/shared-todo-and-stale-update-gate.md` — 設計全文、保存/API/時計/監査/プロセス節と未決事項を確認。
- `nl -ba src/index.ts | sed -n '1027,1080p'; nl -ba src/index.ts | sed -n '1157,1176p'` — 共通 MCP 受付の監査順序とプロセス監視/API動作を確認。
- `rg -n -i 'issue.?56|#56|shared todo|stale update|running process|terminate|termination' . --glob '!**/.git/**'` — 要件・設計・追跡・関連レビュー記録を検索。
- GitHub Issue #56 本文を閲覧し、目的、機能要件、例外、検討項目、受入条件を照合。
- テスト・ビルド・lint・製品実装は行っていない（禁止事項）。

## 対象ファイル

- Issue #56 全文（2026-10-03時点）。目的はTodo共有と、設定有効時に最終更新から5分で通常toolを拒否する任意強制。Todo scope と強制初期値は明示的に未決。例外、所有境界、時計・更新失敗、監査、ON切替猶予、再開規則を設計で定義することが受入条件。
- `doc/design/shared-todo-and-stale-update-gate.md`（対象 diff 全体と最終状態）。
- `doc/design/functional-requirements.md:50`（候補決定前は実装開始しないとの参照）。
- `src/index.ts:259,1027-1075,1157-1175`（audit実装、共通tool wrapper、process watcher/status/output/kill）。
- `tasks/tasks-status.md` のT09行と末尾のT09記述、`tasks/phases-status.md` のP5行と注記（設計レビュー中、親判断後にTDD実装）。
- `reports/2026-10-03-issue-56-design-review.md`（本報告。親所有文・dispatch profile は保持）。

対象差分は設計文書の具体案と二つのtracking表現の更新のみ。製品コード差分なし。基準HEADは `b8749ae9d1a65aa1ce979b2f43cde7c5cbfa5b4f`。

## 指摘事項

### DREV-56-01 — High — 監査故障時の例外操作が共通受付監査で止まり、Todo復旧と安全操作が実行不能

- 起点: 設計不足。場所: `doc/design/shared-todo-and-stale-update-gate.md:89-91`。現行実装根拠: `src/index.ts:1045-1051,1067-1072`。
- 影響: audit.jsonl追記/ACL検査に失敗すると、`this.tool` はhandlerに入る前に `operation.received`、さらにhandler実行前に `operation.started` を必須awaitする（`src/index.ts:1046,1050-1051`）。例外操作本文内の `audit()` を個別catchして続行するだけでは、Todo更新・強制設定・process kill・session close・transfer cancel等は実行されない。特に期限ゲートを解除するTodo更新が監査障害で拒否され続け、自己回復できない。正常系の最終 `operation.succeeded` 監査が失敗した場合も、更新適用済みなのに一般エラーとなる経路がある（`1058`からcatchへ入り`1071`が再監査）。
- 必要な対応: 共通wrapperを含む監査イベント順序を設計で規定する。強制中に許可判断の監査が書けない通常操作は副作用前にfail-closedとする。一方、Todo回復と列挙された安全例外については、`operation.received/started/succeeded/failed` の各書込み失敗をどう扱い、どの操作を実行するか明記する。変更/停止後の監査失敗を適用済み成功または未確認状態＋警告として返し、二重更新・二重停止を誤誘導しない応答契約も定義する。代替実装は登録済み固定操作allowlistを扱う専用wrapper、または共通wrapper内の安全例外経路。
- 理由: 文書は `:91` で共通受付処理変更が必要と認識し、`:89` で操作個別のaudit_warningを提案するが、拒否点はhandlerより前にあり、個別捕捉だけでは届かない。設計のままでは「Todo更新は常に可能」「監査故障だけを理由に安全停止等を拒まない」と矛盾する。警告fieldの細目を保留することは製品判断として可能だが、制御順序は実装前に解決が必要。

「監査が復旧するまでTodo更新も拒否」は、期限ゲートの復旧手段がなくIssueの自己回復要件に反するため代替にならない。

## 結果

- モード: initial review。対象HEAD: `b8749ae9d1a65aa1ce979b2f43cde7c5cbfa5b4f`（branch `feature/issue-56-shared-todo`）。設計差分、Issue、functional requirement、現行audit/tool/process実装、task/phase trackingを確認した。実装・テスト・Issue/PRコメントなし。reviewerは候補作成者とは別担当として割当てられた。
- 判定: **fail**。DREV-56-01 は、audit fault recovery / safety exception を現行共通入口で実現できない具体的な制御順序の矛盾。設計修正後はこの契約に対する限定確認が必要。
- 観点: requirement/design `checked_finding`; correctness/error handling `checked_finding`; scope/default/grace `held`; API/data/lifetime `checked_no_finding`（下記保留を除く）; security/ownership `checked_no_finding`; process exception/bypass `checked_no_finding`; task/report accuracy `checked_no_finding`; test/validation adequacy `not_applicable`（設計のみ、実行禁止）; matching current-HEAD CI `unexplored`（CI証拠の照会なし）。
- 適用範囲、初期値、有効化猶予は明示的に親判断待ちで保持されている。レビューではいずれも選択していない。
- 起動中のsession MapにTodoを置く案は既存session寿命と一貫し、再起動後に古いsession IDが無効となる点とも整合する。MCP/HTTPの所有確認、expected-version競合、固定server-side操作名、所有processに限った状態/output読取、期限後status/outputから下流読取を起こさない条件が説明される。通常tool bypassを作るとの所見はない。
- process例外は、強制中のstatus/outputが既存watcherの保存済状態を返し、呼出しから新たな下流読取を起こさない設計。実際の終了確認は既存watcherが状態/outputを監視して記録するモデルを前提にし、停止未確認時に終了済みと偽らず `termination_unconfirmed` を維持する。例外API単体がkillや任意の下流操作を実行する迂回路にはならないと評価した。

## リスク

- 保留（製品選択、レビュー上のブロッカーではない）: Todo/強制scope、強制初期値、有効化後の猶予を親が確定する。既存sessionへの導入時挙動は初期値判断に連動する。レビューでは選択していない。
- 保留（環境確認）: perf_hooks単調時計がOS休止時間を含むか。設計は確認不能時の代替案を記載するが、環境の事実は未検証。
- 保留（UI/API契約）: audit障害時に画面とMCP応答へ示すwarning field、および完了process詳細の保持・清掃期間（設計`:123-124`）。製品判断として保留。
- ブロッカー: audit障害を回復するTodo更新と例外操作を共通 `this.tool` の事前監査からどう通すか、更新後のwarningをどう確実に返すか（DREV-56-01）。
- 未探索: Draft PR #61 のPR差分/コメント、CI、対象環境のclock suspend semantics、動作検証。範囲外または禁止のため調べず、コード検証・テストはしていない。
- 本報告はレビュー前に親が用意した未追跡の予約パスへ記入。実装HEADの判定移転、report attestationは主張しない。

## DREV-56-01 限定設計確認

- モード: 同一reviewerによる finding 限定確認。対象HEAD: `72ea62933222d875db21857ff65221017d53e937`（branch `feature/issue-56-shared-todo`）。初回レビューの `b8749ae9d1a65aa1ce979b2f43cde7c5cbfa5b4f` に対する設計差分のみを確認し、初回判定と finding は履歴として維持する。
- 確認コマンド: `git status --short --branch; git rev-parse HEAD; git show --stat --oneline --no-renames 72ea62933222d875db21857ff65221017d53e937`; `git diff b8749ae9d1a65aa1ce979b2f43cde7c5cbfa5b4f 72ea62933222d875db21857ff65221017d53e937 -- doc/design/shared-todo-and-stale-update-gate.md tasks/tasks-status.md tasks/phases-status.md`; `nl -ba doc/design/shared-todo-and-stale-update-gate.md | sed -n '85,100p'`; `nl -ba src/index.ts | sed -n '1027,1075p'`。
- 対象diffは設計文書の監査受付方針と tracking 更新。プロダクトソースの変更はない。現行 `src/index.ts` wrapper を再確認した。従って本判定は設計内容の充足性であり、実装が動作することの確認ではない。

### 要件ごとの判定

| 初回 finding の必須条件 | 状態 | 根拠 / 評価 |
| --- | --- | --- |
| 通常操作はゲート許可監査が成功した時だけ委譲し、監査失敗時は副作用前にfail-closed | 解消 | 設計 `doc/design/shared-todo-and-stale-update-gate.md:89` は、強制中の通常操作に `todo.gate_allowed` を要求し、書けない場合 `TODO_GATE_AUDIT_UNAVAILABLE` として下流委譲を止める。期限拒否も監査が失敗しても維持。 |
| 固定例外は `operation.received/started` の事前監査失敗でもhandlerへ進み得る | 解消 | 設計 `:91-92` は、Todo読取/更新・設定、緊急停止、所有確認済process停止/終了確認、転送取消、session終了を例外候補とし、共通受付のpre-handler audit失敗を捕捉して処理関数へ進め、監査記録なし状態を保持すると明記。 |
| 事後の `succeeded/failed` 監査失敗を操作結果と区別し、再実行を誘わない | 解消 | 設計 `:91-92` は、既処理結果または終了未確認など実状態＋警告を返し、処理結果が不明なら `applied: unknown` として自動再試行を誘う成功/失敗扱いにしない。Todo更新後のaudit失敗は更新済み成功として返す。warning field形式自体はAPI設計へ残されているが、必須の重複防止意味は定義済み。 |
| Todoを監査故障から復旧する経路がある | 解消 | Todo更新は固定例外であり、pre-handler audit失敗でも実行継続可能。通常操作の許可監査が復旧するまで通常ツールを停止する一方、例外のwarning解消時も暗黙の再実行をしない（`:89-92`）。 |
| 例外判定は固定allowlistで、呼出し引数や申告による拡張なし | 解消 | 設計 `:92` はサーバー側の固定allowlistを推奨し、任意のtool名、引数、呼出し元申告による拡張を明確に禁止。専用受付案でも認証・所有権・緊急停止確認の共通規則を共有するとしている。例外候補は直前の`:90-91`と既存文書の具体tool/route候補に束縛される。 |

### 限定確認の結果

- **DREV-56-01: closed in design at `72ea62933222d875db21857ff65221017d53e937`.** 初回 High の必要条件はすべて設計に反映され、今回確認した範囲で残件なし。severityの再分類は行っていない。初回レビューの履歴上の verdict `fail` は変更しない。設計差分の技術的な限定確認のみ解消とする。
- 固定例外候補を“候補”と呼び、最終HTTP/MCP応答型と `audit_warning` schema をAPI設計に残すが、設計段階で必要な事前/事後の制御規則と再実行抑止はある。これら細部はIssue scope/default/graceの選択とは独立して後続API設計で確定できる。
- 未確認: 実装、fixture/テスト、CI、実際の監査ストレージ故障時のレスポンス。今回対象外・禁止であり、設計確認の完了を実装検証と混同しない。
- scope、強制初期値、有効化猶予の親判断は引き続きheld。今回も選択していない。

### 有効化猶予の式に関する追加確認

- 指定HEAD `72ea62933222d875db21857ff65221017d53e937` の `doc/design/shared-todo-and-stale-update-gate.md:34` を確認。`nowMonotonic - max(lastTodoUpdatedMono, enabledAtMono) >= 300_000` とし、後続文で「有効中に一覧更新が成功すれば、その更新単調時計値から通常の5分期限を数え直す」と明記する。
- 判定: **説明十分、findingなし**。`max` はTodo更新時刻と今回の有効化時刻の後者を基準にするため、ON時には過去の古いTodo時刻にかかわらず切替から5分の猶予となる。ただしON後にTodoを更新すれば、その更新が新しい後者となって期限は更新時点から新たに5分数える。したがって更新があれば「切替から絶対5分で拒否」ではなく、最終更新から5分で拒否される通常規則に戻る。この意味は式と文章の両方から読み取れる。
- 有効化猶予を採用するかどうか自体はscope/default/graceの親判断としてheldのまま。今回選んでいない。
