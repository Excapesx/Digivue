@echo off
REM ============================================================
REM  digivue daily refresh + build
REM ------------------------------------------------------------
REM  Run by Windows Task Scheduler once a day:
REM    1. refresh prices   ->  prices.json
REM    2. rebuild the site ->  dist/
REM
REM  Deploy is NOT automatic (it needs your EdgeOne credentials).
REM  Upload the whole dist/ folder after this script finishes.
REM
REM  Usage:
REM    daily.bat            snapshot prices, no external API
REM    daily.bat jd         JD Union API (needs JD_UNION_KEY /
REM                         JD_UNION_SECRET / JD_UNION_PID in the
REM                         machine environment, not in this file)
REM
REM  NOTE: this file is ASCII-only on purpose. cmd.exe reads .bat
REM  files in the machine OEM code page, and non-ASCII comments
REM  can break parsing on Chinese Windows.
REM ============================================================

setlocal
cd /d "%~dp0"

set "LOG=%~dp0refresh.log"
set "PROVIDER=%~1"

echo. >> "%LOG%"
echo ============================================ >> "%LOG%"
echo [%date% %time%] start (provider=%PROVIDER%) >> "%LOG%"

REM ---------- 1. find node ----------
where node >nul 2>nul
if errorlevel 1 (
  echo [%date% %time%] ERROR: node not found in PATH >> "%LOG%"
  echo node not found. Install Node.js 18+ first.
  exit /b 1
)

REM ---------- 2. refresh prices ----------
echo [%date% %time%] refresh prices... >> "%LOG%"
if "%PROVIDER%"=="" (
  call node refresh-price.mjs >> "%LOG%" 2>&1
) else (
  call node refresh-price.mjs --provider %PROVIDER% >> "%LOG%" 2>&1
)
if errorlevel 1 (
  echo [%date% %time%] refresh FAILED - prices.json untouched >> "%LOG%"
  echo refresh failed, see refresh.log
  exit /b 1
)

REM ---------- 3. rebuild the site ----------
echo [%date% %time%] rebuild... >> "%LOG%"
call node build.mjs >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [%date% %time%] build FAILED >> "%LOG%"
  echo build failed, see refresh.log
  exit /b 1
)

REM ---------- 4. deploy (optional) ----------
REM Install and log in once, then remove the REM on these lines:
REM   npm i -g edgeone
REM   edgeone login
REM call edgeone deploy --dir dist >> "%LOG%" 2>&1
REM if errorlevel 1 echo [%date% %time%] deploy FAILED - upload dist\ by hand >> "%LOG%"

echo [%date% %time%] done. dist\ is up to date, upload it to EdgeOne Pages. >> "%LOG%"
echo done. dist\ is up to date.
exit /b 0
