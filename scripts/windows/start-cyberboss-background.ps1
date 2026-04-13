$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$stateDir = Join-Path $repoRoot ".cyberboss-state"
$workspaceRoot = $repoRoot
$logDir = Join-Path $stateDir "logs"
$appServerPidFile = Join-Path $logDir "shared-app-server.pid"
$bridgePidFile = Join-Path $logDir "shared-wechat.pid"
$appServerLogFile = Join-Path $logDir "shared-app-server.log"
$bridgeLogFile = Join-Path $logDir "shared-wechat.log"
$listenUrl = "ws://127.0.0.1:8765"

New-Item -ItemType Directory -Path $logDir -Force | Out-Null

function Test-ProcessAlive {
  param([string]$PidFile)

  if (-not (Test-Path $PidFile)) {
    return $false
  }

  $rawPid = (Get-Content $PidFile | Select-Object -First 1).Trim()
  if (-not $rawPid) {
    return $false
  }

  try {
    Get-Process -Id ([int]$rawPid) -ErrorAction Stop | Out-Null
    return $true
  } catch {
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    return $false
  }
}

function Start-AppServerIfNeeded {
  $ready = $false
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8765/readyz" -TimeoutSec 2
    $ready = $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch {
    $ready = $false
  }

  if ($ready) {
    Write-Host "Shared app-server already ready."
    return
  }

  $appServerCommand = "cd /d `"$repoRoot`" && codex.cmd app-server --listen $listenUrl >> `"$appServerLogFile`" 2>&1"

  $process = Start-Process -FilePath "cmd.exe" `
    -WindowStyle Hidden `
    -WorkingDirectory $repoRoot `
    -PassThru `
    -ArgumentList @("/c", $appServerCommand)
  Set-Content -Path $appServerPidFile -Value $process.Id
  Start-Sleep -Seconds 2
}

function Start-BridgeIfNeeded {
  if (Test-ProcessAlive -PidFile $bridgePidFile) {
    Write-Host "Cyberboss bridge already running."
    return
  }

  $runnerPath = Join-Path $repoRoot "scripts\windows\run-cyberboss-bridge.ps1"

  $process = Start-Process -FilePath "powershell.exe" `
    -WindowStyle Hidden `
    -WorkingDirectory $repoRoot `
    -PassThru `
    -ArgumentList @(
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", $runnerPath
    )
  Set-Content -Path $bridgePidFile -Value $process.Id
}

Start-AppServerIfNeeded
Start-BridgeIfNeeded

Write-Host "Cyberboss background processes started."
Write-Host "Use status-cyberboss.cmd to check status."
