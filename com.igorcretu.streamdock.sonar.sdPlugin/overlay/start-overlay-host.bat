@echo off
rem Launched via $websocket.openUrl() from plugin/index.js (a browser-like webview
rem with no child_process access) — StreamDock itself ShellExecutes this file,
rem same mechanism already used to launch SteelSeriesGGEZ.exe elsewhere in the plugin.
start "" /min powershell.exe -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0overlay-host.ps1"
