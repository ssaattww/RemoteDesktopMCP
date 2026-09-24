# PR #1 製品観点再レビュー — 実行権限モデル明確化

## 判定

- product content target: `1cefa9c701a683c054e0718bab1e009ab6ec32dd`
- review-record-only current HEAD at start: `89ecd4a60d8db8438a1749af6d8cd50324a456a1`
- review mode: product-only re-review
- verdict: **fail**
- product finding: **RDMCP-IFR-002 / Medium 1件**
- previous RDMCP-IFR-001 / High: **resolved by authoritative requirement clarification**
- review time: 2026-09-24T21:44:38+09:00

利用者から、`process_start` の実行権限はMCPサーバーを起動したOSユーザーの権限でよく、
そのために別OSユーザーや新規サンドボックスを必須にする必要はない、と明確化された。

今回は開発手法、レビュー順序、completeness matrix、独立closure手順を製品不具合として扱わない。
製品・設計上の実質だけを確認した。

## RDMCP-IFR-001 の扱い

RDMCP-IFR-001 は、`process_start` からMCPサーバー実行ユーザーが読める秘密設定へ到達できることを
製品上の権限境界違反として扱っていた。

今回の仕様明確化により、認証済み利用者が `process_start` を通してMCPサーバー実行ユーザーと
同じOS権限を行使すること自体が許容される。
この前提では、同じOSユーザーの権限内で設定やファイルへ到達できることは権限昇格ではない。
したがって、RDMCP-IFR-001 の根拠となった「別OSユーザーで強制隔離しなければならない」という要求は
現在の製品要件には適用しない。

これは過去のfindingを無かったことにするものではない。
当時の要求解釈ではHigh findingだったが、利用者による要件明確化で前提が変更されたため、
現在の製品仕様ではresolvedとする。

同じ理由で、前回追加した「管理側と実行ワーカー間の制御チャネルを、
同じOSユーザーの任意プロセスからさらに隔離する必要がある」という指摘も製品findingとして撤回する。
`process_start` が任意コードを同一OSユーザー権限で実行できる製品なら、
そのユーザー権限内の操作を追加の権限昇格とは扱わない。

## RDMCP-IFR-002 — Medium — 現行設計が意図より強い隔離を必須化している

### 問題

現在の設計は、次を初期版の必須条件としている。

- 管理側とDesktop Commander実行側を別OSユーザーに分離する。
- 実行側を専用標準ユーザーとしてWindowsサービスで起動する。
- OS ACLで管理領域から隔離する。
- 分離やACLを確認できなければ `process_start` を利用不可にする。
- 実配備2ユーザー構成を前提に境界fixtureを実行する。

これは今回明確化された製品要件より強い。
利用者が許容する構成では、MCPサーバーとDesktop Commander、`process_start` の子プロセスは
同じOSユーザー権限で動作してよい。
現行設計のままだと、この正当な構成で `process_start` が利用不可になり得る。

### 影響

- 初期版の主要機能である `process_start` が、不要な別ユーザー配備をしないだけで無効になる。
- Windowsサービス、専用ユーザー、ACL、専用fixtureが必須となり、配備構成が製品要件以上に複雑になる。
- 本来許容する「MCPサーバー実行ユーザー権限でのリモート操作」と設計本文が矛盾する。

### 必要な修正

初期版の基本trust modelを次のように整理する。

1. 認証済みの許可ユーザーは、`process_start` を通してMCPサーバー実行OSユーザーと同等の権限を行使できる。
2. `process_start` で起動するプロセスは、原則としてMCPサーバー実行ユーザーと同じOS権限で動かしてよい。
3. `file_*` の許可ディレクトリはfile toolの操作範囲を制限するものであり、任意コマンド実行に対するサンドボックスとは扱わない。
4. MCPサーバー実行ユーザーが読めるファイルや設定は、任意コマンドからも到達可能であることを運用上のtrust boundaryとして明記する。
5. 別OSユーザー、ACL分離、追加サンドボックスは必要なら任意のhardeningとして扱い、初期版の必須条件にしない。
6. そのhardeningを導入していないことだけを理由に `process_start` を無効化しない。

この変更ではDesktop Commanderの再利用方針は変わらない。
新しいサンドボックス実装も要求しない。

## その他の製品観点

現行設計の次の点について、今回の仕様明確化後に新たなblocking findingは確認しなかった。

- OAuth/OIDCで許可ユーザー1名を識別する方針
- RemoteDesktopMCP独自の `session_id`
- 登録ノード数による `node_id` 必須判定
- ノード間PSK/HMAC/HKDFとsequenceによる再送防止
- Desktop Commander 0.2.50への委譲
- stdout/stderrを推測せず統合出力として扱う仕様
- `desktop_commander_generation` と `current_process_owner` によるPID再利用対策
- 同一世代のprocess操作を直列化し、ロック取得後にownerを再確認するRDMCP-R8対策

RDMCP-R8については、設計本文上は以前のTOCTOU指摘に対する必要条件が維持されている。
開発手法上の「通常レビュー未完了」は今回の製品findingには含めない。

## 検証状態

product content target `1cefa9c7` に一致するGitHub Actions lint run
`35998579435` はcompleted / successである。

現行current HEAD `89ecd4a6` は、`1cefa9c7` に製品観点レビュー報告2ファイルだけを追加したcommitで、
製品・設計本文の差分はない。
前回のcurrent-HEAD CIはrun `36000723364` successとして記録されている。

今回の判定変更はコード変更によるものではなく、利用者による製品trust modelの明確化に基づく。

## 次のアクション

設計担当はRDMCP-IFR-002として、別OSユーザーを初期版必須とする記述を外し、
同一OSユーザー権限を基本trust modelとして明記する。

Windowsサービス、専用実行ユーザー、ACL分離、execution-boundary fixtureは、
必須製品仕様から外す。将来の任意hardeningとして残すか削除するかは実装側で決めてよい。

この報告は製品観点のレビューであり、開発手法やreview processの完了判定ではない。
マージは行わない。
