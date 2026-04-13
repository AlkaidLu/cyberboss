@echo off
setlocal
cd /d "%~dp0"
set "TIMELINE_FOR_AGENT_STATE_DIR=%~dp0.cyberboss-state"
set "TIMELINE_FOR_AGENT_LOCALE=zh-CN"
npm.cmd run timeline:build
endlocal
