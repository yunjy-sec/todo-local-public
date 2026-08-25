@echo off
setlocal
cd /d "%~dp0"

set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
    echo csc.exe not found - .NET Framework 4.x required
    exit /b 1
)

rem Stamp which commit this build came from, embedded into the exe.
rem Why not the build time: see src/BuildInfo.cs (mtime does not identify code).
rem With git -> read it now. Without git (ZIP release) -> use the shipped commit.txt,
rem which tools/cut writes into the generated tree.
git rev-parse --git-dir >nul 2>&1
if not errorlevel 1 (
    for /f "usebackq delims=" %%c in (`git log -1 "--format=%%h %%cI" 2^>nul`) do >commit.txt echo %%c
)
if not exist commit.txt >commit.txt echo unknown

"%CSC%" /nologo /target:winexe /platform:anycpu /optimize+ /codepage:65001 ^
    /win32manifest:app.manifest ^
    /out:TodoPopup.exe ^
    /r:System.dll ^
    /r:System.Core.dll ^
    /r:System.Drawing.dll ^
    /r:System.Windows.Forms.dll ^
    /r:System.Runtime.Serialization.dll ^
    /r:System.Xml.dll ^
    /resource:commit.txt,commit ^
    src\*.cs

if errorlevel 1 (
    echo BUILD FAILED
    exit /b 1
)
echo BUILD OK: TodoPopup.exe
