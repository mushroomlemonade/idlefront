$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimeRoot = (Resolve-Path (Join-Path $projectRoot "..\.runtime\node-v24.18.1-win-x64")).Path
$logRoot = Join-Path $projectRoot ".dev-logs"
$npm = Join-Path $runtimeRoot "npm.cmd"

if (Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue) {
  Write-Output "Expo is already listening on port 8081."
  exit 0
}

New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$env:Path = "$runtimeRoot;$env:Path"
$env:EXPO_PUBLIC_GAME_URL = "https://atlas-dev.sightings.today/?map-material=mineral"
$env:EXPO_UNSTABLE_TUNNEL_V2 = "1"

$arguments = @(
  "--prefix",
  "apps/mobile",
  "run",
  "start:tunnel",
  "--",
  "--port",
  "8081",
  "--clear"
)

$process = Start-Process `
  -FilePath $npm `
  -ArgumentList $arguments `
  -WorkingDirectory $projectRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logRoot "expo-current.out.log") `
  -RedirectStandardError (Join-Path $logRoot "expo-current.err.log") `
  -PassThru

Write-Output "Started persistent Expo launcher PID $($process.Id)."
