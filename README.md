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
