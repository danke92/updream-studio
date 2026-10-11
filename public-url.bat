@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo   NEXUS STAGE - 生成公网访问网址（任何网络、任何设备可打开）
echo ============================================================
echo.
echo 使用说明：
echo   1. 先确保工作台已启动（双击 start.bat），本机 http://127.0.0.1:8788/ 能打开
echo   2. 运行本脚本，稍等几秒，屏幕上会出现 https://xxxxxxxx.lhr.life
echo   3. 把这个网址发给任何设备 / 在任何网络下打开即可，无需安装任何东西
echo.
echo 注意：
echo   - 这个黑色窗口【不能关闭】，关掉网址立刻失效
echo   - 这台电脑必须保持开机且工作台在运行
echo   - 每次重新运行，网址会变（免费版随机域名）
echo   - 无需下载：用的是 Windows 自带的 OpenSSH，不安装任何软件
echo.
echo 正在建立隧道，请稍候...
echo ============================================================
echo.

ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -o ServerAliveInterval=60 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -R 80:127.0.0.1:8788 nokey@localhost.run

echo.
echo 隧道已断开。
pause
