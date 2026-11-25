@echo off
rem PC capture helper: restore the Windows system proxy.
rem Run as Administrator. Pair with capture-pc-start.bat.
setlocal EnableExtensions
title QQ_FARM_CAPTURE_PC_STOP
chcp 65001 >nul

set "IKEY=HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"

net session >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Administrator rights required.
    echo         Right-click this file -^> Run as administrator.
    goto :fail
)

echo [1/2] Disabling the system proxy ...
reg add "%IKEY%" /v ProxyEnable /t REG_DWORD /d 0 /f >nul
reg delete "%IKEY%" /v ProxyServer /f >nul 2>&1
reg delete "%IKEY%" /v ProxyOverride /f >nul 2>&1
echo       done.

echo [2/2] Reminder: stop the capture session in the panel.
echo         The HAR is written to core\data\capture\har\ when the session stops.
echo.
pause
exit /b 0

:fail
echo.
pause
exit /b 1
