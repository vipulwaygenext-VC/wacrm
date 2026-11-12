@echo off
REM Double-click this file to set up the Hindrishi label printer.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -Path . -Filter *.ps1 | Unblock-File"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-print-agent.ps1"
echo.
echo If you see a red error above, take a screenshot and send it to Claude.
pause
