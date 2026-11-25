@echo off
setlocal
cd /d "%~dp0"
set "HOST=127.0.0.1"
set "PORT=4186"
set "DATABASE_URL="
set "APP_DATA_DIR=%LOCALAPPDATA%\DeliveryDesk"
set "OLLAMA_HOST=127.0.0.1:11434"
set "OLLAMA_URL=http://127.0.0.1:11434"
set "PATH=%LOCALAPPDATA%\Programs\Ollama;%PATH%"
where ollama >nul 2>nul
if errorlevel 1 (
 winget install --id Ollama.Ollama --exact --source winget
 if errorlevel 1 goto failed
)
ollama list >nul 2>nul
if errorlevel 1 (
 start "" /min ollama serve
 timeout /t 4 >nul
)
ollama list | findstr /i /c:"qwen3:4b " >nul
if errorlevel 1 (
 ollama pull qwen3:4b
 if errorlevel 1 goto failed
)
exit /b 0
:failed
echo Model setup failed. Run this file to retry.
pause

