# Deploy LINE Workflow App บน Windows Server ด้วย Docker (แบบ offline)

ชุดไฟล์นี้สร้างจาก `offline-bundle.sh` มีทุกอย่างที่ต้องใช้ ไม่ต้องให้เครื่องปลายทางต่ออินเทอร์เน็ต

| ไฟล์ | ใช้ทำอะไร |
| --- | --- |
| `images.tar.gz` | Docker image ของ app (และ PostgreSQL ถ้ารวมมา) |
| `docker-compose.prod.yml` | นิยาม service สำหรับรัน |
| `.env.example` | ต้นแบบ config ให้ copy เป็น `.env` |
| `bundle.env` | ชื่อ/tag ของ image ในชุดนี้ (สคริปต์จะเติมให้ใน `.env` เอง) |
| `load-and-run.bat` | โหลด image + เปิดระบบในคำสั่งเดียว (Command Prompt) |
| `load-and-run.ps1` | แบบเดียวกันสำหรับ PowerShell |
| `MANIFEST.txt` | บันทึกว่า build เมื่อไหร่ จาก commit ไหน |

---

## สิ่งที่เครื่อง Windows Server ต้องมี

- Windows Server 2019/2022 (หรือ Windows 10/11) ที่ติดตั้ง **Docker Desktop** (โหมด Linux containers, WSL 2)
  หรือ Docker Engine + `docker compose` v2
- PowerShell 5.1 ขึ้นไป
- เปิดพอร์ตที่ตั้งใน `PORT` (ค่าเริ่มต้น 3000) ใน Windows Firewall ถ้าจะให้เครื่องอื่นใน LAN เข้าถึง
- ถ้าจะรับ webhook จาก LINE ต้องมี HTTPS สาธารณะชี้มาที่เครื่องนี้ (Cloudflare Tunnel, ngrok, หรือ reverse proxy + โดเมน)

---

## ขั้นตอน

### 1) แตก zip แล้วเตรียม `.env`

```powershell
Expand-Archive line-workflow-app_<tag>.zip -DestinationPath C:\line-workflow
cd C:\line-workflow\line-workflow-app_<tag>
copy .env.example .env
notepad .env
```

ค่าที่ต้องแก้ใน `.env`

| ตัวแปร | ค่า |
| --- | --- |
| `DATABASE_URL` | ใช้ PostgreSQL ใน compose: `postgres://postgres:postgres@postgres:5432/linechat`<br>ใช้ฐานข้อมูลที่มีอยู่แล้ว: `postgres://user:pass@192.168.x.x:5432/linechat` (ถ้ารหัสมี `@` `%` ให้ percent-encode เช่น `%40` `%25`) |
| `DATABASE_SSL` | `false` สำหรับฐานข้อมูลใน LAN |
| `PORT` | พอร์ตบนเครื่อง Windows ที่เปิดให้เข้าเว็บ (ค่าเริ่มต้น 3000 เช่น `PORT=5318` -> `http://<ip>:5318`) ภายใน container ยังเป็น 3000 เสมอ nginx ไม่ต้องแก้ |
| `BASE_PATH` | `/line-workflow` เมื่อเปิดผ่าน nginx gateway ที่ `https://qtecintegra.com/line-workflow/` (ปล่อยว่างถ้าเข้าผ่าน `http://<ip>:<PORT>` ตรง ๆ) |
| `DATABASE_URL_MSSQL` | SQL Server ของ HR เช่น `Server=192.168.2.9\SQLEXPRESS01;Database=BPLUSHRM_QTEC;User Id=...;Password=...;TrustServerCertificate=True;`<br>ถ้า SQL Server อยู่บนเครื่อง Windows เดียวกันให้ใช้ `host.docker.internal` แทน `localhost` |
| `CHANNEL_ACCESS_TOKEN_HR` / `CHANNEL_SECRET_HR` | OA หลัก (HR Notification) จาก LINE Developers Console (channel เดียวกันทั้งคู่) ชื่อเดิม `CHANNEL_ACCESS_TOKEN` / `CHANNEL_SECRET` ก็ยังใช้ได้ |
| `CHANNEL_ACCESS_TOKEN_MT` / `CHANNEL_SECRET_MT` | OA ทีมซ่อมบำรุง (แชทบอท MCP) Webhook URL ใน LINE console = `https://qtecintegra.com/api/line-workflow/webhook/mt` (nginx.conf มี location ให้แล้ว) ต้องมี `ANTHROPIC_API_KEY` ด้วย |
| `MOCK_LINE` | `false` |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` | บัญชีเข้า dashboard (สร้าง hash ด้วย `npm run hash-password -- <รหัส>` จากเครื่อง dev) |
| `SESSION_SECRET` | ข้อความสุ่มยาว ๆ ห้ามใช้ค่าเริ่มต้น |
| `COOKIE_SECURE` | `false` ถ้าเปิดเว็บผ่าน `http://<ip>:3000` ตรง ๆ โดยไม่มี HTTPS (ไม่งั้นล็อกอินไม่ติด) |
| `ENABLE_SCHEDULER` | `true` ถ้าต้องการให้สรุปแชท/รายงานรันเองตามเวลา (`SUMMARY_CRON`, `REPORT_CRON`) |
| `MEDIA_LOCAL_DIR` | ปล่อยค่าเริ่มต้น `storage/media` (path ภายใน container ซึ่ง compose bind mount ให้แล้ว) |
| `MEDIA_HOST_DIR` | โฟลเดอร์จริงบนเครื่อง Windows ที่เก็บไฟล์จากไลน์กลุ่ม ค่าเริ่มต้น `D:/QTEC/File_Storage/LineWorkflow` (ใส่เฉพาะเมื่อต้องการเปลี่ยนที่เก็บ ใช้ `/` แทน `\` ไม่ต้องครอบเครื่องหมายคำพูด) สคริปต์ `load-and-run` สร้างโฟลเดอร์ให้ถ้ายังไม่มี |

> **สำคัญ:** ค่าที่มีเครื่องหมาย `$` เช่น `ADMIN_PASSWORD_HASH` (ขึ้นต้น `$2b$10$...`) หรือรหัสผ่านที่มี `$`
> ต้องครอบด้วย single quote เช่น `ADMIN_PASSWORD_HASH='$2b$10$abc...'`
> ไม่งั้น docker compose จะตีความ `$abc` เป็นตัวแปรแล้วค่าหายไป (ทั้ง compose และตัว app อ่านค่าในเครื่องหมายคำพูดได้ถูกต้อง)

### 2) โหลด image และเปิดระบบ

**Command Prompt (cmd.exe)** - ไม่ต้องตั้ง ExecutionPolicy

```bat
cd C:\line-workflow\line-workflow-app_<tag>

rem มี PostgreSQL อยู่แล้ว (ชี้ DATABASE_URL ไปที่นั่น)
load-and-run.bat setup

rem หรือให้ compose เปิด PostgreSQL ให้ด้วยในเครื่องนี้
load-and-run.bat localdb setup

rem รันอีกครั้งโดยไม่โหลด image ซ้ำ
load-and-run.bat localdb skipload
```

**PowerShell** (ทำงานเหมือนกันทุกอย่าง)

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass   # ถ้า PowerShell ไม่ยอมรันสคริปต์
.\load-and-run.ps1 -Setup
.\load-and-run.ps1 -LocalDb -Setup
```

`setup` / `-Setup` รัน `db-setup` เพื่อสร้างตารางและข้อมูลตัวอย่าง ใช้ครั้งแรกครั้งเดียว
(ถ้าฐานข้อมูลมีตารางอยู่แล้วก็รันซ้ำได้ ไม่ทำลายข้อมูลเดิม)

### 3) ตรวจว่าทำงาน

```powershell
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f app
curl http://localhost:3000/health
```

เปิด `http://localhost:<PORT>` แล้วล็อกอิน (หรือ `https://qtecintegra.com/line-workflow/` เมื่อตั้ง `BASE_PATH=/line-workflow`
และเพิ่ม location block ใน nginx.conf ของ gateway แล้ว)
จากนั้นตั้ง Webhook URL ใน LINE Developers Console เป็น `https://qtecintegra.com/api/line-workflow/webhook` แล้วกด Verify

---

## คำสั่งที่ใช้บ่อย

```powershell
$c = 'docker compose -f docker-compose.prod.yml'

# หยุด / เริ่มใหม่ (ข้อมูลใน volume ยังอยู่)
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml --profile localdb up -d

# รีสตาร์ท app อย่างเดียว
docker compose -f docker-compose.prod.yml restart app

# รันสคริปต์ในตัว app (เช่น รายงานประจำวันแบบ dry-run)
docker compose -f docker-compose.prod.yml run --rm app node dist/scripts/daily-report.js --dry-run

# ล้างตารางแล้วสร้างใหม่ (ข้อมูลหายทั้งหมด!)
docker compose -f docker-compose.prod.yml --profile setup run --rm db-setup node dist/scripts/db-setup.js --reset
```

## อัปเดตเป็นเวอร์ชันใหม่

1. รับ `line-workflow-app.zip` ชุดใหม่ (ชื่อเดิมทุกครั้ง ดูวันที่ build ได้ใน `MANIFEST.txt`)
   แตกทับโฟลเดอร์เดิมได้เลย ไฟล์ `.env` เดิมยังใช้ต่อ (หรือแตกไว้โฟลเดอร์ใหม่แล้วคัดลอก `.env` มาใส่)
2. `load-and-run.bat` (เติม `localdb` ถ้าใช้ PostgreSQL ใน compose) หรือ `.\load-and-run.ps1 -LocalDb`
   image ใช้ tag `line-workflow-app:latest` เสมอ compose จะเห็นว่า image id เปลี่ยนแล้วสร้าง container ใหม่ให้เอง
   ถ้า `.env` ยังมี `APP_IMAGE=line-workflow-app:2026xxxx` จากชุดเก่า ให้แก้เป็น `line-workflow-app:latest` (หรือลบบรรทัดนั้น) ครั้งเดียว
3. ข้อมูลใน volume (`pgdata`, `reports`) และไฟล์สื่อในโฟลเดอร์ `MEDIA_HOST_DIR`
   (ค่าเริ่มต้น `D:\QTEC\File_Storage\LineWorkflow`) จะถูกใช้ต่อโดยอัตโนมัติ

### ย้ายไฟล์สื่อจาก volume เดิม (เฉพาะเครื่องที่เคยรันเวอร์ชันก่อน)

เวอร์ชันก่อนหน้าเก็บไฟล์สื่อไว้ใน named volume `line-workflow-app_media` เวอร์ชันนี้เปลี่ยนเป็น bind mount
ลงโฟลเดอร์จริงบนเครื่อง Windows ครั้งแรกที่อัปเดตให้คัดลอกไฟล์เดิมมาใส่ก่อน `up` ไม่งั้นแกลเลอรีจะว่าง
(ข้อมูลใน DB ยังชี้ไปที่ไฟล์เดิม):

```powershell
docker compose -f docker-compose.prod.yml down
mkdir D:\QTEC\File_Storage\LineWorkflow -Force
docker run --rm -v line-workflow-app_media:/from -v D:/QTEC/File_Storage/LineWorkflow:/to alpine sh -c "cp -a /from/. /to/"
dir D:\QTEC\File_Storage\LineWorkflow\media    # ต้องเห็นไฟล์เดิม
docker compose -f docker-compose.prod.yml up -d
# พอใช้งานได้ตามปกติแล้วค่อยลบ volume เก่า (ทำหลังตรวจสอบเท่านั้น)
docker volume rm line-workflow-app_media
```

## สำรองข้อมูล

```powershell
# ฐานข้อมูล (กรณีใช้ PostgreSQL ใน compose)
docker exec line-workflow-postgres pg_dump -U postgres linechat > backup_linechat.sql

# ไฟล์สื่อจากไลน์กลุ่ม อยู่ในโฟลเดอร์ MEDIA_HOST_DIR บนเครื่อง Windows ตรง ๆ คัดลอก/ซิปได้เลย
Compress-Archive -Path D:\QTEC\File_Storage\LineWorkflow\* -DestinationPath media_backup.zip
```

## ปัญหาที่พบบ่อย

| อาการ | สาเหตุ / วิธีแก้ |
| --- | --- |
| `docker compose up` ขึ้น "invalid mount config" / "bind source path does not exist" หรือ log ขึ้น `EACCES` ตอนเก็บไฟล์ | โฟลเดอร์ `MEDIA_HOST_DIR` ไม่มีหรือ Docker เข้าถึงไดรฟ์นั้นไม่ได้ ตรวจว่ามีไดรฟ์/โฟลเดอร์จริง (`mkdir D:\QTEC\File_Storage\LineWorkflow -Force`) และใน Docker Desktop เปิด Settings > Resources > File sharing ให้ไดรฟ์ D: ถ้าเป็น Docker Desktop รุ่นที่ต้องตั้งค่า |
| `/health` ตอบ 500, log ขึ้น "ต่อฐานข้อมูลไม่ได้" | `DATABASE_URL` ผิด หรือใช้ `localhost` แทนที่จะเป็น `postgres` / `host.docker.internal` |
| ล็อกอินแล้วเด้งกลับหน้า login | เปิดผ่าน http ล้วน แต่ `COOKIE_SECURE` ไม่ได้ตั้งเป็น `false` |
| ล็อกอินได้ "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" ทั้งที่รหัสถูก | `ADMIN_PASSWORD_HASH` ไม่ได้ครอบ single quote ทำให้ `$2b$10$...` ถูก compose ตัดทิ้ง ตรวจด้วย `docker compose -f docker-compose.prod.yml exec app sh -c 'echo $ADMIN_PASSWORD_HASH'` ต้องขึ้นต้น `$2b$10$` และยาว 60 ตัว |
| บอทตอบ "ต่อฐานข้อมูล HR ไม่ได้ชั่วคราว" | 1) รหัสผ่านใน `DATABASE_URL_MSSQL` มี `$` แต่ไม่ได้ครอบ single quote 2) instance แบบมีชื่อ (`\SQLEXPRESS01`) ต้องให้ container ถึง SQL Browser (UDP 1434) ได้ ถ้าไม่ได้ให้ระบุพอร์ตตรง `Server=192.168.2.9,1433` 3) ทดสอบจากใน container: `docker compose -f docker-compose.prod.yml exec app node -e "require('mssql').connect(process.env.DATABASE_URL_MSSQL).then(p=>p.request().query('SELECT 1 AS ok')).then(r=>{console.log(r.recordset);process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})"` |
| LINE Verify ได้ "signature validation failed" | `CHANNEL_SECRET` ไม่ตรงกับ channel ของ token |
| ต่อ SQL Server ไม่ได้ | เปิด TCP/IP ใน SQL Server Configuration Manager, เปิด SQL Browser (UDP 1434) หรือระบุพอร์ตตรง `Server=host,1433` และเปิด firewall |
| ไม่มีข้อความจากกลุ่มเข้ามา | ยังไม่ได้เปิด "Allow bot to join group chats" ใน LINE OA Manager หรือ Webhook URL ยังชี้ผิด |
