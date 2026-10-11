@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo   NEXUS STAGE · 放行局域网访问（防火墙）
echo ============================================================
echo.
echo 作用：允许手机 / 平板 / 其它电脑通过局域网访问本机 8788 端口
echo 说明：Windows 会弹出「是否允许此应用更改设备」，请点「是」
echo.

net session >nul 2>&1
if errorlevel 1 (
  echo [!] 需要管理员权限，正在请求提升...
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo [*] 添加入站放行规则 TCP 8788 ...
netsh advfirewall firewall delete rule name="NEXUS STAGE 8788" >nul 2>&1
netsh advfirewall firewall add rule name="NEXUS STAGE 8788" dir=in action=allow protocol=TCP localport=8788 profile=any
if errorlevel 1 (
  echo [!] 添加失败，请手动在防火墙中放行 TCP 8788
) else (
  echo [OK] 已放行。其它设备现在可以访问 http://本机IP:8788/
)

echo.
echo 本机局域网地址：
ipconfig | findstr /i "IPv4"
echo.
pause
