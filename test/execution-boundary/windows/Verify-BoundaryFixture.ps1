[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$FixtureRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$protectedDir = Join-Path $FixtureRoot 'protected'
$workspaceDir = Join-Path $FixtureRoot 'workspace'
$manifestFile = Join-Path $protectedDir 'manifest.json'
$probeResultFile = Join-Path $workspaceDir 'probe-results.json'

if (-not (Test-Path -LiteralPath $manifestFile)) {
    throw "Fixture manifest not found: $manifestFile"
}
if (-not (Test-Path -LiteralPath $probeResultFile)) {
    throw "Probe result not found: $probeResultFile"
}

$manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
$probe = Get-Content -LiteralPath $probeResultFile -Raw | ConvertFrom-Json
$currentUser = (& whoami).Trim()

$checks = @()

$checks += [ordered]@{
    name = 'management-user-matches'
    passed = $currentUser -ieq [string]$manifest.managementUser
    expected = [string]$manifest.managementUser
    actual = $currentUser
}

$checks += [ordered]@{
    name = 'execution-user-matches'
    passed = ([string]$probe.executionUser) -ieq ([string]$manifest.executionUser)
    expected = [string]$manifest.executionUser
    actual = [string]$probe.executionUser
}

$checks += [ordered]@{
    name = 'probe-overall-passed'
    passed = [bool]$probe.overallPassed
    expected = $true
    actual = [bool]$probe.overallPassed
}

$protectedTargets = @(
    @{ Name = 'protectedFile'; Path = [string]$manifest.protectedFile },
    @{ Name = 'boundaryConfigFile'; Path = [string]$manifest.boundaryConfigFile },
    @{ Name = 'serviceConfigFile'; Path = [string]$manifest.serviceConfigFile },
    @{ Name = 'managementExecutableFile'; Path = [string]$manifest.managementExecutableFile }
)

foreach ($target in $protectedTargets) {
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $target.Path).Hash
    $expectedHash = [string]$manifest.baselineSha256.($target.Name)
    $checks += [ordered]@{
        name = "hash-unchanged-$($target.Name)"
        passed = $actualHash -eq $expectedHash
        expected = $expectedHash
        actual = $actualHash
    }
}

$failedProbeChecks = @($probe.checks | Where-Object { -not $_.passed })
$checks += [ordered]@{
    name = 'all-probe-denials-passed'
    passed = $failedProbeChecks.Count -eq 0
    expected = 0
    actual = $failedProbeChecks.Count
}

$checks += [ordered]@{
    name = 'dummy-secret-not-inherited'
    passed = [bool]$probe.secretNotInherited
    expected = $true
    actual = [bool]$probe.secretNotInherited
}

$failed = @($checks | Where-Object { -not $_.passed })
$result = [ordered]@{
    schemaVersion = 1
    verifiedAt = (Get-Date).ToString('o')
    managementUser = $currentUser
    fixtureRoot = $FixtureRoot
    checks = $checks
    overallPassed = $failed.Count -eq 0
}

$result | ConvertTo-Json -Depth 8 | Write-Output

if ($failed.Count -ne 0) {
    exit 1
}

exit 0
