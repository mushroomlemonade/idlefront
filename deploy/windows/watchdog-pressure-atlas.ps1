[CmdletBinding()]
param(
    [string]$ConfigPath = "C:\ProgramData\OpenFrontIdle\config\runtime.json"
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
$taskPath = "\OpenFrontIdle\"
$failures = @{ Authority = 0; Gateway = 0 }

function Test-Endpoint([string]$Url) {
    try {
        $response = Invoke-WebRequest `
            -Uri $Url `
            -UseBasicParsing `
            -TimeoutSec 5 `
            -MaximumRedirection 0
        return $response.StatusCode -eq 200
    }
    catch { return $false }
}

function Restart-Component([string]$Name) {
    Stop-ScheduledTask -TaskPath $taskPath -TaskName $Name -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Start-ScheduledTask -TaskPath $taskPath -TaskName $Name
}

function Write-PublicUrl($config, [string]$Url) {
    if (-not $Url) { return }
    $urlPath = Join-Path $config.RunPath "public-url.txt"
    $current = if (Test-Path -LiteralPath $urlPath) {
        (Get-Content -LiteralPath $urlPath -Raw).Trim()
    }
    else { "" }
    if ($current -ne $Url) {
        [IO.File]::WriteAllText($urlPath, $Url + [Environment]::NewLine)
    }
}

function Maintain-TunnelLog($config, [bool]$ExtractQuickUrl) {
    $logPath = if ($ExtractQuickUrl) {
        Join-Path $config.LogsPath "tunnel.log"
    }
    elseif ($config.TunnelLogPath) {
        [string]$config.TunnelLogPath
    }
    else { Join-Path $config.LogsPath "tunnel.log" }
    if (-not (Test-Path -LiteralPath $logPath)) { return }
    if ($ExtractQuickUrl) {
        $text = Get-Content -LiteralPath $logPath -Raw -ErrorAction SilentlyContinue
        $matches = [regex]::Matches(
            $text,
            "https://[a-z0-9-]+\.trycloudflare\.com",
            [Text.RegularExpressions.RegexOptions]::IgnoreCase
        )
        if ($matches.Count -gt 0) {
            Write-PublicUrl $config $matches[$matches.Count - 1].Value
        }
    }

    if ((Get-Item -LiteralPath $logPath).Length -gt 20971520) {
        Stop-ScheduledTask -TaskPath $taskPath -TaskName Tunnel -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        $archive = Join-Path $config.LogsPath (
            "tunnel-{0}.log" -f [DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss")
        )
        Move-Item -LiteralPath $logPath -Destination $archive
        Start-ScheduledTask -TaskPath $taskPath -TaskName Tunnel
    }
    Get-ChildItem -LiteralPath $config.LogsPath -Filter "tunnel-*.log" -File |
        Where-Object { $_.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddDays(-14) } |
        Remove-Item -Force
}

while ($true) {
    try {
        $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
        $authorityPort = if ($config.AuthorityPort) {
            [int]$config.AuthorityPort
        }
        else { 3000 }
        $gatewayPort = if ($config.GatewayPort) {
            [int]$config.GatewayPort
        }
        else { 3100 }
        $checks = @{
            Authority = Test-Endpoint "http://127.0.0.1:$authorityPort/api/idle/health"
            Gateway = Test-Endpoint "http://127.0.0.1:$gatewayPort/__preview/login"
        }
        foreach ($name in @("Authority", "Gateway")) {
            if ($checks[$name]) {
                $failures[$name] = 0
            }
            else {
                $failures[$name] += 1
                if ($failures[$name] -ge 2) {
                    Restart-Component $name
                    $failures[$name] = 0
                }
            }
        }

        $tunnelMode = if ($config.TunnelMode) {
            [string]$config.TunnelMode
        }
        elseif ($null -ne $config.QuickTunnelEnabled -and -not [bool]$config.QuickTunnelEnabled) {
            "disabled"
        }
        else { "quick" }
        if ($tunnelMode -eq "quick") {
            $tunnel = Get-ScheduledTask -TaskPath $taskPath -TaskName Tunnel
            if ($tunnel.State -ne "Running") {
                Start-ScheduledTask -TaskPath $taskPath -TaskName Tunnel
            }
            Maintain-TunnelLog $config $true
        }
        elseif ($tunnelMode -eq "service") {
            $serviceName = [string]$config.NamedTunnelServiceName
            if ($serviceName) {
                $service = Get-Service -Name $serviceName -ErrorAction Stop
                if ($service.Status -ne "Running") {
                    Start-Service -Name $serviceName
                }
            }
            Write-PublicUrl $config ([string]$config.PublicUrl)
        }
    }
    catch {
        # Task Scheduler restarts this watchdog if PowerShell itself exits. A
        # transient command failure should not take monitoring offline.
    }
    Start-Sleep -Seconds 10
}
