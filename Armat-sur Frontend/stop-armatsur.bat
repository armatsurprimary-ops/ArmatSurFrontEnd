@echo off
REM ============================================================
REM  Armat-sur Session Runner - stopper
REM  Kills the local server started by start-armatsur.bat
REM  (usually you can just close the server window instead)
REM ============================================================
setlocal
set PORT=8000
set FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /C:":%PORT% " ^| findstr "LISTENING"') do (
    taskkill /PID %%a /F >nul 2>nul
    set FOUND=1
)
if "%FOUND%"=="1" (
    echo Armat-sur server stopped.
) else (
    echo No Armat-sur server was running.
)
timeout /t 2 >nul
exit /b 0