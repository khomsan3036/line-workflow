-- ==========================================================================
-- ข้อมูลยอดขายจำลอง "สยามสมาร์ทเทรด" ย้อนหลัง 30 วัน (นับจากวันนี้)
-- ทุกครั้งที่รันใหม่ วันที่จะขยับตามวันปัจจุบันเสมอ ข้อมูลจึงสดใหม่ตลอด
-- และมีรายการผิดปกติ (anomaly) ฝังไว้ให้ผู้เรียนหาใน Capstone
--
-- เทคนิค: ไม่ใช้ random() เพราะ Postgres อาจประเมินค่าเพียงครั้งเดียวต่อกลุ่มแถว
-- ทำให้ข้อมูลกระจุกตัว (ทุกบิลในวันเดียวกันได้สาขา/สินค้าเดียวกัน)
-- จึงใช้ md5 ของเลขที่เอกสารเป็นตัวสุ่มแทน ได้ผลกระจายดีและ "คงที่" ทุกครั้งที่รัน
--   pick(key, m) = จำนวนเต็ม 0..m-1 ที่คำนวณจาก md5 ของ key
-- ==========================================================================

TRUNCATE TABLE sales_orders RESTART IDENTITY;

INSERT INTO sales_orders
    (order_no, order_date, branch, channel, sales_person, customer_name, product, qty, unit_price, amount, status)
SELECT
    b.order_no,
    b.order_date,
    (ARRAY['สำนักงานใหญ่','สาขาเชียงใหม่','สาขาขอนแก่น','สาขาหาดใหญ่','สาขาชลบุรี'])[1 + b.i_branch],
    (ARRAY['หน้าร้าน','LINE OA','Marketplace','ตัวแทนขาย','เว็บไซต์'])[1 + b.i_channel],
    (ARRAY['สมชาย ใจดี','สุดา แสนสุข','ประเสริฐ มั่นคง','กัญญา วงศ์ทอง','ธนา รุ่งเรือง'])[1 + b.i_person],
    (ARRAY['บจก.ไทยรุ่งเรือง','หจก.สมชายพาณิชย์','บมจ.นครทองกรุ๊ป','ร้านพี่หน่อย','บจก.อีสานฟู้ด',
           'บจก.ลานนาเทรดดิ้ง','ร้านเจ๊แดง','บจก.บูรพาซัพพลาย'])[1 + b.i_customer],
    (ARRAY['เครื่องปรับอากาศ 12000 BTU','ตู้เย็น 2 ประตู 9 คิว','เครื่องซักผ้าฝาหน้า 9 กก.','พัดลมไอเย็น',
           'หม้อทอดไร้น้ำมัน','เครื่องกรองน้ำ RO','ทีวี 43 นิ้ว Smart TV','เครื่องดูดฝุ่นไร้สาย'])[1 + b.i_product],
    b.qty,
    (ARRAY[14900, 12500, 16900, 3290, 2590, 8900, 9990, 5990])[1 + b.i_product]::numeric,
    b.qty * (ARRAY[14900, 12500, 16900, 3290, 2590, 8900, 9990, 5990])[1 + b.i_product]::numeric,
    CASE WHEN ('x' || substr(md5(b.order_no || 'status'), 1, 7))::bit(28)::int % 100 < 8
         THEN 'pending' ELSE 'paid' END
FROM (
    SELECT
        'SO-' || to_char(d, 'YYYYMMDD') || '-' || lpad(n::text, 3, '0')                        AS order_no,
        d::date                                                                                AS order_date,
        ('x' || substr(md5('SO-' || to_char(d,'YYYYMMDD') || '-' || lpad(n::text,3,'0') || 'br'), 1, 7))::bit(28)::int % 5 AS i_branch,
        ('x' || substr(md5('SO-' || to_char(d,'YYYYMMDD') || '-' || lpad(n::text,3,'0') || 'ch'), 1, 7))::bit(28)::int % 5 AS i_channel,
        ('x' || substr(md5('SO-' || to_char(d,'YYYYMMDD') || '-' || lpad(n::text,3,'0') || 'sp'), 1, 7))::bit(28)::int % 5 AS i_person,
        ('x' || substr(md5('SO-' || to_char(d,'YYYYMMDD') || '-' || lpad(n::text,3,'0') || 'cu'), 1, 7))::bit(28)::int % 8 AS i_customer,
        ('x' || substr(md5('SO-' || to_char(d,'YYYYMMDD') || '-' || lpad(n::text,3,'0') || 'pr'), 1, 7))::bit(28)::int % 8 AS i_product,
        1 + ('x' || substr(md5('SO-' || to_char(d,'YYYYMMDD') || '-' || lpad(n::text,3,'0') || 'qt'), 1, 7))::bit(28)::int % 5 AS qty
    FROM generate_series((CURRENT_DATE - INTERVAL '29 days')::date, CURRENT_DATE, INTERVAL '1 day') AS d
    CROSS JOIN generate_series(1, 16) AS n
    -- จำนวนบิลต่อวันไม่เท่ากัน (10-16 บิล) เพื่อให้กราฟดูมีชีวิต
    WHERE n <= 10 + ('x' || substr(md5(to_char(d, 'YYYYMMDD') || 'count'), 1, 7))::bit(28)::int % 7
) AS b;

-- --------------------------------------------------------------------------
-- ฝัง "รายการผิดปกติ" ของเมื่อวานไว้ให้ AI ตรวจจับ 4 รูปแบบ
--   1) SO-ANOM-001 ยอดต่อบิลสูงผิดปกติ (คีย์จำนวนเกินจริง 40 เครื่อง)
--   2) SO-ANOM-002 ราคาต่อหน่วยผิดปกติ (คีย์ผิดตำแหน่งทศนิยม 2,590 -> 259,000)
--   3) SO-ANOM-003 ยอดติดลบ (บันทึกคืนสินค้าผิดวิธี ควรออกใบลดหนี้)
--   4) SO-ANOM-004/005 รายการซ้ำ (คีย์ซ้ำสองครั้ง คนละเลขที่เอกสาร)
-- --------------------------------------------------------------------------
INSERT INTO sales_orders
    (order_no, order_date, branch, channel, sales_person, customer_name, product, qty, unit_price, amount, status)
VALUES
    ('SO-ANOM-001', CURRENT_DATE - 1, 'สาขาหาดใหญ่', 'ตัวแทนขาย', 'ธนา รุ่งเรือง',
     'บจก.บูรพาซัพพลาย', 'เครื่องปรับอากาศ 12000 BTU', 40, 14900.00, 596000.00, 'paid'),
    ('SO-ANOM-002', CURRENT_DATE - 1, 'สาขาเชียงใหม่', 'หน้าร้าน', 'สุดา แสนสุข',
     'ร้านพี่หน่อย', 'หม้อทอดไร้น้ำมัน', 1, 259000.00, 259000.00, 'paid'),
    ('SO-ANOM-003', CURRENT_DATE - 1, 'สำนักงานใหญ่', 'LINE OA', 'สมชาย ใจดี',
     'บจก.ไทยรุ่งเรือง', 'ตู้เย็น 2 ประตู 9 คิว', 1, -12500.00, -12500.00, 'paid'),
    ('SO-ANOM-004', CURRENT_DATE - 1, 'สาขาขอนแก่น', 'Marketplace', 'ประเสริฐ มั่นคง',
     'บจก.อีสานฟู้ด', 'เครื่องกรองน้ำ RO', 3, 8900.00, 26700.00, 'paid'),
    ('SO-ANOM-005', CURRENT_DATE - 1, 'สาขาขอนแก่น', 'Marketplace', 'ประเสริฐ มั่นคง',
     'บจก.อีสานฟู้ด', 'เครื่องกรองน้ำ RO', 3, 8900.00, 26700.00, 'paid');
