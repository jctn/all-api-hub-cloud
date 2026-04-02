@echo off
setlocal

cd /d "%~dp0"

if not exist "packages\worker\.env" if not exist "packages\worker\.env.local" (
  echo [worker-keepalive] Missing packages\worker\.env or packages\worker\.env.local
  echo [worker-keepalive] Copy packages\worker\.env.example to packages\worker\.env and fill in your local secrets first.
  exit /b 1
)

echo [worker-keepalive] Building shared workspaces...
call npm run build --workspace @all-api-hub/browser --workspace @all-api-hub/core --workspace @all-api-hub/server --workspace @all-api-hub/worker
if errorlevel 1 (
  echo [worker-keepalive] Build failed.
  exit /b 1
)

echo [worker-keepalive] Starting worker keepalive loop. Close the window to stop it.

:restart
call npm run start:worker
set "EXIT_CODE=%ERRORLEVEL%"

if "%EXIT_CODE%"=="0" (
  echo [worker-keepalive] Worker exited normally.
  exit /b 0
)

echo [worker-keepalive] Worker exited with code %EXIT_CODE%. Restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto restart
