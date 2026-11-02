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
  "$root = (Get-Location).Path; " ^
  "Remove-Item (Join-Path $root 'data\.bridge-stopped') -Force -ErrorAction SilentlyContinue; " ^
  "$watcher = Get-Process -Name 'work-office-native' -ErrorAction SilentlyContinue; " ^
  "$binPath = Join-Path $root 'bin\work-office-native.exe'; " ^
  "if (-not $watcher -and (Test-Path $binPath)) { " ^
  "  $si = [CimInstance]::new((Get-CimClass Win32_ProcessStartup)); $si.ShowWindow = 0; " ^
  "  Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ('\"' + $binPath + '\" watch-bridge \"' + $root + '\"'); CurrentDirectory = $root; ProcessStartupInformation = $si } | Out-Null; " ^
  "}; " ^
  "$up = $false; try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:4310/health' -TimeoutSec 2 -UseBasicParsing; $up = ($r.StatusCode -eq 200) } catch {}; " ^
  "if (-not $up) { " ^
  "  Write-Host 'Đang khởi động Docker container work-office...' -ForegroundColor Cyan; " ^
  "  docker start work-office 2>$null | Out-Null; " ^
  "  if ($LASTEXITCODE -ne 0) { docker compose up -d }; " ^
  "  for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 600; try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:4310/health' -TimeoutSec 1 -UseBasicParsing; if ($r.StatusCode -eq 200) { break } } catch {} } " ^
  "} else { Write-Host 'Container work-office đang chạy sẵn!' -ForegroundColor Green }; " ^
  "Start-Process 'http://localhost:4310'"
