param([switch]$Online)
$ErrorActionPreference = 'Stop'
$projectPath = $PSScriptRoot
$address = 'http://127.0.0.1:8765'
function Test-Podpis {
    try {
        $response = Invoke-RestMethod -Uri "$address/api/state" -TimeoutSec 2
        return ($null -ne $response.settings -and $null -ne $response.history)
    } catch { return $false }
}
if (-not (Test-Podpis)) {
    $nodePath = (Get-Command node -ErrorAction Stop).Source
    $logPath = Join-Path $projectPath 'data'
    New-Item -ItemType Directory -Force -Path $logPath | Out-Null
    $process = Start-Process -FilePath $nodePath -ArgumentList ('"' + (Join-Path $projectPath 'server.mjs') + '"') -WorkingDirectory $projectPath -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logPath 'server.log') -RedirectStandardError (Join-Path $logPath 'error.log')
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if (Test-Podpis) { $ready = $true; break }
        Start-Sleep -Milliseconds 300
    }
    if (-not $ready) { throw 'Could not start the game. See data/error.log. Port 8765 may be busy.' }
    Set-Content -LiteralPath (Join-Path $logPath 'server.pid') -Value $process.Id
}
if ($Online) {
    try { Invoke-RestMethod -Uri "$address/api/share/start" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 10 | Out-Null }
    catch { throw 'Could not enable remote access. Stop the old game with stop.cmd, then run start-online.cmd again.' }
    Start-Process "$address/#share"
} else { Start-Process $address }
