@echo off
setlocal
cd /d "%~dp0"

set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
    echo csc.exe not found - .NET Framework 4.x required
    exit /b 1
)

"%CSC%" /nologo /target:winexe /platform:anycpu /optimize+ /codepage:65001 ^
    /win32manifest:app.manifest ^
    /out:TodoPopup.exe ^
    /r:System.dll ^
    /r:System.Core.dll ^
    /r:System.Drawing.dll ^
    /r:System.Windows.Forms.dll ^
    /r:System.Runtime.Serialization.dll ^
    /r:System.Xml.dll ^
    src\*.cs

if errorlevel 1 (
    echo BUILD FAILED
    exit /b 1
)
echo BUILD OK: TodoPopup.exe
