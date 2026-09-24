# PR #1 独立レビュー

## 判定と対象

判定は **fail**。新規の要修正指摘は **High 1件（RDMCP-IFR-001）** である。
設計上の権限境界に不足があり、lint・ビルド・CIの成功だけでは解消しない。
製品コードや設計本文は修正していない。マージは行わない。

| 項目 | 値 |
| --- | --- |
| リポジトリ / PR | ssaattww/RemoteDesktopMCP / #1 |
| ブランチ | feat/tailscale-funnel-design-lint |
| ベース | 759f6c429cdaabb47cbdd16d2e4acda5eaa69041 |
| レビュー対象HEAD | 99f2fd2a084156951db5f036d4bf01f79aded3e5 |
| 対象tree | c4c392cd80666b06a0bc2bd836b29a522adbefc1 |
| モード | independent_final_review |
| レビュアー | この独立レビューチャット |
| 開始時刻 | 2026-09-24T11:18:35+09:00（チャット実行環境で取得） |

このチャットは対象の実装・修正・通常レビューを行っていない。
過去の報告は指摘履歴として参照し、対象HEADの設計と依存先を独立に確認した。
通常レビュアーの継続チャットになり代わって、過去のレビュー状態を更新しない。

## RDMCP-IFR-001 — High — プロセス実行からローカル専用設定を守る権限境界が未定義

### 位置と発生範囲

- `doc/design/functional-requirements.md:14-15,88-99`
- `doc/design/tailscale-funnel-architecture.md:148-158,190-196`
- `doc/design/multi-pc-architecture.md:215-225`

発生区分は `introduced_by_change`。PR全体で追加された設計の問題であり、直近の文章再構成が作った回帰ではない。

### 問題

要件は許可ユーザーの変更をローカル操作に限定する。
設計は管理用MCPツールを公開せず、認証設定・監査ログなどを許可ディレクトリから除外する。
一方、許可ユーザー設定はサーバーを実行するOSユーザーが読み書きでき、公開する `process_start` はコマンドやプログラムを実行する。

Desktop Commander 0.2.50 の `allowedDirectories` は、ターミナルから起動したコマンドのファイルアクセスを制限しない。
同版の `command-manager.js` は禁止コマンドを検査するが、子プロセスにファイルアクセス用の保護領域を設けない。
`terminal-manager.js` は通常のシェルを起動し、`...process.env` で環境変数を引き継ぐ。
この呼び出しには、設定を管理する主体と異なる制限付き実行主体を選ぶ処理はない。

このため、設定を読める・書ける同じOSユーザーでDesktop Commanderを起動する構成では、通常のシェルやインタープリターを経由して保護対象へ到達できる。
現在の設計には、その構成を禁止し、コマンドと子孫プロセスを設定管理主体から隔離する必須条件がない。
管理用ツールを隠すことやファイル操作の許可範囲から外すことだけでは、ローカル専用という要件を満たせない。

### 影響

認証済みのリモート操作から、許可ユーザー設定やノード登録情報の変更、PSKなどの読み取り、監査ログの変更が可能になる構成を排除できない。
公開プロセス実行を使う以上、正規ユーザーの誤操作や不適切な指示に対しても、ローカル専用設定を保護する境界が必要である。
これは未認証ユーザーからの侵入を再現したという指摘ではない。
実際の認証情報・設定・監査ログには触れておらず、未実装のRemoteDesktopMCP全体を通した再現でもない。

### 独立検証と証拠の範囲

固定版 `@wonderwhy-er/desktop-commander@0.2.50` を `npm pack --ignore-scripts` で取得した。
既存のDesktop Commander設定は読み込まず、隔離した検証ディレクトリだけを使用した。
以下の実ファイルを変更せずにVMモジュールとして読み込んだ。

- `dist/tools/improved-process-tools.js`
- `dist/tools/schemas.js`
- `dist/command-manager.js`
- `dist/terminal-manager.js`

設定取得だけをダミー設定へ置き換え、テレメトリー、表示用プロセス検出、既定タイムアウトも検証用に差し替えた。
実際の引数検査、禁止コマンド検査、シェル起動、Node.jsの子プロセス、出力蓄積処理は依存先の実処理を使用した。
MCPのstdio通信全体やRemoteDesktopMCPの認可処理を検証したものではない。

| 確認 | 結果 |
| --- | --- |
| `allowedDirectories` の外にある検証用設定の読み取り | 内容を取得できた |
| 同じ検証用設定の書き換え | `CHANGED_BY_CHILD` へ変更された |
| 親に設定したダミー秘密環境変数 | 起動した子から取得できた |
| 禁止コマンドの負例 `shutdown` | 検査で拒否され、起動されなかった |
| stdout / stderr の識別文字列 | 同じ統合出力から両方を取得した |
| 検証用プロセスの終了コード | 7を取得した |
| 終了済みPIDに対する停止 | active sessionなしと返り、別プロセスを停止しなかった |

検証スクリプトの終了コードは0。
検証用設定にはOSレベルの別ユーザーACLを付けていないため、隔離済み構成を突破した証拠ではない。
「ファイルツールの許可範囲だけではコマンドを制限できない」ことを確認し、その結果を現在の設計が許す同一OSユーザー構成と照合した。

### 必要な修正

設定管理主体と、Desktop Commanderが実行するコマンド・子孫プロセスの間に、OS権限または同等の強制力を持つ実行境界を設計する。
別の制限付きOSユーザー、サンドボックス、同等の制限付き起動方式など、実際に保証できる方式を選ぶ。
Desktop Commanderの再利用方針は維持し、単にローカル操作を独自実装へ戻さない。

少なくとも次を定義する。

1. コマンドとその子孫から、許可ユーザー設定、ノード登録、PSK、認証情報、監査ログへ不正に到達・変更できないこと。
2. 秘密の環境変数、継承ハンドル、管理用接続先を子へ渡さず、実行ファイルや設定の書き換えで境界を解除できないこと。
3. 統括ノードが実行ノードを兼ねる場合も同じ条件を満たし、境界を用意できない場合は `process_start` を利用不可にすること。
4. 実際の配備時の実行主体で、許可した作業は成功し、シェル、インタープリター、リダイレクト、子孫プロセスによる保護対象へのアクセスは拒否される検証を設けること。
5. ダミー秘密情報が環境・出力へ漏れず、拒否後も保護対象が変わらないことを確認すること。

禁止コマンドの追加、作業ディレクトリ指定、管理用ツールの非公開化だけで修正済みにしない。
制限のない同一OSユーザーのシェルを必須とする場合は、両立しないローカル専用要件の扱いを利用者と明示的に決める必要がある。

## 既存指摘と今回の文章再構成

RDMCP-R1〜R7は、過去の通常レビューで解消済みと記録されている。
現在の本文でも、明示的なアプリケーションセッション、接続ノード数ではなく登録数による対象選択、Desktop Commanderへの委譲、統合出力、世代ID、現在有効なプロセスIDの一意化が保持されている。
RDMCP-IFR-001は追加で見つけた実行権限境界の問題であり、過去の指摘の識別子や重大度を変更しない。

RDMCP-R8に対しては、`multi-pc-architecture.md:442-458` に次が明記されている。
起動と既存PID操作を同じノード・世代のロックで直列化し、ロック取得後に有効性を再確認する。
Desktop Commander呼び出しと状態更新が終わるまでロックを保持し、新IDは解除後に公開する。
検証項目には、既存操作が先の場合と新しい起動が先の場合の両方が残る。
この要求の設計上の反映と直接回帰を確認したが、並行制御の製品実装試験や通常レビュアーによる正式な修正確認を代替しない。
R8の通常レビュー状態は変更しない。

文章レビューでは、設計3文書の現本文と、`b55f57e528b7405c2428ba07ed24101c14280099..99f2fd2a084156951db5f036d4bf01f79aded3e5` の差分全体を読み比べた。
PSK32バイト、HMACの入力と役割、HKDF入力、接続ID、リプレイ拒否、セッション期限24時間、終了時にプロセスを自動停止しない規則、OAuth/OIDCの検証条件は保持されている。
段落・表・見出しへの再構成による意味の欠落や、lintを通すための不自然な語の置き換えは追加指摘としなかった。
lint成功を文章の自然さや認証の正しさの根拠にはしていない。

## 対象同一性と機械検証

FA780にレビュー専用のローカルcloneを作り、対象HEADへdetachした。
元の作業ツリーと既存の他タスクセッションは変更していない。

- 作業場所: `C:\Users\donabe\Project\RemoteDesktopMCP-pr1-independent-20260924-1121`
- 証拠保存先: `C:\Users\donabe\Project\RemoteDesktopMCP-pr1-independent-evidence-20260924-1121`
- 環境: Windows、PowerShell、Node.js v24.20.0、npm 11.19.0

対象HEADの全追跡ファイルをSHA-256で記録し、各検証の前後で一致を確認した。
レビュー開始時と製品側の検証完了時はcleanだった。
本報告と引き継ぎの追加は、その後のレビュー記録だけの変更である。

| コマンド | 結果 |
| --- | --- |
| `npm.cmd ci` | 成功、終了コード0 |
| `npm.cmd run lint` | 成功、終了コード0 |
| `npm.cmd run check` | 成功、終了コード0 |
| `npm.cmd run build` | 成功、終了コード0 |
| `npm.cmd audit --audit-level=low` | 成功、脆弱性0件 |
| `git diff --check 759f6c429cdaabb47cbdd16d2e4acda5eaa69041 HEAD` | 成功、終了コード0 |
| 固定版依存先の検証スクリプト | 成功、終了コード0。保護不足の挙動を確認 |

`identity.json`、`source-manifest.json`、`results.json`、各コマンドのstdout/stderr、`dependency-probe.mjs`、`dependency-probe.results.json`、固定版tarball、`finding-anchors.txt` を証拠保存先に保持する。
初回のPowerShell経由の差分保存は文字コード変換が不適切だったため、`readability-powershell-encoding.invalid.diff` として除外し、gitの出力バイトをそのまま保存した `readability.diff` で再確認した。ソースの文字化けではない。
PythonのPyYAMLは未導入だった。これは補助確認の不足であり、上記の製品検証の失敗としては扱わない。

## CIと診断artifact

GitHubコネクタで対象HEADに一致するpushイベントのrunを確認した。
[run 35941652910](https://github.com/ssaattww/RemoteDesktopMCP/actions/runs/35941652910) は `lint` の成功である。

- artifact ID: `10785335981`
- 名前: `lint-diagnostics-99f2fd2a084156951db5f036d4bf01f79aded3e5`
- digest: `sha256:f3927b26c605eccd4f5459935083fa18c85ad36d3edf268c69c14c2fbb5fe388`
- artifactの存在・対象SHA・非失効を確認。ZIP内容の確認済みとは扱わない。

既存workflowは成功・失敗の両方でインストールとlintの診断を保存するため、変更していない。
CIはUbuntu / Node.js 22、手元の実行はWindows / Node.js 24であり、同一環境とは扱わない。
この成功はレビュー対象99f2fd2の証拠であり、報告追加後のSHAへ読み替えない。

## レビュー観点の結果

| 観点 | disposition | 根拠 |
| --- | --- | --- |
| 要件と設計の整合 | checked_finding | RDMCP-IFR-001 |
| 正しさ・境界条件 | checked_finding | ローカル専用設定とコマンド実行の境界 |
| スコープ管理 | checked_no_finding | 初期実装の暫定部分を完成品とは評価しない |
| 変更ファイル・直接依存 | checked_finding | 現行設計、実装、lint設定と固定版依存先を照合 |
| API・設定・workflow互換性 | checked_finding | プロセス出力の契約は確認、設定保護に不足 |
| エラー処理・診断 | checked_finding | 実行境界が用意できない場合の拒否条件が必要 |
| セキュリティ・秘密情報 | checked_finding | 設定アクセスと秘密環境変数の継承 |
| テスト・検証の妥当性 | checked_finding | 実行権限境界の受入試験が必要 |
| 対象HEADのCI | checked_no_finding | exact-HEADのpush runが成功 |
| 文書・報告の正確さ | checked_no_finding | 現本文と直近差分を比較。過去の状態は当時の記録として扱う |
| 回帰・保守性 | checked_finding | 再利用とプロセス識別の規則は維持。設定保護は要修正 |
| 実配備でのOAuth・ノード接続・並行制御 | held | 設計段階で未実装。実接続の受入合格を主張しない |

現行の設計3文書、実装2ファイル、手書きlintスクリプト・設定、直近差分、通常レビュー指摘の経緯を確認した。
生成lockfileはインストール・auditによる確認であり、全行の意味を人手で確認したとは扱わない。
過去の全handoffの重複payloadを逐語的に再監査したわけではない。
これらの範囲制限を、現行設計の問題がないという主張へ置き換えない。

## 読み込んだ手順

CodexSkillのHEAD `89c2bc6d1a9bdf2797770a70331d5b0723cf92b7` はcleanだった。
`chat-review-worker`、`work-context-manager`、`review-worker`、`document-wording-review` とその判断例、`report-writer`、`chat-handoff-manager` を読んだ。
各ファイルのハッシュは証拠保存先の `skills-hashes.json` に記録した。
時刻はチャット実行環境で取得し、接続先PCの時刻や推測値を進捗報告に使っていない。

## 次の対応と記録の扱い

設計担当がRDMCP-IFR-001の実行権限境界と受入条件を具体化する。
通常レビュアーがR8の既存修正と今回の対応を確認した後、この独立レビューチャットで該当指摘と変更・CI差分を閉じる。
新しい独立レビュアーへの無制限な再レビューの繰り返しを要求しない。
タスク台帳 `tasks/tasks-status.md` は存在せず、更新対象はなかった。

この報告はfailのレビュー記録であり、合格のreport-attestationではない。
引き継ぎ: `doc/report/2026-09-24-pr1-independent-review-handoff.yaml`。
報告・引き継ぎの公開SHAとPRコメントは公開後のコメントで示し、99f2fd2の検証結果と区別する。

## 外部の一次資料

[Desktop Commander公式README](https://github.com/wonderwhy-er/DesktopCommanderMCP) は、許可ディレクトリの制約がターミナルコマンドには適用されないことを明記している。
実装に関する判定は更新され得るREADMEだけに依存せず、取得した固定版0.2.50の実ファイルと検証結果に基づく。
