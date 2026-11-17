# Mount Coffee AI assistant: one-time setup on the FORECAST PC.
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\setup_agent.ps1
# It: 1) asks for the Anthropic API key (hidden), checks it, saves it in dashboard\.env.local (never in git)
#     2) registers "MCSolar AI Reports" (07:00 and 19:05 GMT shift reports by e-mail)
#     3) optionally sets up the Telegram bot and registers "MCSolar Telegram"
#     4) rebuilds and restarts the dashboard so the "Ask AI" chat and alert analysis work
# The assistant only READS plant data. Usage is billed to the API key's account (console.anthropic.com).
param([switch]$SkipKey, [switch]$SkipTelegram)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path $here
$live = Join-Path $root "forecast\live"
$cfgPath = Join-Path $live "config.json"
$envFile = Join-Path $here ".env.local"

function Set-EnvLine($name, $value) {
    $lines = @()
    if (Test-Path $envFile) { $lines = Get-Content $envFile | Where-Object { $_ -notmatch "^$name=" } }
    $lines += "$name=$value"
    $lines | Set-Content $envFile -Encoding ASCII
}

# --- 1) API key
if (-not $SkipKey) {
    Write-Host "Anthropic API key: create one at https://console.anthropic.com (Settings > API keys)." -ForegroundColor Cyan
    $sec = Read-Host "Paste the API key (hidden)" -AsSecureString
    $key = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    if (-not $key) { Write-Host "No key entered." -ForegroundColor Red; exit 1 }
    try {
        Invoke-RestMethod -Uri "https://api.anthropic.com/v1/models" -Headers @{ "x-api-key" = $key; "anthropic-version" = "2023-06-01" } -TimeoutSec 30 | Out-Null
        Write-Host "Key accepted." -ForegroundColor Green
    } catch {
        Write-Host "The key was not accepted ($($_.Exception.Message)). Nothing saved." -ForegroundColor Red; exit 1
    }
    Set-EnvLine "ANTHROPIC_API_KEY" $key
    $key = $null
    Write-Host "Saved in dashboard\.env.local (this file is not shared through GitHub)."
}

# --- python for the tasks
$py = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $py) { Write-Host "Python not found." -ForegroundColor Red; exit 1 }
$pyw = Join-Path (Split-Path $py) "pythonw.exe"
if (-not (Test-Path $pyw)) { $pyw = $py }
$set = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

# --- 2) Shift reports (this PC's clock is GMT)
$act = New-ScheduledTaskAction -Execute $pyw -Argument ("`"" + (Join-Path $live "agent_report.py") + "`" --config `"" + $cfgPath + "`"") -WorkingDirectory (Join-Path $root "forecast")
$trig = @((New-ScheduledTaskTrigger -Daily -At "07:00"), (New-ScheduledTaskTrigger -Daily -At "19:05"))
Register-ScheduledTask -TaskName "MCSolar AI Reports" -Action $act -Trigger $trig -Settings $set -Description "Mount Coffee AI shift reports (read-only)" -Force | Out-Null
Write-Host "Registered 'MCSolar AI Reports' (07:00 and 19:05)." -ForegroundColor Green

# --- 3) Telegram
if (-not $SkipTelegram) {
    $ans = Read-Host "Set up the Telegram bot now? (y/n)"
    if ($ans -match "^[yY]") {
        Write-Host "In Telegram: message @BotFather, send /newbot, pick a name; copy the token it gives you."
        & $py (Join-Path $live "set_telegram.py")
        $act = New-ScheduledTaskAction -Execute $pyw -Argument ("`"" + (Join-Path $live "telegram_bot.py") + "`" --config `"" + $cfgPath + "`"") -WorkingDirectory (Join-Path $root "forecast")
        $trig = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
        Register-ScheduledTask -TaskName "MCSolar Telegram" -Action $act -Trigger $trig -Settings $set -Description "Mount Coffee Telegram assistant (read-only)" -Force | Out-Null
        Write-Host "Registered 'MCSolar Telegram'. Each operator: send /start to the bot, then add their chat id:" -ForegroundColor Green
        Write-Host "   python live\set_telegram.py --allow <chat id>   (in the forecast folder)"
    }
}

# --- 4) Rebuild and restart the dashboard with the key
& (Join-Path $here "setup_dashboard.ps1")
try {
    $s = Invoke-RestMethod -Uri "http://localhost:3000/api/agent" -TimeoutSec 20
    if ($s.configured) { Write-Host "AI assistant ready (model $($s.model)). Click 'Ask AI' at the bottom right of the dashboard." -ForegroundColor Green }
    else { Write-Host "The dashboard does not see the key - check dashboard\.env.local." -ForegroundColor Yellow }
} catch { Write-Host "Could not check the assistant yet; open http://localhost:3000 and click 'Ask AI'." -ForegroundColor Yellow }
