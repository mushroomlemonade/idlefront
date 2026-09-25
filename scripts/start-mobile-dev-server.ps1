param(
  [int]$Port = 8081,
  [string]$GameUrl = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$mobileRoot = Join-Path $repoRoot "apps\mobile"
$expoCli = Join-Path $mobileRoot "node_modules\expo\bin\cli"
$bundledNode = Join-Path $repoRoot "..\.runtime\node-v24.18.1-win-x64\node.exe"
$systemNode = Get-Command node -ErrorAction SilentlyContinue

if ($systemNode) {
  $nodeExe = $systemNode.Source
} elseif (Test-Path -LiteralPath $bundledNode) {
  $nodeExe = (Resolve-Path -LiteralPath $bundledNode).Path
} else {
  throw "Node.js was not found. Install Node or restore the repository runtime."
}

if (-not (Test-Path -LiteralPath $expoCli)) {
  throw "Expo dependencies are missing. Run npm install in apps/mobile."
}

if ($GameUrl) {
  $env:EXPO_PUBLIC_GAME_URL = $GameUrl
}

$env:Path = "$(Split-Path $nodeExe);$env:Path"

while ($true) {
  Write-Output "Starting Pressure Atlas mobile preview on port $Port"
  Push-Location $mobileRoot
  try {
    & $nodeExe $expoCli start --go --lan --port $Port
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }

  Write-Warning "Metro exited with code $exitCode; restarting in two seconds."
  Start-Sleep -Seconds 2
}
