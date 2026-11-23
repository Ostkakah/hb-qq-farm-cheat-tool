@echo off
chcp 65001 >nul
title PUSH_TO_GITHUB
cd /d "%~dp0"

echo.
echo [1/3] 检查待推送内容...
git status --short
echo.
echo [2/3] 目标远端:
git remote -v | findstr "mine"
echo.
echo [3/3] 推送到 GitHub（会弹出浏览器请你在 GitHub 上点授权）...
echo.
git push mine main

if errorlevel 1 (
    echo.
    echo [ERROR] 推送失败。常见原因：
    echo        - 没有授权：先执行 "git credential-manager github login" 再重试
    echo        - 远端仓库名不对：执行 "git remote set-url mine https://github.com/Ostkakah/hb-qq-farm-cheat-tool.git"
    echo.
) else (
    echo.
    echo [OK] 推送完成。
)
echo.
pause
