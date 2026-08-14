# FACADE X Construction Dashboard

React + Vite SPA บน Vercel + Supabase สำหรับบริหารโครงการก่อสร้าง

---

## 1. Setup Supabase

1. ไปที่ [supabase.com](https://supabase.com) → New Project
2. คัดลอกข้อมูล:
   - **Project URL** → `https://xxxxx.supabase.co`
   - **anon public key** → Settings → API → anon/public key
3. เปิด **SQL Editor** แล้วรัน `supabase/schema.sql` ทั้งไฟล์ (สร้างตาราง, views, triggers ทั้งหมด)
4. ตรวจสอบ Tables ใน Table Editor: `sites`, `expenses`, `incomes`, `workers`, `worker_assignments`, `salary_records`, `expense_categories`
5. (Optional) เปิด Row Level Security (RLS) ถ้าต้องการ auth — ปัจจุบัน app ไม่มี login

---

## 2. Local Development

```bash
# clone หรือ copy โฟลเดอร์ facadex-app ไปไว้ที่ใดก็ได้

cd facadex-app

# สร้างไฟล์ .env จาก template
cp .env.example .env

# แก้ไขค่า
# VITE_SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
# VITE_SUPABASE_ANON_KEY=your_anon_key_here

# ติดตั้ง dependencies
npm install

# รัน dev server
npm run dev
# → http://localhost:3000
```

---

## 3. Deploy บน Vercel

### วิธีที่ 1: Vercel CLI
```bash
npm install -g vercel
npm run build
vercel --prod
```

### วิธีที่ 2: Vercel Dashboard (แนะนำ)
1. Push โค้ดขึ้น GitHub
2. ไปที่ [vercel.com](https://vercel.com) → New Project → Import Git Repository
3. Framework: **Vite** (detect อัตโนมัติ)
4. Environment Variables → เพิ่ม:
   - `VITE_SUPABASE_URL` = URL ของ project
   - `VITE_SUPABASE_ANON_KEY` = anon key
5. Deploy → ได้ URL แบบ `https://facadex-xxx.vercel.app`

---

## 4. โครงสร้างโปรเจค

```
facadex-app/
├── supabase/
│   └── schema.sql          ← รัน 1 ครั้งใน Supabase SQL Editor
├── src/
│   ├── lib/
│   │   └── supabase.js     ← Supabase client + helper functions
│   ├── hooks/
│   │   └── useSupabase.js  ← Custom hooks ทุกหน้า
│   ├── components/
│   │   ├── Modal.jsx       ← Modal + ConfirmDialog
│   │   └── ExcelUpload.jsx ← Drag-drop Excel import
│   ├── pages/
│   │   ├── Dashboard.jsx   ← ภาพรวม, KPI, chart, ตาราง ongoing
│   │   ├── Sites.jsx       ← ไซท์งาน CRUD
│   │   ├── Expenses.jsx    ← รายจ่าย + import Excel
│   │   ├── Income.jsx      ← รายรับ + import Excel
│   │   ├── Assign.jsx      ← Assign ช่าง + labor cost
│   │   ├── Payroll.jsx     ← เงินเดือน รายเดือน
│   │   └── Categories.jsx  ← หมวดค่าใช้จ่าย
│   ├── App.jsx             ← Tab router
│   ├── main.jsx
│   └── index.css           ← Dark theme CSS
├── .env.example
├── package.json
├── vite.config.js
└── index.html
```

---

## 5. Excel Templates

อยู่ในโฟลเดอร์ `FINANCIAL PLANNING/`:
- `TEMPLATE_รายจ่าย.xlsx` — สำหรับ import รายจ่าย (หน้า Expenses)
- `TEMPLATE_รายรับ.xlsx` — สำหรับ import รายรับ (หน้า Income)

**วิธีใช้:**
1. Download template → กรอกข้อมูล
2. ในแอป → หน้า Expenses หรือ Income → กด "Import Excel"
3. Drag & Drop ไฟล์ → ตรวจสอบ preview → กด "นำเข้า"

**ข้อควรระวัง:**
- รหัสไซท์งาน (column "รหัสไซท์งาน") ต้องตรงกับ site_number ในระบบ (เช่น FX-2026-001)
- ถ้าไซท์หรือหมวดไม่พบ จะแสดง ⚠️ ใน preview ก่อน insert

---

## 6. Database Schema

### Tables
| ตาราง | ใช้ทำอะไร |
|---|---|
| `sites` | ข้อมูลไซท์งาน (site_number auto FX-YYYY-NNN) |
| `expenses` | รายจ่าย |
| `incomes` | รายรับ (invoice_no auto IVYYMM-NNN) |
| `workers` | ข้อมูลช่าง/พนักงาน |
| `worker_assignments` | การ assign ช่างเข้าไซท์รายวัน |
| `salary_records` | บันทึกเงินเดือนรายเดือน |
| `expense_categories` | หมวดค่าใช้จ่าย |

### Views
| View | ใช้ใน |
|---|---|
| `site_financial_summary` | Dashboard, Sites — รวม income/expense/profit ต่อไซท์ |
| `expenses_view` | Expenses — join ชื่อไซท์ + หมวด |
| `incomes_view` | Income — join ชื่อไซท์ |
| `payment_forecast` | Dashboard — ยอดที่ต้องชำระรายเดือน |
| `labor_cost_by_site` | Assign — ค่าแรงช่างต่อไซท์ |
| `workers_with_rate` | Assign — worker + daily_rate (salary/26) |

⚠️ **`supabase/schema.sql` ไม่ครบ** — ปัจจุบันขาด 9 ตารางที่มีอยู่จริงในฐานข้อมูล production: `user_roles` (auth/role), `clients`, `suppliers`, `labor_subcontractors`, `labor_contracts`, `labor_payments`, `audit_logs`, `site_phases`, `calendar_sync` — รวมถึง trigger ที่ auto-insert แถว `user_roles` ตอนสมัครสมาชิกใหม่ก็ไม่ได้อยู่ในไฟล์นี้ด้วย. **ห้ามใช้ `schema.sql` เป็นแหล่งความจริงเพียงอย่างเดียวเวลาขึ้นระบบใหม่** — ดูหัวข้อ 7 ด้านล่างว่าควรทำยังไง

---

## 7. Starter Guide: ขึ้นระบบใหม่แบบ Clean Start (ให้บริษัทอื่น)

### 7.1 สถาปัตยกรรมที่ต้องเข้าใจก่อนเริ่ม

ระบบนี้เป็นแบบ **single-tenant** — ไม่มีคอลัมน์ `company_id`/`tenant_id` ในตารางไหนเลย และ **ไม่ได้เปิด Row Level Security (RLS)** เกือบทุกตาราง (18 จาก 19 ตาราง ณ ตอนที่เขียนนี้ — เปิดอยู่แค่ `user_roles`) ผลคือ:

- **ห้ามเอาบริษัทอื่นมาแชร์ Supabase project เดียวกับ FacadeX เด็ดขาด** ข้อมูลจะปนกันหมด ไม่มีกลไกกันเห็นข้อมูลข้ามบริษัทในระดับฐานข้อมูล
- **1 บริษัท = 1 Supabase project + 1 การ deploy แยกกันชัดเจน** (คนละ `.env`, คนละโดเมน/URL, คนละ build)
- ⚠️ **ช่องโหว่ความปลอดภัยที่มีอยู่ตอนนี้**: `VITE_SUPABASE_ANON_KEY` ฝังอยู่ใน JS bundle ที่ใครก็ดึงออกมาดูได้ (เปิด DevTools → Network ก็เห็น) เมื่อ RLS ปิดอยู่ ใครก็ตามที่มี anon key นี้สามารถอ่าน/เขียนข้อมูลได้เกือบทุกตารางโดยตรงผ่าน Supabase REST API — **ข้ามการเช็ค role ของแอปไปเลย** (role-check ที่มีอยู่ตอนนี้เป็นแค่ระดับ UI เท่านั้น ไม่ใช่ระดับฐานข้อมูล) ต้องแก้ก่อนขึ้น production จริงกับข้อมูลสำคัญ โดยเฉพาะถ้าจะเอาไปให้บริษัทอื่นใช้ (ดูหัวข้อ 8)

### 7.2 Checklist ทีละขั้น

1. **สร้าง Supabase project ใหม่** ที่ [supabase.com](https://supabase.com)

2. **Schema** — อย่ารัน `supabase/schema.sql` แล้วคิดว่าจบ (ไฟล์นี้ขาด 9 ตารางตามที่เตือนไว้ด้านบน) เลือกทำอย่างใดอย่างหนึ่ง:
   - **แนะนำ**: dump schema จริงจาก Supabase project ที่ใช้งานอยู่ตอนนี้ (`supabase db dump --schema public` ผ่าน Supabase CLI หรือ Dashboard → Database → Backups) แล้วเอาไปรันใน project ใหม่ — แม่นยำที่สุดเพราะดึงจากของจริง
   - หรือให้ Claude ช่วย diff schema จริงกับ `schema.sql` แล้วอัปเดตไฟล์ให้ครบก่อน ค่อยใช้ไฟล์นั้นขึ้นระบบใหม่

3. **Auth** — เปิด Email provider ที่ Supabase Dashboard → Authentication → Providers จากนั้นสมัคร user คนแรกผ่านหน้า Signup ของแอป แล้ว **ต้อง promote ตัวเองเป็น OWNER ผ่าน SQL Editor** (หน้า User Management ในแอปต้องเป็น OWNER ถึงจะเข้าได้ — user คนแรกจึงเข้าไม่ได้ด้วยตัวเอง):
   ```sql
   UPDATE user_roles SET role = 'OWNER' WHERE user_email = 'you@example.com';
   ```

4. **`.env`** — คัดลอกจาก `.env.example` แล้วใส่ URL/anon key ของ project ใหม่

5. **Rebrand** — จุดที่ต้องแก้ชื่อ "FACADE X" / "FX":
   - `index.html` → `<title>`
   - `src/App.jsx`, `src/pages/Login.jsx` → ข้อความ "FACADE X" ในหน้า UI
   - ฟังก์ชัน `generate_site_number()` ในฐานข้อมูล → prefix `'FX-'` เปลี่ยนเป็นตัวย่อบริษัทใหม่ (เช่น `'ABC-'`) — ส่วน prefix อื่น (`CL-` ลูกค้า, `SP-` ซัพพลายเออร์, `LC-` ผู้รับเหมาช่วง, `IV` ใบแจ้งหนี้) เป็นตัวย่อ generic อยู่แล้ว ไม่ต้องแก้ก็ได้

6. **Seed data** — `expense_categories` (12 หมวดปัจจุบันเป็นของ FacadeX เอง) ต้องปรับให้ตรงกับธุรกิจใหม่; `app_settings` (`travel_rate_per_km`, `holiday_pay_multiplier`) มี default seed มาให้จาก schema แต่ควรรีวิวให้ตรงกับเรทจริงของบริษัทใหม่ก่อนใช้งาน

7. **Deploy** — `npm run build` แล้ว zip โฟลเดอร์ `dist/` (วิธีที่ใช้งานจริงตอนนี้ ผ่าน cPanel) หรือ deploy ผ่าน Vercel ตามหัวข้อ 3 ด้านบนก็ได้

8. **ก่อนขึ้น production จริงกับข้อมูลสำคัญ**: ปิดช่องโหว่ RLS — เปิด RLS แล้วเขียน policy ให้ครบทุกตาราง (⚠️ เปิด RLS เฉยๆ โดยไม่มี policy จะ block การอ่าน/เขียนทั้งหมดทันที ต้องวางแผน policy ก่อนเปิด ไม่ใช่เปิดมั่ว)

---

## 8. ถ้าจะเอาระบบนี้ไปขาย/ให้บริการผู้รับเหมาบริษัทอื่น — หลักคิดเรื่องราคา

### รูปแบบธุรกิจที่เหมาะกับสถาปัตยกรรมนี้

เพราะระบบเป็น single-tenant (1 Supabase project ต่อ 1 บริษัท ไม่ใช่ multi-tenant SaaS ที่ต้นทุนต่อลูกค้าใหม่ใกล้ 0) รูปแบบที่ตรงกับความเป็นจริงที่สุดคือ **"managed instance" แบบ agency/boutique** ไม่ใช่ SaaS self-serve สมัครแล้วใช้ได้ทันที มี 3 แนวทางหลัก:

1. **Setup fee + Subscription รายเดือน/ปี (แนะนำที่สุด)** — ค่า setup ครั้งแรกคุ้ม effort การขึ้นระบบ (schema, rebrand, ย้ายข้อมูลเก่า, สอนใช้งาน) บวกค่าสมาชิกรายเดือน/ปีคุ้ม hosting + support + อัปเดตฟีเจอร์ต่อเนื่อง โมเดลนี้ยั่งยืนที่สุดเพราะมี recurring revenue และผูกลูกค้าไว้กับการดูแลของเรา
2. **ขายขาดครั้งเดียว + Support แยก** — ลูกค้า host/ดูแล Supabase + เว็บเอง เราขายแค่ตัวระบบ + ติดตั้งครั้งแรก แล้วขาย support contract แยกถ้าต้องการ รายได้ recurring น้อยกว่าแบบแรก แต่ภาระผูกพันเราก็น้อยกว่า เหมาะกับลูกค้าที่มีทีม IT เอง
3. **Revenue-share / % จากงานที่บริหารผ่านระบบ** — ไม่แนะนำ ตรวจสอบยาก และไม่เข้ากับธรรมชาติของ internal tool แบบนี้

### ตั้งราคายังไง — กรอบคิด ไม่ใช่ตัวเลขตายตัว

- **ราคาพื้น (cost floor)** = ต้นทุนจริงที่ต้องจ่าย: Supabase (free tier พอสำหรับบริษัทเล็ก ถ้าข้อมูล/การเชื่อมต่อพร้อมกันเยอะขึ้นต้องอัปเป็น Pro ~$25/เดือน/project) + hosting (cPanel/Vercel ต้นทุนแทบไม่มี) + เวลาที่เราต้องเสีย setup และดูแลต่อ 1 ลูกค้า
- **ราคาเพดาน (value ceiling)** = สิ่งที่ลูกค้าประหยัดได้จริง — ถามลูกค้าว่าตอนนี้เสียเวลา/จ้างใครทำอะไรอยู่ (บัญชีคีย์มือ, ความผิดพลาดจาก Excel, จ่ายเงินเดือนช้า) แล้วตีมูลค่าตรงนั้นเป็นฐานราคา ไม่ใช่ตั้งราคาจาก "โค้ดกี่บรรทัด" หรือเวลาที่เราใช้เขียนโค้ด
- ราคาควรผูกกับขนาดธุรกิจลูกค้า (จำนวนไซท์งาน/ช่างที่บริหาร) เพราะ value ที่ลูกค้าได้จะโตตามขนาดธุรกิจเขา แม้ต้นทุนฝั่งเราแทบไม่โตตาม — นี่คือช่องว่างที่ทำกำไรได้

### ก่อนขายให้บริษัทอื่นจริงจัง ต้องปิดช่องว่างพวกนี้ก่อน

ความเสี่ยงพวกนี้พอยอมรับได้ตอนใช้ภายในบริษัทตัวเองที่ควบคุมได้ แต่รับไม่ได้ถ้าเป็นลูกค้าจ่ายเงินที่เอาข้อมูลการเงิน/เงินเดือนจริงมาฝาก:

- **ปิดช่องโหว่ RLS** (หัวข้อ 7.1) — ข้อมูลการเงิน/เงินเดือนของลูกค้าเปิดผ่าน anon key ให้ใครก็อ่านได้ไม่ได้เด็ดขาดถ้าเป็น production จริงของคนอื่น เป็นความเสี่ยงทางกฎหมายและความน่าเชื่อถือธุรกิจโดยตรง
- **`schema.sql` ต้องแม่นและครบ** จะได้ onboard ลูกค้าใหม่แต่ละรายได้เร็วและซ้ำได้ ไม่ต้องนั่งไล่หาว่าขาดตารางอะไรทุกครั้ง
- **ยังไม่มี automated test** — ถ้าต้องดูแลหลาย instance พร้อมกัน (หลายลูกค้า) ความเสี่ยง regression กระทบลูกค้าหลายรายพร้อมกันจะสูงขึ้นตามจำนวนลูกค้าที่ดูแล
