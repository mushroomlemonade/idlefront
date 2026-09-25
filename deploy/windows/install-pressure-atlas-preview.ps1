[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Workspace,

    [Parameter(Mandatory = $true)]
    [string]$NodeRuntimeRoot,

    [Parameter(Mandatory = $true)]
    [string]$CloudflaredSource,

    [string]$ExistingDatabase
)

$ErrorActionPreference = "Stop"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this installer from an elevated PowerShell session"
}

$Workspace = (Resolve-Path -LiteralPath $Workspace).Path
$NodeRuntimeRoot = (Resolve-Path -LiteralPath $NodeRuntimeRoot).Path
$CloudflaredSource = (Resolve-Path -LiteralPath $CloudflaredSource).Path
$InstallRoot = [IO.Path]::GetFullPath("C:\ProgramData\OpenFrontIdle")
$nodePath = Join-Path $NodeRuntimeRoot "node.exe"
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
    throw "node.exe was not found under $NodeRuntimeRoot"
}

$signature = Get-AuthenticodeSignature -LiteralPath $CloudflaredSource
if ($signature.Status -ne "Valid" -or $signature.SignerCertificate.Subject -notmatch "Cloudflare") {
    throw "cloudflared does not have a valid Cloudflare Authenticode signature"
}

$paths = @{
    Bin = Join-Path $InstallRoot "bin"
    Config = Join-Path $InstallRoot "config"
    Data = Join-Path $InstallRoot "data"
    Logs = Join-Path $InstallRoot "logs"
    Run = Join-Path $InstallRoot "run"
    Backups = Join-Path $InstallRoot "backups"
    Scripts = Join-Path $InstallRoot "scripts"
}
New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
foreach ($path in $paths.Values) {
    New-Item -ItemType Directory -Path $path -Force | Out-Null
}

# Quiesce direct task-owned executables before refreshing their launcher or
# cloudflared binary. On a first install these tasks simply do not exist.
foreach ($name in @("Watchdog", "Authority", "Gateway", "Tunnel")) {
    Stop-ScheduledTask `
        -TaskName $name `
        -TaskPath "\OpenFrontIdle\" `
        -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

$cloudflaredPath = Join-Path $paths.Bin "cloudflared.exe"
Copy-Item -LiteralPath $CloudflaredSource -Destination $cloudflaredPath -Force
Copy-Item `
    -LiteralPath (Join-Path $Workspace "deploy\windows\watchdog-pressure-atlas.ps1") `
    -Destination (Join-Path $paths.Scripts "watchdog-pressure-atlas.ps1") `
    -Force
Copy-Item `
    -LiteralPath (Join-Path $Workspace "deploy\windows\backup-pressure-atlas.ps1") `
    -Destination (Join-Path $paths.Scripts "backup-pressure-atlas.ps1") `
    -Force

function New-RandomSecret([int]$Bytes) {
    $buffer = New-Object byte[] $Bytes
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($buffer) }
    finally { $generator.Dispose() }
    return [Convert]::ToBase64String($buffer).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Invoke-Icacls {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,

        [Parameter(Mandatory = $true)]
        [string]$Operation
    )

    & "$env:SystemRoot\System32\icacls.exe" @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "icacls failed while $Operation (exit code $LASTEXITCODE)"
    }
}

$configPath = Join-Path $paths.Config "runtime.json"
$existingConfig = if (Test-Path -LiteralPath $configPath) {
    Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
}
else { $null }
$previewTokenCreated = -not (
    $null -ne $existingConfig -and
    $existingConfig.PreviewAccessToken
)
$previewToken = if (-not $previewTokenCreated) {
    [string]$existingConfig.PreviewAccessToken
}
else { New-RandomSecret 24 }
$hmacSecret = if ($null -ne $existingConfig -and $existingConfig.TelemetryHmacSecret) {
    [string]$existingConfig.TelemetryHmacSecret
}
else { New-RandomSecret 32 }
$quickTunnelEnabled = if (
    $null -ne $existingConfig -and
    $null -ne $existingConfig.QuickTunnelEnabled
) {
    [bool]$existingConfig.QuickTunnelEnabled
}
else { $true }
$tunnelMode = if ($null -ne $existingConfig -and $existingConfig.TunnelMode) {
    ([string]$existingConfig.TunnelMode).ToLowerInvariant()
}
elseif ($quickTunnelEnabled) { "quick" }
else { "disabled" }
if ($tunnelMode -notin @("quick", "service", "disabled")) {
    throw "Existing runtime configuration has an invalid TunnelMode"
}
$namedTunnelConfigPath = if (
    $null -ne $existingConfig -and
    $existingConfig.CloudflaredConfigPath
) {
    [IO.Path]::GetFullPath([string]$existingConfig.CloudflaredConfigPath)
}
else { "" }
$publicUrl = if ($null -ne $existingConfig -and $existingConfig.PublicUrl) {
    [string]$existingConfig.PublicUrl
}
else { "" }
$tunnelLogPath = if ($null -ne $existingConfig -and $existingConfig.TunnelLogPath) {
    [IO.Path]::GetFullPath([string]$existingConfig.TunnelLogPath)
}
else { Join-Path $paths.Logs "tunnel.log" }
$quickTunnelLogPath = Join-Path $paths.Logs "tunnel.log"
if ($tunnelMode -eq "service") {
    $configRoot = [IO.Path]::GetFullPath(
        (Join-Path $InstallRoot "named-tunnel")
    ).TrimEnd("\") + "\"
    if (
        -not $namedTunnelConfigPath.StartsWith(
            $configRoot,
            [StringComparison]::OrdinalIgnoreCase
        ) -or
        -not (Test-Path -LiteralPath $namedTunnelConfigPath -PathType Leaf)
    ) {
        throw "Named tunnel service configuration must exist under $configRoot"
    }
    $parsedPublicUrl = $null
    if (
        -not [Uri]::TryCreate($publicUrl, [UriKind]::Absolute, [ref]$parsedPublicUrl) -or
        $parsedPublicUrl.Scheme -ne "https"
    ) {
        throw "Named tunnel service PublicUrl must be an absolute HTTPS URL"
    }
}
$namedTunnelServiceName = if (
    $null -ne $existingConfig -and
    $existingConfig.NamedTunnelServiceName
) {
    [string]$existingConfig.NamedTunnelServiceName
}
else { "" }
if ($tunnelMode -eq "service" -and -not $namedTunnelServiceName) {
    throw "NamedTunnelServiceName is required when TunnelMode is service"
}
$databasePath = Join-Path $paths.Data "idle-demo.sqlite"

$runtimeConfig = [ordered]@{
    Workspace = $Workspace
    NodePath = $nodePath
    CloudflaredPath = $cloudflaredPath
    AuthorityPort = 3000
    GatewayPort = 3100
    TunnelMode = $tunnelMode
    QuickTunnelEnabled = ($tunnelMode -eq "quick")
    CloudflaredConfigPath = $namedTunnelConfigPath
    NamedTunnelServiceName = $namedTunnelServiceName
    PublicUrl = $publicUrl
    TunnelLogPath = $tunnelLogPath
    DatabasePath = $databasePath
    TelemetryHmacSecret = $hmacSecret
    PreviewAccessToken = $previewToken
    LogsPath = $paths.Logs
    RunPath = $paths.Run
    BackupsPath = $paths.Backups
}
[IO.File]::WriteAllText(
    $configPath,
    ($runtimeConfig | ConvertTo-Json -Depth 3) + [Environment]::NewLine
)

if (-not (Test-Path -LiteralPath $databasePath) -and $ExistingDatabase) {
    $resolvedExistingDatabase = (Resolve-Path -LiteralPath $ExistingDatabase).Path
    $backupScript = Join-Path $Workspace "scripts\idle-db-backup.mjs"
    & $nodePath $backupScript $resolvedExistingDatabase $databasePath
    if ($LASTEXITCODE -ne 0) {
        throw "Existing idle database migration failed"
    }
}

# The task identity gets read/execute access to code/runtime and write access
# only to the service's data, logs, run state, and backups.
Invoke-Icacls `
    -Arguments @($InstallRoot, "/inheritance:r") `
    -Operation "protecting the service directory"
Invoke-Icacls `
    -Arguments @(
        $InstallRoot,
        "/grant:r",
        "SYSTEM:(OI)(CI)F",
        "BUILTIN\Administrators:(OI)(CI)F",
        "NT AUTHORITY\LOCAL SERVICE:(OI)(CI)RX"
    ) `
    -Operation "setting the service directory ACL"
foreach ($path in @($paths.Data, $paths.Logs, $paths.Run, $paths.Backups)) {
    Invoke-Icacls `
        -Arguments @($path, "/grant:r", "NT AUTHORITY\LOCAL SERVICE:(OI)(CI)M") `
        -Operation "granting Local Service write access to $path"
}
Invoke-Icacls `
    -Arguments @($Workspace, "/grant", "NT AUTHORITY\LOCAL SERVICE:(OI)(CI)RX") `
    -Operation "granting Local Service read access to the workspace"
Invoke-Icacls `
    -Arguments @($NodeRuntimeRoot, "/grant", "NT AUTHORITY\LOCAL SERVICE:(OI)(CI)RX") `
    -Operation "granting Local Service read access to the Node runtime"

# A profile directory commonly withholds traverse access from service
# identities. Grant this identity read/execute on each ancestor itself (never
# inherited into sibling trees), while the recursive code/runtime grants above
# remain scoped to this checkout.
foreach ($leaf in @($Workspace, $NodeRuntimeRoot)) {
    $ancestor = Split-Path -Parent $leaf
    $volumeRoot = [IO.Path]::GetPathRoot($leaf).TrimEnd("\")
    while ($ancestor -and $ancestor.TrimEnd("\") -ne $volumeRoot) {
        $hasTraverse = (Get-Acl -LiteralPath $ancestor).Access |
            Where-Object {
                $_.IdentityReference.Value -eq "NT AUTHORITY\LOCAL SERVICE" -and
                ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadAndExecute) -eq
                    [Security.AccessControl.FileSystemRights]::ReadAndExecute
        }
        if (-not $hasTraverse) {
            Invoke-Icacls `
                -Arguments @($ancestor, "/grant", "NT AUTHORITY\LOCAL SERVICE:(RX)") `
                -Operation "granting Local Service traverse access to $ancestor"
        }
        $ancestor = Split-Path -Parent $ancestor
    }
}

$scheduler = New-Object -ComObject "Schedule.Service"
$scheduler.Connect()
$rootFolder = $scheduler.GetFolder("\")
try { $null = $scheduler.GetFolder("\OpenFrontIdle") }
catch { $null = $rootFolder.CreateFolder("OpenFrontIdle") }

$powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$launcher = Join-Path $Workspace "scripts\idle-windows-launcher.mjs"
$watchdog = Join-Path $paths.Scripts "watchdog-pressure-atlas.ps1"
$backupRunner = Join-Path $paths.Scripts "backup-pressure-atlas.ps1"
$principalDefinition = New-ScheduledTaskPrincipal `
    -UserId "NT AUTHORITY\LOCAL SERVICE" `
    -LogonType ServiceAccount `
    -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries
$startup = New-ScheduledTaskTrigger -AtStartup

foreach ($component in @("Authority", "Gateway")) {
    $arguments = "--import tsx `"$launcher`" $component `"$configPath`""
    $action = New-ScheduledTaskAction `
        -Execute $nodePath `
        -Argument $arguments `
        -WorkingDirectory $Workspace
    $task = New-ScheduledTask `
        -Action $action `
        -Trigger $startup `
        -Principal $principalDefinition `
        -Settings $settings
    Register-ScheduledTask `
        -TaskName $component `
        -TaskPath "\OpenFrontIdle\" `
        -InputObject $task `
        -Force | Out-Null
}

$tunnelArguments = "tunnel --no-autoupdate --url http://127.0.0.1:3100 --loglevel info --logfile `"$quickTunnelLogPath`""
$tunnelAction = New-ScheduledTaskAction `
    -Execute $cloudflaredPath `
    -Argument $tunnelArguments `
    -WorkingDirectory $Workspace
$tunnelTask = New-ScheduledTask `
    -Action $tunnelAction `
    -Trigger $startup `
    -Principal $principalDefinition `
    -Settings $settings
Register-ScheduledTask `
    -TaskName "Tunnel" `
    -TaskPath "\OpenFrontIdle\" `
    -InputObject $tunnelTask `
    -Force | Out-Null
if ($tunnelMode -eq "quick") {
    Enable-ScheduledTask -TaskName "Tunnel" -TaskPath "\OpenFrontIdle\" | Out-Null
}
else {
    Disable-ScheduledTask -TaskName "Tunnel" -TaskPath "\OpenFrontIdle\" | Out-Null
}

$watchdogPrincipal = New-ScheduledTaskPrincipal `
    -UserId "SYSTEM" `
    -LogonType ServiceAccount `
    -RunLevel Highest
$watchdogAction = New-ScheduledTaskAction `
    -Execute $powerShell `
    -Argument "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$watchdog`" -ConfigPath `"$configPath`""
$watchdogTask = New-ScheduledTask `
    -Action $watchdogAction `
    -Trigger $startup `
    -Principal $watchdogPrincipal `
    -Settings $settings
Register-ScheduledTask `
    -TaskName "Watchdog" `
    -TaskPath "\OpenFrontIdle\" `
    -InputObject $watchdogTask `
    -Force | Out-Null

$backupAction = New-ScheduledTaskAction `
    -Execute $powerShell `
    -Argument "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$backupRunner`" -ConfigPath `"$configPath`""
$backupTrigger = New-ScheduledTaskTrigger -Daily -At "03:15"
$backupSettings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -MultipleInstances IgnoreNew
$backupTask = New-ScheduledTask `
    -Action $backupAction `
    -Trigger $backupTrigger `
    -Principal $principalDefinition `
    -Settings $backupSettings
Register-ScheduledTask `
    -TaskName "Backup" `
    -TaskPath "\OpenFrontIdle\" `
    -InputObject $backupTask `
    -Force | Out-Null

$startupTasks = @("Authority", "Gateway", "Watchdog")
if ($tunnelMode -eq "quick") { $startupTasks += "Tunnel" }
foreach ($name in $startupTasks) {
    Start-ScheduledTask -TaskName $name -TaskPath "\OpenFrontIdle\"
}

Write-Output "Installed Pressure Atlas startup tasks and watchdog."
if ($previewTokenCreated) {
    Write-Output "Preview password: $previewToken"
}
else {
    Write-Output "The existing preview password was preserved in protected configuration."
}
