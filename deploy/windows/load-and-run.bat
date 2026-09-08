@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem ==========================================================================
rem load-and-run.bat - Command Prompt version of load-and-run.ps1
rem
rem   Load the Docker images from the offline bundle and start LINE Workflow App
rem   with docker compose. Run it from the extracted bundle folder
rem   (needs images.tar.gz, docker-compose.prod.yml and .env).
rem
rem   load-and-run.bat                  start app only (existing PostgreSQL)
rem   load-and-run.bat localdb          start app + PostgreSQL on this machine
rem   load-and-run.bat localdb setup    ...and create tables (first run)
rem   load-and-run.bat setup            existing PostgreSQL + create tables
rem   load-and-run.bat skipload         do not docker load again
rem
rem   Options are case-insensitive; "-Setup", "/setup" and "setup" all work.
rem   Messages are in English on purpose: cmd.exe shows Thai text as garbage
rem   unless the console code page is changed first.
rem ==========================================================================

cd /d "%~dp0"

set "LOCALDB=0"
set "SETUP=0"
set "SKIPLOAD=0"

for %%A in (%*) do (
  set "ARG=%%~A"
  set "ARG=!ARG:-=!"
  set "ARG=!ARG:/=!"
  if /I "!ARG!"=="localdb"  set "LOCALDB=1"
  if /I "!ARG!"=="setup"    set "SETUP=1"
  if /I "!ARG!"=="skipload" set "SKIPLOAD=1"
  if /I "!ARG!"=="help"     goto :usage
  if /I "!ARG!"=="?"        goto :usage
)

rem ---------- checks ----------
where docker >nul 2>&1
if errorlevel 1 (
  set "MSG=docker command not found (install Docker Desktop or Docker Engine first)"
  goto :fail
)
docker info >nul 2>&1
if errorlevel 1 (
  set "MSG=Docker is not running"
  goto :fail
)
if not exist "docker-compose.prod.yml" (
  set "MSG=docker-compose.prod.yml not found in this folder"
  goto :fail
)
if not exist ".env" (
  set "MSG=.env not found - run:  copy .env.example .env   then fill in the real values"
  goto :fail
)

rem ---------- guard: values containing $ must be single-quoted ----------
rem docker compose expands $name inside .env values (ADMIN_PASSWORD_HASH starts with $2b$10$,
rem passwords may contain $). Unquoted, the value reaches the container mangled and login /
rem SQL Server auth fail silently. Single quotes make compose pass the value literally.
set "BADENV=0"
for /f "usebackq eol=# tokens=1* delims==" %%K in (".env") do (
  set "VAL=%%L"
  if defined VAL (
    set "FIRST=!VAL:~0,1!"
    if not "!FIRST!"=="'" (
      echo(!VAL!| findstr /c:"$" >nul && (
        echo [x] .env: %%K contains $ but is not single-quoted. Change it to:  %%K='...value...'
        set "BADENV=1"
      )
    )
  )
)
if "%BADENV%"=="1" (
  set "MSG=fix the .env lines above (wrap the value in single quotes) then run again"
  goto :fail
)

rem ---------- merge image tags from bundle.env into .env (only keys not present yet) ----------
if exist "bundle.env" (
  for /f "usebackq eol=# tokens=1* delims==" %%K in ("bundle.env") do (
    findstr /b /r /c:"%%K=" ".env" >nul 2>&1
    if errorlevel 1 (
      >>".env" echo %%K=%%L
      echo   added %%K to .env
    )
  )
)

rem ---------- media folder on this machine (bind mounted into /app/storage) ----------
rem docker-compose.prod.yml mounts ${MEDIA_HOST_DIR:-D:/QTEC/File_Storage/LineWorkflow} as /app/storage.
rem Create it up front so the location is obvious and a missing drive fails with a clear message.
set "MEDIA_HOST_DIR=D:/QTEC/File_Storage/LineWorkflow"
for /f "usebackq eol=# tokens=1* delims==" %%K in (".env") do (
  if /I "%%K"=="MEDIA_HOST_DIR" if not "%%L"=="" set "MEDIA_HOST_DIR=%%L"
)
set "MEDIA_HOST_DIR=%MEDIA_HOST_DIR:'=%"
set "MEDIA_DIR_WIN=%MEDIA_HOST_DIR:/=\%"
if not exist "%MEDIA_DIR_WIN%\" (
  call :step "Creating media folder %MEDIA_DIR_WIN%"
  mkdir "%MEDIA_DIR_WIN%"
  if errorlevel 1 (
    set "MSG=cannot create %MEDIA_DIR_WIN% - check the drive exists or change MEDIA_HOST_DIR in .env"
    goto :fail
  )
)

rem ---------- docker load ----------
if "%SKIPLOAD%"=="1" goto :compose
if not exist "images.tar.gz" (
  set "MSG=images.tar.gz not found"
  goto :fail
)
call :step "Loading images into Docker (docker load) - this can take a while"
docker load -i images.tar.gz
if errorlevel 1 (
  set "MSG=docker load failed"
  goto :fail
)

:compose
set "COMPOSE=docker compose -f docker-compose.prod.yml"
set "PROFILE="
if "%LOCALDB%"=="1" set "PROFILE=--profile localdb"

call :step "Starting services (docker compose up -d)"
%COMPOSE% %PROFILE% up -d
if errorlevel 1 (
  set "MSG=docker compose up failed"
  goto :fail
)

rem ---------- first-run table setup ----------
if "%SETUP%"=="0" goto :status

if "%LOCALDB%"=="1" (
  call :step "Waiting for PostgreSQL to become healthy"
  set "READY=0"
  for /l %%I in (1,1,30) do (
    if "!READY!"=="0" (
      for /f "delims=" %%S in ('docker inspect -f "{{.State.Health.Status}}" line-workflow-postgres 2^>nul') do (
        if "%%S"=="healthy" set "READY=1"
      )
      if "!READY!"=="0" timeout /t 2 /nobreak >nul
    )
  )
  if "!READY!"=="0" (
    set "MSG=PostgreSQL did not become healthy in time"
    goto :fail
  )
)

call :step "Creating tables and sample data (db-setup)"
%COMPOSE% --profile setup run --rm db-setup
if errorlevel 1 (
  set "MSG=db-setup failed - check DATABASE_URL in .env"
  goto :fail
)

:status
call :step "Status"
%COMPOSE% ps

set "PORT=3000"
for /f "usebackq eol=# tokens=1* delims==" %%K in (".env") do (
  if /I "%%K"=="PORT" set "PORT=%%L"
)

echo.
echo   Open      : http://localhost:%PORT%   (or http://^<this-machine-ip^>:%PORT%)
echo   Media dir : %MEDIA_DIR_WIN%   (bind mount -^> /app/storage)
echo   Logs      : docker compose -f docker-compose.prod.yml logs -f app
echo   Stop      : docker compose -f docker-compose.prod.yml down
echo.
endlocal
exit /b 0

rem ---------- helpers ----------
:step
echo.
echo ==^> %~1
exit /b 0

:fail
echo.
echo [x] %MSG%
endlocal
exit /b 1

:usage
echo.
echo   load-and-run.bat [localdb] [setup] [skipload]
echo.
echo     localdb   also start PostgreSQL from docker-compose.prod.yml
echo     setup     run db-setup after start (first run)
echo     skipload  skip docker load (images already loaded)
echo.
endlocal
exit /b 0
