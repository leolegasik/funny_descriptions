$ErrorActionPreference = 'Stop'
$pidPath = Join-Path $PSScriptRoot 'data/server.pid'
try {
    Invoke-RestMethod -Uri 'http://127.0.0.1:8765/api/shutdown' -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 10 | Out-Null
    if (Test-Path -LiteralPath $pidPath) { Remove-Item -LiteralPath $pidPath }
    exit 0
} catch { }
if (Test-Path -LiteralPath $pidPath) {
    $serverProcessId = [int](Get-Content -LiteralPath $pidPath)
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $serverProcessId"
    $expectedScript = Join-Path $PSScriptRoot 'server.mjs'
    if ($process -and $process.Name -eq 'node.exe' -and $process.CommandLine.Contains($expectedScript)) {
        Stop-Process -Id $serverProcessId
    }
    Remove-Item -LiteralPath $pidPath
}
