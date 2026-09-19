# PR #1 設計レビュー報告

## メタデータ

- リポジトリ: `ssaattww/RemoteDesktopMCP`
- PR: #1
- レビューモード: initial review
- ブランチ: `feat/tailscale-funnel-design-lint`
- ベース: `main`
- reviewed implementation HEAD: `4e6a4bac3c8f7823fa24305d2c640f6e0b188b4b`
- レビュー実行環境: `ibis-ThinkBook-14-G7-IML`
- 作業ディレクトリ: `/home/ibis/CodexProjects/RemoteDesktopMCP`
- レビュアー: この ChatGPT チャットの通常レビュアー
- reviewer continuity: initial review のため前任レビュアーなし

## 目的と範囲

PR #1 の設計について、機能要件、Tailscale Funnel 公開設計、複数 PC 接続設計の相互整合性、認証・認可境界、対象ノード選択、障害時挙動、実装可能性を確認した。

主な対象:

- `doc/design/functional-requirements.md`
- `doc/design/tailscale-funnel-architecture.md`
- `doc/design/multi-pc-architecture.md`
- 設計との差分確認のため `src/index.ts`、`.env.example`
- CI 診断 workflow `.github/workflows/lint.yml`

本レビューでは指摘の実装修正は行わない。

## 対象同一性

レビュー開始時および報告保存直前に、接続 PC 上の対象 worktree が次であることを確認した。

- branch: `feat/tailscale-funnel-design-lint`
- HEAD: `4e6a4bac3c8f7823fa24305d2c640f6e0b188b4b`
- worktree: clean
- remote: `origin = https://github.com/ssaattww/RemoteDesktopMCP.git`

GitHub PR #1 の current HEAD も同じ SHA であることを確認した。

## CI と診断 artifact

対象 HEAD に対応する workflow run として run `35284335055` を確認した。

- job: `lint`
- conclusion: `success`
- artifact: `lint-diagnostics-4e6a4bac3c8f7823fa24305d2c640f6e0b188b4b`
- artifact 内 workflow metadata の `head_sha`: `4e6a4bac3c8f7823fa24305d2c640f6e0b188b4b`

したがって、別 SHA の workflow run を代用していない。

`.github/workflows/lint.yml` は成功・失敗にかかわらず `if: always()` で診断 artifact を保存し、少なくとも npm install と lint の stdout/stderr、結果、環境情報を保存する構成であることを確認した。

## ローカル検証

対象 HEAD で次を実行した。

| コマンド | 結果 |
| --- | --- |
| `npm run lint` | pass |
| `npm run check` | pass |
| `npm run build` | pass |
| `git diff --check` | pass |

stderr に追加の失敗情報はなかった。

## カバレッジ

| 観点 | disposition | 根拠 |
| --- | --- | --- |
| 機能要件と公開設計の整合性 | checked_finding | セッション定義に finding RDMCP-R1 |
| 公開入口とローカル待受 | checked_no_finding | Funnel のみを公開入口とし外部 MCP listener は loopback 限定 |
| Funnel とアプリ認証境界 | checked_no_finding | Funnel を認証境界とせず RemoteDesktopMCP が認証・認可 |
| Google OIDC のユーザー識別 | checked_no_finding | `iss` + `sub` を主キーとする |
| OAuth redirect URI | checked_no_finding | 設計では完全一致を要求し、現実装との差分も明記 |
| トークン失効 | checked_no_finding | 許可ユーザー変更後の旧 access/refresh token 拒否を要求 |
| 複数 PC の公開範囲 | checked_no_finding | Funnel は統括ノード1台だけ |
| ノード間認証 | checked_finding | 認証方式が実装可能な粒度まで確定していない RDMCP-R2 |
| 対象ノード選択 | checked_finding | `node_id` 省略条件が接続状態で変化し得る RDMCP-R3 |
| ローカル実行と遠隔実行の認可経路 | checked_no_finding | 兼任時も同じ認可・監査経路を要求 |
| ノード切断 | checked_no_finding | 別ノードへ振り替えず状態不明を返す |
| 監査追跡 | checked_no_finding | `request_id` で統括・実行ノードを関連付け |
| 現実装との差分 | checked_no_finding | listener、認証、DCR/CIMD、redirect URI、refresh token の差分を明記 |
| lint/check/build | checked_no_finding | 対象 HEAD で全て pass |
| exact-HEAD CI | checked_no_finding | run 35284335055 artifact の head SHA が対象 HEAD と一致 |

## Findings

### RDMCP-R1 — High — MCP 接続と独自セッションの境界が未定義

**Location:**

- `doc/design/functional-requirements.md:16-22`
- `doc/design/multi-pc-architecture.md:178-185`

**Description:**

機能要件は「接続ごとにセッションを識別」「セッションごとに一意な `session_id`」を要求し、複数 PC 設計では統括ノードがそのセッションを管理するとしている。一方、設計が参照している MCP 2026-07-28 系ではプロトコルセッションに依存しない方向へ変更されているため、RemoteDesktopMCP 独自セッションを保持するなら、その開始・継続・終了の境界を別途定義する必要がある。

**Impact:**

現状の記述だけでは、HTTP/MCP のどの事象を同一セッションとみなすか、`session_list` が何を列挙するか、プロセスをどのセッションへ紐付けるかを実装者が独自判断することになる。

**Required action:**

`session_id` を MCP プロトコルセッションとは独立した RemoteDesktopMCP の操作コンテキストとして定義し、その生成、継続、終了、期限、`session_list` の列挙対象を定める。独自セッションが不要なら初期版要件から削除する。

### RDMCP-R2 — High — ノード間相互認証方式が未確定

**Location:**

- `doc/design/multi-pc-architecture.md:79-80`
- `doc/design/multi-pc-architecture.md:102-115`

**Description:**

Tailscale の暗号化だけを認証根拠にせず RemoteDesktopMCP 自身でも相互認証するとしているが、「認証用公開情報」以外の具体的な認証方式が定義されていない。

**Impact:**

鍵種別、所有証明、リプレイ防止、秘密鍵保管、鍵更新・失効が実装者判断になる。実行ノードは認証済みと判断した統括ノードからファイル変更やプロセス操作を受けるため、この境界の仕様不足はセキュリティ設計に直接影響する。

**Required action:**

初期版で採用するノード間認証プロトコルを定義し、少なくとも鍵・資格情報の形式、相互の所有証明、リプレイ防止、ローカル保管、登録、更新、失効、認証失敗時の扱いを設計に追加する。

### RDMCP-R3 — Medium — node_id 省略条件が接続状態によって実行対象を変え得る

**Location:**

- `doc/design/functional-requirements.md:76-77`
- `doc/design/multi-pc-architecture.md:117-135`
- `doc/design/multi-pc-architecture.md:238-249`

**Description:**

「実行可能なノードが1台だけの場合は `node_id` を省略できる」という条件では、複数ノード登録済みの構成で他ノードが切断すると、省略要求が残った1台へ自動的に向かう。

**Impact:**

同一のツール要求でもノードのオンライン状態によって実行対象が変化する。特に `file_patch`、`process_start`、`process_kill` などの変更操作では誤対象実行につながる。

**Required action:**

複数ノードが登録された構成では接続状態にかかわらず `node_id` を必須とするなど、対象選択規則を接続状態から独立させる。検証項目にも、複数登録・1台のみオンライン時に対象未指定要求を拒否するケースを追加する。

## Held / unexplored / unknown

### Held

なし。

### Unexplored

- ChatGPT と CIMD/DCR の実接続互換性は実環境接続試験前のため未検証。設計自身も実接続確認が必要としている。
- Google OIDC の実際の設定値と callback 動作は設計レビュー範囲では実行していない。
- ノード間通信プロトコルそのものは未設計のため、通信実装レビューは実施不能。

### Unknown

- `tasks/tasks-status.md` は現在の worktree に存在しなかったため、このリポジトリに別のタスク台帳規則があるかは確認できなかった。

## Intentionally untouched

レビュー担当として、設計、実装、workflow、設定、タスク管理の修正は行っていない。

## Verdict

fail

RDMCP-R1 と RDMCP-R2 は実装時の契約またはセキュリティ境界を実装者判断に残すため、設計修正後に fix verification が必要である。RDMCP-R3 も対象 PC の決定規則として修正が必要である。

## 次のアクション

実装担当で RDMCP-R1〜RDMCP-R3 を設計へ反映し、コミット後、この通常レビューチャットで fix verification を行う。

## Merge boundary

本レビューでは merge を行わない。
