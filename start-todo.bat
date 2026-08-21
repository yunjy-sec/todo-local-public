@echo off
rem ============================================================
rem  TodoPopup - start the local app (tray + list window)
rem  Local-only by default. Nothing goes over the network.
rem  Just double-click this file.
rem ============================================================
setlocal
set "APP=%~dp0app"
set "ELECTRON=%APP%\node_modules\electron\dist\electron.exe"

if exist "%ELECTRON%" goto RUN

echo.
echo   First run: preparing (this can take a few minutes)...
echo.
where npm >nul 2>&1
if errorlevel 1 goto NONODE
pushd "%APP%"
call npm install
popd
if not exist "%ELECTRON%" goto FAILED

:RUN
start "" "%ELECTRON%" "%APP%" %*
exit /b 0

:NONODE
echo   [ERROR] Node.js is required. Install it and run again.
echo           Lightweight alternative: build.cmd makes TodoPopup.exe (no Node needed).
pause
exit /b 1

:FAILED
echo   [ERROR] Preparation failed. See the messages above.
pause
exit /b 1