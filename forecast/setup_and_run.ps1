# Mount Coffee forecast: one-click setup and test run (Windows).
# 1. Installs Python 3.13 with winget if Python is missing
# 2. Copies the data files from your Downloads folder into ..\data
# 3. Installs the Python packages
# 4. Trains the model (plant + weather + satellite where those files are present)
# 5. Runs a test forecast for 13 Nov 2026 11:30 and saves the output
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$data = Join-Path $root "data"
$downloads = Join-Path $env:USERPROFILE "Downloads"
Set-Location $here

function Step($n, $msg) { Write-Host ""; Write-Host "=== Step $n : $msg ===" -ForegroundColor Cyan }
function Find-Python {
    foreach ($c in @("python", "py")) {
        try { $v = & $c --version 2>&1; if ($LASTEXITCODE -eq 0 -and "$v" -match "Python 3\.(1[1-9])") { return $c } } catch {}
    }
    return $null
}

Step 1 "Python"
$py = Find-Python
if (-not $py) {
    Write-Host "Python 3.11+ not found. Installing Python 3.13 with winget..."
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Host "winget is not available on this computer." -ForegroundColor Red
        Write-Host "Please install Python 3.13 (64-bit) from https://www.python.org/downloads/windows/"
        Write-Host "and tick 'Add python.exe to PATH', then double-click SETUP_AND_RUN.bat again."
        exit 1
    }
    winget install -e --id Python.Python.3.13 --scope user --accept-package-agreements --accept-source-agreements
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "User") + ";" + [Environment]::GetEnvironmentVariable("Path", "Machine")
    $py = Find-Python
    if (-not $py) {
        Write-Host "Python was installed. Please close this window and double-click SETUP_AND_RUN.bat again." -ForegroundColor Yellow
        exit 1
    }
}
Write-Host "Using $(& $py --version)"

Step 2 "Data files"
New-Item -ItemType Directory -Force -Path $data | Out-Null
$want = @{
    "iv2" = "iv2_20260917_000000_20261114_000000*.csv";
    "iv1" = "iv1_20260917_000000_20261114_000000*.csv";
    "sat" = "mount_coffee_satellite_ghi*.csv"
}
$files = @{}
foreach ($k in $want.Keys) {
    $existing = Get-ChildItem -Path $data -Filter $want[$k] -ErrorAction SilentlyContinue | Sort-Object Length -Descending | Select-Object -First 1
    if (-not $existing) {
        $src = Get-ChildItem -Path $downloads -Filter $want[$k] -ErrorAction SilentlyContinue | Sort-Object Length -Descending | Select-Object -First 1
        if ($src) { Copy-Item $src.FullName $data; $existing = Get-Item (Join-Path $data $src.Name); Write-Host "Copied $($src.Name)" }
    }
    if ($existing) { $files[$k] = $existing.FullName; Write-Host "$k : $($existing.Name)" }
    else { Write-Host "$k : not found in $downloads or $data" -ForegroundColor Yellow }
}
if (-not $files["iv2"]) {
    Write-Host "The plant file (iv2_20260917_000000_20261114_000000.csv) is required. Put it in $data and run again." -ForegroundColor Red
    exit 1
}

Step 3 "Python packages (needs internet, a few minutes the first time)"
& $py -m pip install --upgrade pip --quiet
& $py -m pip install pandas numpy scikit-learn pvlib joblib --quiet
if ($LASTEXITCODE -ne 0) { Write-Host "Package install failed. Check the internet connection and run again." -ForegroundColor Red; exit 1 }

Step 4 "Train the model (2-3 minutes)"
$trainArgs = @("train.py", "--iv2", $files["iv2"])
$fcArgs = @("forecast.py", "--iv2", $files["iv2"])
$model = "mcsolar_model.joblib"
if ($files["iv1"]) { $trainArgs += @("--iv1", $files["iv1"]); $fcArgs += @("--iv1", $files["iv1"]); $model = "mcsolar_model_weather.joblib" }
if ($files["iv1"] -and $files["sat"]) { $trainArgs += @("--sat", $files["sat"]); $fcArgs += @("--sat", $files["sat"]); $model = "mcsolar_model_satellite.joblib" }
$trainArgs += @("--out", $model)
& $py -W ignore @trainArgs | Tee-Object -FilePath (Join-Path $here "training_report.txt")
if ($LASTEXITCODE -ne 0) { Write-Host "Training failed - copy the message above and send it to Claude." -ForegroundColor Red; exit 1 }

Step 5 "Test forecast for 13 Nov 2026 11:30"
$fcArgs += @("--model", $model, "--at", "2026-11-13 11:30")
& $py -W ignore @fcArgs | Tee-Object -FilePath (Join-Path $here "test_forecast.txt")
if ($LASTEXITCODE -ne 0) { Write-Host "Forecast failed - copy the message above and send it to Claude." -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "Done. Model: $here\$model" -ForegroundColor Green
Write-Host "Reports saved: training_report.txt and test_forecast.txt in $here"
