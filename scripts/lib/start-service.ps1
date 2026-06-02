param(
    [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
. (Join-Path $PSScriptRoot 'web-service.ps1')
Initialize-OpenPlcWebService -RootDir $repoRoot

if (Test-ServiceRunning) {
    if (-not (Confirm-RestartIfRunning -Force:$Yes.IsPresent)) {
        exit 0
    }
    Stop-WebService
    Wait-PortFree | Out-Null
}

Start-WebService
