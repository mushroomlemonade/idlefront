# Run once manually in an elevated PowerShell opened as your normal Windows user.
# No execution-policy changes, credentials, firewall changes, or backend kills.
[CmdletBinding()]
param(
  [string]$NodePath = 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Open PowerShell with Run as administrator, using your existing Windows account, then run this installer again.'
}
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$oldConfigPath = 'C:\ProgramData\OpenFrontIdle\config\runtime.json'
$configPath = 'C:\ProgramData\OpenFrontIdle\config\dev-runtime.json'
$taskPath = '\OpenFrontIdle\'
$names = @('Gateway', 'Expo', 'Web', 'Backend')
foreach ($file in @($NodePath, $oldConfigPath, (Join-Path $workspace 'scripts\idle-dev-supervisor.mjs'),
  (Join-Path $workspace 'apps\mobile\node_modules\expo\bin\cli'),
  (Join-Path $workspace 'node_modules\vite\bin\vite.js'))) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing required file: $file" }
}
& $NodePath --version
if ($LASTEXITCODE -ne 0) { throw 'Node validation failed.' }
$legacyGateway = Get-ScheduledTask -TaskPath $taskPath -TaskName Gateway
if ($legacyGateway.Actions.Arguments -notmatch 'idle-(windows-launcher|dev-supervisor)\.mjs') {
  throw 'Gateway task has an unexpected action. Nothing was changed.'
}
$watchdog = Get-ScheduledTask -TaskPath $taskPath -TaskName Watchdog -ErrorAction SilentlyContinue
if ($watchdog -and $watchdog.Settings.Enabled) { throw 'Legacy watchdog is enabled. Review it before migrating.' }
$config = Get-Content -LiteralPath $oldConfigPath -Raw | ConvertFrom-Json
if (-not $config.PreviewAccessToken) { throw 'Existing preview credential is missing.' }

# Keep Node independent of Codex runtime upgrades; never overwrite a running copy.
$runtimeDir = 'C:\ProgramData\OpenFrontIdle\dev-runtime'
$logsDir = Join-Path $workspace '.dev-logs\managed'
$backupDir = Join-Path $logsDir ('setup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $runtimeDir,$backupDir -Force | Out-Null
$stableNode = Join-Path $runtimeDir 'node.exe'
if (-not (Test-Path -LiteralPath $stableNode)) { Copy-Item -LiteralPath $NodePath -Destination $stableNode }
foreach ($name in $names) {
  $existing = Get-ScheduledTask -TaskPath $taskPath -TaskName $name -ErrorAction SilentlyContinue
  if ($existing) {
    Export-ScheduledTask -TaskPath $taskPath -TaskName $name | Set-Content -LiteralPath (Join-Path $backupDir "$name.xml") -Encoding Unicode
  }
}
if (Test-Path -LiteralPath $configPath) { Copy-Item -LiteralPath $configPath -Destination (Join-Path $backupDir 'dev-runtime.json') }
$config.Workspace = $workspace
$config.NodePath = $stableNode
$config.LogsPath = $logsDir
$config | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configPath -Encoding ascii

# S4U: same user, non-elevated, no saved password; starts before interactive login.
# It cannot use Windows integrated network credentials or EFS-encrypted files.
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$trigger = New-ScheduledTaskTrigger -AtStartup
foreach ($name in $names) {
  $arguments = '"{0}" {1} "{2}"' -f (Join-Path $workspace 'scripts\idle-dev-supervisor.mjs'), $name, $configPath
  $action = New-ScheduledTaskAction -Execute $stableNode -Argument $arguments -WorkingDirectory $workspace
  Register-ScheduledTask -TaskName $name -TaskPath $taskPath -Action $action `
    -Trigger $trigger -Principal $taskPrincipal -Settings $settings -Force | Out-Null
}

# Only the gateway is replaced now. Existing Metro, Vite, and game sessions stay up.
Stop-ScheduledTask -TaskPath $taskPath -TaskName Gateway
Start-Sleep -Seconds 2
foreach ($name in $names) { Start-ScheduledTask -TaskPath $taskPath -TaskName $name }
Write-Host "Startup tasks installed. Configuration/task backups: $backupDir"
Write-Host 'Backend, Vite and Metro were not stopped. Supervisors wait for occupied ports.'
Write-Host 'Cloudflare, production, databases, and the existing preview password are unchanged.'
Write-Host 'Send Codex this output so it can verify the Atlas manifest and bundle before playtesting.'
Get-ScheduledTask -TaskPath $taskPath | Select-Object TaskName,State
