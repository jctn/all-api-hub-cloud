@echo off
setlocal

cd /d "%~dp0"

if not exist "packages\worker\.env" if not exist "packages\worker\.env.local" (
  echo [worker-dev] Missing packages\worker\.env or packages\worker\.env.local
  echo [worker-dev] Copy packages\worker\.env.example to packages\worker\.env and fill in your local secrets first.
  exit /b 1
)

echo [worker-dev] Building shared workspaces...
call npm run build --workspace @all-api-hub/browser --workspace @all-api-hub/core --workspace @all-api-hub/server --workspace @all-api-hub/worker
if errorlevel 1 (
  echo [worker-dev] Build failed.
  exit /b 1
)

echo [worker-dev] Starting local browser worker in dev mode...
call npm run dev:worker
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo [worker-dev] Worker exited with code %EXIT_CODE%.
)

exit /b %EXIT_CODE%
