@echo off
:: Check for administrative privileges
net session >nul 2>&1
if %errorLevel% NEQ 0 (
    echo Requesting administrative privileges...
    powershell -Command "Start-Process '%~dpnx0' -Verb RunAs"
    exit /b
)

:: Ensure we are in the script's directory
cd /d "%~dp0"

echo Stopping VOD Automator Service...
net stop "VOD Automator" >nul 2>&1
taskkill /F /IM vodautomator.exe >nul 2>&1
ping 127.0.0.1 -n 2 >nul

echo Uninstalling VOD Automator Service...
node scripts/uninstall-service.js

echo Waiting for service cleanup to complete...
ping 127.0.0.1 -n 4 >nul
echo Uninstallation complete.
pause
