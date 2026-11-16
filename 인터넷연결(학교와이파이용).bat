@echo off
cd /d "%~dp0"
chcp 65001 > nul
title Hangeul Typing Contest Server
color 0A

taskkill /F /IM node.exe > nul 2>&1
taskkill /F /IM cloudflared.exe > nul 2>&1

node server.js
pause
