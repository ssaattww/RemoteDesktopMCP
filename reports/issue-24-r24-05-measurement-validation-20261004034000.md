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

登録後のローカル全gate、manifest commit、Windows上での`applied`確認およびその最終HEADのrequired CI 3回はこれから行う。測定artifact自体は全件成功だが、Issue #24はこれだけでは完了しない。性能比較ではPR #63の最大Windows Test中央値272秒と、PR #66の測定前CI最大Windows Test中央値256秒を記述的に比較できる。16秒差は単発の構成比較に過ぎず、測定manifestの最適化効果とは認定しない。PR #66測定後の5 shard CI結果を別に評価する。3分達成は必須CIの各回全体が180秒以下の場合に限る。
