# Windows 実行権限境界 fixture

## 目的

RDMCP-IFR-001 で要求された、RemoteDesktopMCP の管理側と
Desktop Commander の実行側を別 OS ユーザーへ分離する構成を、
実際の配備と同じ実行主体で確認するための fixture である。

この fixture は実際の認証情報や監査ログを使用しない。
専用の作業ディレクトリ、保護ディレクトリ、ダミー秘密情報だけを使用する。

## 前提

次が実装・配備済みであること。

- RemoteDesktopMCP の管理側プロセスと実行ワーカーが別 OS ユーザーで動作する。
- 実行ワーカーが Desktop Commander を起動する。
- `process_start` が実行ワーカー経由でコマンドを起動する。
- 管理側の秘密環境変数を実行側へ継承しない。
- 管理側と実行側の OS ユーザー名が分かっている。

この fixture 自体は OS ユーザーを作成しない。
ユーザー作成、サービス登録、OS 権限変更などの配備操作は
RemoteDesktopMCP の配備手順で行う。

## 構成

- `Prepare-BoundaryFixture.ps1`
  - 管理側ユーザーで実行する。
  - ダミーの保護領域と作業領域を作る。
  - 実行側ユーザーに作業領域の変更権限を与え、保護領域へのアクセスを拒否する。
  - 保護ファイルの初期ハッシュと実行ユーザーを manifest に記録する。
  - 保護領域を指す junction と symbolic link を作る。
- `Probe-BoundaryFixture.ps1`
  - **実際の RemoteDesktopMCP の `process_start` から**実行する。
  - 許可された作業領域の読み書きが成功することを確認する。
  - 保護領域への直接アクセス、シェル、PowerShell、Node.js、
    リダイレクト、子孫プロセス、junction、symbolic link 経由のアクセスが
    拒否されることを確認する。
  - 管理側だけに設定したダミー秘密環境変数が見えないことを確認する。
- `Verify-BoundaryFixture.ps1`
  - 管理側ユーザーで実行する。
  - Probe の実行ユーザーが想定どおりであること、
    すべての拒否試験が成功したこと、
    保護ファイルのハッシュが変化していないことを確認する。

## 実行手順

1. 管理側ユーザーで fixture を準備する。

```powershell
$fixture = 'C:\Temp\rdmcp-boundary-fixture'
.\test\execution-boundary\windows\Prepare-BoundaryFixture.ps1 `
  -FixtureRoot $fixture `
  -ExecutionUser 'FA780\rdmcp-exec'
```

1. RemoteDesktopMCP の**管理側プロセスだけ**に、
   manifest の `dummySecretName` と `dummySecretValue` を環境変数として設定する。

1. 配備した RemoteDesktopMCP を起動する。
   実行ワーカー / Desktop Commander 側にはこの環境変数を設定しない。

1. RemoteDesktopMCP の `process_start` から次を実行する。

```powershell
powershell.exe -NoProfile -File <repo>\test\execution-boundary\windows\Probe-BoundaryFixture.ps1 `
  -FixtureRoot C:\Temp\rdmcp-boundary-fixture
```

1. 管理側ユーザーで結果を検証する。

```powershell
.\test\execution-boundary\windows\Verify-BoundaryFixture.ps1 `
  -FixtureRoot C:\Temp\rdmcp-boundary-fixture
```

## 合格条件

- Probe の実行ユーザーが manifest の `executionUser` と一致する。
- 作業ディレクトリの読み書きに成功する。
- 保護ファイルへの全アクセス方法が拒否される。
- Probe からダミー秘密環境変数を取得できない。
- 保護ファイルの SHA-256 が準備時から変化していない。
- Probe と Verify がともに終了コード 0 で終了する。

## 注意

この fixture を同一 OS ユーザーだけで実行した結果は、
RDMCP-IFR-001 の focused evidence として扱わない。

また、スクリプトの構文検査だけを実施した結果も、
実配備の権限境界を確認した evidence にはならない。
