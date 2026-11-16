# Mount Coffee dashboard (Next.js): install, build and start it on this PC.
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\setup_dashboard.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\setup_dashboard.ps1 -Uninstall
# It: 1) checks Node.js (installs the LTS with winget if missing)
#     2) installs the packages and builds the app
#     3) registers the "MCSolar Dashboard" task so it starts at every log-on, and starts it now
#     4) opens http://localhost:3000
param([switch]$Uninstall)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here
$task = "MCSolar Dashboard"

function Stop-Dashboard {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like "*next*start*-p 3000*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
    Stop-Dashboard
    Write-Host "Dashboard task removed and stopped." -ForegroundColor Green
    exit 0
}

# --- Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js not found - installing the LTS version with winget..." -ForegroundColor Yellow
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host "Could not install Node.js automatically. Install the LTS from https://nodejs.org, then run this again." -ForegroundColor Red
        exit 1
    }
}
Write-Host ("Node.js " + (node -v))

# --- Install and build
Stop-Dashboard
Write-Host "Installing packages (first time takes a few minutes)..."
npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { npm install --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { Write-Host "npm install failed - see above." -ForegroundColor Red; exit 1 } }
Write-Host "Building..."
npm run build
if ($LASTEXITCODE -ne 0) { Write-Host "Build failed - see above." -ForegroundColor Red; exit 1 }

# --- Start at log-on, and now
$vbs = Join-Path $here "start_dashboard.vbs"
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbs`"" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Description "Mount Coffee forecast dashboard on port 3000" -Force | Out-Null
Start-ScheduledTask -TaskName $task
Start-Sleep -Seconds 6

$ok = $false
try { $ok = (Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:3000/api/live" -TimeoutSec 20).StatusCode -eq 200 } catch {}
if (-not $ok) { Write-Host "The dashboard did not answer yet - see dashboard.log in this folder." -ForegroundColor Yellow }
else { Write-Host "Dashboard running: http://localhost:3000" -ForegroundColor Green }

$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } | Select-Object -First 1).IPAddress
if ($ip) { Write-Host "Other PCs on the LEC network: http://$($ip):3000  (if blocked, allow port 3000 in Windows Firewall as administrator)" }
Start-Process "http://localhost:3000"
