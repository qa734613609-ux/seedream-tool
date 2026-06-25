@echo off
cd /d "%~dp0"
echo Starting Seedream image tool...
echo Project: %cd%
echo.
echo Keep this window open while using http://localhost:3000
echo.
node server.js
pause
