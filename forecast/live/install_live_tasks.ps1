# Mount Coffee live forecast: set up the scheduled tasks on this PC.
# Run from PowerShell in the forecast folder:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\live\install_live_tasks.ps1
#   (add  -Source api  to use the Gantner RAS API with an API key instead of the web portal)
#
# It: 1) installs the extra Python packages (requests, keyring)
#     2) checks live\config.json (creates it from the example with a random token if missing)
#     3) asks once for the portal and logger passwords and stores them in Windows Credential Manager
#     4) trains the plant-only and plant+weather models (fallbacks when satellite data is missing)
#     5) tests one small read
#     6) registers three Windows scheduled tasks for this user:
#        MCSolar Collector  every 5 min (portal) / 1 min (api)  reads the logger and saves the values (read-only)
#        MCSolar Forecast   every 15 minutes  forecasts 15/30/60 min ahead, logs it, sends it to the Google Sheet
#        MCSolar Retrain    every 4 weeks     retrains the models on all data so far
# The PC must stay on and this user logged in. Remove everything with:  .\live\install_live_tasks.ps1 -Uninstall
param([switch]$Uninstall, [ValidateSet("portal", "api")][string]$Source = "portal")
$ErrorActionPreference = "Continue"
$live = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $live
$names = @("MCSolar Collector", "MCSolar Forecast", "MCSolar Retrain", "MCSolar Weather Models", "MCSolar Alerts")

if ($Uninstall) {
    foreach ($n in $names) { Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue }
    Write-Host "Scheduled tasks removed." -ForegroundColor Green
    exit 0
}

# --- Python
$py = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $py) { Write-Host "Python not found. Run SETUP_AND_RUN.bat first." -ForegroundColor Red; exit 1 }
$pyw = Join-Path (Split-Path $py) "pythonw.exe"
if (-not (Test-Path $pyw)) { $pyw = $py }
Write-Host "Python: $py"
& $py -m pip install requests keyring --quiet

# --- Config
$cfgPath = Join-Path $live "config.json"
if (-not (Test-Path $cfgPath)) {
    $token = -join ((48..57) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
    (Get-Content (Join-Path $live "config.example.json") -Raw).Replace("CHANGE-ME-to-the-same-secret-as-apps_script_receiver.gs", $token) | Set-Content $cfgPath -Encoding UTF8
    Write-Host ""
    Write-Host "Created live\config.json with a new secret token:" -ForegroundColor Yellow
    Write-Host "  $token"
    Write-Host "1. Put this same token in the Apps Script line  const TOKEN = '...';  then Deploy > Manage deployments > New version."
    Write-Host "2. Paste the Apps Script Web app URL into sheet_webhook_url in live\config.json (Notepad opens now). Save."
    Write-Host "3. Run this script again."
    notepad $cfgPath
    exit 0
}
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
if ($cfg.sheet_webhook_url -like "PASTE*") { Write-Host "Note: sheet_webhook_url not set - forecasts will only be saved on this PC." -ForegroundColor Yellow }

if ($Source -eq "portal") {
    # --- Passwords in Windows Credential Manager (never in a file)
    $have = & $py -c "import json,keyring;c=json.load(open(r'$cfgPath',encoding='utf-8-sig'));print(bool(c.get('portal_user')) and bool(keyring.get_password('MCSolar Gantner portal',c.get('portal_user',''))) and bool(keyring.get_password('MCSolar Q.reader logger',c.get('logger_user','admin'))))"
    if ("$have".Trim() -ne "True") {
        Write-Host ""
        Write-Host "Enter the Gantner portal and logger sign-in details (stored in Windows Credential Manager only):" -ForegroundColor Yellow
        & $py (Join-Path $live "set_credentials.py")
    }
} elseif ($cfg.ras_api_key -eq "" -or $cfg.ras_api_key -like "PASTE*") {
    Write-Host "Fill in ras_api_key in live\config.json first (or use -Source portal)." -ForegroundColor Red; notepad $cfgPath; exit 1
}

# --- Fallback models
Set-Location $root
$data = Join-Path (Split-Path $root) "data"
$iv2 = Get-ChildItem $data -Filter "iv2_2026*.csv" | Where-Object { $_.Name -notmatch "_1\.csv|\(1\)" } | Select-Object -First 1
$iv1 = Get-ChildItem $data -Filter "iv1_2026*.csv" | Where-Object { $_.Name -notmatch "_1\.csv|\(1\)" } | Sort-Object Length -Descending | Select-Object -First 1
if ($iv2 -and -not (Test-Path "mcsolar_model.joblib")) {
    Write-Host "Training plant-only model..."; & $py -W ignore train.py --iv2 $iv2.FullName --out mcsolar_model.joblib | Out-Null
}
if ($iv2 -and $iv1 -and -not (Test-Path "mcsolar_model_weather.joblib")) {
    Write-Host "Training plant + weather model..."; & $py -W ignore train.py --iv2 $iv2.FullName --iv1 $iv1.FullName --out mcsolar_model_weather.joblib | Out-Null
}

# --- Test one read
$collector = if ($Source -eq "portal") { "portal_collector.py" } else { "ras_collector.py" }
Write-Host ""
Write-Host "Testing one read from the logger ($Source, read-only)..."
& $py (Join-Path $live $collector) --config $cfgPath --test
if ($LASTEXITCODE -ne 0) {
    Write-Host "The test read failed - see the message above. Nothing was scheduled." -ForegroundColor Red
    exit 1
}

# --- Scheduled tasks
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$settingsLong = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 3) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$now = Get-Date
$long = New-TimeSpan -Days 3650
$every = if ($Source -eq "portal") { 5 } else { 1 }
$start1 = $now.Date.AddHours($now.Hour).AddMinutes([math]::Ceiling(($now.Minute + 1) / 5) * 5 + 1)   # 1 min after each 5-min mark
$q = [math]::Ceiling(($now.Minute + 1) / 15) * 15 + 8                                                  # 8 min after each quarter hour
$start15 = $now.Date.AddHours($now.Hour).AddMinutes($q)
$startH = $now.Date.AddHours($now.Hour + 1).AddMinutes(5)                                             # 5 min past each hour
$startA = $now.Date.AddHours($now.Hour).AddMinutes([math]::Ceiling(($now.Minute + 1) / 15) * 15 + 11) # 11 min after each quarter hour

$tasks = @(
    @{ Name = $names[0]; Script = $collector;           Trigger = (New-ScheduledTaskTrigger -Once -At $start1 -RepetitionInterval (New-TimeSpan -Minutes $every) -RepetitionDuration $long) },
    @{ Name = $names[1]; Script = "live_forecast.py";   Trigger = (New-ScheduledTaskTrigger -Once -At $start15 -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration $long) },
    @{ Name = $names[2]; Script = "retrain_monthly.py"; Trigger = (New-ScheduledTaskTrigger -Weekly -WeeksInterval 4 -DaysOfWeek Sunday -At "22:00") },
    @{ Name = $names[3]; Script = "nwp_forecast.py";    Trigger = (New-ScheduledTaskTrigger -Once -At $startH -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration $long) },
    @{ Name = $names[4]; Script = "alerts.py";          Trigger = (New-ScheduledTaskTrigger -Once -At $startA -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration $long) }
)
foreach ($t in $tasks) {
    $action = New-ScheduledTaskAction -Execute $pyw -Argument ("`"" + (Join-Path $live $t.Script) + "`" --config `"" + $cfgPath + "`"") -WorkingDirectory $root
    Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger $t.Trigger -Settings $(if ($t.Name -eq $names[2]) { $settingsLong } else { $settings }) -Description "Mount Coffee solar forecast" -Force | Out-Null
    Write-Host "Registered: $($t.Name)" -ForegroundColor Green
}
Write-Host ""
Write-Host "Calibrating the weather-model forecast hour by hour against the logger (downloads past forecasts, about a minute)..."
& $py (Join-Path $live "calibrate_nwp.py") --config $cfgPath
Write-Host "Fetching the first weather-model forecast (hours to 3 days ahead)..."
& $py (Join-Path $live "nwp_forecast.py") --config $cfgPath
Write-Host ""
Write-Host "Done. First forecast after about 2 hours of collected data (the model needs recent history)."
Write-Host "Logs: data\live\collector_log.txt and data\live\forecast_log.csv (next to the forecast folder)"
