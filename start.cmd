@echo off
rem Double-click to start the local config tool and open the browser.
rem Requires Node.js 18+ (no dependencies are downloaded).
rem
rem Note: do NOT double-click index.html - browsers refuse ES modules under
rem file://, the page only shows the "must open via local server" notice.
setlocal
cd /d "%~dp0"

set "PORT=5273"
rem Extra args are passed through, e.g.:
rem   start.cmd --port=5300 --site="D:\path\SteveServerMap.github.io"
set "ARGS=%*"

echo.
echo   Steve Server map config tool
echo   URL:  http://127.0.0.1:%PORT%/   (if the startup log shows another port, use that)
echo   Stop: Ctrl + C
echo.
echo   Site dir (default ..\SteveServerMap.github.io):
echo     %~dp0..\SteveServerMap.github.io
echo.

where node >nul 2>nul
if %errorlevel%==0 goto runnode

echo   [x] Node.js not found.
echo       Install Node.js 18+ (https://nodejs.org/) and double-click this file again.
echo.
pause
exit /b 1

:runnode
rem Open the browser 2 seconds later (separate background cmd, does not block node)
start "" /b cmd /c "%SystemRoot%\System32\timeout.exe /t 2 >nul & start "" http://127.0.0.1:%PORT%/"
node server.mjs %ARGS%
set EXITCODE=%errorlevel%
if not "%EXITCODE%"=="0" (
  echo.
  echo   Exit code %EXITCODE%: if the port is in use, try another port:
  echo     start.cmd --port=5300
  echo.
  pause
)
endlocal
