# app - Webhook Server + Admin Dashboard

โปรเจกต์ที่รันได้จริงของหลักสูตร **LINE Workflow Automation with Claude Code & MCP**
ใช้เป็นทั้งเฉลยของ Workshop 3-5 และเป็นตัวอย่างระบบที่ส่งมอบให้ผู้ใช้จริงได้

> สาขา `day2` / `main` (ระบบเต็ม) · เวอร์ชันของวันแรกที่ยังไม่มีฐานข้อมูลอยู่ที่สาขา `day1`
> ดู [BRANCHES.md](../BRANCHES.md)

---

## เริ่มใช้งานใน 4 คำสั่ง

```bash
npm install
cp .env.example .env          # Windows: copy .env.example .env
npm run db:setup              # สร้างตาราง + ใส่ข้อมูลจำลอง
npm run dev
```

เปิด http://localhost:3000 ล็อกอิน `admin` / `admin1234`

ยังไม่ต้องมี LINE Official Account เพราะค่าเริ่มต้นคือ `MOCK_LINE=true`
ระบบจะทำงานครบทุกหน้า แต่ไม่ยิง LINE API จริง

---

## คำสั่งทั้งหมด

| คำสั่ง | ทำอะไร |
| --- | --- |
| `npm run dev` | เปิดเซิร์ฟเวอร์แบบ auto-reload |
| `npm run build` + `npm start` | build เป็น JavaScript แล้วรันแบบ production |
| `npm run typecheck` | ตรวจ TypeScript ทั้งโปรเจกต์ |
| `npm run db:setup` | สร้างตารางและใส่ข้อมูลจำลองทั้งหมด |
| `npm run db:reset` | ลบทุกตารางแล้วสร้างใหม่ |
| `npm run seed:sales` | ใส่ข้อมูลยอดขาย 30 วันใหม่ (Capstone) |
| `npm run seed:chat` | ใส่บทสนทนากลุ่มจำลองใหม่ |
| `npm run seed:media` | สร้างไฟล์ตัวอย่างในแกลเลอรี (ไม่ต้องมี LINE OA) |
| `npm run media:cleanup -- --days=90` | ดู/ลบไฟล์ที่เก่ากว่ากำหนดตามนโยบายเก็บข้อมูล |
| `npm run hash-password -- <รหัส>` | สร้าง bcrypt hash สำหรับ `ADMIN_PASSWORD_HASH` |
| `npm run daily-summary -- --dry-run` | สรุปแชทประจำวัน (ไม่ส่งออก) |
| `npm run daily-report -- --dry-run --html` | รายงานผู้บริหาร + เขียนไฟล์ HTML |
| `npm run mt:publish-test -- repair` | จำลอง event ระบบซ่อมบำรุงลง RabbitMQ (repair / fuel / vehicle / mcp) ทดสอบแจ้งเข้าไลน์กลุ่ม |

---

## ค่าใน .env ที่ควรรู้

| ตัวแปร | ความหมาย |
| --- | --- |
| `DATABASE_URL` | เช่น `postgres://postgres:postgres@localhost:5432/linechat` |
| `CHANNEL_ACCESS_TOKEN` (หรือ `CHANNEL_ACCESS_TOKEN_HR`) | จาก LINE Developers Console > tab Messaging API |
| `CHANNEL_SECRET` (หรือ `CHANNEL_SECRET_HR`) | จาก tab **Basic settings** (คนละค่ากับ token) ใช้ตรวจ signature |
| `CHANNEL_ACCESS_TOKEN_MT` / `CHANNEL_SECRET_MT` | OA ที่สอง "ทีมซ่อมบำรุง" (webhook `/webhook/mt`) แชทบอทตอบด้วย Claude + MCP tool |
| `MAINTENANCE_MCP_URL` / `MAINTENANCE_MCP_TOOLS` | MCP server ของระบบซ่อมบำรุง และรายชื่อ tool ที่อนุญาต (เช่น `Get*` = อ่านอย่างเดียว) |
| `RABBITMQ_URL` | ถ้าตั้ง แอปจะรับ event จากระบบซ่อมบำรุง (exchange `maintenance`: `repair.requested`, `fuel.requested`, `vehicle.booking.requested`, `maintenance.*.notification`) แล้วส่งการ์ดแจ้งเตือนเข้าไลน์กลุ่มที่บอท MT อยู่ |
| `MAINTENANCE_AI_PROVIDER` | โมเดลของแชทบอทซ่อมบำรุง: `openai` (ใช้ `OPENAI_API_KEY`/`OPENAI_MODEL`), `anthropic`, หรือ `auto` (OpenAI ก่อน สำรองด้วย Claude) |
| `MOCK_LINE` | `true` = ไม่ยิง LINE API จริง (ค่าเริ่มต้น) / `false` = ส่งจริง |
| `DEFAULT_GROUP_ID` | groupId ปลายทางเริ่มต้นของสคริปต์ตั้งเวลา |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | บัญชีเข้า dashboard |
| `ADMIN_PASSWORD_HASH` | ถ้าใส่ค่านี้ ระบบจะใช้ hash แทนรหัสผ่านธรรมดา |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | ใส่แล้วการสรุปจะใช้ OpenAI (ค่าเริ่มต้น `gpt-4o`) |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | ทางเลือกแทน OpenAI ใช้เมื่อไม่ได้ใส่ `OPENAI_API_KEY` |
| `ANOMALY_AMOUNT_THRESHOLD` | เกณฑ์ยอดต่อบิลที่ถือว่าผิดปกติ (ค่าเริ่มต้น 300000) |
| `MEDIA_ARCHIVE_ENABLED` | เปิด/ปิดการเก็บภาพและไฟล์จากไลน์กลุ่ม |
| `MEDIA_STORAGE_DRIVER` | `local` (ดิสก์) หรือ `s3` (object storage) |
| `MEDIA_LOCAL_DIR` | โฟลเดอร์เก็บไฟล์เมื่อใช้ดิสก์ (ค่าเริ่มต้น `storage/media`) |
| `MEDIA_HOST_DIR` | (เฉพาะ `docker-compose.prod.yml`) โฟลเดอร์บนเครื่อง Windows ที่ bind mount เป็น `/app/storage` (ค่าเริ่มต้น `D:/QTEC/File_Storage/LineWorkflow`) |
| `MEDIA_MAX_SIZE_MB` | ขนาดไฟล์สูงสุดที่ยอมโหลด (ค่าเริ่มต้น 25 MB) |

---

## หน้าจอทั้ง 10 หน้า (ยังมีหน้าล็อกอินอีก 1)

| URL | ทำอะไร |
| --- | --- |
| `/` | ภาพรวม: KPI, กราฟรายวัน, ความคึกคักตามชั่วโมง, Top talkers, โควต้า |
| `/messages` | ประวัติแชท: ค้นหา กรอง แบ่งหน้า export CSV |
| `/summaries` | สั่ง AI สรุปบทสนทนา เก็บประวัติ ส่งกลับเข้ากลุ่มเป็น Flex |
| `/tasks` | ติดตามงานที่ AI สกัดมา + เพิ่มเอง + ส่งการ์ดเตือนงานค้าง |
| `/send` | ส่ง text/Flex เข้ากลุ่มหรือ broadcast พร้อม preview และ dry-run |
| `/sales` | รายงานผู้บริหาร: ยอดขาย สาขา ช่องทาง สินค้าขายดี รายการผิดปกติ |
| `/groups` | จัดการกลุ่ม ตั้งชื่อ หมายเหตุ และยืนยันความยินยอม (PDPA) |
| `/media` | แกลเลอรีภาพและไฟล์ที่เก็บจากไลน์กลุ่ม ค้นหา ดู โหลดกลับ ลบ |
| `/simulator` | ใส่บทสนทนาจำลอง ใช้ทดสอบเมื่อยังไม่มี LINE OA |
| `/logs` | ทุกข้อความที่ระบบส่งออก รวม dry-run และ mock |

นอกจากนี้มี `POST /webhook` (ขาเข้าจาก LINE) และ `GET /health` (ไม่ต้องล็อกอิน)

ฝั่ง `POST /webhook` รับ event เหล่านี้: บอทเข้า/ออกกลุ่ม, ข้อความในกลุ่ม (บันทึกลง DB),
ไฟล์ในกลุ่ม (ดาวน์โหลดเก็บทันที), `unsend` (ลบตามข้อกำหนดของ LINE)
และ **แชท 1:1 กับ OA + ปุ่ม Rich Menu** ซึ่งตอบกลับตามที่ตั้งไว้ใน
[`src/services/autoReply.ts`](src/services/autoReply.ts) - แก้ข้อความตอบกลับได้ที่ไฟล์เดียวนั้น

---

## ต่อ LINE จริง (รันในเครื่องตัวเอง)

1. ใส่ `CHANNEL_ACCESS_TOKEN` และ `CHANNEL_SECRET` ในไฟล์ `.env`
2. ตั้ง `MOCK_LINE=false`
3. เปิด tunnel: `cloudflared tunnel --url http://localhost:3000`
   แล้วตั้ง Webhook URL เป็น `https://xxxx.trycloudflare.com/webhook`
4. เปิด "Use webhook" ใน LINE Developers Console
5. ใน OA Manager เปิด "Allow bot to join group chats" และปิด Auto-response

---

## Deploy ขึ้น cloud (Render Starter + Neon)

ไฟล์ `render.yaml` ในโฟลเดอร์นี้เป็น Blueprint พร้อมใช้ ดูขั้นตอนละเอียดใน
`../docs/10-Deployment-Render-Neon.md`

สรุปสั้น

```bash
# 1) สร้างฐานข้อมูลที่ neon.com แล้วคัดลอก connection string แบบ pooled
# 2) เตรียมตารางจากเครื่องตัวเอง (ครั้งเดียว)
DATABASE_URL="postgres://...-pooler.../linechat?sslmode=require" npm run db:setup

# 3) push ขึ้น GitHub แล้วสร้าง Blueprint ใน Render (แผน Starter)
# 4) กรอก env ใน Render: DATABASE_URL, CHANNEL_ACCESS_TOKEN, CHANNEL_SECRET,
#    DEFAULT_GROUP_ID, ADMIN_PASSWORD_HASH, OPENAI_API_KEY
# 5) ตั้ง Webhook URL ใน LINE เป็น https://<ชื่อ>.onrender.com/webhook
```

ค่า env ที่ต่างจากตอนรันในเครื่อง

| ตัวแปร | ค่าตอน deploy | เหตุผล |
| --- | --- | --- |
| `NODE_ENV` | `production` | เปิด session ใน DB, secure cookie, trust proxy ให้อัตโนมัติ |
| `MOCK_LINE` | `false` | ส่งเข้า LINE จริง |
| `ENABLE_SCHEDULER` | `true` | ให้โปรแกรมตั้งเวลารันงานเอง แทน Windows Task Scheduler |
| `PG_POOL_MAX` | `5` | ฐานข้อมูลฟรีจำกัดจำนวน connection |
| `SESSION_SECRET` | ข้อความสุ่มยาว | ห้ามใช้ค่าเริ่มต้นบน production |

---

## Deploy บน Windows Server ด้วย Docker (offline)

สำหรับเครื่องภายในองค์กรที่ไม่ต่ออินเทอร์เน็ต หรือไม่อยากให้ดึง image เอง

```bash
# บนเครื่อง dev (Mac/Linux ที่มี Docker): build + แพ็กทุกอย่างเป็น zip
./offline-bundle.sh            # หรือ ./offline-bundle.sh v1.0.0
# ได้ offline-bundle/line-workflow-app_<tag>.zip  -> ก๊อปไปเครื่อง Windows Server
```

บน Windows Server: แตก zip, `copy .env.example .env` แล้วกรอกค่าจริง, จากนั้น

```bat
load-and-run.bat setup            # มี PostgreSQL อยู่แล้ว (Command Prompt)
load-and-run.bat localdb setup    # ให้ compose เปิด PostgreSQL ให้ด้วย
```

หรือใช้ PowerShell: `.\load-and-run.ps1 -Setup` / `.\load-and-run.ps1 -LocalDb -Setup`

ไฟล์ที่เกี่ยวข้อง: `Dockerfile`, `docker-compose.prod.yml`, `offline-bundle.sh`,
`deploy/windows/README-DEPLOY.md` (ขั้นตอนละเอียด, ค่า .env, ปัญหาที่พบบ่อย)

---

## หมายเหตุ

- โปรเจกต์นี้สำหรับการอบรม ยังไม่พร้อม production (ดู `docs/09-Architecture-and-Repo-Review.md` ส่วนที่ 3)
- Tailwind CSS โหลดจาก CDN แบบ Play CDN ซึ่งเหมาะกับ dev/prototype เท่านั้น
- ข้อมูลทุกอย่างเป็นข้อมูลจำลอง ไม่เกี่ยวข้องกับบุคคลหรือบริษัทจริง
