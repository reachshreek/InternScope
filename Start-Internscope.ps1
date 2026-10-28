$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/health' -TimeoutSec 2
    if ($health.app -eq 'internscope') {
        Write-Host 'Internscope is already running. Open http://localhost:3000 in your browser.'
        exit 0
    }
} catch { }
$runtime = Get-Command node -ErrorAction SilentlyContinue
$localRuntime = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot '.tools') -Filter node.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if ($runtime -and ([int]((& $runtime.Source --version) -replace '^v(\d+).*', '$1')) -ge 24) {
    $nodePath = $runtime.Source
} elseif ($localRuntime) {
    $nodePath = $localRuntime.FullName
} else {
    throw 'Node.js 24 or newer is required. Install it from https://nodejs.org, then run this script again.'
}
$env:PATH = "$(Split-Path $nodePath -Parent);$env:PATH"
if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) {
    & (Join-Path (Split-Path $nodePath -Parent) 'npm.cmd') ci --omit=dev
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
Write-Host 'Open http://localhost:3000 in your browser. Keep this window open for automatic refreshes.'
& $nodePath --env-file-if-exists=.env server/index.js
