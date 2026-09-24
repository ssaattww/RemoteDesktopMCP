[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$FixtureRoot,

    [string]$SecretEnvironmentVariableName = 'RDMCP_BOUNDARY_DUMMY_SECRET'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$workspaceDir = Join-Path $FixtureRoot 'workspace'
$protectedDir = Join-Path $FixtureRoot 'protected'
$protectedFile = Join-Path $protectedDir 'protected.txt'
$boundaryConfigFile = Join-Path $protectedDir 'boundary-config.txt'
$serviceConfigFile = Join-Path $protectedDir 'service-config.txt'
$managementExecutableFile = Join-Path $protectedDir 'management-executable.bin'
$junctionProtectedFile = Join-Path (Join-Path $workspaceDir 'junction-to-protected') 'protected.txt'
$symbolicProtectedFile = Join-Path $workspaceDir 'symlink-to-protected.txt'
$resultPath = Join-Path $workspaceDir 'probe-results.json'
$allowedFile = Join-Path $workspaceDir 'allowed.txt'

function Invoke-DenialCheck {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [scriptblock]$Operation
    )

    try {
        & $Operation
        return [ordered]@{
            name = $Name
            passed = $false
            detail = 'operation unexpectedly succeeded'
        }
    }
    catch {
        return [ordered]@{
            name = $Name
            passed = $true
            detail = $_.Exception.Message
        }
    }
}

function Invoke-ExternalDenied {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [Parameter(Mandatory = $true)]
        [string[]]$ArgumentList
    )

    & $FilePath @ArgumentList *> $null
    if ($LASTEXITCODE -eq 0) {
        throw 'external command unexpectedly succeeded'
    }

    throw "external command denied access with exit code $LASTEXITCODE"
}

$currentUser = (& whoami).Trim()
if ([string]::IsNullOrWhiteSpace($currentUser)) {
    throw 'Could not determine the execution OS user.'
}

Set-Content -LiteralPath $allowedFile -Value 'allowed-write' -Encoding utf8NoBOM
$allowedRead = Get-Content -LiteralPath $allowedFile -Raw
$allowedWorkspacePassed = $allowedRead.Trim() -eq 'allowed-write'

$checks = @()

$checks += Invoke-DenialCheck -Name 'direct-read-protected' -Operation {
    Get-Content -LiteralPath $protectedFile -Raw | Out-Null
}

$checks += Invoke-DenialCheck -Name 'direct-write-protected' -Operation {
    Set-Content -LiteralPath $protectedFile -Value 'CHANGED_BY_DIRECT_WRITE' -Encoding utf8NoBOM
}

$checks += Invoke-DenialCheck -Name 'cmd-read-protected' -Operation {
    Invoke-ExternalDenied -FilePath 'cmd.exe' -ArgumentList @('/d', '/s', '/c', "type `"$protectedFile`"")
}

$checks += Invoke-DenialCheck -Name 'powershell-read-protected' -Operation {
    $escaped = $protectedFile.Replace("'", "''")
    Invoke-ExternalDenied -FilePath 'powershell.exe' -ArgumentList @(
        '-NoProfile',
        '-Command',
        "Get-Content -LiteralPath '$escaped' -Raw | Out-Null"
    )
}

$checks += Invoke-DenialCheck -Name 'node-read-protected' -Operation {
    Invoke-ExternalDenied -FilePath 'node.exe' -ArgumentList @(
        '-e',
        "require('fs').readFileSync(process.argv[1], 'utf8')",
        $protectedFile
    )
}

$checks += Invoke-DenialCheck -Name 'redirect-write-protected' -Operation {
    Invoke-ExternalDenied -FilePath 'cmd.exe' -ArgumentList @(
        '/d',
        '/s',
        '/c',
        "(echo CHANGED_BY_REDIRECT)>`"$protectedFile`""
    )
}

$checks += Invoke-DenialCheck -Name 'descendant-process-read-protected' -Operation {
    $childScript = @'
const { spawnSync } = require("child_process");
const p = process.argv[1];
const escaped = p.replace(/'/g, "''");
const result = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-Command", "Get-Content -LiteralPath '" + escaped + "' -Raw | Out-Null"],
  { stdio: "ignore" }
);
process.exit(result.status === 0 ? 0 : 1);
'@
    Invoke-ExternalDenied -FilePath 'node.exe' -ArgumentList @('-e', $childScript, $protectedFile)
}

$checks += Invoke-DenialCheck -Name 'junction-read-protected' -Operation {
    Get-Content -LiteralPath $junctionProtectedFile -Raw | Out-Null
}

$checks += Invoke-DenialCheck -Name 'symbolic-link-read-protected' -Operation {
    Get-Content -LiteralPath $symbolicProtectedFile -Raw | Out-Null
}

foreach ($target in @(
    @{ Name = 'boundary-config-write'; Path = $boundaryConfigFile },
    @{ Name = 'service-config-write'; Path = $serviceConfigFile },
    @{ Name = 'management-executable-write'; Path = $managementExecutableFile }
)) {
    $name = $target.Name
    $path = $target.Path
    $checks += Invoke-DenialCheck -Name $name -Operation {
        Set-Content -LiteralPath $path -Value 'CHANGED_BY_EXECUTION_IDENTITY' -Encoding utf8NoBOM
    }
}

$secretValue = [Environment]::GetEnvironmentVariable(
    $SecretEnvironmentVariableName,
    [EnvironmentVariableTarget]::Process
)
$secretNotInherited = [string]::IsNullOrEmpty($secretValue)

$allDenied = ($checks | Where-Object { -not $_.passed }).Count -eq 0
$overallPassed = $allowedWorkspacePassed -and $allDenied -and $secretNotInherited

$result = [ordered]@{
    schemaVersion = 1
    executedAt = (Get-Date).ToString('o')
    executionUser = $currentUser
    fixtureRoot = $FixtureRoot
    allowedWorkspacePassed = $allowedWorkspacePassed
    secretEnvironmentVariableName = $SecretEnvironmentVariableName
    secretNotInherited = [string]::IsNullOrEmpty($secretValue)

    checks = $checks
    overallPassed = $overallPassed
}

$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resultPath -Encoding utf8NoBOM
Write-Output ($result | ConvertTo-Json -Depth 8)

if (-not $overallPassed) {
    exit 1
}

exit 0
