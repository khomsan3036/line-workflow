<#
.SYNOPSIS
  โหลด image จาก offline bundle แล้วเปิดระบบ LINE Workflow App ด้วย docker compose

.DESCRIPTION
  รันในโฟลเดอร์ที่แตก zip ออกมา (ต้องมี images.tar.gz, docker-compose.prod.yml, .env)

  .\load-and-run.ps1                 # เปิด app อย่างเดียว (ใช้ฐานข้อมูลที่มีอยู่แล้ว)
  .\load-and-run.ps1 -LocalDb        # เปิด app + PostgreSQL ในเครื่องนี้
  .\load-and-run.ps1 -LocalDb -Setup # เปิดแล้วสร้างตารางให้ด้วย (ครั้งแรก)
  .\load-and-run.ps1 -SkipLoad       # ไม่ต้องโหลด image ซ้ำ (โหลดไปแล้ว)

  ถ้า PowerShell ไม่ยอมรันสคริปต์:
    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#>
[CmdletBinding()]
param(
  [switch]$LocalDb,
  [switch]$Setup,
  [switch]$SkipLoad
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host "[x] $msg" -ForegroundColor Red; exit 1 }

# ---------- ตรวจความพร้อม ----------
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'ไม่พบคำสั่ง docker (ติดตั้ง Docker Desktop หรือ Docker Engine ก่อน)' }
try { docker info *> $null } catch { Fail 'Docker ไม่ได้รันอยู่' }
if (-not (Test-Path 'docker-compose.prod.yml')) { Fail 'ไม่พบ docker-compose.prod.yml ในโฟลเดอร์นี้' }
if (-not (Test-Path '.env')) {
  Fail 'ยังไม่มีไฟล์ .env  ให้ copy .env.example .env แล้วกรอกค่าจริงก่อน'
}

# ---------- ตรวจค่าที่มี $ ต้องครอบ single quote ----------
# docker compose แทนค่า $ชื่อ ในไฟล์ .env (ADMIN_PASSWORD_HASH ขึ้นต้น $2b$10$, รหัสผ่านที่มี $)
# ถ้าไม่ครอบ single quote ค่าที่เข้า container จะเพี้ยน ล็อกอินไม่ได้ / ต่อ SQL Server ไม่ได้ โดยไม่มี error
$bad = @()
foreach ($line in Get-Content '.env') {
  if ($line -match '^\s*#' -or $line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { continue }
  $key = $Matches[1]; $val = $Matches[2]
  if ($val -match '\$' -and -not $val.StartsWith("'")) { $bad += $key }
}
if ($bad.Count -gt 0) {
  foreach ($k in $bad) { Write-Host "[x] .env: $k มีเครื่องหมาย $ แต่ไม่ได้ครอบ single quote ให้แก้เป็น  $k='...ค่า...'" -ForegroundColor Red }
  Fail 'แก้ไฟล์ .env ตามด้านบนแล้วรันใหม่'
}

# ---------- รวมค่า image tag จาก bundle.env เข้าไปใน .env (ถ้ายังไม่มี) ----------
if (Test-Path 'bundle.env') {
  $envText = Get-Content '.env' -Raw
  foreach ($line in Get-Content 'bundle.env') {
    if ($line -match '^\s*([A-Z_]+)=(.*)$') {
      $key = $Matches[1]
      if ($envText -notmatch "(?m)^\s*$key=") {
        Add-Content '.env' $line
        Write-Host "  เพิ่ม $key ลง .env"
      }
    }
  }
}

# ---------- โฟลเดอร์เก็บไฟล์สื่อบนเครื่องนี้ (bind mount เข้า /app/storage) ----------
# docker-compose.prod.yml mount ${MEDIA_HOST_DIR:-D:/QTEC/File_Storage/LineWorkflow} เป็น /app/storage
# สร้างให้ล่วงหน้าเพื่อให้เห็นชัดว่าไฟล์อยู่ที่ไหน และให้ error อ่านง่ายถ้าไดรฟ์นั้นไม่มี
$mediaDir = 'D:/QTEC/File_Storage/LineWorkflow'
$mediaLine = Get-Content '.env' | Where-Object { $_ -match '^\s*MEDIA_HOST_DIR=(.+)$' } | Select-Object -Last 1
if ($mediaLine -match '^\s*MEDIA_HOST_DIR=(.+)$') { $mediaDir = $Matches[1].Trim().Trim('"', "'") }
$mediaDirWin = $mediaDir -replace '/', '\'
if (-not (Test-Path $mediaDirWin)) {
  Step "สร้างโฟลเดอร์เก็บไฟล์สื่อ $mediaDirWin"
  try { New-Item -ItemType Directory -Path $mediaDirWin -Force | Out-Null }
  catch { Fail "สร้างโฟลเดอร์ $mediaDirWin ไม่ได้ ($($_.Exception.Message)) - ตรวจว่ามีไดรฟ์นี้ หรือแก้ MEDIA_HOST_DIR ใน .env" }
}

# ---------- โหลด image ----------
if (-not $SkipLoad) {
  if (-not (Test-Path 'images.tar.gz')) { Fail 'ไม่พบ images.tar.gz' }
  Step 'โหลด image เข้า Docker (docker load) อาจใช้เวลาสักครู่'
  docker load -i images.tar.gz
  if ($LASTEXITCODE -ne 0) { Fail 'docker load ไม่สำเร็จ' }
}

# ---------- เปิดระบบ ----------
$compose = @('compose', '-f', 'docker-compose.prod.yml')
if ($LocalDb) { $compose += @('--profile', 'localdb') }

Step 'เปิดระบบ (docker compose up -d)'
& docker @compose up -d
if ($LASTEXITCODE -ne 0) { Fail 'docker compose up ไม่สำเร็จ' }

# ---------- สร้างตาราง (ครั้งแรก) ----------
if ($Setup) {
  if ($LocalDb) {
    Step 'รอ PostgreSQL พร้อม'
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
      $status = docker inspect -f '{{.State.Health.Status}}' line-workflow-postgres 2>$null
      if ($status -eq 'healthy') { $ready = $true; break }
      Start-Sleep -Seconds 2
    }
    if (-not $ready) { Fail 'PostgreSQL ไม่พร้อมภายในเวลาที่กำหนด' }
  }
  Step 'สร้างตารางและข้อมูลตัวอย่าง (db-setup)'
  & docker compose -f docker-compose.prod.yml --profile setup run --rm db-setup
  if ($LASTEXITCODE -ne 0) { Fail 'db-setup ไม่สำเร็จ ตรวจ DATABASE_URL ใน .env' }
}

Step 'สถานะ'
& docker compose -f docker-compose.prod.yml ps
Write-Host ''
$port = 3000
$portLine = Get-Content '.env' | Where-Object { $_ -match '^\s*PORT=(\d+)' } | Select-Object -Last 1
if ($portLine -match '^\s*PORT=(\d+)') { $port = $Matches[1] }
Write-Host "  เปิดเว็บ  : http://localhost:$port  (หรือ http://<ip เครื่องนี้>:$port)"
Write-Host "  ไฟล์สื่อ  : $mediaDirWin  (bind mount -> /app/storage)"
Write-Host '  ดู log    : docker compose -f docker-compose.prod.yml logs -f app'
Write-Host '  ปิดระบบ   : docker compose -f docker-compose.prod.yml down'
Write-Host ''
