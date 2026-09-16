# Site Gantt + Kanban (v2) — Design Spec

วันที่: 2026-09-17
สถานะ: รออนุมัติดีไซน์ (ก่อนเขียนแผน implementation)
อ้างอิง: ต่อยอด/แทนที่ [`2026-07-06-sites-gantt-scurve-design.md`](2026-07-06-sites-gantt-scurve-design.md) (spec เดิม, branch `worktree-sites-gantt-scurve` ที่สร้างจาก spec นั้นค้างอยู่ 563 commits หลัง `main` แล้ว — ใช้เป็นข้อมูลอ้างอิงด้านตรรกะ/สูตรคำนวณ ไม่ merge โค้ดตรงๆ)

## เป้าหมาย

เพิ่ม 4 หน้าจอที่อ่าน/เขียนข้อมูลชุดเดียวกัน เพื่อให้เห็นภาพรวมงานแต่ละไซท์ทั้งระดับ "แผนใหญ่" (PM) และ "งานรายวันของแต่ละทีม" (โฟร์แมน/ช่าง) โดยไม่ต้องมีระบบข้อมูลแยกกันคนละชุด:

1. **Gantt ต่อไซท์** (PM) — ไทม์ไลน์ขั้นตอนงาน + กราฟ S-curve รายรับ/รายจ่ายสะสม
2. **Kanban ต่อไซท์** (ADMIN/OWNER/PM) — บอร์ดงานย่อยของแต่ละขั้นตอน แยกกรองตามชั้น/โซนได้
3. **Worker Dashboard** (ช่างแต่ละคน) — งานของทีมตัวเองวันนี้ แบบ list เดียว
4. **Day View ผู้ดูแล** (ADMIN/OWNER) — ทุกทีมที่ลงงานวันนี้ เรียงเป็นการ์ด mini-Kanban ทีละไซท์

ขอบเขตรุ่นแรก: **ต่อไซท์ก่อน** (มุมมองรวมทุกไซท์พร้อมกันทำทีหลัง), ไม่ทำ offline support, ไม่บังคับ sequencing ระหว่างขั้นตอน (push/pull ทำได้ทั้งคู่), ติดตามความคืบหน้าเป็น **% ของงาน** (ไม่ทำ zone เป็นตารางแยก)

## สถานะปัจจุบัน (สำคัญ ต้องรู้ก่อนอ่านต่อ)

- ตาราง `site_phases` **มีอยู่แล้วบน production** (migration จาก spec เดิมถูก apply ไปแล้ว แม้โค้ด UI ที่ควรมาคู่กันจะไม่เคยขึ้น `main`) — 966 แถว ครบทุกไซท์ (auto-seed 7 ขั้นตอนมาตรฐานทำงานอยู่)
- ทุกแถว `status = 'not_started'` และ `start_date`/`end_date` เป็น `null` ทั้งหมด — เพราะไม่เคยมีหน้าจอไหนเขียนลงไปเลย ค่าเหล่านี้ "มีอยู่แต่ตาย"
- `depends_on_phase_id` มีคอลัมน์อยู่แล้วเช่นกัน (migration เดียวกัน) แต่ไม่เคยถูกใช้งาน
- branch `sites-gantt-scurve` (`GanttView`, `SCurveChart`, `PhaseManageModal`, dependency picker, drag-to-reorder) มีของจริงครบ แต่ล้าหลัง `main` 563 commits (คร่อมช่วง quotation-module split, multi-tenant, offline-support, PWA) — **ใช้อ่านเป็นตัวอย่างตรรกะเท่านั้น ไม่ merge**
- `useIncomes({ siteId })` / `useExpenses({ siteId })` ยืนยันแล้วว่ายังอยู่ ใช้ pattern เดิมได้ตรงๆ (verified 2026-09-17)
- `MySchedule.jsx` (มุมมอง WORKER ของหน้า "จ่ายงานช่าง") มีอยู่แล้ว พร้อม GPS check-in/check-out จริง (`perform_worker_checkin`/`perform_worker_checkout`) — ช่างใช้มือถือเข้าแอปนี้ทุกวันอยู่แล้ว ไม่ใช่ความเสี่ยงใหม่
- `workers.position` มีค่า `"หัวหน้าช่าง"` อยู่แล้ว (5 คนจาก active roster) — เป็น job title นิ่งๆ ไม่ใช่ "หัวหน้าทีมของวันนี้" (คนละแนวคิดกัน ดูหัวข้อ team leader ด้านล่าง)

## การตัดสินใจที่ยืนยันแล้ว

| หัวข้อ | ข้อสรุป |
|---|---|
| Dependency ระหว่างขั้นตอน | Soft เท่านั้น — วาดลูกศรบน Gantt เป็นข้อมูลอ้างอิง ไม่ block การลากการ์ดใน Kanban ข้ามขั้นตอน (ธุรกิจจริงมีงาน overlap กันตามชั้น ไม่ใช่ sequential เป๊ะ) |
| ความคืบหน้าของขั้นตอน | คำนวณสดจาก `phase_tasks` (done/total) ไม่เก็บเป็นค่า stored — pattern เดียวกับ `site_financial_summary` view ที่มีอยู่แล้ว |
| ขั้นตอนที่ยังไม่มี `phase_tasks` เลย | ถือว่า `not_started` (fallback ตรงกับ default เดิม) — PM ต้อง "แตกงาน" (สร้าง phase_tasks) เองตอนขั้นตอนใกล้เริ่ม |
| ระดับความละเอียดของ Kanban card | = `phase_tasks` (งานย่อยในขั้นตอน) ไม่ใช่ตัวขั้นตอนเอง — ขั้นตอนเดียวแตกเป็นหลายการ์ดได้ |
| Zone/ชั้น | เก็บเป็น text field เดียว (`phase_tasks.zone`) ไม่ทำตาราง `zones` แยก (**Option B** จาก 3 ตัวเลือกที่เทียบกัน — ดูอาร์ทิแฟกต์ [phase_tasks: A vs B vs C](https://claude.ai/artifact/MVfgBe1xC66QZFv9Ho9KfM)) |
| Team leader | เลือกเอง (manual) ต่อไซท์ต่อวัน ไม่ auto จาก `workers.position` — เก็บเป็น flag บน `assignments` ไม่ใช่ตารางใหม่ |
| สิทธิ์ลากการ์ด (`phase_tasks.status`) | ADMIN/OWNER ลากได้ทุกการ์ดเสมอ · team leader ของไซท์+วันนั้น ลากได้ (default ทำโดยคนนี้) · ช่างคนอื่นในทีม อ่านอย่างเดียว |
| Worker Dashboard | ต่อยอด `MySchedule.jsx` เดิม ไม่สร้างหน้าใหม่แยก — เพิ่ม section งานวันนี้ + รายชื่อทีม; แสดง tap-to-update เฉพาะกรณี user คนนั้นเป็น team leader ของวันนั้น |
| S-curve | ทำต่อจาก spec เดิม (3 เส้น: แผนเบิกเงิน/เบิกจริง/ต้นทุน) ย้ายมาอยู่ใต้ Gantt tab ของ site detail แทนที่จะเป็น section แยกในหน้า Sites list |
| Day View ผู้ดูแล | ต่อยอด `DayView.jsx` เดิม (จัดกลุ่มตามไซท์อยู่แล้ว = "ทีม") เปลี่ยนเนื้อหาการ์ดจากโฟกัสต้นทุนอย่างเดียว → เพิ่ม mini-Kanban ของงานที่กำลังทำ |

## Data model

### `site_phases` — ใช้ของเดิม ไม่แก้ schema
เพิ่มการใช้งานจริง: `start_date`/`end_date` (แกน Gantt), `depends_on_phase_id` (ลูกศร, soft), `status` (จะกลายเป็นค่าที่คำนวณสดจาก `phase_tasks`, ไม่ใช่ให้ผู้ใช้กดตั้งเองอีกต่อไป — ผิดกับ spec เดิมที่ให้ตั้งผ่าน modal ได้ตรงๆ)

### ตารางใหม่: `phase_tasks`
```sql
CREATE TABLE phase_tasks (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phase_id            UUID NOT NULL REFERENCES site_phases(id) ON DELETE CASCADE,
  tenant_id           UUID NOT NULL,
  name                TEXT NOT NULL,
  zone                TEXT,                    -- อิสระ, พิมพ์เอง เช่น "ชั้น 3" (Option B)
  status              TEXT NOT NULL DEFAULT 'todo'
                      CHECK (status IN ('todo','doing','done')),
  assigned_worker_id  UUID REFERENCES workers(id),
  date                DATE,                     -- วันที่ตั้งใจจะทำ ไม่ใช่ deadline บังคับ
  sort_order          INT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
```
- `date` ที่ผ่านไปแล้วแต่ยัง `status != 'done'` = "เลยกำหนด" — เป็นแค่การคำนวณฝั่ง UI (เทียบ `date < today`) ไม่ต้องมีคอลัมน์ `overdue` แยก การ์ดไม่หายไม่ reset เอง ค้างอยู่ตรงคอลัมน์เดิมจนกว่าจะมีคนย้าย
- ไม่มี CHECK บังคับผลรวมอะไรทั้งสิ้น (ต่างจาก `billing_weight_pct` ที่ต้องรวม 100% — `phase_tasks` ไม่มีน้ำหนักเป็น %, ความคืบหน้ามาจากการนับจำนวนแถว `done/total` ตรงๆ)

### `assignments` — เพิ่ม 1 คอลัมน์
```sql
ALTER TABLE assignments ADD COLUMN is_team_lead BOOLEAN NOT NULL DEFAULT false;
```
"ทีม" ไม่ใช่ entity ใหม่ — คือกลุ่ม `assignments` ที่ `site_id` + `date` เดียวกัน (ตรรกะเดียวกับที่ `DayView.jsx` group by site อยู่แล้ว) หาหัวหน้าทีมของไซท์+วันนั้นด้วย `WHERE site_id=? AND date=? AND is_team_lead=true` (ควรมี partial unique index กันตั้งสองคนพร้อมกันโดยไม่ตั้งใจ — ดูหัวข้อความเสี่ยง)

## สิทธิ์ (RLS + UI)

| ใคร | อ่าน Kanban ไซท์ | ลากการ์ด (update `phase_tasks`) | ตั้ง team leader |
|---|---|---|---|
| OWNER | ✓ ทุกไซท์ | ✓ ทุกการ์ด | ✓ |
| ADMIN/PM | ✓ ทุกไซท์ | ✓ ทุกการ์ด | ✓ |
| WORKER ที่เป็น team leader วันนั้น | ✓ เฉพาะไซท์ตัวเอง (ผ่าน Worker Dashboard) | ✓ เฉพาะการ์ดทีมตัวเอง | ✕ |
| WORKER ทั่วไป | ✓ เฉพาะไซท์ตัวเอง อ่านอย่างเดียว | ✕ | ✕ |

RLS policy บน `phase_tasks` (update) ต้องเช็ค: `auth role >= ADMIN` OR `EXISTS (SELECT 1 FROM assignments a WHERE a.site_id = (SELECT site_id FROM site_phases WHERE id = phase_tasks.phase_id) AND a.date = CURRENT_DATE AND a.is_team_lead = true AND a.worker_id = current_worker_id())`

## UI Components

### 1. Gantt ต่อไซท์ — แท็บใหม่ในหน้า site detail
- `src/pages/sites/GanttView.jsx` (พอร์ตแนวคิด timeline-positioning-math จาก branch เก่า ไม่ก็อปโค้ดตรงๆ)
- แท่งสีตาม progress ที่คำนวณสด: เทา (0%, ยังไม่มี/ยังไม่เริ่ม phase_tasks) / เหลือง (บางส่วนเสร็จ, โชว์ % บนแท่ง) / เขียว (100%)
- ลูกศร `depends_on_phase_id` เป็นเส้นประ ไม่ block อะไร
- `PhaseManageModal.jsx` — ยังคงไว้สำหรับตั้ง `start_date`/`end_date`/`depends_on_phase_id` ของขั้นตอน (ไม่ใช่ `status` อีกต่อไป — ตัดช่องนั้นออกจาก modal เดิม)

### 2. S-curve — ใต้ Gantt tab เดียวกัน (ไม่ใช่ section แยก)
- `src/pages/sites/SCurveChart.jsx` — **ใช้สูตรจาก spec เดิมตรงๆ**: แผน = บันไดสะสม `billing_weight_pct/100 × contract_value` ที่ `end_date` แต่ละขั้นตอน; เบิกจริง = สะสม `amount_no_vat+vat` จาก `useIncomes({siteId})`; ต้นทุน = สะสม `amount` จาก `useExpenses({siteId})`
- ใช้ `recharts` (มีอยู่แล้ว) ตาม spec เดิม — ไม่มีเหตุผลต้องเปลี่ยน

### 3. Kanban ต่อไซท์ — แท็บใหม่ที่สอง
- `src/pages/sites/PhaseKanbanBoard.jsx`
- Filter แถวบน: เลือกขั้นตอน + เลือกชั้น (`zone`, list ค่าที่มีจริงในข้อมูล ไม่ hardcode)
- คอลัมน์ตายตัว 3 อัน: `todo` / `doing` / `done` (ไทย: ยังไม่เริ่ม / กำลังทำ / เสร็จแล้ว)
- Drag ปิดใช้งาน (การ์ด disabled, cursor default) เมื่อ role ไม่ผ่านตารางสิทธิ์ด้านบน — ไม่ใช่ซ่อนบอร์ด แค่ล็อกการลาก

### 4. Worker Dashboard — ขยาย `MySchedule.jsx` เดิม
- เพิ่ม section "ทีมของคุณวันนี้" (avatar+ชื่อเพื่อนร่วมทีม, join `assignments` ที่ site_id/date เดียวกับตัวเอง)
- เพิ่ม section "งานของคุณวันนี้" — list เดียว (ไม่ใช่ 3 คอลัมน์ แบบ mobile-friendly) ของ `phase_tasks` ที่ `assigned_worker_id` ตรงกับตัวเองเท่านั้น (ตรงกับที่ mockup แสดง — งานของ "กร" ไม่ใช่งานของทั้งทีม) — ถ้า task ไหนยังไม่ได้ assign ใครเลย จะไม่ขึ้นในหน้านี้ของใครทั้งนั้น รอ team leader/PM assign ก่อนผ่าน Kanban tab
- ปุ่ม tap-to-update render เฉพาะเมื่อ `is_team_lead` ของตัวเองวันนี้เป็น true

### 5. Day View ผู้ดูแล — ขยาย `assign/DayView.jsx` เดิม
- การ์ดต่อไซท์เดิม (group by site อยู่แล้ว) เพิ่ม mini-board 3 คอลัมน์แสดง `phase_tasks` ของขั้นตอนที่ active วันนั้น ใต้ข้อมูลต้นทุน/OT เดิม (ไม่ลบของเดิม เพิ่มเติม)

## ผลกระทบ / ความเสี่ยง

- `phase_tasks.status` เข้ามาแทนที่การตั้ง `site_phases.status` ตรงๆ — ต้องตัด status selector ออกจาก `PhaseManageModal` ตาม spec เดิม (ของเดิมให้ตั้งเองได้) มิฉะนั้นค่าที่ผู้ใช้ตั้งเองจะขัดกับค่าที่คำนวณสด
- `assignments.is_team_lead` ควรมี partial unique index `(site_id, date) WHERE is_team_lead` กันตั้งสองหัวหน้าพร้อมกันในไซท์เดียววันเดียว (ยังไม่ยืนยันกับผู้ใช้ว่าจะ block หรือแค่เตือน — ต้องถามตอนเขียนแผน)
- ขั้นตอนที่ยังไม่มี `phase_tasks` (คือทุกขั้นตอนตอนนี้ ทั้ง 966 แถว) จะโชว์ 0%/เทาไปก่อนจนกว่า PM จะแตกงานเอง — ไม่ backfill task อัตโนมัติ เพราะไม่มีข้อมูลจริงให้เดา
- `depends_on_phase_id` เป็น soft hint ล้วนๆ หมายความว่า UI ต้องรับมือกรณี user ลากการ์ดของขั้นตอนที่ "ควรจะ" รอขั้นตอนก่อนหน้าไม่เสร็จได้แบบไม่ error — แสดง badge เตือนเท่านั้น (ยังไม่ได้ design ข้อความ/ตำแหน่ง badge ชัดเจน)

## นอกขอบเขต (รุ่นแรกไม่ทำ)

- มุมมองรวมทุกไซท์พร้อมกัน (portfolio-wide) — รุ่นถัดไป
- Offline support สำหรับ Worker Dashboard
- Zone เป็นตารางแยก + Gantt แยกแท่งตามชั้น (Option C) — ไว้ถ้าจำเป็นจริงค่อยย้ายจาก Option B
- Hard dependency gating (บังคับ push หรือ pull อย่างใดอย่างหนึ่ง)
- Drag-to-resize/reschedule แท่ง Gantt ตรงๆ (แก้ผ่าน `PhaseManageModal` เท่านั้น เหมือน spec เดิม)
- Notification/LINE integration เมื่องานเลยกำหนด (คนละ track กับที่คุยไว้ก่อนหน้านี้ — communications track)

## ลำดับการสร้าง (สำหรับแผน implementation ถัดไป)

1. Migration: `phase_tasks` table + `assignments.is_team_lead` + RLS policies
2. Gantt tab + S-curve (พอร์ตตรรกะจาก branch เก่า, คำนวณ progress สดจาก `phase_tasks` แทน `status` ที่ตั้งเอง)
3. Kanban tab ต่อไซท์ (สิทธิ์ลากการ์ดตามตาราง RLS ด้านบน)
4. Worker Dashboard ต่อยอด `MySchedule.jsx` + UI ตั้ง team leader ใน `GridView.jsx`
5. Day View ผู้ดูแล ต่อยอด `DayView.jsx`
