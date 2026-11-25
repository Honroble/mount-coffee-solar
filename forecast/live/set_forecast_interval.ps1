# Switch the live forecast between every 1 minute (fresh data) and every 5 minutes (original behaviour).
# Run in PowerShell opened with "Run as administrator", from the forecast folder:
#     powershell -ExecutionPolicy Bypass -File live\set_forecast_interval.ps1 -Minutes 1     # new
#     powershell -ExecutionPolicy Bypass -File live\set_forecast_interval.ps1 -Minutes 5     # roll back
# It writes forecast_issue_every_min, satellite_refresh_min and sheet_every_min into live\config.json (keeping every
# other setting as it is) and changes how often the "MCSolar Forecast" task runs.
param([ValidateSet(1, 5)][int]$Minutes = 1)

$cfgPath = Join-Path $PSScriptRoot "config.json"
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
foreach ($kv in @(@("forecast_issue_every_min", $Minutes), @("satellite_refresh_min", 5), @("sheet_every_min", 5))) {
    $cfg | Add-Member -NotePropertyName $kv[0] -NotePropertyValue $kv[1] -Force
}
[IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding $false))
Write-Host "config.json: forecast_issue_every_min = $Minutes"

$task = Get-ScheduledTask -TaskName "MCSolar Forecast"
$trig = $task.Triggers[0]
$trig.Repetition.Interval = "PT$($Minutes)M"
$settings = $task.Settings
$settings.ExecutionTimeLimit = $(if ($Minutes -lt 5) { "PT3M" } else { "PT10M" })
Set-ScheduledTask -TaskName "MCSolar Forecast" -Trigger $trig -Settings $settings | Out-Null
Write-Host "MCSolar Forecast now runs every $Minutes minute(s)."
