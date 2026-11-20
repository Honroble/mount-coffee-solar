# Restart the Mount Coffee tasks whenever this PC wakes up or the user logs on.
# Why: on 18 and 19 Nov 2026 the PC went into standby on battery in the evening (Windows: "Hibernate from Sleep -
# Standby Battery Budget Exceeded"); the runs that were active froze, still counted as "Running", and Windows then
# refused every later run until the tasks were restarted by hand in the morning.
# This adds one task, "MCSolar Wake Restart", triggered by the wake event (Power-Troubleshooter, event 1) and at logon.
# It ends any MCSolar runs left over from before the sleep and starts them again (not Retrain or AI Reports).
# Run once from PowerShell in the forecast folder:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\live\install_wake_restart.ps1
# Remove with:  ... -File .\live\install_wake_restart.ps1 -Uninstall
param([switch]$Uninstall)
$name = "MCSolar Wake Restart"
if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed $name." -ForegroundColor Green
    exit 0
}

$cmd = @'
Start-Sleep -Seconds 45
$skip = @("MCSolar Retrain", "MCSolar AI Reports", "MCSolar Wake Restart")
$tasks = Get-ScheduledTask -TaskName "MCSolar*" | Where-Object { $skip -notcontains $_.TaskName }
$tasks | Stop-ScheduledTask -ErrorAction SilentlyContinue
Get-Process pythonw -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 5
$tasks | Start-ScheduledTask -ErrorAction SilentlyContinue
Add-Content -Path "$env:USERPROFILE\Downloads\mcsolar\data\live\collector_log.txt" -Value ((Get-Date).ToUniversalTime().ToString("yyyy-MM-dd HH:mm") + " UTC  wake restart: MCSolar tasks restarted after the PC woke or the user logged on")
'@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd))
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand $encoded"

# trigger 1: wake from sleep/hibernate (System log, Microsoft-Windows-Power-Troubleshooter, event 1)
$class = Get-CimClass -ClassName MSFT_TaskEventTrigger -Namespace Root/Microsoft/Windows/TaskScheduler
$wake = New-CimInstance -CimClass $class -ClientOnly
$wake.Enabled = $true
$wake.Subscription = '<QueryList><Query Id="0" Path="System"><Select Path="System">*[System[Provider[@Name=''Microsoft-Windows-Power-Troubleshooter''] and EventID=1]]</Select></Query></QueryList>'
# trigger 2: user logs on
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $name -Action $action -Trigger @($wake, $logon) -Settings $settings -Description "Mount Coffee solar: restart the MCSolar tasks after wake or logon" -Force | Out-Null
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    Write-Host "Installed '$name': restarts the MCSolar tasks 45 s after the PC wakes or you log on." -ForegroundColor Green
} else {
    Write-Host "Could not register '$name'." -ForegroundColor Red
}
