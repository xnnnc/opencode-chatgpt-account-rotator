@echo off
setlocal

cd /d "%~dp0"

start "Rotator GUI Server" cmd /k "npm run gui"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:4317"

endlocal
