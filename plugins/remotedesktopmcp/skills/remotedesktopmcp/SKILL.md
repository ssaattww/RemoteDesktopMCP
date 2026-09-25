---
name: remotedesktopmcp
description: Use when the user explicitly requests RemoteDesktopMCP to inspect or operate their authorized remote computer, files, or processes. Requires a separately connected RemoteDesktopMCP server.
---

# RemoteDesktopMCP

## 接続と対象の確認

現在利用できるツールから RemoteDesktopMCP の接続を確認する。
このプラグインを導入しただけで、MCP の登録や認証が済んだと判断しない。
接続がなければ、未接続であることと必要な設定だけを伝える。
公開版 Remote Desktop Commander と自作 RemoteDesktopMCP を区別する。
利用者の指示なしに別の接続先や別 PC へ切り替えない。

ツールの実際の定義を読み、読取操作で対象 PC と作業場所を確認する。
返された識別子を使い、PC 名、ノード ID、パス、成功結果を推測しない。
複数の対象があって操作先を決められない場合は、変更前に利用者へ確認する。

## 操作

利用者が依頼した範囲で、読取、編集、転送、プロセス操作を行う。
変更前に既存の内容を読み、無関係な作業を上書きしない。
プロセスは MCP サーバーの OS ユーザー権限で動く。独自サンドボックスが
存在する、管理者権限が付く、子孫プロセスを必ず停止できるとは説明しない。
権限昇格、認証設定変更、サービスの公開、アクセス制御の変更は、別途許可が
ない限り行わない。読取専用ツールを装って書込確認を回避しない。

返り値の保留、未確認、期限切れ、失敗を成功へ読み替えない。
タイムアウトした書込や起動を、状態確認なしに再実行しない。
操作後は読取や状態取得で結果を確認し、確認できない部分を明示する。
秘密鍵、パスワード、アクセストークンを報告や配布物へ含めない。

## 報告

確認した PC、変更内容、実行結果、未検証範囲を簡潔に報告する。
ZIP の生成成功、ChatGPT への導入、MCP の接続、実機の操作成功を区別する。
