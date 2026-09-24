[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$FixtureRoot,

    [Parameter(Mandatory = $true)]
    [string]$ExecutionUser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (Test-Path -LiteralPath $FixtureRoot) {
    throw "FixtureRoot already exists. Use a new disposable path: $FixtureRoot"
}

$managementUser = (& whoami).Trim()
if ([string]::IsNullOrWhiteSpace($managementUser)) {
    throw 'Could not determine the management OS user.'
}

$protectedDir = Join-Path $FixtureRoot 'protected'
$workspaceDir = Join-Path $FixtureRoot 'workspace'
$protectedFile = Join-Path $protectedDir 'protected.txt'
$boundaryConfigFile = Join-Path $protectedDir 'boundary-config.txt'
$serviceConfigFile = Join-Path $protectedDir 'service-config.txt'
$managementExecutableFile = Join-Path $protectedDir 'management-executable.bin'
$manifestFile = Join-Path $protectedDir 'manifest.json'
$junctionPath = Join-Path $workspaceDir 'junction-to-protected'
$symbolicLinkPath = Join-Path $workspaceDir 'symlink-to-protected.txt'

New-Item -ItemType Directory -Path $protectedDir -Force | Out-Null
New-Item -ItemType Directory -Path $workspaceDir -Force | Out-Null

$dummySecretName = 'RDMCP_BOUNDARY_DUMMY_SECRET'
$dummySecretValue = 'rdmcp-fixture-' + [guid]::NewGuid().ToString('N')
$protectedValue = 'protected-' + [guid]::NewGuid().ToString('N')
Set-Content -LiteralPath $protectedFile -Value $protectedValue -Encoding utf8NoBOM
Set-Content -LiteralPath $boundaryConfigFile -Value 'executionUser=protected-management-value' -Encoding utf8NoBOM
Set-Content -LiteralPath $serviceConfigFile -Value 'serviceIdentity=protected-management-value' -Encoding utf8NoBOM
[System.IO.File]::WriteAllBytes($managementExecutableFile, [byte[]](1, 2, 3, 4, 5, 6, 7, 8))

$inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$none = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$deny = [System.Security.AccessControl.AccessControlType]::Deny

$rootAcl = Get-Acl -LiteralPath $FixtureRoot
$rootAcl.AddAccessRule(
    [System.Security.AccessControl.FileSystemAccessRule]::new(
        $ExecutionUser,
        [System.Security.AccessControl.FileSystemRights]::ReadAndExecute,
        $inherit,
        $none,
        $allow
    )
)
Set-Acl -LiteralPath $FixtureRoot -AclObject $rootAcl

$workspaceAcl = Get-Acl -LiteralPath $workspaceDir
$workspaceAcl.AddAccessRule(
    [System.Security.AccessControl.FileSystemAccessRule]::new(
        $ExecutionUser,
        [System.Security.AccessControl.FileSystemRights]::Modify,
        $inherit,
        $none,
        $allow
    )
)
Set-Acl -LiteralPath $workspaceDir -AclObject $workspaceAcl

$protectedAcl = New-Object System.Security.AccessControl.DirectorySecurity
$protectedAcl.SetAccessRuleProtection($true, $false)
foreach ($identity in @($managementUser, 'NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators')) {
    $protectedAcl.AddAccessRule(
        [System.Security.AccessControl.FileSystemAccessRule]::new(
            $identity,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            $inherit,
            $none,
            $allow
        )
    )
}
$protectedAcl.AddAccessRule(
    [System.Security.AccessControl.FileSystemAccessRule]::new(
        $ExecutionUser,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        $inherit,
        $none,
        $deny
    )
)
Set-Acl -LiteralPath $protectedDir -AclObject $protectedAcl

New-Item -ItemType Junction -Path $junctionPath -Target $protectedDir | Out-Null
try {
    New-Item -ItemType SymbolicLink -Path $symbolicLinkPath -Target $protectedFile | Out-Null
}
catch {
    throw "Could not create symbolic link required by the fixture. Enable an authorized management-side mechanism and retry. $($_.Exception.Message)"
}

$baselineHashes = [ordered]@{
    protectedFile = (Get-FileHash -Algorithm SHA256 -LiteralPath $protectedFile).Hash
    boundaryConfigFile = (Get-FileHash -Algorithm SHA256 -LiteralPath $boundaryConfigFile).Hash
    serviceConfigFile = (Get-FileHash -Algorithm SHA256 -LiteralPath $serviceConfigFile).Hash
    managementExecutableFile = (Get-FileHash -Algorithm SHA256 -LiteralPath $managementExecutableFile).Hash
}
$manifest = [ordered]@{
    schemaVersion = 1
    createdAt = (Get-Date).ToString('o')
    managementUser = $managementUser
    executionUser = $ExecutionUser
    fixtureRoot = (Resolve-Path -LiteralPath $FixtureRoot).Path
    protectedFile = $protectedFile
    boundaryConfigFile = $boundaryConfigFile
    serviceConfigFile = $serviceConfigFile
    managementExecutableFile = $managementExecutableFile
    workspaceDir = $workspaceDir
    junctionPath = $junctionPath
    symbolicLinkPath = $symbolicLinkPath
    baselineSha256 = $baselineHashes
    dummySecretName = $dummySecretName
    dummySecretValue = $dummySecretValue
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestFile -Encoding utf8NoBOM

Write-Output "fixture_root=$FixtureRoot"
Write-Output "management_user=$managementUser"
Write-Output "execution_user=$ExecutionUser"
Write-Output "dummy_secret_name=$dummySecretName"
Write-Output 'Set dummySecretValue only in the RemoteDesktopMCP management process environment.'
Write-Output "manifest=$manifestFile"
