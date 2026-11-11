@echo off
cd /d "%~dp0"
if exist "bin\tuna.exe" (
  "bin\tuna.exe" tunnel
) else (
  where tuna.exe >nul 2>nul
  if errorlevel 1 (
    echo Install Tuna CLI or put tuna.exe in the bin folder. See README.md.
    pause
    exit /b 1
  )
  tuna.exe tunnel
)
pause
