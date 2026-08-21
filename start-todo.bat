@echo off
rem ============================================================
rem  TodoPopup - the only file you need to run.
rem
rem  Double-click        -> tray + list window
rem  start-todo.bat cal  -> opens the calendar window instead
rem
rem  Two ways to run, picked automatically:
rem    1. Electron build - full features (calendar window, ICS files).
rem       Used when app\node_modules\electron is already present.
rem    2. TodoPopup.exe  - 52KB, no Node.js, no download, no network.
rem       Built here by build.cmd with the csc.exe that ships with
rem       Windows (.NET Framework 4.x). Popup + list + tray + settings.
rem
rem  Nothing goes over the network in either case. This launcher never
rem  downloads anything - if neither runtime is available it says so.
rem ============================================================
setlocal
cd /d "%~dp0"
set "APP=%~dp0app"
set "ELECTRON=%APP%\node_modules\electron\dist\electron.exe"
set "EXE=%~dp0TodoPopup.exe"

set "ARGS=%*"
if /i "%~1"=="cal" set "ARGS=--calendar"
if /i "%~1"=="calendar" set "ARGS=--calendar"

rem  1. Electron, if it is already installed.
if exist "%ELECTRON%" (
    start "" "%ELECTRON%" "%APP%" %ARGS%
    exit /b 0
)

rem  2. The standalone build. Make it if it is not there yet.
if exist "%EXE%" goto RUNEXE

set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" goto NORUNTIME

echo.
echo   Building TodoPopup.exe (a few seconds, nothing is downloaded)...
call "%~dp0build.cmd"
if not exist "%EXE%" goto BUILDFAILED

:RUNEXE
if /i "%ARGS%"=="--calendar" (
    echo.
    echo   [NOTE] The calendar window needs the Electron build.
    echo          Opening the list window instead.
    echo.
    set "ARGS="
)
start "" "%EXE%" %ARGS%
exit /b 0

:NORUNTIME
echo.
echo   [ERROR] No runtime found.
echo.
echo     Option A - no install needed:
echo       This PC has no .NET Framework 4.x, which Windows normally
echo       includes. Enable it in "Turn Windows features on or off".
echo.
echo     Option B - full features:
echo       Install Node.js, then run:  cd app ^&^& npm install
echo       That step downloads packages, so it needs network access.
echo.
pause
exit /b 1

:BUILDFAILED
echo.
echo   [ERROR] Build failed. See the messages above.
pause
exit /b 1
