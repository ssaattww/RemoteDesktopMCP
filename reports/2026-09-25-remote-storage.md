# 公開認証の保存領域保護

## タスクと範囲

REMOTE-NR-002 / P1 に対応する Windows ACL と保存領域の検査を実装する。
対象は `src/private-storage.ts`、`test/private-storage.test.ts` と本報告。
既存の公開認証への組込みは元の実装担当が行う。実際の `.env` と資格情報を読まない。

## Dispatch profile

- selection inputs: implementation, bounded_technical, medium uncertainty, cross_module, high criticality, single repetition, independent_workstreams, fresh context.
- selection source: user_override; 実装 Terra / high。
- decomposition policy / disposition: allowed; 保存領域の helper と専用試験を独立分担。
- requested profile: gpt-5.6-terra / high / fork_turns none.
- agent role / default-role plan: ツールの既定 role。別の role 切替フィールドなし。
- role config evidence / profile effect: 公開ツール定義の model と reasoning_effort を指定、別 role による変更設定なし。
- planned runtime profile: gpt-5.6-terra / high.
- applied profile: null.
- application status: spawn_succeeded_profile_unverified; identity /root/remote_private_storage.
- runtime profile observability: final_profile_hidden.
- approval: not_required; 利用者が明示指定。
- fork policy: none. 異なる作業なので新規担当。

## 結果

`src/private-storage.ts` に次を追加した。

- Windows では静的な PowerShell スクリプトへ標準入力の JSON で対象パスだけを渡す。現在の `SID`、`SYSTEM`、`Administrators` だけに完全制御を設定し、継承無効、所有者、許可規則を再読して検査する。子プロセスには `GOOGLE_CLIENT_SECRET`、`TOKEN_SECRET`、PowerShell 7 のモジュール探索設定を渡さない。
- POSIX ではディレクトリを 0700、ファイルを 0600 にし、現在の `UID` 所有を確認する。
- 既存のファイル、保存用ディレクトリ、親ディレクトリを検査する。親が安全でない場合は、新しいファイルへ内容を書き込む前に拒否する。新規ファイルは空のファイルを保護・再検査してから内容を書き込む。
- 一時ファイルを保護した状態で作り、名前変更後もファイルを再検査できる API を提供する。
- 親ディレクトリ用の `assertSafePrivateParent` を分けた。親は一般利用者が読めてもよいが、一般利用者に書込み、削除、作成、アクセス規則変更、所有者変更の許可がある場合は拒否する。root と repository のアクセス規則は変更しない。

`test/private-storage.test.ts` は `reference/validation` 内の空の専用ディレクトリを実際に保護してから、Windows のアクセス規則による新規作成、既存ファイルの広い許可拒否、読み取り専用の一般親での作成成功、書込み可能な一般親の拒否、一時ファイルの名前変更後再検査を確認する。POSIX の同じ契約は POSIX 実行時に走る。

| 対象 | helper の契約 | Windows 実測 |
| --- | --- | --- |
| 秘密を持つ leaf | 現在の利用者、`SYSTEM`、`Administrators` だけを許可し、所有者と継承なしを再検査する。 | 新規作成と名前変更後を確認し、読み取り許可を追加した既存ファイルを拒否。 |
| 一般親 | 現在の利用者、`SYSTEM`、`Administrators` のいずれかが所有し、一般利用者の読み取り専用を許容する。 | 読み取り許可を追加した親で、新規 leaf を保護してから内容を書き込めることを確認。 |
| 危険な親 | 一般利用者の書込み、削除、作成、アクセス規則変更、所有者変更を拒否する。 | 書込み可能な ACL を追加した親で、秘密を持つファイルの作成を拒否。 |
| 別の所有者を持つ親 | 読み取り専用の許可規則でも、許可主体外の owner を拒否する。 | `Users` SID へ実際に owner を変更した親で、親検査と秘密ファイル作成を拒否。 |

既存の HTTP fixture も、秘密を書き込む前の空の `DATA_DIR` を `protectPrivateDirectory` で保護してから `RemoteDesktopService` を初期化するようにした。この変更は親の明示許可で `test/fixture.ts` に限定した。

限定確認（Windows / PowerShell / `C:\Users\donabe\Project\RemoteDesktopMCP`）:

- `npx.cmd tsx --test test/private-storage.test.ts`: Windows 1件成功、POSIX 1件省略。読み取り専用親と書込み可能親を Windows ACL で実測した。
- `npx.cmd eslint src/private-storage.ts test/private-storage.test.ts test/fixture.ts`: 成功。
- `npx.cmd tsc -p tsconfig.json --noEmit`: 成功。

実際の `.env`、Google 資格情報、実運用 `DATA_DIR` は読取・変更していない。全体試験、`commit`、`push` は親の工程である。
