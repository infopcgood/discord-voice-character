@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 LTS from https://nodejs.org and run again.
  pause
  exit /b 1
)
if not exist .env (
  copy .env.example .env >nul
  echo Fill in .env, save it, then run start.cmd again.
  notepad .env
  exit /b 0
)
if not exist node_modules (
  call npm install
  if errorlevel 1 goto fail
)
call npm run register
if errorlevel 1 goto fail
call npm start
:fail
pause
