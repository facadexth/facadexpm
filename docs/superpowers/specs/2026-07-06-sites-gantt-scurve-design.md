# Sites — Gantt Chart + S-curve — Design Spec

วันที่: 2026-07-06
สถานะ: อนุมัติดีไซน์แล้ว (รอเขียนแผน implementation)

## เป้าหมาย

เพิ่มมุมมอง Gantt chart ในหน้า Sites (`src/pages/Sites.jsx`) เพื่อโชว์ขั้นตอนงาน (process) ของแต่ละไซท์ตามลำดับเวลา พร้อมกราฟ S-curve เปรียบเทียบ "แผนเบิกเงิน" vs "เบิกจริง" vs "ต้นทุนเรา" ต่อไซท์ — เพื่อให้เห็นภาพความคืบหน้าของงานและกระแสเงินสดควบคู่กัน แยกจากตารางเดิมที่โฟกัสตัวเลขการเงินสรุปรายไซท์

## การตัดสินใจที่ยืนยันแล้ว

| หัวข้อ | ข้อสรุป |
|---|---|
| ตำแหน่ง | View toggle ในหน้า Sites เดิม (Table / Gantt) ใช้ toolbar เดิม (filter สถานะ, search) ร่วมกันทั้ง 2 มุมมอง |
| วิธีสร้าง Gantt | Custom div/CSS (ไม่ใช้ library ใหม่) ตาม pattern เดิมของหน้า Assign (Day/Week/Month grid) |
| ขั้นตอนงาน (phase) | เก็บเป็นตารางใหม่ `site_phases` ต่อไซท์ — มี template เริ่มต้น 7 ขั้นตอน แก้ไข/เพิ่ม/ลบเองได้ต่อไซท์ |
| Auto-เติม template | เมื่อสร้างไซท์ใหม่ → DB trigger auto-insert 7 ขั้นตอน (วันที่เว้นว่างไว้ก่อน) |
| สถานะขั้นตอน | แต่ละขั้นตอนมี status: `not_started` / `in_progress` / `done` — โชว์เป็นสีบนแท่ง Gantt |
| แก้ไขขั้นตอน | Modal แยก "จัดการขั้นตอน" เปิดจากปุ่มต่อแถวในหน้า Gantt (ไม่ใช่ในฟอร์ม edit ไซท์เดิม) |
| Cross-link | คลิกชื่อไซท์ในแถว Gantt (นอกปุ่มจัดการขั้นตอน) → `navigateTo('assign', { siteId, siteName })` เหมือน pattern เดิมที่มีอยู่แล้วในตาราง Sites |
| S-curve ตำแหน่ง | แสดงต่อไซท์ — คลิกเลือกไซท์ในหน้า Gantt แล้วเห็นกราฟ (ไม่ใช่กราฟรวมทุกไซท์ในจอเดียว เพราะสเกล/ช่วงเวลาต่างกัน) |
| S-curve library | `recharts` (มีอยู่แล้วในโปรเจกต์ — ไม่ต้องเพิ่ม dependency) |
| เส้น "แผนเบิกเงิน" | บันไดสะสม: ที่ `end_date` ของแต่ละขั้นตอน บวกเพิ่ม `billing_weight_pct × contract_value` ของขั้นตอนนั้น (ข้ามขั้นตอนที่ยังไม่ตั้ง `end_date`) |
| เส้น "เบิกจริง" | ผลรวมสะสมของ `amount_no_vat + vat` จากตาราง `incomes` (ยอดใบแจ้งหนี้สะสม) เรียงตาม `date`, กรอง `site_id` |
| เส้น "ต้นทุนเรา" | ผลรวมสะสมของ `amount` จากตาราง `expenses` เรียงตาม `date`, กรอง `site_id` |
| % เริ่มต้นต่อขั้นตอน (แก้ทีหลังได้) | ทำแบบ 5% · สั่งวัสดุ 15% · วัดหน้างาน 5% · ผลิต 30% · ติดตั้ง 30% · เก็บงาน 10% · ส่งมอบ 5% (รวม 100%) |

## ขั้นตอน template เริ่มต้น (เรียงตาม sort_order)

| # | ชื่อขั้นตอน | billing_weight_pct เริ่มต้น |
|---|---|---|
| 1 | ทำแบบเพื่อขออนุมัติ | 5 |
| 2 | สั่งวัสดุ | 15 |
| 3 | วัดหน้างานเพื่อผลิต | 5 |
| 4 | ผลิต | 30 |
| 5 | ติดตั้ง | 30 |
| 6 | เก็บงานรอบสุดท้าย | 10 |
| 7 | ส่งมอบงาน | 5 |

## Database

> ⚠️ ต้องเช็ค schema จริงผ่าน Supabase ก่อนร่าง migration (ยืนยันแล้วผ่าน live query 2026-07-06: `sites` มีคอลัมน์ `contract_value`, `start_date`, `end_date`; `incomes` มี `amount_no_vat`, `vat`, `date`, `site_id`; `expenses` มี `amount`, `date`, `site_id`)

### ตารางใหม่: `site_phases`
```sql
CREATE TABLE site_phases (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  site_id             UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  sort_order          INT NOT NULL DEFAULT 0,
  start_date          DATE,
  end_date            DATE,
  status              TEXT NOT NULL DEFAULT 'not_started'
                      CHECK (status IN ('not_started','in_progress','done')),
  billing_weight_pct  NUMERIC NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
```
ไม่บังคับ CHECK ว่าผลรวม `billing_weight_pct` ต่อไซท์ต้อง = 100 — ปล่อยให้ UI เตือนแทน (เหมือน pattern "รวมต้นทุนที่ระบุ" ที่มีอยู่แล้วใน `SiteForm`) เพราะระหว่างแก้ไขอาจติดลบ/เกินชั่วคราวได้ ไม่ควร block การบันทึก

### Trigger: auto-เติม template เมื่อสร้างไซท์ใหม่
```sql
CREATE OR REPLACE FUNCTION seed_site_phases() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO site_phases (site_id, name, sort_order, billing_weight_pct) VALUES
    (NEW.id, 'ทำแบบเพื่อขออนุมัติ', 1, 5),
    (NEW.id, 'สั่งวัสดุ', 2, 15),
    (NEW.id, 'วัดหน้างานเพื่อผลิต', 3, 5),
    (NEW.id, 'ผลิต', 4, 30),
    (NEW.id, 'ติดตั้ง', 5, 30),
    (NEW.id, 'เก็บงานรอบสุดท้าย', 6, 10),
    (NEW.id, 'ส่งมอบงาน', 7, 5);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_seed_site_phases
  AFTER INSERT ON sites
  FOR EACH ROW EXECUTE FUNCTION seed_site_phases();
```
ใช้ trigger (ไม่ใช่ insert ฝั่ง client) เพื่อให้ auto-เติมครบทุกช่องทางที่สร้างไซท์ใหม่ได้ (ฟอร์มเพิ่มไซท์, Excel import) โดยไม่ต้องแก้ทุกจุดที่ insert เข้า `sites`

### Backfill: ไซท์เก่าที่มีอยู่ก่อน migration นี้
Trigger ทำงานเฉพาะ insert ใหม่ — ไซท์เดิมทั้งหมดต้อง insert ขั้นตอน template เดียวกันแบบ one-time:
```sql
INSERT INTO site_phases (site_id, name, sort_order, billing_weight_pct)
SELECT s.id, p.name, p.sort_order, p.billing_weight_pct
FROM sites s
CROSS JOIN (VALUES
  ('ทำแบบเพื่อขออนุมัติ', 1, 5),
  ('สั่งวัสดุ', 2, 15),
  ('วัดหน้างานเพื่อผลิต', 3, 5),
  ('ผลิต', 4, 30),
  ('ติดตั้ง', 5, 30),
  ('เก็บงานรอบสุดท้าย', 6, 10),
  ('ส่งมอบงาน', 7, 5)
) AS p(name, sort_order, billing_weight_pct)
WHERE NOT EXISTS (SELECT 1 FROM site_phases sp WHERE sp.site_id = s.id);
```
`WHERE NOT EXISTS` ทำให้ idempotent — รันซ้ำได้โดยไม่สร้างซ้ำ (ไซท์ที่มี phase อยู่แล้วจะถูกข้าม ทั้งไซท์ทั้งหมด ไม่ใช่ทีละแถว)

## UI Components

### `src/pages/Sites.jsx`
- เพิ่ม view toggle (Table / Gantt) เหนือตาราง ใช้ `statusFilter`/`search` เดิมร่วมกันทั้ง 2 มุมมอง
- เพิ่ม hook ใหม่ `useSitePhases()` ใน `useSupabase.js` (ดึงทุกแถวของ `site_phases` เรียง `site_id, sort_order` — ใช้ pattern เดียวกับ `useLaborCost` ที่ query ทีเดียวแล้ว group ฝั่ง client ด้วย `useMemo`)

### `src/pages/sites/GanttView.jsx` (ใหม่ — โฟลเดอร์ใหม่ตาม pattern `src/pages/assign/`)
- 1 แถวต่อไซท์ (จากรายการที่กรองแล้วเหมือนตาราง)
- แกนเวลา: scale ตามช่วง min(`start_date` ของทุกขั้นตอน หรือ `sites.start_date` ถ้ายังไม่มีขั้นตอนที่ตั้งวันที่) ถึง max(`end_date` ของทุกขั้นตอน หรือ `sites.end_date`) ของไซท์ที่กรองอยู่ทั้งหมด
- แต่ละแถว: ชื่อไซท์/รหัส (คลิก → `navigateTo('assign', ...)`) + แท่ง 7 ขั้นตอนเรียงตาม `sort_order` วางตำแหน่งตาม % ของช่วงเวลา
  - สีแท่งตาม status: `not_started` เทา, `in_progress` เหลือง (`var(--yellow)`), `done` เขียว (`var(--green)`) — ใช้ CSS variable เดิมของธีม
  - ขั้นตอนที่ยังไม่ตั้งวันที่ (`start_date`/`end_date` เป็น null) ไม่วาดแท่ง แสดงเป็น placeholder เล็กๆ ต่อท้ายแถวแทน (กันกรณีไซท์ใหม่ที่ยังไม่กรอกวันที่เลย)
  - Hover แท่ง → tooltip: ชื่อขั้นตอน, ช่วงวันที่, สถานะ
- ปุ่ม "📋 จัดการขั้นตอน" ท้ายแถว → เปิด `PhaseManageModal`
- คลิกที่แถว (นอกปุ่มจัดการขั้นตอน/ลิงก์ชื่อไซท์) → เลือกไซท์นั้น แสดง `SCurveChart` ด้านล่างตาราง Gantt

### `src/pages/sites/PhaseManageModal.jsx` (ใหม่)
- รายการขั้นตอนของไซท์ที่เลือก: name (input text), start_date, end_date (input date), status (select), billing_weight_pct (input number)
- ปุ่มเพิ่มแถว / ลบแถว (ไม่ทำ drag-reorder — เรียงตาม sort_order ที่แก้เป็นตัวเลขได้ตรงๆ ถ้าต้องการสลับลำดับ)
- แสดงผลรวม `billing_weight_pct` พร้อมเตือนถ้า ≠ 100% (เหมือน pattern "รวมต้นทุนที่ระบุ" ใน `SiteForm`)
- บันทึก → diff กับข้อมูลเดิม: update แถวที่แก้, insert แถวใหม่ (ไม่มี id), delete แถวที่ถูกลบออกจาก list

### `src/pages/sites/SCurveChart.jsx` (ใหม่)
- รับ `siteId` ที่เลือกจาก `GanttView`
- ใช้ `useSitePhases()` (filter เฉพาะไซท์นี้), `useIncomes({ siteId })`, `useExpenses({ siteId })` — hook ที่มีอยู่แล้ว ไม่ต้องเพิ่ม view/query ใหม่ฝั่ง Supabase
- คำนวณ 3 เส้นสะสมฝั่ง client (`useMemo`):
  - **แผน**: เรียงขั้นตอนที่มี `end_date` ตามวันที่ → บันไดสะสม `billing_weight_pct / 100 × contract_value`
  - **เบิกจริง**: เรียง `incomes` ตาม `date` → สะสม `amount_no_vat + vat`
  - **ต้นทุน**: เรียง `expenses` ตาม `date` → สะสม `amount`
- Render ด้วย `recharts` `<LineChart>` — แกน X วันที่ (รวม timestamp ของทั้ง 3 ชุดข้อมูลมาเป็นแกนเดียว), แกน Y บาท, legend 3 เส้น

## ผลกระทบ / ความเสี่ยง

- Trigger บน `sites` มีผลกับทุกช่องทางที่ insert แถวใหม่ (รวม Excel import ผ่าน `ExcelUpload`) — ต้องตรวจว่า import flow ไม่ insert เป็น bulk ในแบบที่ trigger ทำงานช้าผิดปกติ (ปริมาณไซท์ต่อการ import ไม่น่าเกินหลักสิบ ไม่ใช่ปัญหาจริง)
- ไซท์เก่าที่มีอยู่แล้วก่อน migration นี้จะไม่มีแถวใน `site_phases` (trigger ทำงานเฉพาะ insert ใหม่) — ต้อง backfill migration แยกสำหรับไซท์เก่าทั้งหมดที่ยังไม่มี phase (insert 7 แถว template เดียวกัน)
- ถ้าไม่มีขั้นตอนไหนตั้ง `end_date` เลย เส้น "แผน" จะว่างเปล่า (แบนที่ 0) — เป็นพฤติกรรมที่ตั้งใจ ไม่ error
- ตัวเลข % เริ่มต้นเป็นค่ากะเอง ไม่ผูกกับสัญญาจริงแต่ละไซท์ — ผู้ใช้ต้องปรับเองถ้าต้องการความแม่นยำ

## นอกขอบเขต (ยังไม่ทำ)

- ไม่ทำ drag-to-resize/reschedule แท่ง Gantt โดยตรง (แก้ผ่าน modal เท่านั้น)
- ไม่ทำ dependency line ระหว่างขั้นตอน (เช่น ขั้นตอน B ต้องรอ A เสร็จก่อน)
- ไม่ทำกราฟ S-curve รวมหลายไซท์พร้อมกัน
- ไม่ผูก billing_weight_pct กับ `plan_type`/`plan_aluminum` ฯลฯ ที่มีอยู่แล้วใน `sites` (คนละกลไกกัน — อันเดิมคือประมาณการต้นทุนแยกประเภท ไม่ใช่ตารางเวลาเบิกเงิน)
