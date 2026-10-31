@echo off
chcp 65001 >nul
title Work Office 3D — Docker & CLI Launcher
cd /d "%~dp0"

REM Ensure Antigravity CLI (agy.exe) is in PATH for this session
set "PATH=%LOCALAPPDATA%\agy\bin;%USERPROFILE%\.gemini\bin;%PATH%"

REM Clear any stale Desktop App environment variables so Work Office uses standalone Antigravity CLI (agy.exe)
set "ANTIGRAVITY_LS_ADDRESS="
set "ANTIGRAVITY_CSRF_TOKEN="

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$bridgeUp = $false; try { $rb = Invoke-WebRequest -Uri 'http://127.0.0.1:4311/health' -TimeoutSec 1 -UseBasicParsing; $bridgeUp = ($rb.StatusCode -eq 200) } catch {}; " ^
  "if (-not $bridgeUp) { " ^
  "  $vbs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\My Office.vbs'; " ^
  "  if (Test-Path $vbs) { Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ('wscript.exe \"' + $vbs + '\"'); CurrentDirectory = 'E:\WorkOffice' } | Out-Null } " ^
  "  else { Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'node.exe E:\WorkOffice\server\host-bridge.mjs'; CurrentDirectory = 'E:\WorkOffice' } | Out-Null } " ^
  "}; " ^
  "$up = $false; try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:4310/health' -TimeoutSec 2 -UseBasicParsing; $up = ($r.StatusCode -eq 200) } catch {}; " ^
  "if (-not $up) { " ^
  "  Write-Host 'Đang khởi động Docker container work-office...' -ForegroundColor Cyan; " ^
  "  docker start work-office 2>$null | Out-Null; " ^
  "  if ($LASTEXITCODE -ne 0) { docker compose up -d }; " ^
  "  for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 600; try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:4310/health' -TimeoutSec 1 -UseBasicParsing; if ($r.StatusCode -eq 200) { break } } catch {} } " ^
  "} else { Write-Host 'Container work-office đang chạy sẵn!' -ForegroundColor Green }; " ^
  "Start-Process 'http://localhost:4310'"
