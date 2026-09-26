# PR #1 RDMCP-IFR-001 指摘対応報告

## メタデータ

- リポジトリ: `ssaattww/RemoteDesktopMCP`
- PR: #1
- finding: RDMCP-IFR-001
- severity: High
- independent review 対象 HEAD: `99f2fd2a084156951db5f036d4bf01f79aded3e5`
- 作業開始 HEAD: `6397a6ad3a854e29802ae412c4877f18bb0ae902`
- 設計修正 HEAD: `3a66f444a91e05f1667a7ca258c377679b23fbfc`
- fixture technical HEAD: `b8ea26436ecef4b387d7413c681fa15b011dacbe`
- ブランチ: `feat/tailscale-funnel-design-lint`
- 実行環境: FA780
- 作業ディレクトリ: `C:\Users\donabe\Project\RemoteDesktopMCP-pr1-r4-20260922`
- 診断保存先: `C:\Users\donabe\Project\RemoteDesktopMCP-pr1-ifr001-diagnostics-20260924`

## 指摘

`process_start` が Desktop Commander の通常シェルを同じ OS ユーザーで起動できる構成では、
`allowedDirectories` から認証設定を除外していても、コマンド自身のファイルアクセスは制限されない。

そのため、許可ユーザー設定、ノード登録、PSK、トークン、監査ログなどを管理する主体と
リモートコマンドを実行する主体の間に、OS が強制する権限境界が必要である。

## 対応方針

初期版では別 OS ユーザーによる権限分離を必須とした。

- 管理側: RemoteDesktopMCP の認証・認可、ノード認証、秘密設定、監査を担当する。
- 実行側: 専用の非管理者 OS ユーザーで動き、実行ワーカー、Desktop Commander、
  `process_start` のコマンドと子孫プロセスを実行する。

Desktop Commander の再利用方針は維持し、RemoteDesktopMCP でローカル操作を再実装しない。

## OS 権限による保護

実行側ユーザーには、許可した作業用ディレクトリと専用の一時領域だけを読み書き可能にする。

実行側から読み書きできない保護対象を明示した。

- 許可ユーザー設定
- OAuth/OIDC の秘密情報と保存済みトークン
- ノード登録情報、PSK、ノード認証設定
- 監査ログ
- `DATA_DIR`
- 管理側の実行ファイルと設定
- 実行ユーザー、許可ディレクトリ、起動方法、サービス設定など権限境界を決める設定
- 権限境界を変更できる起動スクリプトや実行ファイル

Windows では実行側を専用の標準ユーザーとし、Administrators へ所属させない。
バックアップ、復元、所有権取得、デバッグなど、OS のアクセス権を迂回できる特権も付与しない。

実行ワーカーは Windows サービスとして専用ユーザーで起動し、
サービスの実行ユーザー、実行ファイル、起動引数は OS 管理者だけが変更できる設計とした。

## Desktop Commander の起動経路

管理側プロセスから Desktop Commander を同一 OS ユーザーで直接起動しない。

管理側
→ 同一PC上の実行ワーカー
→ `stdio` MCP
→ Desktop Commander
→ コマンド / 子孫プロセス

の順で実行する。

実行ワーカーとの通信は、Desktop Commander へ渡す操作と結果だけを扱う。
管理側の設定ファイルを読み書きする機能や、秘密情報を返す機能は設けない。
通信方式やサービス設定自体も実行側から変更できない場所で管理する。

## 環境変数と継承

管理側プロセスの環境変数を実行側へそのまま継承しない。

実行ワーカーと Desktop Commander の環境変数は安全な値だけから新しく構成し、
OAuth/OIDC の秘密情報、アクセストークン、リフレッシュトークン、PSK などを含めない。

秘密情報を実行側から参照できるPC全体の環境変数や共有設定にも保存しない。

`HOME`、`USERPROFILE`、一時ディレクトリは実行側専用の場所を使う。
管理側との通信用ハンドルなども Desktop Commander やコマンドの子孫へ継承させない。

## Desktop Commander の既存制限との関係

`allowedDirectories` は追加の防御として利用するが、
`process_start` のセキュリティ境界としては扱わない。

禁止コマンドや作業ディレクトリ指定だけで権限境界を代替しない。
シェル、インタープリター、リダイレクト、子孫プロセスを使っても、
保護対象は OS のアクセス権で拒否されることを要求する。

## 境界を用意できない場合

実行ノードの起動時に、管理側と実行側の OS ユーザー、
実行側の権限、作業用ディレクトリへの許可、保護領域への拒否、
秘密環境変数の非継承を確認する。

必要な境界を確認できない場合は `process_start` を利用不可とし、
Desktop Commander の `start_process` を呼び出さない。

同じ OS ユーザーでの無制限実行や、
RemoteDesktopMCP の直接実装へのフォールバックは禁止した。

統括ノード自身を実行ノードとして使う場合も例外にしない。

## 配備時の受入試験

実際の配備で使用する管理側ユーザーと実行側ユーザーを使う検証を設計へ追加した。

許可試験:

- 実行側ユーザーから作業用ディレクトリを読み書きできる。
- `process_start` で許可されたコマンドを実行できる。

拒否試験:

- 通常のシェル
- PowerShell
- Node.js などのインタープリター
- 出力リダイレクト
- 子孫プロセス
- シンボリックリンク / ジャンクション

を使って保護領域のダミーファイルを読み書きしようとしても拒否される。

拒否後はダミーファイルのハッシュ値を比較し、変更されていないことを確認する。

管理側だけに設定したダミー秘密環境変数が、
Desktop Commander、起動コマンド、子孫プロセスのいずれからも取得できず、
stdout / stderr にも出ないことを確認する。

実行側から管理側の実行ファイル、サービス設定、実行ユーザーを決める設定、
起動スクリプトを変更できないことも確認する。

境界が不成立の構成では `process_start` が利用不可になり、
`start_process` が呼ばれないことを確認する。

## ホワイトリスト追加候補

自然な技術用語を避けず、次をホワイトリストへ追加した。

- Windows
- Administrators
- PowerShell
- Node.js
- インタープリター
- グループ
- シェル
- シェルコマンド
- ジャンクション
- シンボリックリンク
- スクリプト
- ダミー
- ダミーファイル
- デバッグ
- バックアップ
- ハンドル
- リンク
- ワーカー

`マシン` も一度候補に出たが、
本文では「PC全体で共有される環境変数」の方が明確だったため追加していない。

検査を通すためだけのコード表記や引用符への変更は行っていない。

## actual composition fixture

独立closureで要求された実配備構成のfixtureとして、
`test/execution-boundary/windows/` を追加した。

- `Prepare-BoundaryFixture.ps1`
  - 管理側ユーザーでダミー保護領域と作業領域を作成する。
  - 実行側ユーザーへ作業領域の変更権限を与え、保護領域は拒否する。
  - 保護対象の初期SHA-256、想定管理ユーザー、想定実行ユーザーをmanifestへ保存する。
  - 保護領域を指すjunctionとsymbolic linkを作成する。
- `Probe-BoundaryFixture.ps1`
  - 実際のRemoteDesktopMCPの `process_start` から実行する。
  - 作業領域への許可操作と、保護領域への各種アクセス拒否を確認する。
  - シェル、PowerShell、Node.js、リダイレクト、子孫プロセス、
    junction、symbolic link、境界設定ファイルの書き換えを確認する。
  - 管理側だけに設定したダミー秘密環境変数が見えないことを確認する。
- `Verify-BoundaryFixture.ps1`
  - 管理側ユーザーで実行する。
  - Probeが想定した実行ユーザーで動いたことと、拒否試験結果を確認する。
  - 保護ファイル、境界設定、サービス設定、管理側実行ファイルの
    SHA-256が変化していないことを確認する。

fixtureはOSユーザーやWindowsサービスを作成しない。
実配備と同じ2つの実行主体が用意された環境で使用する。

今回の作業環境には、配備済みの専用実行ユーザーと実行ワーカーがまだ存在しない。
そのためPowerShell構文検査までは実施したが、
このfixtureを異なるOSユーザー間で実行したfocused evidenceはまだない。
同一ユーザーでの実行結果を代用しない。

## finding completeness matrix

| required action | production path | actual composition fixture | focused validation evidence |
| --- | --- | --- | --- |
| 管理側とコマンド・子孫プロセスをOS権限で分離する | `functional-requirements.md` の「ローカル実行の権限分離」、`multi-pc-architecture.md` の「ローカル実行の権限境界」「Desktop Commander の起動経路」 | `Prepare-BoundaryFixture.ps1` + `Probe-BoundaryFixture.ps1` + `Verify-BoundaryFixture.ps1` | fixture構文検査pass。実配備2ユーザーでの実行はruntime未実装のためpending |
| 秘密環境変数・管理用ハンドルを継承せず、境界を決める設定を実行側から変更させない | `multi-pc-architecture.md` の環境変数・サービス設定・保護対象、`tailscale-funnel-architecture.md` の「ローカル秘密情報と実行環境」 | Probeの `secretNotInherited` と boundary/service/executable write拒否、Verifyのhash比較 | fixture構文検査pass。実配備での秘密非継承・書換拒否はpending |
| 統括ノード兼任時も同じ境界を使い、境界不成立なら `process_start` を拒否する | `multi-pc-architecture.md` の「起動時の確認と失敗時の扱い」「統括ノード自身を操作する場合」 | README記載の実配備手順 + Probe/Verify | 設計lint/check pass。実際のfail-closed composition evidenceはpending |
| シェル、インタープリター、リダイレクト、子孫プロセス、link経由を含む許可/拒否試験を行う | `multi-pc-architecture.md` の「権限境界の配備試験」 | Probeのdirect/cmd/PowerShell/Node.js/redirection/descendant/junction/symbolic-link checks | fixture構文検査pass。実配備でのfocused runはpending |
| ダミー秘密情報が漏れず、拒否後も保護対象が変わらないことを確認する | `multi-pc-architecture.md` の「権限境界の配備試験」 | Probeのsecret check + Verifyの複数SHA-256比較 | fixture構文検査pass。実配備でのfocused runはpending |

matrix自体は用意したが、focused evidenceがpendingの行を完了扱いにはしない。
独立closureのreadinessは、runtime実装と実配備2ユーザーでのfixture実行後に再評価する。

## 変更ファイル

- `doc/design/functional-requirements.md`
- `doc/design/multi-pc-architecture.md`
- `doc/design/tailscale-funnel-architecture.md`
- `tools/lint/markdown-whitelist.yaml`
- `test/execution-boundary/windows/README.md`
- `test/execution-boundary/windows/Prepare-BoundaryFixture.ps1`
- `test/execution-boundary/windows/Probe-BoundaryFixture.ps1`
- `test/execution-boundary/windows/Verify-BoundaryFixture.ps1`

製品runtime、依存関係、CI workflow、過去のレビュー報告は変更していない。

## 診断 workflow

`.github/workflows/lint.yml` を作業開始時に確認した。

workflow は成功・失敗の両方で npm install / lint の stdout、stderr、結果、
対象 SHA、Node.js / npm の情報を artifact に保存する。
今回の変更は不要だった。

## ローカル検証

technical HEAD の内容に対して次を実行した。

- `npm run lint`: pass
- markdownlint: 26 files / 0 issues
- design terminology lint: pass
- `npm run check`: pass
- `npm run build`: pass
- `npm audit --audit-level=low`: pass、0 vulnerabilities
- `git diff --check`: pass
- design `--list-unknown`: 0件

各コマンドの stdout / stderr / result は
`C:\Users\donabe\Project\RemoteDesktopMCP-pr1-ifr001-diagnostics-20260924`
へ保存した。

fixture / matrix 追加後の最終候補の検証要約は
`C:\Users\donabe\Project\RemoteDesktopMCP-pr1-closure-readiness-diagnostics-20260924\validation-summary.txt`
へ保存した。

fixtureと更新済みreport / handoffを含む publication 候補でも `npm run lint` は
26 files / 0 issues で pass した。
handoff YAML parse、`npm run check`、`npm run build`、
`npm audit --audit-level=low`、`git diff --check` も pass した。

これは設計段階の指摘対応であり、実際の別 OS ユーザーによる受入試験は
製品実装後に実施する必要がある。

## finding disposition

RDMCP-IFR-001 (High) は実装担当として addressed とする。
独立レビューの severity は変更していない。

通常レビュアーによる RDMCP-R8 と今回変更の確認、
その後の独立レビューチャットによる RDMCP-IFR-001 の closure は未実施である。

## CI

report / handoff を含む最終 publication commit を push 後、
PR current HEAD と workflow run の `head_sha` が一致する run だけを確認する。

別 SHA の run は代用しない。

## タスク台帳

`tasks/tasks-status.md` は存在しないため更新対象なし。

## マージ境界

マージは行わない。
