@echo off
rem PC capture helper: install the MITM root CA into the Windows trust store
rem and point the system proxy at the local capture proxy.
rem Run as Administrator. Pair with capture-pc-stop.bat to restore the proxy.
setlocal EnableExtensions
title QQ_FARM_CAPTURE_PC_START
chcp 65001 >nul

set "REPO=%~dp0..\.."
set "CA=%REPO%\core\data\capture\ca\ca.crt"
set "PROXY_HOST=127.0.0.1"
set "PROXY_PORT=18000"
set "IKEY=HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"

net session >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Administrator rights required.
    echo         Right-click this file -^> Run as administrator.
    goto :fail
)

if not exist "%CA%" (
    echo [ERROR] CA not found: %CA%
    echo         Start the bot once so the capture service creates it.
    goto :fail
)

echo [1/3] Installing capture root CA into Trusted Root Certification Authorities...
certutil -addstore -f ROOT "%CA%" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Failed to install the CA.
    goto :fail
)
echo       done.

echo [2/3] Setting system proxy -^> %PROXY_HOST%:%PROXY_PORT% ...
reg add "%IKEY%" /v ProxyEnable /t REG_DWORD /d 1 /f >nul
reg add "%IKEY%" /v ProxyServer /t REG_SZ /d "%PROXY_HOST%:%PROXY_PORT%" /f >nul
reg add "%IKEY%" /v ProxyOverride /t REG_SZ /d "<local>;localhost;127.*;10.*;192.168.*" /f >nul
echo       done.

echo [3/3] Checking the capture proxy is listening on %PROXY_PORT% ...
netstat -ano | findstr ":%PROXY_PORT%" | findstr "LISTENING" >nul
if errorlevel 1 (
    echo [WARN] Nothing is listening on %PROXY_PORT%.
    echo        Start a capture session in the panel first (Capture Login -^> Start).
    echo        The proxy only runs while a session is active.
) else (
    echo       proxy is up.
)

echo.
echo [READY]
echo   1. Open QQ Farm on this PC and enter the event.
echo   2. Click every button in it, 2 seconds apart.
echo   3. When done, run capture-pc-stop.bat, then stop the capture in the panel.
echo.
echo The HAR will be written to:
echo   %REPO%\core\data\capture\har\
echo.
pause
exit /b 0

:fail
echo.
pause
exit /b 1
