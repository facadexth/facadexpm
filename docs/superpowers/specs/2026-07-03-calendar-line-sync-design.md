# FXPM ↔ Google Calendar + LINE Sync — Design Spec

วันที่: 2026-07-03
สถานะ: อนุมัติดีไซน์แล้ว (รอเขียนแผน implementation)

## เป้าหมาย

ให้ FXPM (หน้า Assign / ตาราง `worker_assignments`) เป็น single source of truth เดียว แล้ว sync ออกไป 2 ที่แบบอ่านอย่างเดียว (one-way):
1. **Google Calendar** — ปฏิทิน "workworkwork" ใต้บัญชี `contact@facadex.co.th`
2. **LINE กลุ่ม (มีอยู่แล้ว)** ผ่าน LINE Official Account — แจ้งเตือนเฉพาะกรณีจำเป็น + ให้เช็คย้อนได้ระหว่างวันแบบไม่เสียโควต้า

ไม่มีการแก้ไขข้อมูลจาก Calendar หรือ LINE ย้อนกลับเข้า FXPM — ทิศทางเดียวเท่านั้น

## การตัดสินใจที่ยืนยันแล้ว

| หัวข้อ | ข้อสรุป |
|---|---|
| Input | เข้า FXPM เท่านั้น (Assign module) |
| ทิศทาง sync | FXPM → Google Calendar (one-way) |
| Calendar เป้าหมาย | ชื่อ "workworkwork" ใต้บัญชี `contact@facadex.co.th` |
| หน่วย sync | 1 event ต่อ 1 ไซท์ต่อ 1 วัน (รวมช่างทุกคนที่ assign ไซท์นั้นวันนั้นไว้ใน event เดียว) — เฉพาะแถวที่มี `site_id` ไม่ null เท่านั้น (`type` ใน `site`/`factory`/`subcontract`); แถว `leave`/`office`/`holiday` ไม่มี site จึงไม่ sync ขึ้น Calendar |
| Trigger sync | Supabase Database Webhook (INSERT/UPDATE/DELETE บน `worker_assignments`) → เรียก GAS Web App real-time — ไม่ใช้ polling เพราะ polling ทำให้ same-day reassignment ค้างข้อมูลเก่าจนถึงรอบ poll ถัดไป |
| วิธี sync แต่ละครั้ง | recompute-and-overwrite: ดึง roster ปัจจุบันทั้งหมดของ `{site_id, date}` จาก Supabase มาเขียนทับ event เดิม (ไม่ diff จาก payload webhook) — ทำให้ idempotent ต่อ webhook ที่มาซ้ำ/มาไม่เรียงลำดับ |
| Auth เข้า Calendar | GAS ใช้ `CalendarApp` ของบัญชีตัวเอง (`contact@facadex.co.th`) — ไม่ต้องใช้ service account |
| ช่องทาง LINE หลัก | **Pull**: พนักงานพิมพ์ keyword ในกลุ่ม (เช่น `@บอท ตารางงานวันนี้`) → บอทอ่านจาก Google Calendar (ไม่ใช่ query Supabase ตรง เพราะ Calendar มี text ที่ format ไว้แล้วจาก sync — ใช้ซ้ำได้ ไม่ต้องเขียน format 2 ที่) → ตอบกลับ 1 ข้อความรวมทุกไซท์ของวันนั้น ผ่าน LINE Reply API (ฟรี ไม่จำกัดจำนวนครั้ง) |
| ช่องทาง LINE สำรอง | **Push**: เฉพาะกรณี exception เท่านั้น — reassignment ที่แก้ไขในวันเดียวกับวันที่ทำงานจริง (`webhook.type == 'UPDATE' AND record.date == today()`) ถึงจะ push เข้ากลุ่ม ส่วน assignment ใหม่ที่สร้างล่วงหน้าไม่ push |
| งบ push / เดือน | มี safety-cap counter (เก็บใน GAS Script Properties, reset ทุกต้นเดือน) — ใกล้ชน free quota แล้วหยุด push อัตโนมัติ fallback เป็น pull-only แทน ป้องกันโดนคิดเงินเกินโดยไม่ตั้งใจ |
| Timezone | `Asia/Bangkok` ทั้งหมด |

## เหตุผลเรื่องโควต้า LINE (สำคัญ ต้องเข้าใจก่อน implement)

- Push/Multicast มีค่าใช้จ่ายนับ **ต่อสมาชิกในกลุ่ม ไม่ใช่ต่อครั้งที่ส่ง** — กลุ่ม 10 คน push 1 ครั้ง = หัก 10 จากโควต้า ไม่ใช่ 1
- Reply message (ตอบกลับ webhook event ที่มีคนพิมพ์ในกลุ่มจริง) **ฟรีและไม่จำกัด**
- ด้วยเหตุนี้ push ประจำวัน (เช่นสรุปทุกเช้า) ใช้โควต้าเกือบหมดทั้งเดือนจากกลุ่มเดียว จึงออกแบบให้ pull (reply) เป็นช่องทางหลัก และสงวน push ไว้เฉพาะ exception ที่มีมูลค่าจริง (same-day reassignment) เท่านั้น
- LINE Notify ถูกยกเลิกไปแล้ว (มี.ค. 2025) จึงไม่ใช่ทางเลือก

## Architecture

```
worker_assignments (Supabase)
   │  INSERT/UPDATE/DELETE
   ▼
Supabase Database Webhook ──POST (shared secret)──▶ GAS Web App (doPost)
                                                          │
                                    ┌─────────────────────┼─────────────────────┐
                                    ▼                     ▼                     ▼
                       Supabase REST (recompute      Google Calendar     LINE Push API
                       roster for site+date)          "workworkwork"     (เฉพาะ exception,
                                                        (create/update/    same-day update)
                                                        delete event)

LINE กลุ่ม (คนพิมพ์ keyword)
   │  message event
   ▼
LINE Webhook ──POST──▶ GAS Web App (doPost, route แยกจาก Supabase webhook)
                            │
                            ▼
                  CalendarApp.getEventsForDay(today)
                  → รวม description ทุก event → 1 ข้อความ
                            │
                            ▼
                  LINE Reply API (replyToken)
```

GAS project เดียวรับ 2 endpoint: จาก Supabase Database Webhook (calendar sync + exception push) และจาก LINE webhook (pull keyword) — แยก route กันด้วยรูปแบบ payload ที่ต่างกัน (Supabase ส่ง `{type, record, old_record}`, LINE ส่ง `{events: [...]}`)

## Database

### ตารางใหม่: `calendar_sync`
```sql
CREATE TABLE calendar_sync (
  site_id         UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  assignment_date DATE NOT NULL,
  google_event_id TEXT NOT NULL,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (site_id, assignment_date)
);
```
ใช้แม็พว่า `{site_id, date}` ไหน ผูกกับ Google Calendar event ไหน เพื่อ update/delete event เดิมแทนที่จะสร้างซ้ำ

### `worker_assignments`
ไม่ต้องแก้ schema — Supabase Database Webhook payload บอก operation type (`INSERT`/`UPDATE`/`DELETE`) อยู่แล้ว ใช้ตรวจ exception-push logic ได้โดยไม่ต้องเพิ่มคอลัมน์ `updated_at`

### Database Webhook (Supabase)
เปิดใช้บน `worker_assignments` สำหรับ INSERT/UPDATE/DELETE → HTTP POST ไป GAS Web App URL พร้อม shared-secret header เพื่อกัน endpoint ถูกยิงจากที่อื่น

## GAS (Google Apps Script)

โปรเจกต์ใหม่ ผูกกับบัญชี `contact@facadex.co.th` เก็บ source ไว้ใน repo (โฟลเดอร์ `gas/` หรือคล้ายกัน) แล้ว deploy ด้วย `clasp` เพื่อให้ track เป็น git ได้ (ไม่ใช่แก้ตรงใน Apps Script editor เฉยๆ)

Script Properties ที่ต้องตั้ง:
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — query roster
- `LINE_CHANNEL_ACCESS_TOKEN` — push/reply
- `LINE_GROUP_ID` — กลุ่มเป้าหมายสำหรับ push
- `WEBHOOK_SHARED_SECRET` — ตรวจ request จาก Supabase webhook
- `CALENDAR_NAME` = `workworkwork`
- `PUSH_QUOTA_MONTHLY_CAP`, ตัวนับ push ปัจจุบัน (เก็บใน Script Properties, reset ทุกวันที่ 1)

### ฟังก์ชันหลัก
1. `doPost(e)` — แยก route ตามรูปแบบ payload (Supabase webhook vs LINE webhook)
2. `syncCalendarEvent(site_id, date)` — recompute roster จาก Supabase → หา/สร้าง/แก้/ลบ event ผ่าน `CalendarApp`, upsert แถวใน `calendar_sync`
3. `maybePushException(webhookPayload)` — เช็คเงื่อนไข same-day update + งบ push เหลือ → ส่ง push ถ้าเข้าเงื่อนไข
4. `handleLineKeyword(event)` — เช็ค `event.message.text` มี keyword ไหม → ถ้ามี อ่าน `CalendarApp.getEventsForDay(today)` รวม description ทุก event → reply กลับ

## Error Handling

- Calendar API หรือ LINE API ล้มเหลว (rate limit, token หมดอายุ) → log ไว้ (Stackdriver ของ GAS หรือ ตาราง `sync_errors` เพิ่มถ้าจำเป็น) ไม่ throw กลับไปหา Supabase webhook เพราะ webhook ยิงหลัง commit DB ไปแล้ว การ sync fail ไม่ควรกระทบการบันทึก assignment
- Webhook ซ้ำ/มาไม่เรียงลำดับ → รองรับได้เองด้วย recompute-and-overwrite (ไม่ต้องมี retry/dedup logic แยก)
- Roster ว่าง (assignment ถูกลบหมดสำหรับ site+date นั้น) → ลบ Calendar event ทิ้ง + ลบแถว `calendar_sync`

## ผลกระทบ / ความเสี่ยง

- ต้อง provision Google Cloud project สำหรับ GAS + เปิด Calendar API และ ผูก LINE Official Account เดิมเข้ากับ channel access token ใหม่ (ถ้ายังไม่มี)
- GAS เป็น dependency นอก Supabase — ถ้า GAS ล่ม sync จะหยุด (ไม่กระทบ FXPM หลัก เพราะ webhook เป็น fire-and-forget)
- Push exception ยังมีโอกาสใช้โควต้าถ้าเกิด reassignment ถี่มากในวันเดียว — safety-cap ป้องกันไม่ให้เกินฟรี quota แต่ต้องยอมรับว่าถ้าชน cap แล้ว exception นั้นจะไม่ push (fallback pull เท่านั้น)

## นอกขอบเขต (ยังไม่ทำ)

- ไม่ทำ two-way sync (แก้ที่ Calendar หรือ LINE แล้วสะท้อนกลับ FXPM)
- ไม่ทำ 1:1 push ส่วนตัวถึงช่างแต่ละคน (ผูก LINE user ID รายคน)
- ไม่ทำ Rich Menu UI ให้กด (ใช้ keyword พิมพ์ล้วนๆ ในเฟสนี้)
- ไม่ทำ digest ประจำวันแบบ push (เปลี่ยนเป็น pull ทั้งหมดเพื่อประหยัดโควต้า)
- Exception push ครอบคลุมเฉพาะ `UPDATE` ที่ `date == today()` (reassignment) เท่านั้น — `DELETE` same-day (เช่น ยกเลิกงานกะทันหัน) ไม่ push อัตโนมัติในเฟสนี้ ต้องเช็คผ่าน pull เอา
