@echo off
title RevX Photography website
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Please install it from https://nodejs.org (LTS version) and run this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing (first time only, about a minute)...
  call npm install --no-audit --no-fund
)
echo.
echo Starting the website at http://localhost:3000
echo Admin: http://localhost:3000/admin   (password: see HANDOVER.txt)
echo Keep this window open while you use the site. Close it to stop.
echo.
start "" http://localhost:3000
node src\server.js
pause
