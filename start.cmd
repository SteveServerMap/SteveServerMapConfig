@echo off
rem 双击启动本地配置工具，并自动打开浏览器。
rem 需要 Node.js 18+（不下载任何依赖）。
rem
rem 注意：不要直接双击 index.html —— 浏览器在 file:// 下会拒绝加载 ES Module，
rem       页面只会显示「必须通过本地服务器打开」的提示。
setlocal
cd /d "%~dp0"

set "PORT=5273"
rem 允许透传参数，例如 start.cmd --port=5300 --site="D:\某处\SteveServerMap.github.io"
set "ARGS=%*"

echo.
echo   Steve Server 地图配置工具
echo   地址: http://127.0.0.1:%PORT%/   （若启动日志显示别的端口，以日志为准）
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
rem 2 秒后自动打开浏览器（在后台单独起一个 cmd，不阻塞 node）
start "" /b cmd /c "timeout /t 2 >nul & start "" http://127.0.0.1:%PORT%/"
node server.mjs %ARGS%
set EXITCODE=%errorlevel%
if not "%EXITCODE%"=="0" (
  echo.
  echo   退出码 %EXITCODE%：如果提示端口被占用，可换端口启动：
  echo     start.cmd --port=5300
  echo.
  pause
)
endlocal
