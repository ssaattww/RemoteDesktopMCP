# R24-05 測定artifact検証とmanifest登録

## 対象と結果

- PR: #66（draft、未merge）
- 測定workflow run: `37171154214`、attempt 1、成功
- PR head: `771eccdc34c473f8e3a835ad0b9343c98167b4a2`
- workflow checkout / `sourceCommit`: `0a41b970c59ed10e41b81319f535773272fdece6`
- artifact: `test-runtime-measurement-37171154214-1-0a41b970c59ed10e41b81319f535773272fdece6.zip` (`11292268933`)
- artifact SHA-256: `5e3437e369f1ead923228a9618f934bed4ccb559e415e26750a42f6e899969be`
- 実測記録期間: 2026-10-04 02:29:17.711Z〜03:35:49.250Z。測定stepは約66分33秒、workflow全体は67分31秒。これは通常のrequired CI所要時間とは別に扱う。
- workflowのskip判定、依存導入、metadata解決、test measurement、artifact uploadはすべてsuccess。測定中にPR #66のrequired CIは実行されておらず、直前のrequired CI完了から測定開始まで約6分43秒あった。repo全体で他のCIがなかったことは確認しておらず、全体の非並行性や因果効果は主張しない。

## Artifact検証

Artifact内にはmanifest 1件とJSON記録72件がある。対象24 test filesはそれぞれ3回記録され、全72件が`success`、exit code 0、同じrun/job/commitに紐づくことを確認した。manifestの全24中央値は対応する3測定値の中央値と一致する。Artifactのローカル再計算SHA-256はGitHubのartifact digestと一致した。

全レコードの実行環境はWindows / `windows-latest` / `win32` / `x64` / `10.0.26100` / Node `v22.23.3` / npm `10.9.9`、lockfile SHA-256 `f153a51e7f8b4592fcea9b9c6ecfaa4fd3fc9912bcf7d410a54c7fb39829067d`。Manifest fingerprintは`ae6cb758ca3586c66d470c2583121b456b83b63827315472a7d62cb9e674b002`。artifact中の測定checkoutで得られた値であり、WindowsのCRLF内容でfingerprintを再計算すると一致した。Git blobのLF内容による値とは異なるが、CI上のWindows checkoutに対する適用確認はmanifest登録後のrequired CIで行う。

## ファイル別の3回測定と中央値

秒単位。各行の3値は昇順で記載。

| Test file | 3回の測定 (秒) | 中央値 (秒) |
| --- | ---: | ---: |
| `test/admin.test.ts` | 81.103 / 84.238 / 91.221 | 84.238 |
| `test/ci-test-scheduler.test.ts` | 0.598 / 0.693 / 1.059 | 0.693 |
| `test/config-correlation-regression.test.ts` | 30.083 / 30.936 / 34.778 | 30.936 |
| `test/config-transfer-integrity.test.ts` | 133.138 / 138.276 / 148.232 | 138.276 |
| `test/desktop-commander-ownership.test.ts` | 0.600 / 0.705 / 0.710 | 0.705 |
| `test/emergency-stop-backend.test.ts` | 13.950 / 14.613 / 15.569 | 14.613 |
| `test/emergency-stop-windows.test.ts` | 29.132 / 30.185 / 35.000 | 30.185 |
| `test/emergency-stop.test.ts` | 86.446 / 89.247 / 89.334 | 89.247 |
| `test/fixture-runtime.test.ts` | 1.851 / 1.857 / 1.959 | 1.857 |
| `test/http-oauth-regression.test.ts` | 26.805 / 27.221 / 27.977 | 27.221 |
| `test/independent-config-history.test.ts` | 56.369 / 56.641 / 56.872 | 56.641 |
| `test/independent-process-ownership.test.ts` | 73.383 / 75.044 / 77.625 | 75.044 |
| `test/independent-transfer-lifecycle.test.ts` | 91.275 / 91.486 / 91.831 | 91.486 |
| `test/mvp.test.ts` | 36.727 / 37.208 / 37.335 | 37.208 |
| `test/operation-audit-details.test.ts` | 156.137 / 159.929 / 161.582 | 159.929 |
| `test/private-storage.test.ts` | 30.388 / 32.209 / 32.430 | 32.209 |
| `test/public-auth.test.ts` | 112.457 / 118.453 / 120.804 | 118.453 |
| `test/search-process-lifecycle.test.ts` | 66.421 / 68.587 / 70.766 | 68.587 |
| `test/session-filesystem-lifecycle.test.ts` | 66.417 / 68.788 / 70.473 | 68.788 |
| `test/session-time.test.ts` | 0.290 / 0.303 / 0.352 | 0.303 |
| `test/tool-root-contracts.test.ts` | 75.619 / 78.027 / 78.536 | 78.027 |
| `test/user-console-client.test.ts` | 0.909 / 0.911 / 1.070 | 0.911 |
| `test/user-console.test.ts` | 114.056 / 114.463 / 121.822 | 114.463 |
| `test/windows-job.test.ts` | 3.750 / 3.828 / 12.380 | 3.828 |

## 適用確認と残作業

Artifactから候補manifestを`.github/test-duration-manifest.json`へ登録した。schema、24件の正確なpath coverage、正のmedian値を確認し、schedulerの`selectManifest`へmanifestと同一のenvironment/fingerprint、生成時刻後のworkflow時刻を渡した結果は`mode=optimized`、`manifestStatus=applied`、24 durationsだった。これは関数契約の検証であり、Linux上の現在checkoutはWindows runner環境と異なるため、実際のWindows fingerprint一致の証明とは区別する。

当時のLinux環境での関数契約確認の結果を記録した。manifest登録後のローカルgateとWindows `applied`確認、required CIは後続節に記載する。Issue #24は全体workflowが180秒以内の条件を満たすまで未完了とする。

## 登録後のrequired CI（同一HEAD 3回）

- manifest登録commit / PR head: `5e162448c02addf515b289b0d2130ef5dc52c135`
- required workflow run: `37175240494`。attempt 1/2/3はすべて同一headで、Windows assignment artifactも各attemptに生成され、3回とも`mode=optimized` / `manifestStatus=applied` / 同じfingerprintだった。UbuntuとWindows shard 1〜5を含む全jobが各attemptでsuccess。
- 設計主指標（attempt `created_at` → 全jobs中の最大`completed_at`）: 278 / 260 / 263秒。中央値263秒、最大278秒。
- 副指標（`run_started_at` → 同じ最終jobの`completed_at`）: 278 / 261 / 264秒。中央値264秒、最大278秒。以前の278/262/264秒は`run_started_at`→run `updated_at`で算出した値であり、主指標としては置き換える。
- Windows Test stepのshard別秒:

| Attempt | shard 1 | shard 2 | shard 3 | shard 4 | shard 5 | 最大 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 184 | 185 | 144 | 167 | 108 | 185 |
| 2 | 137 | 129 | 145 | 154 | 106 | 154 |
| 3 | 174 | 131 | 141 | 112 | 181 | 181 |

3回の最大Windows Test中央値は181秒、最大185秒。PR #63の3-shard最大Windows Test中央値272秒との観測差は91秒（約33.5%）。PR #66のmanifest前CI 3回の最大Windows Test中央値256秒との観測差は75秒。どちらも小標本のrun比較であり、PR #63のCIと候補CIのマシン・同時負荷などを統制していないため因果効果とは認定しない。

設計主指標は各回180秒を超過し、中央値263秒。副指標中央値264秒。したがって3分達成は未達。Windows最大stepの観測中央値はPR #63基準から80秒以上減ったが、全workflow目標は別途未達。R24-05の設計上の測定・manifest適用・required CI 3回は完了、Issue #24全体は未完了。PR #66はdraft/open/unmerged。kero最終レビューは実装合格・報告時刻指摘KERO-R24-05-001の修正待ち。

登録後ローカルgate（Linux checkout）も成功: `npm test` 135件（124 pass / 11 skip / 0 fail）、`npm run check`、`npm run build`、`npm run lint`、Markdown lint（94 files / 0 issues）、design whitelist lint、`git diff --check`。Windows固有挙動の根拠にはGitHub Windows CIのみを用いる。

## 時刻定義の訂正 — KERO-R24-05-001（P2）

### 主指標と採用フィールド

設計書の主指標は各workflow attemptのAPI `created_at`から、そのattemptに属する全jobのうち最後に完了したjobの`completed_at`までとする。所要秒はUTC ISO-8601時刻をepoch秒へ変換し、`max(jobs[].completed_at) - run.created_at`で求めた。Job APIは各attempt endpointの`/jobs?per_page=100`から全7 jobsを取得した。runオブジェクトの`updated_at`は最終job完了時刻の代用にしない。

副指標は設計に従い、`run_started_at`から同じ最終job `completed_at`までを併記する。待ち時間を作成時刻との差から推定して補わない。各attemptのcreated/startに1秒逆転がある場合もAPI値をそのまま使う。

| Attempt | `created_at` (UTC) | `run_started_at` (UTC) | 最終job `completed_at` (UTC) | 最終job | 主指標 (秒) | 副指標 (秒) | 180秒までの超過 (秒) |
| ---: | --- | --- | --- | --- | ---: | ---: | ---: |
| 1 | 2026-10-04T04:07:29Z | 2026-10-04T04:07:29Z | 2026-10-04T04:11:56Z | Windows shard 1/5 | 267 | 267 | 87 |
| 2 | 2026-10-04T04:12:28Z | 2026-10-04T04:12:27Z | 2026-10-04T04:16:54Z | Windows shard 1/5 | 266 | 267 | 86 |
| 3 | 2026-10-04T04:17:26Z | 2026-10-04T04:17:25Z | 2026-10-04T04:22:02Z | Windows shard 2/5 | 276 | 277 | 96 |

主指標は中央値267秒、最大276秒。3回すべて180秒を超える。副指標は267/267/277秒。Attempt 2/3ではAPI `run_started_at`が`created_at`より1秒早い。これはAPIの値のまま記録し、待ち時間を推定で埋めない。従来の268/268/278秒は`run_started_at`→run `updated_at`の値なので、作成→最終job完了の設計主指標としては撤回する。旧値を引用した過去コメントは履歴として保持し、この訂正コメントから置き換える。

根拠API: [attempt 1](https://api.github.com/repos/ssaattww/RemoteDesktopMCP/actions/runs/37176081921/attempts/1)、[attempt 2](https://api.github.com/repos/ssaattww/RemoteDesktopMCP/actions/runs/37176081921/attempts/2)、[attempt 3](https://api.github.com/repos/ssaattww/RemoteDesktopMCP/actions/runs/37176081921/attempts/3)、および各attemptの[`jobs?per_page=100`](https://api.github.com/repos/ssaattww/RemoteDesktopMCP/actions/runs/37176081921/attempts/3/jobs?per_page=100)（attempt 1/2も同じendpoint形式）。

### Critical pathと残り時間

各attemptの最後に完了したWindows jobと、そのtest stepは次のとおり。job全体からtest stepを引いた値はWindows job内の準備・後処理を表す参考値であり、実時間の単一処理とみなさない。

| Attempt | 最終Windows jobの開始 | Job全体 (秒) | Test step (秒) | その他のjob内時間 (秒) | 作成からjob開始 (秒) | 主指標 |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 2026-10-04T04:07:53Z | 243 | 174 | 69 | 24 | 267 |
| 2 | 2026-10-04T04:12:50Z | 244 | 183 | 61 | 22 | 266 |
| 3 | 2026-10-04T04:18:13Z | 229 | 171 | 58 | 47 | 276 |

Critical pathのjob内準備にはcheckout 5/5/5秒、Node setup 12/9/8秒、dependency install (`npm ci`) 32/30/27秒、type check 6/5/4秒、build 4/5/5秒などを含む。さらにworkflow作成から最終Windows job開始まで24/22/47秒がある。主指標から180秒を引いた残りは87/86/96秒（中央値87秒）で、`Test` stepのみを短くする案では完了時間を説明できない。Attempt 3では最後のjobがshard 2/5だが、最大個別Test stepはshard 1/5の176秒であり、最大stepと最後に完了したjobも区別する。

### Assignment JSONとartifact取得範囲

3 attempt分のplan JSONを正確に保存した。各planはrun `37176081921`、PR head `3b5f24565dec2fcf21f92ac22286ab8e913efecb`に対するGitHub synthetic merge `sourceCommit=ee14c152e7733f0eaa0762fbffde2adefe78019a`、5 shard、`optimized` / `applied`、fingerprint `ae6cb758ca3586c66d470c2583121b456b83b63827315472a7d62cb9e674b002`を持つ。各file群は5/4/7/4/4件。JSONは`reports/issue24-r24-05-assignment-evidence/attempt-{1,2,3}.json`にあり、各plan digestと保存JSON SHA-256は以下。

| Attempt | Artifact ID | 保存plan digest | 保存JSON SHA-256 | ZIP SHA-256と取得範囲 |
| ---: | ---: | --- | --- | --- |
| 1 | `11293136850` | `0cb02602d628d5a174ad1704e8a5820de03e8b20cfa7d183000d83c021293432` | `2119b5f1e497f2cc660cb6fca95fc46ded2d3d0884ed33208c53166be7094e84` | `9d5837bc0fee34a53571f82ae5b7bcad849ebd7f24f48ff73b5af6539b939ddc`（保存済みZIPのSHA-256は当時のGitHub artifact digestと一致。後のreviewer再取得は404） |
| 2 | `11294000613` | `e810e413f5aa7bec7d5af23477f963e50f55ce82eff12c77f22139c6504e8113` | `fd5f876214b52607a9dcff1b3221c9f6e6f2c9e5a56d6384bcc9244b95f4374c` | `acaa647d64196d594ddb944a2e040a0397dd94541179b1d09ada11740df94757`（作者が保存したZIPのローカルSHA-256。後のGitHub digest再取得はできず、reviewer再取得も404） |
| 3 | `11293647137` | `1a7e72eab7b51be021d142f8b2b6474cf27e9244263892c29521c66fb6ff7b6e` | `3f0405fdf1e486f0e2b7748a38ccf14fd34ef00539bc6a3730d3f1c28cb8ba56` | `e5eb92855141975ce7a23dff71bfe6f79347a3ba6864649f2bbe91008826014d`（保存済みZIP SHA-256はGitHub artifact digestと一致。reviewerが独立再取得・照合） |

Attempt 1/2 JSONは作者がGitHub artifact download経由で取得した時点の保存物で、後のreviewer独立再取得を意味しない。Attempt 3はreviewer自身が独立取得した範囲である。GitHub artifact一覧の現在値にはattempt 3のassignmentしか残っていない。作者保存JSONとZIPを消さずに差分照合可能な形で保持した。

### 訂正の及ぶ範囲

過去PR/Issueコメントとreport本文にある268/268/278秒は`run_started_at`→`updated_at`として扱い、設計主指標として参照しない。正しい主指標はcreated→last completed jobの267/266/276秒。Windows Test stepの174/183/176秒および、PR #63基準272秒との差96秒（観測比較）の計算は変更しない。3分未達の結論も変わらない。
