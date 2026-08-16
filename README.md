# Express Hello World

เซิร์ฟเวอร์ Express ตัวเล็กที่สุด เขียนด้วย TypeScript

## เริ่มใช้งาน

```bash
npm install
npm run dev
```

เปิด http://localhost:3000/ จะเห็นข้อความ `Hello World`

## คำสั่งที่มี

| คำสั่ง | ทำอะไร |
| --- | --- |
| `npm run dev` | รันแบบ watch (รีสตาร์ทเองเมื่อแก้ไฟล์) |
| `npm run build` | คอมไพล์ TypeScript ไปที่ `dist/` |
| `npm start` | รันไฟล์ที่ build แล้ว |
| `npm run typecheck` | ตรวจ type อย่างเดียว ไม่สร้างไฟล์ |

---

## ค่าใน .env ที่ควรรู้

| ตัวแปร | ความหมาย |
| --- | --- |
| `DATABASE_URL` | เช่น `postgres://postgres:postgres@localhost:5432/linechat` |
| `CHANNEL_ACCESS_TOKEN` | จาก LINE Developers Console > tab Messaging API |
| `CHANNEL_SECRET` | จาก tab **Basic settings** (คนละค่ากับ token) ใช้ตรวจ signature |
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

## หมายเหตุ

- โปรเจกต์นี้สำหรับการอบรม ยังไม่พร้อม production (ดู `docs/09-Architecture-and-Repo-Review.md` ส่วนที่ 3)
- Tailwind CSS โหลดจาก CDN แบบ Play CDN ซึ่งเหมาะกับ dev/prototype เท่านั้น
- ข้อมูลทุกอย่างเป็นข้อมูลจำลอง ไม่เกี่ยวข้องกับบุคคลหรือบริษัทจริง
