# ChatGPT プラグイン配布の実装・検証記録

実行時刻: 2026-09-25T18:04:59+09:00。ChatGPT の実行環境で取得。
対象: PR #2。基点: `8d72bb8dbc9464e03268bc5be39b72cb929f7e11`。

## 結果

配布専用の manifest、Skill、builder、13件の試験、リリース添付 workflow、
日本語の設定手順を追加しました。公開サーバーの実装や接続完了を意味しません。

Python 3.13.5 / Linux の ChatGPT 実行環境で、配布ファイルだけを配置した作業領域を
使いました。GitHub で確認したルート package.json の版 `0.1.0` を生成に使用します。
全ソースの checkout、npm 依存の復元、既存サーバーの全試験は行っていません。

## 試験

`python3 -m unittest discover -s test/plugin-packaging -v`: 13件成功、失敗・skipなし。

確認範囲: ZIP 直下の manifest、未設定 ID の分離、実 ID の無改変参照、全成果物の
SHA-256、同一入力の再現性、CRLF の正規化、許可リスト外の秘密情報の除外、
不正な ID と版の拒否、入力欠損、既存出力先の保護、シンボリックリンク拒否、
manifest の逸脱拒否、実接続確認済みと誤表示しないメタデータ。

実装前の試験は builder 不在による import error で失敗しました。
実装後は12件成功し、Windows の CRLF を想定した1件を追加して13件成功しました。
Python 構文チェックと workflow YAML の読取・release 条件・権限分離の検査も成功しました。

## 実行経路と制限

RDC の全接続先は読み取り確認で offline でした。利用者 PC のファイル、認証、
プロセス、Funnel 設定を変更していません。配布用ファイルは ChatGPT 実行環境で
作成・検証し、GitHub コネクタで専用ブランチへ保存しています。
通常の接続 PC 上での実装・レビュー経路を完了したという報告ではありません。

現在の Project 添付ファイル一覧は空で、以前の Project Skill ZIP は取得できませんでした。
リポジトリ側の skills 参照と CodexSkill の ChatGPT wrapper は確認しましたが、
インストール済みの依存 Skill による工程完了とは扱いません。
既存の `tasks-status.md` と独立レビュー済み PR #1 のブランチは変更していません。

Windows での実行、ChatGPT の ZIP 導入、OAuth、実機操作、Release assets の実添付、
通常レビュー、独立レビューは未実施です。CI 状態は PR #2 の最新コメントで別途記録します。
ソース内で ID を発行・推測せず、実際の ID が指定されないビルドはテンプレートだけを作ります。
Release とプレリリースの published イベントで添付し、失敗時は添付しません。
既存 release の再実行では自分の同名成果物だけを置換し、ID を外した際は古い接続 ZIP を除去します。

## 未コミット入力の識別

以下はローカルで確認した配布入力の SHA-256 です。基点の HEAD を変更後の検証済み
HEAD と誤認しないため、内容を識別しています。提出 commit は PR の更新履歴を参照します。

```text
9457349a7b24008abb8d887b0fef63bdc99e824e32b6263946cc3b237fa38cda  .github/workflows/chatgpt-plugin.yml
c9b37b0f2fff42f74d68cc9c9ff359b95bfa183fd0f08c3b824152ceb9dffc8d  plugins/remotedesktopmcp/.codex-plugin/plugin.json
41cabc692cd5499828e72caef4c5b135baba513cd6f6ed97f470252e80ea3b9e  plugins/remotedesktopmcp/skills/remotedesktopmcp/SKILL.md
8b454ead3d326664706cab2b89cdeacdcb219a4d7e7c4622dc58254a106ccd8d  scripts/build_chatgpt_plugin.py
0121dd7cbdedfd3aed302dd3dc31cd74f2ead2fa4b18318ba608b88e543caabf  test/plugin-packaging/test_build.py
32d94e5dfff534d34d96aae5b3ae71a934f28fc3ab43dd5d8a867a1ee8e3dcfc  doc/chatgpt-setup.md
10545d27deca79601136d8b6291126a7ab5442ae2fcebd01a795b0a48486f95c  tasks/chatgpt-plugin-release.md
```

## 残作業

PR #1 とこの PR のマージ判断、通常・独立レビュー、実際の release と接続試験は
別に必要です。サーバーの公開認証と ChatGPT 接続は既存の F01〜F03 に残ります。
この変更から、公開 URL の発行、ChatGPT の設定変更、ワークスペース権限の変更は行いません。
