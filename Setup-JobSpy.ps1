$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$jobspyRuntime = Join-Path $PSScriptRoot '.tools\jobspy\Scripts\python.exe'
$uvTool = Get-Command uv -ErrorAction SilentlyContinue
if ($uvTool) {
    $env:UV_CACHE_DIR = Join-Path $PSScriptRoot '.tools\uv-cache'
    $env:UV_PYTHON_INSTALL_DIR = Join-Path $PSScriptRoot '.tools\python'
    if (!(Test-Path -LiteralPath $jobspyRuntime)) {
        & $uvTool.Source venv .tools/jobspy --python 3.12
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the local Python environment.' }
    }
    & $uvTool.Source pip install --python $jobspyRuntime -r requirements-jobspy.txt
} else {
    $pythonTool = Get-Command python -ErrorAction SilentlyContinue
    if (!$pythonTool) { throw 'Install Python 3.10+ or uv, then run Setup-JobSpy.ps1 again.' }
    if (!(Test-Path -LiteralPath $jobspyRuntime)) {
        & $pythonTool.Source -m venv .tools/jobspy
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the local Python environment.' }
    }
    & $jobspyRuntime -m pip install -r requirements-jobspy.txt
}
if ($LASTEXITCODE -ne 0) { throw 'JobSpy dependency installation failed.' }
& $jobspyRuntime server/jobspy_bridge.py --check
if ($LASTEXITCODE -ne 0) { throw 'JobSpy verification failed.' }
Write-Host 'JobSpy is ready. Restart Internscope to use it on every Indeed and ZipRecruiter refresh.'
