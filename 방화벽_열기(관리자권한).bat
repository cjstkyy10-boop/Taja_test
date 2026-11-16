@echo off
:: Auto-elevate to Administrator
net session >nul 2>&1
if %errorLevel% neq 0 (
    powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"
chcp 65001 > nul
title Windows Firewall Auto Fix
color 0E

echo ================================================================
echo    [Firewall Fix] Opening Port 3000 and Allowing Node.js...
echo ================================================================
echo.

:: 1. Remove any existing BLOCK rules for node.exe (Block overrides Allow in Windows Firewall)
powershell -Command "Get-NetFirewallApplicationFilter | Where-Object { $_.Program -like '*node.exe*' } | Get-NetFirewallRule | Where-Object { $_.Action -eq 'Block' } | Remove-NetFirewallRule -ErrorAction SilentlyContinue"

:: 2. Allow node.exe executable directly for all profiles (Domain, Private, Public)
for /f "delims=" %%i in ('where node') do (
    netsh advfirewall firewall add rule name="NodeJS_Allow_In" dir=in action=allow program="%%i" enable=yes profile=any > nul 2>&1
    netsh advfirewall firewall add rule name="NodeJS_Allow_Out" dir=out action=allow program="%%i" enable=yes profile=any > nul 2>&1
)

:: 3. Allow TCP/UDP Port 3000 for all network profiles
netsh advfirewall firewall delete rule name="TypingContest_3000" > nul 2>&1
netsh advfirewall firewall add rule name="TypingContest_3000" dir=in action=allow protocol=TCP localport=3000 profile=any
netsh advfirewall firewall add rule name="TypingContest_3000" dir=out action=allow protocol=TCP localport=3000 profile=any

echo.
echo ================================================================
echo    SUCCESS! Windows Firewall is now open for Port 3000 and Node.js!
echo ================================================================
echo.
pause
