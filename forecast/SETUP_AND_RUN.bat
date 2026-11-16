@echo off
REM Double-click this file to set up and run the Mount Coffee forecast.
REM It runs setup_and_run.ps1 in the same folder.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_and_run.ps1"
echo.
pause
