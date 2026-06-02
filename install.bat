@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1

REM OpenPLC Editor Web - Windows 11 deploy script

cd /d "%~dp0"
set "ROOT_DIR=%CD%"
set "MIN_NODE_MAJOR=20"
set "MIN_NPM_MAJOR=10"
set "MODE=full"
set "DO_START=1"

goto :parse_args

:parse_args
if "%~1"=="" goto args_done
if /i "%~1"=="--check" set "MODE=check" & shift & goto parse_args
if /i "%~1"=="--fix-deps" set "MODE=fix-deps" & shift & goto parse_args
if /i "%~1"=="--no-start" set "DO_START=0" & shift & goto parse_args
if /i "%~1"=="--help" goto show_help
if /i "%~1"=="-h" goto show_help
echo [ERR ] Unknown argument: %~1
goto show_help

:args_done
if /i "%MODE%"=="check" goto do_check
if /i "%MODE%"=="fix-deps" goto do_fix_deps
goto do_full

:show_help
echo install.bat [--check] [--fix-deps] [--no-start]
exit /b 0

:print_info
echo [INFO] %~1
goto :eof

:print_ok
echo [ OK ] %~1
goto :eof

:print_warn
echo [WARN] %~1
goto :eof

:print_err
echo [ERR ] %~1
goto :eof

:check_os
powershell -NoProfile -ExecutionPolicy Bypass -Command "& { $b = [Environment]::OSVersion.Version.Build; if ($b -lt 22000) { Write-Host '[ERR ] Requires Windows 11 (Build 22000+)'; exit 1 }; $v = (Get-CimInstance Win32_OperatingSystem).Caption; Write-Host ('[ OK ] OS: {0} (Build {1})' -f $v, $b); exit 0 }"
if errorlevel 1 exit /b 1
goto :eof

:check_repo
if not exist "%ROOT_DIR%\package.json" (
  call :print_err "package.json not found"
  exit /b 1
)
call :print_ok "Project: %ROOT_DIR%"
goto :eof

:check_git
where git >nul 2>&1
if errorlevel 1 ( call :print_err "Git not installed" & exit /b 1 )
for /f "delims=" %%v in ('git --version 2^>nul') do call :print_ok "%%v"
goto :eof

:check_tar
where tar >nul 2>&1
if errorlevel 1 ( call :print_err "tar not found" & exit /b 1 )
for /f "delims=" %%v in ('tar --version 2^>nul') do ( call :print_ok "tar - %%v" & goto tar_done )
:tar_done
goto :eof

:check_powershell
powershell -NoProfile -Command "exit ($PSVersionTable.PSVersion.Major -lt 5)" >nul 2>&1
if errorlevel 1 ( call :print_err "PowerShell 5.1+ required" & exit /b 1 )
for /f "delims=" %%v in ('powershell -NoProfile -Command "Write-Output $PSVersionTable.PSVersion.ToString()"') do call :print_ok "PowerShell %%v"
goto :eof

:check_node
where node >nul 2>&1
if errorlevel 1 (
  call :print_err "Node.js not installed"
  exit /b 1
)
for /f "delims=" %%v in ('node -v 2^>nul') do set "NODE_VER=%%v"
set "NODE_NUM=!NODE_VER:v=!"
for /f "tokens=1 delims=." %%m in ("!NODE_NUM!") do set "NODE_MAJOR=%%m"
if not defined NODE_MAJOR (
  call :print_err "Cannot read Node version"
  exit /b 1
)
if !NODE_MAJOR! LSS %MIN_NODE_MAJOR% (
  call :print_err "Node !NODE_VER! too old"
  exit /b 1
)
if !NODE_MAJOR! GEQ 24 (
  call :print_err "Node !NODE_VER! too new (need ^<24)"
  exit /b 1
)
call :print_ok "Node.js !NODE_VER!"
goto :eof

:check_npm
where npm >nul 2>&1
if errorlevel 1 ( call :print_err "npm not installed" & exit /b 1 )
for /f %%m in ('npm -v 2^>nul') do set "NPM_VER=%%m"
for /f "tokens=1 delims=." %%a in ("!NPM_VER!") do set "NPM_MAJOR=%%a"
if !NPM_MAJOR! LSS %MIN_NPM_MAJOR% ( call :print_err "npm v!NPM_VER! too old" & exit /b 1 )
call :print_ok "npm v!NPM_VER!"
goto :eof

:check_vs_build_tools
call :print_warn "VS C++ build tools not checked (optional for serialport)"
goto :eof

:run_dependency_checks
set "CHECK_FAILED=0"
echo.
call :print_info "========== Environment check (Windows 11 Web) =========="
echo.
call :check_os
if errorlevel 1 set "CHECK_FAILED=1"
call :check_repo
if errorlevel 1 set "CHECK_FAILED=1"
echo.
call :print_info "--- System tools ---"
call :check_git
if errorlevel 1 set "CHECK_FAILED=1"
call :check_tar
if errorlevel 1 set "CHECK_FAILED=1"
call :check_powershell
if errorlevel 1 set "CHECK_FAILED=1"
call :check_vs_build_tools
echo.
call :print_info "--- Node runtime ---"
call :check_node
if errorlevel 1 set "CHECK_FAILED=1"
call :check_npm
if errorlevel 1 set "CHECK_FAILED=1"
echo.
if "!CHECK_FAILED!"=="1" (
  call :print_err "Dependency check failed"
  exit /b 1
)
call :print_ok "All required dependencies OK"
exit /b 0

:check_binaries
set "NODE_ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "NODE_ARCH=arm64"
set "BIN_DIR=%ROOT_DIR%\resources\bin\win32\%NODE_ARCH%"
echo.
call :print_info "--- Compiler binaries ---"
if exist "%BIN_DIR%\xml2st.exe" if exist "%BIN_DIR%\iec2c.exe" (
  call :print_ok "xml2st.exe / iec2c.exe ready"
) else (
  call :print_warn "Missing xml2st or iec2c"
)
if exist "%BIN_DIR%\arduino-cli.exe" (
  call :print_ok "arduino-cli.exe ready"
) else (
  call :print_warn "arduino-cli.exe not found"
)
goto :eof

:check_desktop_session
goto :eof

:do_fix_deps
where winget >nul 2>&1
if errorlevel 1 ( call :print_err "winget not found" & exit /b 1 )
where git >nul 2>&1
if errorlevel 1 winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements
where node >nul 2>&1
if errorlevel 1 winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
goto do_check

:do_check
call :run_dependency_checks
exit /b %ERRORLEVEL%

:deploy
call :print_info "========== Build and deploy =========="
set "HUSKY=0"
call :print_info "npm install..."
call npm install
if errorlevel 1 exit /b 1
call :check_binaries
if not exist "%ROOT_DIR%\release\app\dist\renderer\index.html" (
  call :print_info "npm run build:renderer..."
  call npm run build:renderer
  if errorlevel 1 exit /b 1
) else (
  call :print_info "Skip build:renderer (artifact exists)"
)
if not exist "%ROOT_DIR%\release\app\dist\renderer\index.html" (
  call :print_err "Frontend build failed"
  exit /b 1
)
call :print_ok "Build complete"
exit /b 0

:do_full
call :run_dependency_checks
if errorlevel 1 exit /b 1
call :deploy
if errorlevel 1 exit /b 1
if "%DO_START%"=="0" (
  call :print_info "Skipped start (--no-start)"
  exit /b 0
)
call :print_info "========== Start service =========="
call "%ROOT_DIR%\start.bat"
exit /b %ERRORLEVEL%
