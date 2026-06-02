function Initialize-OpenPlcWebService {
    param(
        [Parameter(Mandatory)]
        [string]$RootDir,
        [int]$ApiPort = $(if ($env:API_PORT) { [int]$env:API_PORT } else { 3001 })
    )

    $script:RootDir = $RootDir
    $script:ApiPort = $ApiPort
    $script:PidFile = Join-Path $RootDir 'logs\openplc-web.pid'
    $script:LogFile = Join-Path $RootDir 'logs\openplc-web.log'
    $script:ErrLog = Join-Path $RootDir 'logs\openplc-web.err.log'
}

function Write-Info([string]$Message) { Write-Host "[INFO] $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "[ OK ] $Message" -ForegroundColor Green }
function Write-WarnMsg([string]$Message) { Write-Host "[WARN] $Message" -ForegroundColor Yellow }
function Write-ErrMsg([string]$Message) { Write-Host "[ERR ] $Message" -ForegroundColor Red }

function Test-ServiceRunning {
    if (Test-Path $script:PidFile) {
        $pidText = (Get-Content $script:PidFile -Raw).Trim()
        if ($pidText -match '^\d+$') {
            $proc = Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue
            if ($proc -and -not $proc.HasExited) { return $true }
        }
    }

    $listen = Get-NetTCPConnection -LocalPort $script:ApiPort -State Listen -ErrorAction SilentlyContinue
    return [bool]$listen
}

function Get-ServicePid {
    if (Test-Path $script:PidFile) {
        $pidText = (Get-Content $script:PidFile -Raw).Trim()
        if ($pidText -match '^\d+$') { return [int]$pidText }
    }
    $listen = Get-NetTCPConnection -LocalPort $script:ApiPort -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty OwningProcess
    if ($listen) { return [int]$listen }
    return $null
}

function Wait-PortFree {
    for ($i = 0; $i -lt 20; $i++) {
        if (-not (Test-ServiceRunning)) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return -not (Test-ServiceRunning)
}

function Show-ServiceUrls {
    $servicePid = Get-ServicePid
    $ip = (Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
        Select-Object -First 1).IPAddress
    if (-not $ip) { $ip = '127.0.0.1' }

    Write-Host ''
    Write-Ok 'OpenPLC Editor Web service is running'
    Write-Host "  Local:   http://127.0.0.1:$($script:ApiPort)"
    Write-Host "  Network: http://${ip}:$($script:ApiPort)"
    Write-Host "  Log:     $($script:LogFile)"
    Write-Host "  PID:     $servicePid"
    Write-Host '  Stop:    .\stop.bat'
    Write-Host ''
}

function Start-WebService {
    $indexHtml = Join-Path $script:RootDir 'release\app\dist\renderer\index.html'
    if (-not (Test-Path $indexHtml)) {
        Write-ErrMsg 'Frontend build not found. Run install.bat first.'
        exit 1
    }

    New-Item -ItemType Directory -Force -Path (Join-Path $script:RootDir 'logs') | Out-Null

    $env:NODE_ENV = 'production'
    $env:API_PORT = "$($script:ApiPort)"
    $env:HUSKY = '0'

    if (Test-Path $script:LogFile) { Remove-Item $script:LogFile -Force }
    if (Test-Path $script:ErrLog) { Remove-Item $script:ErrLog -Force }

    Write-Info "Starting web service (API_PORT=$($script:ApiPort))..."

    $p = Start-Process -FilePath 'npm.cmd' -ArgumentList 'start' -WorkingDirectory $script:RootDir `
        -WindowStyle Hidden -RedirectStandardOutput $script:LogFile -RedirectStandardError $script:ErrLog -PassThru

    $p.Id | Out-File -FilePath $script:PidFile -Encoding ascii -NoNewline
    Start-Sleep -Seconds 3

    if ($p.HasExited) {
        Write-ErrMsg "Service failed to start. See log: $($script:LogFile)"
        Get-Content $script:LogFile, $script:ErrLog -ErrorAction SilentlyContinue | Select-Object -Last 30
        exit 1
    }

    Show-ServiceUrls
}

function Stop-WebService {
    if (-not (Test-ServiceRunning)) {
        Write-WarnMsg "Service is not running (port $($script:ApiPort))"
        if (Test-Path $script:PidFile) { Remove-Item $script:PidFile -Force }
        return
    }

    $servicePid = Get-ServicePid
    if ($servicePid) {
        Write-Info "Stopping OpenPLC Web service (PID $servicePid)..."
        Stop-Process -Id $servicePid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }

    $listeners = Get-NetTCPConnection -LocalPort $script:ApiPort -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($listenerPid in $listeners) {
        Stop-Process -Id $listenerPid -Force -ErrorAction SilentlyContinue
    }

    if (Test-Path $script:PidFile) { Remove-Item $script:PidFile -Force }

    if (Test-ServiceRunning) {
        Write-ErrMsg "Could not stop service on port $($script:ApiPort)"
        exit 1
    }

    Write-Ok 'Service stopped'
}

function Confirm-RestartIfRunning([bool]$Force) {
    if (-not (Test-ServiceRunning)) { return $true }

    $servicePid = Get-ServicePid
    if ($Force) {
        Write-Info "Service running (PID $servicePid), --yes: restarting"
        return $true
    }

    Write-Host ''
    Write-WarnMsg "Service already running (PID $servicePid, port $($script:ApiPort))"
    $answer = Read-Host 'Restart service? [y/N]'
    if ($answer -match '^(y|Y|yes|YES)$') {
        return $true
    }

    Write-Info 'Keeping current service (no restart)'
    Show-ServiceUrls
    return $false
}
