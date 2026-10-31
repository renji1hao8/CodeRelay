@echo off
cd /d "%~dp0"
if exist "%~dp0runtime\node.exe" ("%~dp0runtime\node.exe" scripts\doctor.mjs) else (node scripts\doctor.mjs)
pause
