@echo off
chcp 65001 >nul
title Work Office 3D — Stop Docker & Host Bridge
cd /d "%~dp0"
echo Đang dừng Docker container work-office và Host Bridge...
node scripts\docker-ctl.mjs down
echo Đã dừng hoàn tất!
timeout /t 2 >nul
