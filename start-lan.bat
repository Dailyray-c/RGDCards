@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动局域网联机服务……
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [错误] 未检测到 Node.js。请先安装：https://nodejs.org （LTS 版，勾选 "Add to PATH"）
  echo 安装后重新双击本文件即可。
  pause
  exit /b 1
)
node lan-server.js
echo.
echo 服务已停止。
pause
