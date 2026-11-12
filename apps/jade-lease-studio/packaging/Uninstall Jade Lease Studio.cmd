@echo off
setlocal
cd /d "%TEMP%"
powershell.exe -NoProfile -Command "$root = Join-Path $env:LOCALAPPDATA 'Jade Lease Studio'; $exe = Join-Path $root 'App\JadeLeaseStudio.exe'; Get-Process -Name JadeLeaseStudio -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | ForEach-Object { taskkill.exe /PID $_.Id /T /F }; Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name JadeLeaseStudio -ErrorAction SilentlyContinue; $shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Jade Lease Studio.lnk'; Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2; Remove-Item -LiteralPath $root -Recurse -Force; Write-Host 'Jade Lease Studio removed. Saved plans in Documents were kept.'"
pause
