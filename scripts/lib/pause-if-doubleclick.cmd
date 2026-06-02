@echo off
REM Pause when launched from Explorer (cmd.exe /c "script.bat"). Skip when run from an open terminal.
if defined OPENPLC_SKIP_PAUSE exit /b 0
echo %CMDCMDLINE% | findstr /i /c:"/c " >nul
if errorlevel 1 exit /b 0

echo.
if not "%~1"=="" if not "%~1"=="0" (
  echo [ERR ] Exit code: %~1
)
echo Press any key to close...
pause >nul
exit /b 0
