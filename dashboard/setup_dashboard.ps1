# Mount Coffee dashboard (Next.js): install, build and start it on this PC.
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\setup_dashboard.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\setup_dashboard.ps1 -Uninstall
# It: 1) checks Node.js (installs the LTS with winget if missing)
#     2) installs the packages and builds the app
#     3) registers the "MCSolar Dashboard" task so it starts at every log-on, and starts it now
#     4) on the forecast PC: opens port 3000 in Windows Firewall so colleagues can reach it
#        on a colleague's PC: asks for the forecast PC's address and reads live data from there
#     5) opens http://localhost:3000
#   Colleague's PC, address known:  .\setup_dashboard.ps1 -Source http://10.0.0.25:3000
param([switch]$Uninstall, [string]$Source = "")
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
    if (Get-NetFirewallRule -DisplayName "MCSolar Dashboard 3000" -ErrorAction SilentlyContinue) {
        Start-Process powershell -Verb RunAs -Wait -ArgumentList "-NoProfile -Command Remove-NetFirewallRule -DisplayName 'MCSolar Dashboard 3000'"
    }
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

# --- Where the live data comes from
$liveDir = Join-Path (Split-Path $here) "data\live"
$envFile = Join-Path $here ".env.local"
$isForecastPC = Test-Path $liveDir
if (-not $isForecastPC -and -not $Source -and -not (Test-Path $envFile)) {
    Write-Host ""
    Write-Host "This PC has no live forecast data (no ..\data\live folder), so it will show the live data of the forecast PC." -ForegroundColor Yellow
    Write-Host "Open the dashboard on the forecast PC: the address is at the bottom of the page, e.g. http://10.0.0.25:3000"
    $Source = Read-Host "Forecast PC dashboard address (leave empty to show history only)"
}
if ($Source) {
    if ($Source -notmatch "^https?://") { $Source = "http://$Source" }
    if ($Source -notmatch ":\d+/?$") { $Source = $Source.TrimEnd("/") + ":3000" }
    "MCSOLAR_SOURCE_URL=$($Source.TrimEnd('/'))" | Set-Content $envFile -Encoding ASCII
    Write-Host "Live data will be read from $Source (saved in .env.local)."
    try { Invoke-WebRequest -UseBasicParsing -Uri "$($Source.TrimEnd('/'))/api/live" -TimeoutSec 10 | Out-Null; Write-Host "Forecast PC reachable." -ForegroundColor Green }
    catch { Write-Host "Cannot reach $Source right now - check the address, that the forecast PC is on, and that you are on the LEC network or VPN." -ForegroundColor Yellow }
}

# --- Install and build
Stop-Dashboard
Write-Host "Installing packages (first time takes a few minutes)..."
npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { npm install --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { Write-Host "npm install failed - see above." -ForegroundColor Red; exit 1 } }
Write-Host "Building..."
npm run build
if ($LASTEXITCODE -ne 0) { Write-Host "Build failed - see above." -ForegroundColor Red; exit 1 }

# --- Let colleagues on the LEC network open it (forecast PC only; asks for administrator approval once)
if ($isForecastPC -and -not (Get-NetFirewallRule -DisplayName "MCSolar Dashboard 3000" -ErrorAction SilentlyContinue)) {
    Write-Host "Opening port 3000 in Windows Firewall for the LEC network (Windows will ask for administrator approval)..."
    $cmd = "New-NetFirewallRule -DisplayName 'MCSolar Dashboard 3000' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -Profile Domain,Private"
    try { Start-Process powershell -Verb RunAs -Wait -ArgumentList "-NoProfile -Command $cmd" } catch { Write-Host "Firewall rule not added (approval declined). Colleagues will not reach this PC until port 3000 is allowed." -ForegroundColor Yellow }
    $prof = (Get-NetConnectionProfile | Select-Object -First 1).NetworkCategory
    if ($prof -eq "Public") { Write-Host "Note: this PC's network is set to Public. Set it to Private (Settings > Network > Properties) or colleagues cannot connect." -ForegroundColor Yellow }
}

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
if ($ip -and $isForecastPC) {
    Write-Host ""
    Write-Host "Colleagues: open http://$($ip):3000 in a browser, or run SETUP_DASHBOARD.bat on their PC and enter http://$($ip):3000" -ForegroundColor Green
}
Start-Process "http://localhost:3000"
