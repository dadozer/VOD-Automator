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

:: Limit Node.js memory usage to prevent runaway heap allocations (e.g. 16GB spikes)
set "NODE_OPTIONS=--max-old-space-size=4096"

echo ===================================================
echo             VOD Automator Installer
echo ===================================================

:: Safeguard config.json
if exist config.json (
  echo Safeguarding existing config.json to config.json.bak...
  copy /y config.json config.json.bak >nul 2>&1
) else if exist config.json.bak (
  echo Restoring config.json from backup...
  copy /y config.json.bak config.json >nul 2>&1
)

:: Pre-install check: stop running service / process if performing an update or reinstall
echo Stopping existing VOD Automator services or instances...
net stop "VOD Automator" >nul 2>&1
taskkill /F /IM vodautomator.exe >nul 2>&1

:: Safe delay without timeout.exe to avoid input redirection crashes
ping 127.0.0.1 -n 3 >nul

:: Update from git if this is a Git clone
if exist .git (
  where git >nul 2>&1
  if %errorlevel% equ 0 (
    echo Updating repository via git pull...
    call git pull
  )
)

:: Restore config if newly extracted ZIP replaced or omitted it
if not exist config.json (
  if exist config.json.bak (
    echo Restoring config.json from backup...
    copy /y config.json.bak config.json >nul 2>&1
  )
)

:: Fast, reliable dependency installation
echo Installing dependencies...
call npm install --no-audit --no-fund
if %errorlevel% neq 0 (
  echo Retrying dependency installation with legacy peer dependencies...
  call npm install --legacy-peer-deps --no-audit --no-fund
)
if %errorlevel% neq 0 (
  echo.
  echo ERROR: npm install failed! Please check the output above.
  pause
  exit /b %errorlevel%
)

echo Building application...
call npm run build
if %errorlevel% neq 0 (
  echo.
  echo ERROR: Build failed! Please check the output above.
  pause
  exit /b %errorlevel%
)

echo Registering and starting VOD Automator Windows Service...
node scripts/install-service.js

echo.
echo ===================================================
echo   VOD Automator setup/update complete!
echo   Service is running in the background.
echo   Local Dashboard: http://localhost:3000
echo ===================================================
pause
