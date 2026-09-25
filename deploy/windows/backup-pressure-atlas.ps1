[CmdletBinding()]
param(
    [string]$ConfigPath = "C:\ProgramData\OpenFrontIdle\config\runtime.json"
)

$ErrorActionPreference = "Stop"
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$timestamp = [DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss")
$destination = Join-Path $config.BackupsPath "idle-$timestamp.sqlite"
$backupScript = Join-Path $config.Workspace "scripts\idle-db-backup.mjs"

& $config.NodePath $backupScript $config.DatabasePath $destination
if ($LASTEXITCODE -ne 0) {
    throw "Verified SQLite backup failed with exit code $LASTEXITCODE"
}

Get-ChildItem -LiteralPath $config.BackupsPath -Filter "idle-*.sqlite" -File |
    Where-Object { $_.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddDays(-14) } |
    Remove-Item -Force
