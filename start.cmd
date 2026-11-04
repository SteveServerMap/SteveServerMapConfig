@echo off
rem 双击启动本地配置工具，然后浏览器打开 http://127.0.0.1:5273/
rem 需要 Node.js 18+（不下载任何依赖）。
setlocal
cd /d "%~dp0"

echo.
echo   Steve Server 地图配置工具
echo   地址: http://127.0.0.1:5273/
echo   停止: Ctrl + C
echo.
echo   站点目录（默认 ..\SteveServerMap.github.io）：
echo     %~dp0..\SteveServerMap.github.io
echo.

where node >nul 2>nul
if %errorlevel%==0 goto runnode

echo   [x] 没有找到 Node.js。
echo       请安装 Node.js 18+（https://nodejs.org/）后重新双击本文件。
echo.
pause
exit /b 1

:runnode
node server.mjs %*
set EXITCODE=%errorlevel%
if not "%EXITCODE%"=="0" (
  echo.
  echo   退出码 %EXITCODE%：如果提示端口被占用，可换端口启动：
  echo     node server.mjs --port=5300
  echo.
  pause
)
endlocal
