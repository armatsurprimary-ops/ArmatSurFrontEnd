@echo off
REM ============================================================
REM  Armat-sur Session Runner - launcher
REM  Starts the local server in its own window (it prints the
REM  OpenRouter traffic live; close that window to stop it)
REM  and opens the app in your default browser.
REM ============================================================
setlocal
cd /d "%~dp0"
set PORT=8000

REM --- If the server is already running, just open the browser ---
netstat -ano | findstr /C:":%PORT% " | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
    start "" "http://localhost:%PORT%"
    exit /b 0
)

REM --- Find Python ---
set PY=
where python >nul 2>nul
if not errorlevel 1 set "PY=python"
if not defined PY (
    where py >nul 2>nul
    if not errorlevel 1 set "PY=py -3"
)

if not defined PY (
    echo Python was not found on this system.
    echo Install it from https://www.python.org/ and run this file again.
    pause
    exit /b 1
)

REM --- Start the server in its own visible window ---
start "Armat-sur server - close window to stop" %PY% serve.py %PORT%

REM --- Give it a moment, then open the app ---
timeout /t 2 /nobreak >nul
start "" "http://localhost:%PORT%"
exit /b 0
