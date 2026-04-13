$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$stateDir = Join-Path $repoRoot ".cyberboss-state"
$listenUrl = "ws://127.0.0.1:8765"
$logFile = Join-Path $stateDir "logs\shared-wechat.log"

Set-Location $repoRoot
$env:CYBERBOSS_USER_NAME = "小周"
$env:CYBERBOSS_USER_GENDER = "female"
$env:CYBERBOSS_ALLOWED_USER_IDS = "o9cq806g2juwG4Ll2W7tF_OjTG4U@im.wechat"
$env:CYBERBOSS_ACCOUNT_ID = "d97a721ea399-im.bot"
$env:CYBERBOSS_WORKSPACE_ROOT = $repoRoot
$env:CYBERBOSS_STATE_DIR = $stateDir
$env:CYBERBOSS_CODEX_COMMAND = "codex.cmd"
$env:CYBERBOSS_CODEX_ENDPOINT = $listenUrl
$env:CYBERBOSS_WEIXIN_ADAPTER = "v2"

& node .\bin\cyberboss.js start --checkin *>> $logFile
