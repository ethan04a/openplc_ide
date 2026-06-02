$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
. (Join-Path $PSScriptRoot 'web-service.ps1')
Initialize-OpenPlcWebService -RootDir $repoRoot
Stop-WebService
