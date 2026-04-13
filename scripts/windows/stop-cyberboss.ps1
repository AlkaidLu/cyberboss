$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$stateDir = Join-Path $repoRoot ".cyberboss-state"
$appPidFile = Join-Path $stateDir "logs\shared-app-server.pid"
$bridgePidFile = Join-Path $stateDir "logs\shared-wechat.pid"

function Stop-TrackedProcess {
  param(
    [string]$PidFile
  )

  if (-not (Test-Path $PidFile)) {
    return
  }

  $rawPid = (Get-Content $PidFile | Select-Object -First 1).Trim()
  if (-not $rawPid) {
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    return
  }

  try {
    $process = Get-Process -Id ([int]$rawPid) -ErrorAction Stop
    Stop-Process -Id $process.Id -Force -ErrorAction Stop
    Write-Host ("Stopped process {0} ({1})." -f $process.Id, $process.ProcessName)
  } catch {
    Write-Host ("Process {0} is not running." -f $rawPid)
  }

  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

Stop-TrackedProcess -PidFile $bridgePidFile
Stop-TrackedProcess -PidFile $appPidFile

try {
  $listeners = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction Stop
  foreach ($listener in $listeners) {
    try {
      $process = Get-Process -Id $listener.OwningProcess -ErrorAction Stop
      if ($process.ProcessName -match "^(node|powershell|cmd)$") {
        Stop-Process -Id $process.Id -Force -ErrorAction Stop
        Write-Host ("Stopped port 8765 listener {0} ({1})." -f $process.Id, $process.ProcessName)
      }
    } catch {
      # best effort
    }
  }
} catch {
  # no listener found
}

Write-Host "Cyberboss background processes have been stopped."
