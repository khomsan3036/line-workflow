-- ==========================================================================
-- Workshop LINE Workflow Automation 2026 - โครงสร้างฐานข้อมูล
-- รันด้วย:  npm run db:setup
-- หรือ:      psql -U postgres -d linechat -f sql/01_schema.sql
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1) line_messages : ข้อความทุกข้อความที่บอทได้รับจากไลน์กลุ่ม
--    หมายเหตุสำคัญ: LINE Messaging API อ่านแชทย้อนหลังไม่ได้
--    ตารางนี้จึงเป็น "หน่วยความจำ" ของระบบ เก็บได้เฉพาะข้อความหลังบอทเข้ากลุ่ม
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS line_messages (
    id              SERIAL PRIMARY KEY,
    line_message_id VARCHAR(64) UNIQUE,        -- กัน insert ซ้ำเมื่อ LINE retry webhook
    group_id        VARCHAR(64),               -- ID ของกลุ่ม (ขึ้นต้นด้วย C)
    user_id         VARCHAR(64),               -- ID ของผู้ส่ง (ขึ้นต้นด้วย U)
    display_name    VARCHAR(255),              -- ชื่อผู้ส่ง ณ เวลาที่ส่ง
    message_type    VARCHAR(20) NOT NULL,      -- text / sticker / image / video / file ...
    message_text    TEXT,                      -- เนื้อความ (เฉพาะ message_type = 'text')
    sent_at         TIMESTAMPTZ NOT NULL,      -- เวลาส่งจริงจาก LINE (event.timestamp)
    created_at      TIMESTAMPTZ DEFAULT now()  -- เวลาที่บันทึกลงฐานข้อมูล
);

-- OA ที่รับข้อความนี้ (hr = HR Notification, mt = ทีมซ่อมบำรุง) รันซ้ำได้สำหรับฐานข้อมูลเดิม
ALTER TABLE line_messages ADD COLUMN IF NOT EXISTS channel VARCHAR(16) NOT NULL DEFAULT 'hr';

CREATE INDEX IF NOT EXISTS idx_msg_group_time ON line_messages (group_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_user       ON line_messages (user_id);
CREATE INDEX IF NOT EXISTS idx_msg_sent_at    ON line_messages (sent_at DESC);

-- --------------------------------------------------------------------------
-- 2) line_groups : ทะเบียนกลุ่มที่บอทเข้าร่วม (ให้ dashboard เลือกกลุ่มได้ง่าย)
--    consent_at = วันเวลาที่ยืนยันว่าสมาชิกกลุ่มรับทราบการเก็บข้อมูลแล้ว (PDPA)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS line_groups (
    group_id        VARCHAR(64) PRIMARY KEY,
    group_name      VARCHAR(255),
    member_count    INTEGER,
    is_active       BOOLEAN     DEFAULT true,   -- false = บอทถูกเตะออกจากกลุ่มแล้ว
    consent_at      TIMESTAMPTZ,                -- NULL = ยังไม่ยืนยันความยินยอม
    joined_at       TIMESTAMPTZ DEFAULT now(),
    last_message_at TIMESTAMPTZ,
    note            TEXT
);

-- OA ที่บอทเข้ากลุ่มนี้: hr = HR Notification, mt = MT Notification
-- (groupId ของ LINE แยกตาม provider กลุ่มเดียวกันจึงมีคนละ id เมื่อมองจากคนละ OA)
ALTER TABLE line_groups ADD COLUMN IF NOT EXISTS channel VARCHAR(16) NOT NULL DEFAULT 'hr';

-- --------------------------------------------------------------------------
-- 3) message_logs : บันทึกทุกข้อความที่ "เราส่งออก" (ขาส่ง)
--    ใช้ตรวจย้อนหลังว่าใครสั่งส่งอะไรไปที่ไหน สำเร็จหรือไม่
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_logs (
    id           SERIAL PRIMARY KEY,
    target_type  VARCHAR(16)  NOT NULL,        -- group / user / broadcast
    target_id    VARCHAR(64),                  -- groupId หรือ userId (broadcast = NULL)
    target_name  VARCHAR(255),
    message_kind VARCHAR(16)  NOT NULL,        -- text / flex
    preview      TEXT,                         -- ข้อความย่อสำหรับแสดงในตาราง
    payload      JSONB,                        -- payload เต็มที่ส่งไป (ตรวจสอบย้อนหลังได้)
    status       VARCHAR(16)  NOT NULL,        -- sent / mock / dry-run / failed
    error        TEXT,
    sent_by      VARCHAR(64),                  -- ผู้สั่งส่ง: ชื่อ admin หรือชื่อสคริปต์
    created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_logs_created ON message_logs (created_at DESC);

-- OA ที่ใช้ส่ง: hr = OA หลัก (HR Notification), mt = OA ทีมซ่อมบำรุง (Maintenance Team)
ALTER TABLE message_logs ADD COLUMN IF NOT EXISTS channel VARCHAR(16) NOT NULL DEFAULT 'hr';

-- --------------------------------------------------------------------------
-- 4) group_tasks : งานที่มอบหมายกันในกลุ่ม (AI สกัดมาให้ หรือ admin เพิ่มเอง)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS group_tasks (
    id           SERIAL PRIMARY KEY,
    group_id     VARCHAR(64) NOT NULL,
    assignee     VARCHAR(255),                 -- ใครรับปาก
    task_text    TEXT        NOT NULL,         -- งานอะไร
    due_text     VARCHAR(255),                 -- กำหนดส่งตามที่พูดในแชท เช่น "ศุกร์นี้"
    due_date     DATE,                         -- แปลงเป็นวันที่ได้ก็ใส่
    status       VARCHAR(16) DEFAULT 'open',   -- open / done / cancelled
    source       VARCHAR(16) DEFAULT 'ai',     -- ai / manual
    source_msg   VARCHAR(64),                  -- line_message_id ต้นทาง (ถ้ามี)
    created_at   TIMESTAMPTZ DEFAULT now(),
    updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tasks_group_status ON group_tasks (group_id, status);

-- --------------------------------------------------------------------------
-- 5) group_summaries : ประวัติสรุปบทสนทนาที่ AI ทำไว้ (กันสรุปซ้ำและดูย้อนหลังได้)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS group_summaries (
    id            SERIAL PRIMARY KEY,
    group_id      VARCHAR(64) NOT NULL,
    summary_date  DATE        NOT NULL,
    message_count INTEGER,
    summary_text  TEXT,
    topics        JSONB,                       -- ["หัวข้อ 1", "หัวข้อ 2"]
    model         VARCHAR(64),                 -- claude-sonnet-4-5 / local-rule-based
    created_at    TIMESTAMPTZ DEFAULT now()
);

-- หนึ่งกลุ่มมีสรุปได้วันละหนึ่งใบเท่านั้น
-- ถ้าไม่บังคับตรงนี้ การกดปุ่ม "สรุปด้วย AI" ซ้ำ หรือตัวตั้งเวลาทำงานซ้ำ
-- จะได้การ์ดสรุปของวันเดียวกันซ้อนกันหลายใบในหน้า /summaries
-- (ฝั่งโค้ดใช้ ON CONFLICT ทับของเดิม ดู src/services/summary.ts)

-- เคลียร์ของซ้ำที่อาจค้างอยู่จากเวอร์ชันก่อนหน้า เก็บใบล่าสุดของแต่ละวันไว้
DELETE FROM group_summaries a
      USING group_summaries b
      WHERE a.group_id = b.group_id
        AND a.summary_date = b.summary_date
        AND a.id < b.id;

DROP INDEX IF EXISTS idx_summaries_group_date;
CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_group_date ON group_summaries (group_id, summary_date);

-- --------------------------------------------------------------------------
-- 6) sales_orders : ข้อมูลยอดขายจำลองของ "สยามสมาร์ทเทรด" (ใช้ใน Capstone)
--    ข้อมูลนี้ไม่เกี่ยวข้องกับบริษัทจริงใด ๆ ทั้งสิ้น
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_orders (
    id            SERIAL PRIMARY KEY,
    order_no      VARCHAR(32) UNIQUE,
    order_date    DATE          NOT NULL,
    branch        VARCHAR(64)   NOT NULL,      -- สาขา
    channel       VARCHAR(32)   NOT NULL,      -- ช่องทางขาย
    sales_person  VARCHAR(64),
    customer_name VARCHAR(128),
    product       VARCHAR(128),
    qty           INTEGER       NOT NULL,
    unit_price    NUMERIC(12,2) NOT NULL,
    amount        NUMERIC(14,2) NOT NULL,      -- qty * unit_price
    status        VARCHAR(16)   DEFAULT 'paid' -- paid / pending / cancelled
);

CREATE INDEX IF NOT EXISTS idx_sales_date   ON sales_orders (order_date DESC);
CREATE INDEX IF NOT EXISTS idx_sales_branch ON sales_orders (branch);

-- --------------------------------------------------------------------------
-- 7) VIEW ช่วยให้ AI (ผ่าน Postgres MCP) query ได้ง่ายขึ้น
-- --------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_messages_today AS
SELECT m.id,
       m.group_id,
       COALESCE(g.group_name, m.group_id) AS group_name,
       m.display_name,
       m.message_type,
       m.message_text,
       m.sent_at
FROM line_messages m
LEFT JOIN line_groups g ON g.group_id = m.group_id
WHERE (m.sent_at AT TIME ZONE 'Asia/Bangkok')::date = (now() AT TIME ZONE 'Asia/Bangkok')::date
ORDER BY m.sent_at;

CREATE OR REPLACE VIEW v_daily_sales AS
SELECT order_date,
       branch,
       channel,
       COUNT(*)          AS order_count,
       SUM(qty)          AS total_qty,
       SUM(amount)       AS total_amount
FROM sales_orders
WHERE status <> 'cancelled'
GROUP BY order_date, branch, channel;

-- ==========================================================================
-- ส่วนเพิ่มของ Workshop 6: Media Archiver
-- แก้ปัญหา "ภาพและไฟล์ในไลน์กลุ่มหมดอายุ กดโหลดไม่ได้"
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 8) media_files : ไฟล์ที่ดึงจาก LINE มาเก็บไว้ถาวรในระบบของเรา
--
--    ข้อเท็จจริงจากเอกสาร LINE ที่เป็นเหตุผลของตารางนี้
--      "Content that users send is automatically deleted after a certain
--       period of time" และ LINE ไม่เปิดเผยว่ากี่วัน
--    จึงต้องดาวน์โหลดทันทีที่ webhook เข้ามา ไม่ใช่เก็บแค่ messageId ไว้โหลดทีหลัง
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS media_files (
    id              SERIAL PRIMARY KEY,
    line_message_id VARCHAR(64) UNIQUE NOT NULL,   -- ผูกกับ line_messages.line_message_id
    group_id        VARCHAR(64),
    user_id         VARCHAR(64),
    display_name    VARCHAR(255),
    media_type      VARCHAR(20) NOT NULL,          -- image / video / audio / file
    file_name       VARCHAR(512),                  -- ชื่อไฟล์เดิม (เฉพาะ type = file)
    caption         VARCHAR(255),                  -- คำบรรยายที่แอดมินตั้งเอง (LINE ไม่ส่งมาให้)
    content_type    VARCHAR(128),                  -- MIME type ที่ LINE ส่งมา
    size_bytes      BIGINT,
    storage_driver  VARCHAR(16)  NOT NULL,         -- local / s3
    storage_key     VARCHAR(512) NOT NULL,         -- path หรือ object key ของไฟล์จริง
    preview_key     VARCHAR(512),                  -- ภาพย่อ (ถ้ามี)
    checksum        VARCHAR(64),                   -- sha256 ใช้ตรวจว่าไฟล์ไม่เสีย
    status          VARCHAR(16)  DEFAULT 'stored', -- stored / failed / deleted / skipped
    error           TEXT,
    sent_at         TIMESTAMPTZ,                   -- เวลาที่ส่งในกลุ่ม
    archived_at     TIMESTAMPTZ DEFAULT now(),     -- เวลาที่ระบบเก็บสำเร็จ
    deleted_at      TIMESTAMPTZ,                   -- เวลาที่ถูกลบ (เช่นผู้ใช้ unsend)
    deleted_reason  VARCHAR(64)                    -- unsend / retention / manual
);

-- เพิ่มคอลัมน์ให้ฐานข้อมูลที่สร้างไว้ก่อนหน้า (รันซ้ำได้ ไม่พัง)
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS caption VARCHAR(255);
-- OA ที่รับไฟล์นี้ (ต้องใช้ token ตัวเดียวกันดึงไฟล์จาก LINE)
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS channel VARCHAR(16) NOT NULL DEFAULT 'hr';

CREATE INDEX IF NOT EXISTS idx_media_group_time ON media_files (group_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_type       ON media_files (media_type);
CREATE INDEX IF NOT EXISTS idx_media_status     ON media_files (status);

-- --------------------------------------------------------------------------
-- 9) รองรับ unsend event
--    LINE กำหนดไว้ว่าเมื่อผู้ใช้ยกเลิกส่งข้อความ ระบบที่เก็บข้อมูลควร
--    "Delete the target message stored in a database or other storage device"
--    เราจึงทำเครื่องหมายไว้ที่ข้อความและลบไฟล์ที่เกี่ยวข้องออกจริง
-- --------------------------------------------------------------------------
ALTER TABLE line_messages ADD COLUMN IF NOT EXISTS unsent_at TIMESTAMPTZ;

CREATE OR REPLACE VIEW v_media_gallery AS
SELECT m.id,
       m.line_message_id,
       m.group_id,
       COALESCE(g.group_name, m.group_id) AS group_name,
       m.display_name,
       m.media_type,
       m.file_name,
       m.caption,
       m.content_type,
       m.size_bytes,
       m.sent_at,
       m.archived_at
FROM media_files m
LEFT JOIN line_groups g ON g.group_id = m.group_id
WHERE m.status = 'stored'
ORDER BY m.sent_at DESC;

-- --------------------------------------------------------------------------
-- 10) direct_messages : ข้อความที่ผู้ใช้ส่งหาบอทแบบ 1:1 (แชทส่วนตัวกับ OA)
--     แยกจาก line_messages เพื่อให้รายงานและสรุปประชุมของกลุ่มไม่ปนกับแชทส่วนตัว
--     ข้อควรระวัง PDPA: ผู้ใช้ 1:1 ไม่ได้รับข้อความขอความยินยอมแบบสมาชิกกลุ่ม
--     ควรแจ้งไว้ในข้อความต้อนรับ (follow) ว่าระบบบันทึกบทสนทนา
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS direct_messages (
    id              SERIAL PRIMARY KEY,
    line_message_id VARCHAR(64) UNIQUE,        -- กัน insert ซ้ำเมื่อ LINE retry webhook
    user_id         VARCHAR(64) NOT NULL,      -- ID ของผู้ส่ง (ขึ้นต้นด้วย U)
    display_name    VARCHAR(255),              -- ชื่อโปรไฟล์ ณ เวลาที่ส่ง
    message_type    VARCHAR(20) NOT NULL,      -- text / sticker / image / video / file ...
    message_text    TEXT,                      -- เนื้อความ (เฉพาะ message_type = 'text')
    reply_text      TEXT,                      -- ข้อความที่บอทตอบกลับอัตโนมัติ
    reply_matched   BOOLEAN,                   -- true = ตรงเมนู, false = ตอบ fallback
    sent_at         TIMESTAMPTZ NOT NULL,      -- เวลาส่งจริงจาก LINE (event.timestamp)
    unsent_at       TIMESTAMPTZ,               -- เวลาที่ผู้ใช้กดยกเลิกส่ง (ถ้ามี)
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dm_user_time ON direct_messages (user_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_dm_sent_at   ON direct_messages (sent_at DESC);

-- OA ที่รับข้อความ: hr = OA หลัก, mt = OA ทีมซ่อมบำรุง (แชทบอท MCP)
-- group_id ใส่เมื่อบอท MT ถูก mention ในกลุ่ม (ข้อความ 1:1 เป็น NULL)
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS channel  VARCHAR(16) NOT NULL DEFAULT 'hr';
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS group_id VARCHAR(64);

-- --------------------------------------------------------------------------
-- 11) line_employee_links : ผูก LINE userId กับรหัสพนักงาน (prs_no) ในระบบ HR
--     ผู้ใช้พิมพ์รหัสครั้งเดียว บอทจะจำไว้ให้ถาม "เวลาเข้างานของฉัน" ได้ทันที
--     ผู้ใช้พิมพ์รหัสใหม่เพื่อเปลี่ยน หรือ "ยกเลิกรหัสพนักงาน" เพื่อลบ
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS line_employee_links (
    line_user_id VARCHAR(64)  PRIMARY KEY,
    prs_no       VARCHAR(32)  NOT NULL,
    full_name    VARCHAR(255),
    position     VARCHAR(255),
    dept         VARCHAR(255),
    linked_at    TIMESTAMPTZ  DEFAULT now(),
    updated_at   TIMESTAMPTZ  DEFAULT now()
);

-- ยืนยันตัวตนผ่าน LINE Login: แถวที่ verified_at เป็น NULL คือ "พิมพ์รหัสเอง" (ยังไม่ผ่านการยืนยัน)
-- บอทจะตอบเวลาเข้างานให้เฉพาะแถวที่ verified_at ไม่เป็น NULL (เว้นแต่ตั้ง MY_ATTENDANCE_ALLOW_UNVERIFIED=true)
ALTER TABLE line_employee_links ADD COLUMN IF NOT EXISTS verified_at        TIMESTAMPTZ;
ALTER TABLE line_employee_links ADD COLUMN IF NOT EXISTS verified_by        VARCHAR(32);   -- line-login | line-login+password
ALTER TABLE line_employee_links ADD COLUMN IF NOT EXISTS auth_user_id       VARCHAR(64);   -- id ของบัญชีในบริการ auth กลาง
ALTER TABLE line_employee_links ADD COLUMN IF NOT EXISTS auth_username      VARCHAR(64);   -- username ของบัญชี (ปกติ = prs_no)
ALTER TABLE line_employee_links ADD COLUMN IF NOT EXISTS line_display_name  VARCHAR(255);  -- ชื่อที่แสดงใน LINE ตอนยืนยัน

-- --------------------------------------------------------------------------
-- 12) line_login_states : ลิงก์ยืนยันตัวตนแบบใช้ครั้งเดียว (OAuth state + nonce)
--     บอทสร้าง state ผูกกับ LINE userId แล้วส่งปุ่ม "ยืนยันตัวตน" ไปในแชท 1:1
--     เมื่อ LINE Login กลับมาที่ /line-login/callback ระบบตรวจ state/nonce แล้วผูกรหัสพนักงาน
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS line_login_states (
    state         VARCHAR(64)  PRIMARY KEY,
    nonce         VARCHAR(64)  NOT NULL,
    line_user_id  VARCHAR(64)  NOT NULL,        -- userId จาก Messaging API ที่ขอยืนยัน
    id_token      TEXT,                          -- ID token จาก LINE Login (เก็บชั่วคราวระหว่างขั้นกรอกรหัสผ่าน)
    line_sub      VARCHAR(64),                   -- userId จาก ID token (sub)
    display_name  VARCHAR(255),
    created_at    TIMESTAMPTZ  DEFAULT now(),
    expires_at    TIMESTAMPTZ  NOT NULL,
    used_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_login_states_user ON line_login_states (line_user_id, created_at DESC);
