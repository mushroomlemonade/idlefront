@echo off
setlocal EnableExtensions

cd /d "%~dp0"

set "IDLEFRONT_ROOT=%~dp0"
set "IDLEFRONT_RUNTIME=%~dp0..\.runtime\node-v24.18.1-win-x64"
if not exist "%IDLEFRONT_RUNTIME%\node.exe" set "IDLEFRONT_RUNTIME=C:\Users\Administrator\Documents\Codex\2026-08-14\fork-openfront-project-to-start-work\.runtime\node-v24.18.1-win-x64"
set "IDLEFRONT_LOGS=%~dp0.dev-logs"
set "IDLE_PREVIEW_ACCESS_TOKEN=idlefront-preview-password"
set "IDLE_PREVIEW_ORIGIN=http://127.0.0.1:3000"
set "IDLE_PREVIEW_WEB_ORIGIN=http://127.0.0.1:9000"
set "EXPO_PUBLIC_GAME_URL=https://atlas-dev.sightings.today/?map-material=mineral"
set "EXPO_UNSTABLE_TUNNEL_V2=1"
set "IDLE_DISABLE_PUBLIC_LOBBIES=1"

if not exist "%IDLEFRONT_RUNTIME%\node.exe" (
  echo ERROR: The bundled Node runtime was not found.
  echo Expected: "%IDLEFRONT_RUNTIME%\node.exe"
  pause
  exit /b 1
)

if not exist "%IDLEFRONT_RUNTIME%\npm.cmd" (
  echo ERROR: npm.cmd was not found in the bundled Node runtime.
  pause
  exit /b 1
)

if not exist "%IDLEFRONT_LOGS%" mkdir "%IDLEFRONT_LOGS%"
set "PATH=%IDLEFRONT_RUNTIME%;%PATH%"

for %%P in (3000 9000 8081) do (
  powershell.exe -NoProfile -Command "if (Get-NetTCPConnection -State Listen -LocalPort %%P -ErrorAction SilentlyContinue) { exit 1 }"
  if errorlevel 1 (
    echo ERROR: Port %%P is already in use. IdleFront may already be running.
    echo Close the existing process before running this launcher again.
    pause
    exit /b 1
  )
)

set "START_IDLEFRONT_GATEWAY=1"
powershell.exe -NoProfile -Command "if (Get-NetTCPConnection -State Listen -LocalPort 3100 -ErrorAction SilentlyContinue) { exit 1 }"
if errorlevel 1 set "START_IDLEFRONT_GATEWAY=0"

echo Starting IdleFront game server on port 3000...
start "IdleFront game server" /min cmd.exe /d /c ""%IDLEFRONT_RUNTIME%\npm.cmd" run start:server-dev 1^>^>"%IDLEFRONT_LOGS%\server.out.log" 2^>^>"%IDLEFRONT_LOGS%\server.err.log""

echo Starting IdleFront web client on port 9000...
start "IdleFront web client" /min cmd.exe /d /c ""%IDLEFRONT_RUNTIME%\npm.cmd" run start:client -- --host 0.0.0.0 --port 9000 1^>^>"%IDLEFRONT_LOGS%\client.out.log" 2^>^>"%IDLEFRONT_LOGS%\client.err.log""

if "%START_IDLEFRONT_GATEWAY%"=="1" (
  echo Starting IdleFront preview gateway on port 3100...
  start "IdleFront preview gateway" /min cmd.exe /d /c ""%IDLEFRONT_RUNTIME%\node.exe" scripts\idle-public-gateway.mjs 1^>^>"%IDLEFRONT_LOGS%\gateway.out.log" 2^>^>"%IDLEFRONT_LOGS%\gateway.err.log""
) else (
  echo Reusing the managed IdleFront preview gateway on port 3100.
)

echo Starting Expo Go tunnel on port 8081...
start "IdleFront Expo tunnel" /min cmd.exe /d /c ""%IDLEFRONT_RUNTIME%\npm.cmd" --prefix apps\mobile run start:tunnel -- --port 8081 --clear 1^>^>"%IDLEFRONT_LOGS%\expo.out.log" 2^>^>"%IDLEFRONT_LOGS%\expo.err.log""

echo.
echo IdleFront startup has been launched.
echo Web on this computer: http://127.0.0.1:9000
echo Public game origin:   https://atlas-dev.sightings.today/
echo Expo tunnel details:  "%IDLEFRONT_LOGS%\expo.out.log"
echo All service logs:     "%IDLEFRONT_LOGS%"
echo.
echo Allow about 30 seconds for all services and the Expo tunnel to become ready.
timeout /t 8 /nobreak >nul

for %%P in (3000 9000 3100 8081) do (
  powershell.exe -NoProfile -Command "if (Get-NetTCPConnection -State Listen -LocalPort %%P -ErrorAction SilentlyContinue) { Write-Host 'Port %%P: ready' } else { Write-Host 'Port %%P: still starting - check its log' }"
)

echo.
pause
endlocal
