# Site Gantt + Kanban (v2) — Design Spec

วันที่: 2026-09-17 (แก้ไข/สรุปสุดท้าย — แทนที่ฉบับร่างก่อนหน้าในไฟล์เดียวกันนี้)
สถานะ: รอผู้ใช้รีวิวก่อนเขียนแผน implementation
อ้างอิง: ต่อยอด [`2026-07-06-sites-gantt-scurve-design.md`](2026-07-06-sites-gantt-scurve-design.md) (สูตร S-curve) และ mockup [`Site Gantt + Kanban Mockup`](https://claude.ai/artifact/KUZ3KXgSTfXVEE8hc45w81) (4 หน้าจอ)

## สิ่งที่เปลี่ยนจากฉบับร่างแรก

ฉบับร่างแรกของไฟล์นี้เขียนไว้ **ก่อน** ที่ Gantt tab + S-curve (หน้าจอ 1 ใน mockup) จะถูกสร้างจริงและ ship ผ่าน SDD (2 แผนแยก) แล้วขัดเกลาต่ออีกหลายรอบ (today-line, S-curve alignment, template on-demand, inline phase editor) จนสถานะจริงในระบบตอนนี้ต่างจากที่ร่างแรกสมมติไว้พอสมควร — ฉบับนี้ปรับให้ตรงกับของจริง และเปลี่ยนการตัดสินใจ 2 จุดตามที่คุยกับผู้ใช้ใหม่:

| จุด | ร่างแรก | ฉบับนี้ | เหตุผล |
|---|---|---|---|
| คนรับผิดชอบงานย่อย (`phase_tasks`) | `assigned_worker_id` (FK เดียว) | many-to-many ผ่านตารางเชื่อม — การ์ดมีได้ 0/1/หลายคน | ผู้ใช้ตอบตรงๆ ว่า "อาจเป็นคนเดียว, ทั้งทีม, หรือยังไม่มอบหมายก็ได้" |
| สิทธิ์ลากการ์ด (ที่ไม่ใช่ ADMIN+) | "team leader" ต่อไซท์+วัน (คอลัมน์ใหม่ `assignments.is_team_lead`) | ตัดออกจากรุ่นนี้ — Kanban บอร์ด (หน้าจอ 2) ลากได้เฉพาะ ADMIN+/canEditPage เท่านั้น; ช่างทั่วไปอัปเดตสถานะงานของตัวเองผ่าน Worker Dashboard เท่านั้น (ไม่ใช่ลากบนบอร์ดกลาง) | ไม่เคยคุยกับผู้ใช้เรื่อง team-leader ในรอบสนทนานี้ — แนวคิดนี้เก็บไว้เป็น "นอกขอบเขต รุ่นถัดไป" ด้านล่าง ไม่ทิ้งไปเฉยๆ |
| สถานะขั้นตอน (`site_phases.status`) | คำนวณสดจาก `phase_tasks` เสมอ, ตัด selector ออกจาก modal แก้ไขทั้งหมด | **คำนวณสดเมื่อขั้นตอนนั้นมี `phase_tasks` อย่างน้อย 1 แถว** — ขั้นตอนที่ไม่มี task เลย (ตอนนี้คือเกือบทุกขั้นตอน) ยังตั้งเองได้เหมือนเดิมผ่าน editor ที่เพิ่งสร้าง | ระหว่างที่ร่างแรกค้างไว้ หน้าจอ 1 ถูกสร้างเสร็จและ ship ไปแล้วพร้อม inline editor ที่ตั้ง `status` เองได้ตรงๆ (`GanttView.jsx`) — มีการใช้งานจริงแล้ว (8 ขั้นตอนถูกตั้งสถานะเองแล้ว ณ วันที่เขียนนี้) ตัดออกทั้งหมดจะเป็นการถอย regression ให้ไซท์ที่ไม่เคยใช้ Kanban เลย |

จุดอื่นที่ร่างแรกตัดสินใจไว้แล้วและยังยืนยันเหมือนเดิม: zone เป็น free text (ไม่ทำตาราง `zones` แยก), Day View ผู้ดูแล เป็นการ **เพิ่ม** ส่วนใน `DayView.jsx` เดิม (ไม่ใช่แทนที่การ์ดสรุปต้นทุน/ชั่วโมงทำงานต่อไซท์ที่มีอยู่แล้ว — ผู้ใช้ยืนยันอีกรอบว่าข้อมูลชุดนั้น "useful, keep").

## เป้าหมาย

เพิ่ม 3 หน้าจอที่ต่อยอดจาก Gantt tab ที่ ship ไปแล้ว (หน้าจอ 1) โดยอ่าน/เขียนข้อมูลชุดเดียวกัน:

2. **Kanban ต่อไซท์** (ADMIN/OWNER/PM) — บอร์ดงานย่อยของแต่ละขั้นตอน แยกกรองตามขั้นตอน/ชั้น-โซนได้ ลากการ์ดเปลี่ยนสถานะ
3. **Day View ผู้ดูแล** (ADMIN/OWNER/PM) — การ์ดสรุปต้นทุน/ทีมต่อไซท์ที่มีอยู่แล้วใน `จ่ายงานช่าง` → Day view เดิม เพิ่ม mini-board 3 คอลัมน์ของขั้นตอนที่ active วันนั้น
4. **Worker Dashboard** (ช่างแต่ละคน) — ต่อยอด `MySchedule.jsx` เดิม เพิ่มงานของตัวเองวันนี้ (list เดียว, tap เพื่ออัปเดตสถานะ) + รายชื่อทีมวันนี้

ขอบเขตรุ่นนี้: **ต่อไซท์ก่อน** (มุมมองรวมทุกไซท์พร้อมกันของ Kanban ทำทีหลัง — Gantt แบบรวมทุกไซท์มีอยู่แล้วจากรุ่นก่อน), ไม่ทำ offline support, ไม่บังคับ sequencing ระหว่างขั้นตอน (dependency เป็น soft hint เท่านั้น เหมือน Gantt ที่ ship ไปแล้ว)

## สถานะปัจจุบัน (สำคัญ ต้องรู้ก่อนอ่านต่อ)

- Gantt tab + S-curve (หน้าจอ 1) **ship แล้ว จริง** ใน `SiteDetail.jsx` → แท็บ "📅 Gantt": `GanttView.jsx` (Gantt แบบ 1 แถวต่อขั้นตอน + inline editor แก้ไข/เพิ่ม/ลบขั้นตอนในหน้าเดียว), `SCurveChart.jsx`, `ganttTimeline.js`, `scurveCalc.js`
- `site_phases`: 973 แถว ครอบคลุม 139 ไซท์ — **auto-seed trigger ถูกถอดออกแล้ว** (`trg_seed_site_phases` DROP ผ่าน migration `2026-09-17-02-drop-seed-site-phases-trigger.sql`) ไซท์ใหม่จะไม่มีขั้นตอนอัตโนมัติอีกต่อไป ต้องกดปุ่ม "+ เริ่มใช้ Gantt" (เทมเพลต 7 ขั้นตอนเดิม, `PHASE_TEMPLATE` ใน `ganttTimeline.js`) หรือเพิ่มเองทีละขั้นตอน
- ปัจจุบัน 8 แถวมี `status != 'not_started'` (ตั้งเองผ่าน inline editor) และ 10 แถวมี `start_date`/`end_date` — ส่วนใหญ่ยังเป็นค่า default เพราะเพิ่งเปิดใช้งานฟีเจอร์
- `depends_on_phase_id` มีคอลัมน์อยู่แล้ว ใช้งานจริงแล้ว (ลูกศร soft บน Gantt)
- `useIncomes({ siteId })` / `useExpenses({ siteId })` ใช้งานจริงแล้วใน `SCurveChart.jsx`
- `MySchedule.jsx` (มุมมอง WORKER ของหน้า "จ่ายงานช่าง") มีอยู่แล้ว พร้อม GPS check-in/check-out จริง (`perform_worker_checkin`/`perform_worker_checkout`) และ section "ทีมของคุณวันนี้" ในรูปแบบ `TodayCheckinCard` ต่อไซท์ที่ workerลงวันนี้ (จาก `todaySiteAssignments`) — โครงสร้างพร้อมต่อยอด section งานวันนี้
- `DayView.jsx` (มุมมอง ADMIN+ ของ Day view ในหน้า "จ่ายงานช่าง") จัดกลุ่มตามไซท์อยู่แล้ว การ์ดต่อไซท์โชว์ยอดต้นทุนวันนี้ + chip ช่างเช้า/บ่าย + OT — โครงสร้างพร้อมต่อยอด mini-board โดยไม่แตะของเดิม
- ยังไม่มี drag-and-drop library ใดๆ ใน `package.json`

## การตัดสินใจที่ยืนยันแล้ว

| หัวข้อ | ข้อสรุป |
|---|---|
| Dependency ระหว่างขั้นตอน | Soft เท่านั้น (ยืนยันจาก Gantt ที่ ship แล้ว) — ไม่ block การลากการ์ดข้ามขั้นตอนใน Kanban |
| ความคืบหน้าของขั้นตอน | ขั้นตอนที่มี `phase_tasks` ≥ 1 แถว: `status`/`%` คำนวณสดจาก done/total (pattern เดียวกับ `site_financial_summary` view) — ขั้นตอนที่ไม่มี `phase_tasks` เลย: ใช้ `site_phases.status` ที่ตั้งเองตามเดิม (ไม่เปลี่ยนพฤติกรรมของ editor ที่ ship ไปแล้ว) |
| ระดับความละเอียดของ Kanban card | = `phase_tasks` (งานย่อยในขั้นตอน) ไม่ใช่ตัวขั้นตอนเอง |
| Zone/ชั้น | text field เดียว (`phase_tasks.zone`) ไม่ทำตาราง `zones` แยก |
| คนรับผิดชอบงานย่อย | many-to-many ผ่าน `phase_task_workers` — 0/1/หลายคนต่อการ์ด |
| สิทธิ์ลากการ์ด (Kanban บอร์ด, หน้าจอ 2) | ADMIN+ ที่ `canEditPage(role,'sites')` เท่านั้น เหมือนสิทธิ์แก้ Gantt (`GanttView.jsx` ปัจจุบัน) — role อื่นเห็นบอร์ดแบบอ่านอย่างเดียว |
| สิทธิ์อัปเดตสถานะจาก Worker Dashboard | ช่างแก้สถานะได้เฉพาะการ์ดที่ตัวเองเป็นหนึ่งใน assignee เท่านั้น (RLS บังคับ ไม่ใช่แค่ซ่อนปุ่มฝั่ง UI) |
| S-curve | ship แล้ว ไม่แก้เพิ่มในรอบนี้ |
| Day View ผู้ดูแล | **เพิ่ม** section mini-board เข้าไปในการ์ดต่อไซท์เดิมของ `DayView.jsx` (ไม่แทนที่การ์ดสรุปต้นทุน/OT ที่มีอยู่) |
| Worker Dashboard | ต่อยอด `MySchedule.jsx` เดิม — เพิ่ม section งานวันนี้ (list เดียว ไม่ใช่ 3 คอลัมน์ เหมาะกับมือถือ) ใต้ section ทีมวันนี้ที่มีโครงอยู่แล้ว |
| Drag-and-drop | ไม่เพิ่ม dependency ใหม่ — ใช้ HTML5 native drag (`draggable`) บนเดสก์ท็อป + เมนู tap เลือกคอลัมน์ปลายทางเป็น fallback (ใช้ได้ทั้งเมาส์/ทัช) |

## Data model

### `site_phases` — ใช้ของเดิม ไม่แก้ schema
`status` ยังคงเป็น field ที่ตั้งเองได้เหมือนเดิม **สำหรับขั้นตอนที่ไม่มี `phase_tasks`** — เมื่อมี `phase_tasks` แล้ว หน้า UI จะปิดการแก้ `status` เอง (readonly + หมายเหตุ "คำนวณอัตโนมัติจากงานย่อย") และคำนวณจาก `phase_tasks` แทน

### ตารางใหม่: `phase_tasks`
```sql
CREATE TABLE phase_tasks (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phase_id    UUID NOT NULL REFERENCES site_phases(id) ON DELETE CASCADE,
  site_id     UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE, -- denormalize เพื่อ RLS/query ตรงๆ ไม่ต้อง join site_phases ทุกครั้ง
  tenant_id   UUID NOT NULL,
  name        TEXT NOT NULL,
  zone        TEXT,                     -- อิสระ, พิมพ์เอง เช่น "ชั้น 3"
  status      TEXT NOT NULL DEFAULT 'not_started'
              CHECK (status IN ('not_started','in_progress','done')), -- ตรงกับ STATUS_COLOR ใน ganttTimeline.js
  due_date    DATE,                     -- วันที่ตั้งใจจะทำเสร็จ ไม่ใช่ deadline บังคับ
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
```
- `due_date` ที่ผ่านไปแล้วแต่ยัง `status != 'done'` = "เลยกำหนด" — คำนวณฝั่ง UI (`due_date < today`) ไม่มีคอลัมน์ `overdue` แยก
- ไม่มี CHECK บังคับผลรวมใดๆ (ต่างจาก `billing_weight_pct` ของ `site_phases`) — ความคืบหน้าของขั้นตอนมาจากนับจำนวนแถว `done/total` ตรงๆ

### ตารางใหม่: `phase_task_workers` (many-to-many)
```sql
CREATE TABLE phase_task_workers (
  task_id   UUID NOT NULL REFERENCES phase_tasks(id) ON DELETE CASCADE,
  worker_id UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, worker_id)
);
```
0 แถว = ยังไม่มอบหมาย, 1 แถว = คนเดียว, หลายแถว = ทั้งทีม — การ์ดโชว์ avatar ตามจำนวนจริง

## สิทธิ์ (RLS + UI)

| ใคร | อ่าน Kanban ไซท์ | ลากการ์ดบน Kanban บอร์ด | อัปเดตสถานะงานตัวเองจาก Worker Dashboard |
|---|---|---|---|
| OWNER/ADMIN ที่ `canEditPage('sites')` | ✓ ทุกไซท์ | ✓ ทุกการ์ด | ✓ (ถ้าเป็น assignee ด้วย) |
| WORKER (ไม่ใช่ assignee ของการ์ดนั้น) | ✓ เฉพาะไซท์ตัวเอง อ่านอย่างเดียว | ✕ | ✕ |
| WORKER ที่เป็น assignee ของการ์ดนั้น | ✓ เฉพาะไซท์ตัวเอง อ่านอย่างเดียว | ✕ (บอร์ดกลางไม่ให้ลาก) | ✓ เฉพาะการ์ดที่ตัวเองอยู่ใน `phase_task_workers` |

RLS `phase_tasks` (update): `auth role >= ADMIN AND canEditPage('sites')` OR `EXISTS (SELECT 1 FROM phase_task_workers ptw WHERE ptw.task_id = phase_tasks.id AND ptw.worker_id = current_worker_id())` — ฝั่ง UI (tap-to-update บน Worker Dashboard) จำกัดตัวเลือกให้แก้ได้แค่ `status` เท่านั้น (ไม่ใช่ name/zone/assignee)

RLS `phase_tasks` (select): ตามสิทธิ์เดิมของ `site_phases`/`sites` อยู่แล้ว (ผูกกับ tenant + role visibility ที่มี pattern อยู่แล้วในระบบ)

## UI Components

### 1. Gantt ต่อไซท์ (หน้าจอ 1) — **ship แล้ว ไม่แก้ในรอบนี้**
`GanttView.jsx`/`SCurveChart.jsx`/`ganttTimeline.js`/`scurveCalc.js` — เพิ่มแค่การอ่าน `phase_tasks` เพื่อคำนวณ `status`/`%` ของขั้นตอนที่มี task (ดูหัวข้อถัดไป)

**เปลี่ยนแปลงเล็กน้อยที่ต้องทำใน `GanttView.jsx`:**
- คำนวณ derived status ต่อขั้นตอน: ถ้ามี `phase_tasks` ให้ใช้ done/total แทน `phase.status` — bar ที่ done บางส่วนโชว์ `{done}/{total}` หรือ `%` แทนคำว่า "กำลังทำ" เฉยๆ (ตรงกับ mockup "60% = task เสร็จ 3/5")
- Inline editor (ที่เพิ่ง ship): เมื่อขั้นตอนนั้นมี `phase_tasks` แล้ว ให้ปิดช่อง "สถานะ" (disabled + หมายเหตุ "คำนวณอัตโนมัติจากงานย่อย")

### 2. Kanban ต่อไซท์ — แท็บใหม่ที่ 3 ใน `SiteDetail.jsx` ("🗂 Kanban" ถัดจาก "ภาพรวม"/"📅 Gantt")
- ไฟล์ใหม่: `src/pages/sites/PhaseKanbanBoard.jsx`
- Filter แถวบน: chip เลือกขั้นตอน (จาก `site_phases` ของไซท์นี้) + chip เลือกชั้น/โซน (list ค่า `zone` ที่มีจริงในขั้นตอนที่เลือก, ค่าเริ่มต้น "ทุกชั้น")
- คอลัมน์ตายตัว 3 อัน: ยังไม่เริ่ม / กำลังทำ / เสร็จแล้ว
- การ์ด: ชื่องาน, zone badge, avatar ผู้รับผิดชอบ (0/1/หลายคน), ลาก (HTML5 native `draggable`) เพื่อย้ายคอลัมน์บนเดสก์ท็อป + ปุ่มเมนู tap เลือกคอลัมน์ปลายทางสำหรับทัช — ปิดใช้งานทั้งคู่ (การ์ด disabled, cursor default) ถ้าไม่ใช่ ADMIN+
- ปุ่ม "+ เพิ่มงาน" ต่อคอลัมน์ (เฉพาะ ADMIN+) เปิดฟอร์มเล็กๆ ตั้งชื่อ/zone/ผู้รับผิดชอบ

### 3. Day View ผู้ดูแล — **เพิ่ม** section ใน `assign/DayView.jsx` เดิม
- การ์ดต่อไซท์เดิม (ยอดต้นทุนวันนี้ + chip เช้า/บ่าย + OT) **คงไว้ทั้งหมด ไม่แก้**
- เพิ่ม section ใหม่ท้ายการ์ด (pattern เดียวกับ section OT ที่มีอยู่แล้ว — แสดงเมื่อมีข้อมูลเท่านั้น): mini-board 3 คอลัมน์ของ "ขั้นตอน active" ของไซท์นั้น
- "ขั้นตอน active" = ขั้นตอนแรก (เรียงตาม `sort_order`) ที่มีสถานะ `in_progress`; ถ้าไม่มี ให้ตกไปใช้ขั้นตอนแรกที่ `not_started`; ถ้าไซท์นั้นไม่มีขั้นตอนไหนมี `phase_tasks` เลย ไม่ต้องแสดง section นี้

### 4. Worker Dashboard — ต่อยอด `assign/MySchedule.jsx` เดิม
- Section "ทีมของคุณวันนี้": ต่อยอดจาก `todaySiteAssignments` ที่มีอยู่แล้ว — โชว์ avatar เพื่อนร่วมทีมที่ assign ไซท์เดียวกันวันเดียวกัน (join `worker_assignments`)
- Section ใหม่ "งานของคุณวันนี้": list เดียว (ไม่ใช่ 3 คอลัมน์, mobile-friendly) ของ `phase_tasks` ที่ตัวเองอยู่ใน `phase_task_workers` และ `status != 'done'` — เรียงเลยกำหนดก่อน (`due_date < today`), แล้วกำลังทำ, แล้วยังไม่เริ่ม — แต่ละใบ tap เปิดเมนูเล็กเปลี่ยนสถานะ (RLS บังคับแก้ได้เฉพาะของตัวเอง)
- ถ้า task ไหนยังไม่ได้ assign ใครเลย จะไม่ขึ้นในหน้านี้ของใครทั้งนั้น (ต้องมีคน assign ก่อนผ่าน Kanban tab)

## ผลกระทบ / ความเสี่ยง

- `GanttView.jsx` ต้อง fetch `phase_tasks` เพิ่ม (นอกจาก `site_phases` ที่ fetch อยู่แล้ว) — เพิ่ม hook `usePhaseTasks()` (ตาม pattern `useSitePhases()` เดิม, `fetchAllRows` pagination-safe)
- ขั้นตอนที่ยังไม่มี `phase_tasks` (ตอนนี้คือแทบทุกขั้นตอนจาก 973 แถว) จะยังใช้ `status` ที่ตั้งเองต่อไป — ไม่มี backfill อัตโนมัติ เพราะไม่มีข้อมูลงานย่อยจริงให้เดา
- `depends_on_phase_id` เป็น soft hint ล้วนๆ — Kanban ไม่ block การลากข้ามขั้นตอนที่ "ควรจะ" รอกัน (เหมือน Gantt ที่ ship แล้วไม่ block การตั้งวันที่ทับซ้อนกัน)
- HTML5 native drag ใช้ไม่ได้ดีบนทัชสกรีน — ต้องมี fallback (เมนู tap) ให้ครบทุก interaction ไม่ใช่แค่ desktop

## นอกขอบเขต (รุ่นนี้ไม่ทำ)

- **Team leader ต่อไซท์+วัน** (จากร่างแรก — `assignments.is_team_lead`, ให้ช่างที่ไม่ใช่ ADMIN ลากการ์ดแทนทีมได้) — แนวคิดดี แต่ไม่เคยคุยกับผู้ใช้ในรอบนี้ เก็บไว้พิจารณารุ่นถัดไปถ้าจำเป็นจริง (ตอนนี้ ADMIN+ ตั้งค่า/ลากแทนให้ได้อยู่แล้ว)
- มุมมอง Kanban รวมทุกไซท์พร้อมกัน (portfolio-wide)
- Offline support สำหรับ Worker Dashboard
- Zone เป็นตารางแยก + Gantt แยกแท่งตามชั้น
- Hard dependency gating
- Drag-to-resize/reschedule แท่ง Gantt ตรงๆ (แก้ผ่าน inline editor เท่านั้น เหมือนที่ ship แล้ว)
- Notification/LINE integration เมื่องานเลยกำหนด

## ลำดับการสร้าง (สำหรับแผน implementation ถัดไป)

1. Migration: `phase_tasks` + `phase_task_workers` + RLS policies + hook `usePhaseTasks()`
2. `GanttView.jsx`: derived status จาก `phase_tasks` เมื่อมี, ปิด selector สถานะเมื่อมี task
3. Kanban tab ต่อไซท์ (`PhaseKanbanBoard.jsx`) — ใหม่ทั้งไฟล์, ต่อ tab ที่ 3 ใน `SiteDetail.jsx`
4. Day View ผู้ดูแล — เพิ่ม section ใน `DayView.jsx`
5. Worker Dashboard — เพิ่ม section ใน `MySchedule.jsx`
