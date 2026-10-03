# 使用者コンソール日時相対表示 修正確認

## 対象

- repository: `ssaattww/RemoteDesktopMCP`
- Issue: #44
- PR: #50
- mode: fix verification
- initial reviewed implementation HEAD: `4102253628d4d638c26fa5c3a986082a53fe9e59`
- closure candidate HEAD: `f9b60a5ea3fb7b7138efee0a020ba46661b106bb`
- reviewer continuity: 初回reportに安定したchat識別子がないため、このchatはreplacement normal reviewerとして確認する。初回finding IDとseverityは変更しない。

## 結論

verdict: **fail**

`PR50-REV-001` は修正確認済みでclosed。`PR50-REV-002` はMediumのrequired validationとしてopenのまま。severity reclassificationは行っていない。

## Finding closure

### PR50-REV-001 — Medium — closed

`package.json` の `lint:md:terms:design` に `doc/design/使用者コンソール日時相対表示.md` が追加されていることを確認した。whitelist語追加や対象除外はない。

finding completeness:

- required action: 新設計書を設計用語lint対象へ追加し、通常lintを実行する。
- production path: `package.json` の `lint:md:terms:design`。
- actual composition fixture: exact-head GitHub Actions run `37084848590` の Ubuntu `Run lint` step。通常の `npm run lint` 経由で設計用語lintを含め実行する。
- focused evidence: run `37084848590` は `headSha=f9b60a5ea3fb7b7138efee0a020ba46661b106bb`。確認時点で Ubuntu job はlint/check/build/testを含めsuccess。ローカル再実行は `yaml` package不足により `ERR_MODULE_NOT_FOUND` で実行前に失敗したため、ローカル成功証拠には数えない。

このfindingはclosedとする。

### PR50-REV-002 — Medium — open

初回required validationで要求された実ブラウザー・支援技術の確認証拠はまだ提示されていない。既存PRコメントの「held」という表現はfindingの再分類ではなく、source findingはMedium required validationのままとする。

必要証拠は、作成日時・最終アクセス日時の両方について、ポインター操作、キーボードのみの開閉、年月日・時分秒・JST表示、支援技術からの開閉状態と正確な日時、一覧再描画後の開閉/focus保持である。利用者が実UI確認を担当するため、その結果が得られるまでopenとする。

## CI状態

closure candidate HEAD `f9b60a5ea3fb7b7138efee0a020ba46661b106bb` に一致する `pull_request` run `37084848590` を確認した。

確認時点では Ubuntu と Windows shard 2/3 がsuccess、Windows shard 1/3と3/3がin progressだった。ユーザー指示によりCI完了待ちは行っていない。別SHAのrunは代用しない。

## 次工程

`PR50-REV-002` の実UI確認結果が提示された後、同findingだけを限定確認する。mergeは行わない。
