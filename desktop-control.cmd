@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\start-desktop-control.ps1" -Provider both -CreateShortcuts
pause
