@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ============================================================
rem  固定域名：如果你在 admin.localhost.run 订阅了 Custom Domain，
rem  把你的域名填在下面（例如 nexus.lhr.rocks 或 stage.你的域名.com）。
rem  没订阅就留空 —— 会用免费随机域名（每次可能变）。
rem ============================================================
set "DOMAIN="

set "FWD=80:127.0.0.1:8788"
set "USERHOST=localhost.run"
if not "%DOMAIN%"=="" set "FWD=%DOMAIN%:80:127.0.0.1:8788"
if not "%DOMAIN%"=="" set "USERHOST=plan@localhost.run"

echo ============================================================
echo   NEXUS STAGE - 公网访问网址
echo ============================================================
echo.
echo  本地服务： http://127.0.0.1:8788/
echo  连接账号： %USERHOST%
if "%DOMAIN%"=="" (
  echo  域名模式： 免费随机域名（每次运行可能变）
) else (
  echo  域名模式： 固定域名 %DOMAIN%
)
echo.
echo 说明：
echo   - 出现 https://... 之后，任何设备、任何网络都能打开
echo   - 这个黑窗口【不能关】，关掉网址立刻失效
echo   - 本机必须保持开机，且 start.bat 的工作台在运行
echo   - 无需下载任何软件（用的是 Windows 自带 OpenSSH）
echo.
echo 正在建立隧道，请稍候...
echo ============================================================
echo.

ssh -i "%USERPROFILE%\.ssh\id_ed25519" -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -o ServerAliveInterval=60 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -R %FWD% %USERHOST%

echo.
echo 隧道已断开。
pause
