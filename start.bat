@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>&1
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\lib\start-service.ps1" %*
set "EXITCODE=%ERRORLEVEL%"
call "%~dp0scripts\lib\pause-if-doubleclick.cmd" %EXITCODE%
exit /b %EXITCODE%
