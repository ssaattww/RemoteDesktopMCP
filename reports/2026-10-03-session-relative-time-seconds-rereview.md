# 使用者コンソール日時相対表示 秒表示変更の再レビュー

## 対象

- repository: `ssaattww/RemoteDesktopMCP`
- Issue: #44
- PR: #50
- mode: fix verification / rereview
- base: `ed698f1031e9aafb88d4aa0fa6252636ea2df742`
- previous reviewed HEAD: `3506f9414922c9c53e952b33bf074ab23928e1ec`
- reviewed implementation HEAD: `9af766b9893e0548d1a9cdb932525e393e20117c`
- commit range: `3506f9414922c9c53e952b33bf074ab23928e1ec..9af766b9893e0548d1a9cdb932525e393e20117c`
- reviewer continuity: 前回のreplacement normal reviewerと同じchatで継続する。既存finding IDとseverityを維持する。
- verification capability: `local_execution_available`

review開始時のlocal worktreeはcleanで、local HEADとremote PR headは `9af766b9893e0548d1a9cdb932525e393e20117c` で一致した。

## 結論

verdict: **fail**

- `PR50-REV-001` / Medium: closedを維持。
- `PR50-REV-002` / Medium: openを維持。
- `PR50-REV-003` / Medium: 新規required fix。

秒表示のformatting自体、秒表示中の1秒更新、pagehide/pageshowでのtimer解放・再開、DOM非再生成は設計と実装で概ね一致する。ただし未来時刻が分表示から60秒未満へ入る瞬間に、秒表示へ切り替えるwake-upがなく、表示が最大約59秒遅れる。

## 変更範囲

前回reviewed HEADからの変更は5ファイル。

- `doc/design/使用者コンソール日時相対表示.md`
- `src/session-time.ts`
- `src/user-console-client.ts`
- `test/session-time.test.ts`
- `test/user-console-client.test.ts`

変更規模は117 additions / 35 deletions。主な変更は、60秒未満を「N秒前／後」とする表示、秒表示中だけ動く1秒timer、timer寿命回帰テストである。

## Finding status

### PR50-REV-001 — Medium — closed

設計用語lint対象追加は既にclosed。今回の秒表示変更でも `doc/design/使用者コンソール日時相対表示.md` は設計用語lint対象のままで、ローカル `npm run lint:md:terms:design` も成功した。再開条件なし。

### PR50-REV-002 — Medium — open

PRコメントで、利用者から「秒表示以外はOK」と画面確認結果を受領したことが記録されている。これは変更されていないUI部分の実画面確認として参考になる。

一方、同じコメントは、閲覧中の一時画面が既存生成物を使っており、今回の秒表示変更はまだ反映していないことも明記している。したがってcurrent HEADの秒表示について実ブラウザー上の確認証拠はない。

また初回required validationは、作成日時・最終アクセス日時の両方について、ポインター操作、キーボードのみの開閉、正確な年月日・時分秒・JST表示、支援技術からの開閉状態と正確な日時、一覧再描画後の開閉/focus保持を要求している。「秒表示以外はOK」という要約だけでは、これら全項目のcurrent-head evidenceを個別に確定できない。

finding completeness:

- required action: 実ブラウザーと支援技術で指定操作をcurrent HEAD相当の生成物に対して確認する。
- production path: 使用者コンソールの作成日時・最終アクセス日時セル。
- actual composition fixture: current HEADを反映した実ブラウザーの使用者コンソールと支援技術。
- focused evidence: 秒表示変更を反映した画面について未提示。

よってopenを維持し、severity reclassificationは行わない。

### PR50-REV-003 — Medium — required fix

origin: introduced_by_fix

location:

- `src/user-console-client.ts:612-630`
- `test/user-console-client.test.ts:404-422`

description:

未来のセッション日時が「1分後」などの分表示から60秒未満へ入っても、1秒timerは「現在の表示文字列が既に N秒前／後」である場合だけ開始される。非秒表示を更新する基本timerは60秒間隔のため、未来時刻が秒表示領域へ入った直後に表示を切り替える契機がない。

proof:

例として対象日時が現在から61秒後の場合、current formatterは次を返す。

- t0: `1分後`
- t0 + 2秒: `59秒後`
- t0 + 60秒: `1秒後`

しかしt0では秒表示ではないため1秒timerは作られず、次にDOMを更新する予定は60秒後の基本timerである。そのため実画面はt0 + 2秒で本来 `59秒後` となるべきところ、初回60秒timerが発火するまで `1分後` のまま残り得る。

既存のfuture-session testは、clockをt0 + 2秒へ進めた直後に `ui.tickInterval(60_000)` を手動呼出ししている。実ブラウザーの60秒intervalは2秒後には発火しないため、このtestは実際のtimer cadenceを再現せず、上記遅延を見逃している。

impact:

設計は過去・未来の両方向を仕様として扱い、60秒未満では「N秒前／後」とする。clock skewや未来timestampがある場合、current HEADは仕様に反して秒表示開始が最大約59秒遅れる。表示だけの欠陥だが、今回追加した秒表示の中心契約とtimer設計に直接関係するためrequired fixとする。

required action:

- future timestampが60秒未満へ入る境界で、永続的な不要1秒pollingを増やさずに秒表示更新を開始できるwake-upを実装する。one-shot timer、次の境界までのschedule、または同等の方法でよい。
- actual timer cadenceを模擬するfixtureを追加し、61秒後のtimestampが、scheduled callbackだけでt0 + 2秒付近から59秒後へ移行し、その後1秒timerが動くことを確認する。
- pagehide/pageshow、状態再描画、秒表示終了時のtimer解放、通信要求なし、DOM/focus保持の既存契約を維持する。

## Required coverage

| criterion | disposition | evidence |
| --- | --- | --- |
| 要件・設計適合 | checked_finding | 秒表示規則は設計と実装で一致するが、future transitionのtimer開始が設計表示規則を満たさない。REV-003。 |
| 正しさ・境界 | checked_finding | 0/1/59/60秒、JST日付跨ぎ、未来方向を確認。future minute-to-second transitionに欠陥。 |
| scope discipline | checked_no_finding | 変更は秒表示、関連設計、関連テストに限定。認証、API、保存形式、一覧filter/linkは不変。 |
| changed files/direct dependencies | checked_no_finding | 5変更ファイルと共通formatter、client timer lifecycleを確認。 |
| API/data/config/workflow compatibility | checked_no_finding | API日時形式、設定、依存、workflow変更なし。 |
| failure diagnostics | checked_no_finding | CI workflowはtest-results、stdout、stderr、環境ログをalways uploadする。 |
| security/secret handling | not_applicable | 今回差分は表示とtimerのみ。外部値のDOM安全性は既存方式を維持。 |
| tests/validation adequacy | checked_finding | focused 20/20は成功したが、future timer testが60秒callbackを2秒後に手動発火し実cadenceを再現しない。REV-003。 |
| current-HEAD CI | held | exact-head run `37099729165` は確認時点でin progress。Ubuntu、Windows 2/3、3/3はsuccess、Windows 1/3はtest実行中。CI待機なし。 |
| report/tracking/documentation accuracy | checked_no_finding | 秒表示設計はdesignへ反映。PRコメントは秒表示未反映画面であることを明示している。 |
| regression/maintainability | checked_finding | 1秒/60秒の二重timer lifecycleは局所化されているが、threshold wake-up欠落が将来方向で表面化。REV-003。 |

## ローカル検証

execution environment:

- Windows connected computer through RDMCP
- cwd: `C:\Users\donabe\RemoteDesktopWorkspace\RemoteDesktopMCP-issue44`
- branch: `issue44-relative-session-timestamps`
- HEAD: `9af766b9893e0548d1a9cdb932525e393e20117c`
- source state before report write: clean
- `rg` はPATH上に無かったため、検索が必要な箇所は `git grep` と組み込みfile readを使用した。
- `tsx` と `yaml` は既存node_modulesから解決可能。依存追加は行っていない。

validation:

- `node --import tsx --test test/session-time.test.ts test/user-console-client.test.ts`: 20 pass / 0 fail
- `npm run check`: exit 0
- `npm run lint:ts`: exit 0
- `npm run lint:md:terms:design`: exit 0
- `npm run lint:md`: exit 0

review artifacts:

- `C:\Users\donabe\RemoteDesktopWorkspace\review-artifacts\pr50-9af766b\focused-tests.stdout.txt`
- `C:\Users\donabe\RemoteDesktopWorkspace\review-artifacts\pr50-9af766b\focused-tests.stderr.txt`
- 同ディレクトリのcheck/lint stdout/stderr

formatter reproduction:

`2026-10-02T02:01:01Z` をt0の61秒後として確認すると、formatterは `t0=1分後`、`t0+2s=59秒後`、`t0+60s=1秒後` を返した。clientの基本timerは60秒間隔であり、t0では秒timerを作らないため、DOM更新契機が不足する。

## CI

current reviewed implementation HEADに完全一致する `pull_request` runは `37099729165`。

確認時点:

- headSha: `9af766b9893e0548d1a9cdb932525e393e20117c`
- Ubuntu: success
- Windows shard 2/3: success
- Windows shard 3/3: success
- Windows shard 1/3: in progress
- run overall: in progress

利用者指示によりCI完了待ちは行わない。別SHAの成功runをcurrent-head CI成功の代用にはしない。

## 診断artifact workflow

`.github/workflows/lint.yml` はUbuntu/Windows双方で、テスト結果、各コマンドのstdout/stderr、exit code、環境情報を `ci-artifacts` に保存し、`always()` でdiagnostics artifactをuploadする。今回追加は不要。

## Held / unexplored

held:

- current HEADを反映した実ブラウザー・支援技術の操作確認。ownerは利用者。REV-002としてopen。
- exact-head CI run全体の完了。利用者指示により待機しない。これはREV-003のコードfindingを変更しない。

unexplored:

- current HEADの秒表示を実際に反映した運用画面。既存一時画面は旧生成物のため証拠に使用しない。

## 次工程

1. 実装担当で `PR50-REV-003` を修正し、required action / production path / actual composition fixture / focused evidenceのmatrixを提示する。
2. current HEADを反映した実画面で `PR50-REV-002` の操作確認を実施する。
3. 同じ通常review chatでREV-002/003だけをfinding-limited closure reviewする。
4. mergeは利用者が行うため実施しない。

report_attestation_allowed: false
