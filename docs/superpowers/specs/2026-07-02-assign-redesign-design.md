# Assign Page Redesign — Design Spec

วันที่: 2026-07-02
สถานะ: อนุมัติดีไซน์แล้ว (รอเขียนแผน implementation)

## เป้าหมาย

รื้อหน้า Assign (`src/pages/Assign.jsx`) ให้รองรับ:
1. มุมมอง Day / Week / Month (เริ่มสัปดาห์วันจันทร์)
2. โฟลว์ assign ใหม่: เลือกหลายวัน → ประเภท → ไซท์ → ช่างหลายคน
3. คิวช่างแบบกะเช้า-เย็น (1 กะ = 0.5 วัน)
4. Popup ที่ไม่ล้นเมื่อชื่อไซท์ยาว
5. ลิงก์ Google Maps ต่อไซท์
6. ประเภทใหม่ "ผลิตที่โรงงาน" + ระบบค่าเดินทางต่อไซท์ต่อวัน

## การตัดสินใจที่ยืนยันแล้ว

| หัวข้อ | ข้อสรุป |
|---|---|
| มุมมอง | Day / Week / Month สลับได้ + ปุ่มเลื่อน (ก่อนหน้า/ถัดไป/วันนี้) |
| Wizard | แผงเดียวเห็นครบ (ไม่ใช่ stepper) |
| กะเช้า-เย็น | 1 กะ = 0.5 วัน · default ติ๊กทั้งคู่ · split = คลิกเอากะออก |
| ช่องตาราง | เต็มช่องปกติ · แบ่งครึ่งบน(เช้า)-ล่าง(เย็น) เฉพาะตอน split (ต่างไซท์) |
| Day view | จัดกลุ่มตามไซท์ (คอลัมน์เช้า/เย็น + ค่าแรง/วัน) |
| Week view | จัน–อาทิตย์ 7 วัน (อาทิตย์ disable เผื่อ OT) |
| ลา/หยุด/ออฟฟิศ | คลิกช่องในตารางโดยตรง (ไม่ผ่าน wizard) |
| conflict ตอน assign | แจ้งเตือน "ช่าง X มีงาน Y อยู่แล้ว ยืนยันไหม" → ตกลง = เขียนทับ |
| Google Map | โชว์ในหน้า Sites เท่านั้น |
| ค่าเดินทาง | คิดจริง · ต่อไซท์ต่อวัน (ไปด้วยกัน) · ระยะเที่ยวเดียว ระบบคิด ×2 · เรทตั้งค่าได้ใน Settings (default 20 บ./กม.) |

## ประเภทการ assign

| ประเภท (type) | ค่าแรงลงไซท์ | ค่าเดินทาง | ต้องเลือกไซท์ |
|---|---|---|---|
| `site` 🏗️ งานไซท์ | ✅ | ✅ | ✅ |
| `factory` 🏭 ผลิตที่โรงงาน **‹ใหม่›** | ✅ (ลงไซท์ที่ผลิตให้) | ❌ | ✅ |
| `subcontract` 🔧 | ❌ (ตามเดิม) | ❌ | ✅ |
| `office` 🏢 / `leave` 🏖️ / `holiday` 🎌 | ❌ | ❌ | ❌ |

## Database

> ⚠️ `supabase/schema.sql` ล้าสมัย (ไม่มี `ot_hours`, สถานะ/คอลัมน์ไม่ตรง DB จริง) — **ต้องเช็ค schema จริงผ่าน Supabase ก่อนร่าง migration**

### worker_assignments
- เพิ่ม `shift TEXT NOT NULL DEFAULT 'morning' CHECK (shift IN ('morning','evening'))`
- เพิ่มค่า `'factory'` ใน CHECK ของ `type`
- เปลี่ยน unique: `(worker_id, date)` → `(worker_id, date, shift)`
- **Migration ข้อมูลเดิม**: แต่ละแถวเดิม (1 วันเต็ม) → แตกเป็น 2 แถว
  - แถวเดิมกลายเป็น `shift='morning'` (คง `ot_hours` ไว้ที่นี่)
  - insert แถวใหม่ `shift='evening'` (ก็อป site_id/type/date/notes, `ot_hours=0` กันนับซ้ำ)
  - รักษายอดค่าแรงเดิม: 2 กะ × 0.5 = 1 วัน เท่าเดิม

### sites
- เพิ่ม `distance_km NUMERIC` (ระยะทางเที่ยวเดียวจากโรงงาน, nullable)
- เพิ่ม `map_url TEXT` (ลิงก์ Google Maps, nullable)

### Settings (ค่าเรทค่าเดินทาง)
- เก็บ `travel_rate_per_km` (default 20) — ตำแหน่งจัดเก็บให้ยึดตามที่ `Settings.jsx` ใช้อยู่ (ตรวจก่อน implement ว่ามีตาราง config/settings หรือเก็บที่ไหน)

### View: labor_cost_by_site
- `days_worked = COUNT(*) * 0.5` (แต่ละแถว = ครึ่งวัน)
- `WHERE type IN ('site','factory')` (เดิม `= 'site'`)
- `labor_cost = ROUND(monthly_salary / 26 * days_worked, 2)`

### ค่าเดินทางต่อไซท์
- นิยาม: `travel_cost(site) = COUNT(DISTINCT date WHERE type='site') × distance_km × 2 × travel_rate_per_km`
- คิดเฉพาะวันที่มีงาน `type='site'` (factory ไม่คิด)
- Implement เป็น view ใหม่ `site_travel_cost` หรือคำนวณฝั่ง client — ตัดสินตอนเขียนแผน (เรทมาจาก Settings ต้องส่งเข้าไป ถ้าทำเป็น view ต้องอ่านเรทจากตาราง settings)

## UI Components

### หน้า Assign (รื้อ Assign.jsx)
- **View toggle** Day/Week/Month + date navigation (‹ วันนี้ ›)
- **Month**: matrix ช่าง×วัน (เดิม) — ช่อง split แสดงครึ่งบน-ล่าง, เต็มวันแสดงเต็มช่อง
- **Week**: ช่าง × 7 วัน (จัน–อา, อาทิตย์ disable) — ช่องแบบเดียวกับ Month, คลิกครึ่ง/ช่องเพื่อแก้
- **Day**: การ์ดต่อไซท์ — คอลัมน์ 🌅 เช้า / 🌆 เย็น โชว์ช่าง + ค่าแรง+ค่าเดินทางของวันนั้น
- **Wizard (modal แผงเดียว)** ลำดับ: 
  1. ปฏิทินเลือกหลายวัน (คลิก toggle, อาทิตย์คลิกไม่ได้)
  2. ประเภท: 🏗️ งานไซท์ / 🏭 ผลิตที่โรงงาน (ค่าเริ่ม = งานไซท์)
  3. ไซท์งาน (SearchableSelect)
  4. ช่าง: ติ๊กหลายคน + toggle กะเช้า/เย็นรายคน (default ทั้งคู่)
  5. บันทึก → เช็คชนกะที่มีงานอยู่ → ถ้าชนแจ้ง confirm → เขียนทับ (upsert onConflict `worker_id,date,shift`)
- **คลิกช่องในตาราง**: popup เล็ก — ตั้ง type (site/factory/office/leave/holiday), เปลี่ยนไซท์, OT ของกะนั้น, ลบ
- **ค่าแรงต่อไซท์ (การ์ดล่าง)**: แสดง ค่าแรง + ค่าเดินทาง = รวม

### หน้า Sites (Sites.jsx)
- ฟอร์ม: เพิ่มช่อง "ระยะทางจากโรงงาน (กม.)" และ "ลิงก์ Google Maps"
- ตาราง/การ์ด: ปุ่ม 📍 เปิดแผนที่ (target=_blank) เมื่อมี map_url

### หน้า Settings (Settings.jsx)
- เพิ่มช่อง "ค่าเดินทาง (บาท/กม.)" — แก้แล้วบันทึก

### แก้ popup (#4)
- Modal assign: กว้าง responsive (ไม่ fix 400px) ให้ชื่อไซท์ยาวไม่ล้น
- SearchableSelect: ตัดข้อความยาว ellipsis + tooltip (มีอยู่แล้ว ตรวจซ้ำ)

## ผลกระทบ / ความเสี่ยง
- รันบน DB จริงที่มีข้อมูล — migration ต้อง idempotent/ปลอดภัย, ทดสอบ rollback ได้
- ยอดค่าแรงย้อนหลังไม่เปลี่ยน (migration แตกเช้า+เย็นรักษายอด)
- ตัวเลข "วัน" จะมีทศนิยม .5 ได้หลังจากนี้ (แสดงผลให้รองรับ)
- View `labor_cost_by_site` ถูกใช้โดย Assign + อาจมีที่อื่น — ตรวจ dependency ก่อนแก้
- ค่าเดินทางเริ่มคิดตั้งแต่บัดนี้ ทำให้ต้นทุนต่อไซท์เพิ่ม — เป็นพฤติกรรมที่ตั้งใจ

## นอกขอบเขต (ยังไม่ทำ)
- ไม่ทำ Google Maps ฝังในหน้า (ใช้แค่ลิงก์เปิดแท็บใหม่)
- ไม่ทำ import/export assignment
- ไม่แตะ payroll/salary logic (ยกเว้นถ้ากระทบจาก labor view โดยตรง — ตรวจ)
