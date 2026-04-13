$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$stateDir = Join-Path $repoRoot ".cyberboss-state"

Set-Location $repoRoot
$env:CYBERBOSS_STATE_DIR = $stateDir
$env:CYBERBOSS_WORKSPACE_ROOT = $repoRoot
$env:CYBERBOSS_CODEX_COMMAND = "codex.cmd"

node .\scripts\shared-open.js
