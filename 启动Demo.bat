@echo off
cd /d "%~dp0"
echo Local Delivery Review Demo
echo Browser: http://127.0.0.1:4174
echo Close this window to stop the local service.
start "" http://127.0.0.1:4174
node server.js
pause
