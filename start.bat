@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo   NEXUS STAGE - AI 视频制作工作台（本地）
echo ============================================================

where python >nul 2>nul
if errorlevel 1 (
  echo [!] 未检测到 Python，请先安装 Python 3.10+ 并勾选 "Add to PATH"
  pause & exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo [*] 首次运行：创建虚拟环境...
  python -m venv .venv
  if errorlevel 1 ( echo [!] 虚拟环境创建失败 & pause & exit /b 1 )
  echo [*] 安装依赖 playwright / pillow ...
  ".venv\Scripts\python.exe" -m pip install --upgrade pip -q
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
  if errorlevel 1 ( echo [!] 依赖安装失败，可手动执行 pip install -r requirements.txt & pause & exit /b 1 )
  echo [*] 安装 Chromium（updream 采集需要，约 100MB）...
  ".venv\Scripts\python.exe" -m playwright install chromium
)

echo [*] 启动服务（监听 0.0.0.0:8788，本机与局域网均可访问）
echo     如果其它设备（手机 / 平板 / 另一台电脑）打不开，
echo     请先右键「以管理员身份运行」allow-lan.bat 放行防火墙。
echo.
start "" http://127.0.0.1:8788
".venv\Scripts\python.exe" server.py 8788
pause
