# Labor Subcontractor, HR Tab & Audit Log — Design Spec

## Scope

3 subsystems delivered together:

1. **Tab Restructure** — ย้าย worker management ออกจาก Assign → tab ใหม่ชื่อ HR
2. **ผู้รับเหมาค่าแรง** — track สัญญา + เบิกเงิน + retention + PDF
3. **Audit Log** — บันทึกว่าใครแก้อะไร เมื่อไหร่

---

## 1. Tab Restructure

### ก่อน
- Assign — Assign งาน + Worker management (เพิ่ม/แก้/ลบช่าง)
- เงินเดือน — salary records

### หลัง
- **Assign** — เหลือแค่ assignment matrix + เพิ่ม assignment
- **HR** (แทน เงินเดือน) — worker management + salary records + leave balance
- **ผู้รับเหมาค่าแรง** — tab ใหม่

### Files ที่ต้องแก้
- `App.jsx` — เปลี่ยน label + เพิ่ม tab
- `Assign.jsx` — ลบ WorkerForm + worker table section
- `src/pages/HR.jsx` — ใหม่: รวม worker management + payroll + leave balance
- `src/pages/LaborContractors.jsx` — ใหม่

---

## 2. ผู้รับเหมาค่าแรง

### Database Schema

```sql
-- Master list
CREATE TABLE labor_subcontractors (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  subcontractor_number TEXT UNIQUE NOT NULL DEFAULT '',  -- AUTO: LC-YYYY-NNN
  name                TEXT NOT NULL,
  contact_person      TEXT,
  phone               TEXT,
  email               TEXT,
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Trigger: auto LC-YYYY-NNN
CREATE FUNCTION generate_subcontractor_number() ...

-- สัญญา (subcontractor × site, unique pair)
CREATE TABLE labor_contracts (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  subcontractor_id    UUID NOT NULL REFERENCES labor_subcontractors(id) ON DELETE RESTRICT,
  site_id             UUID NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  work_description    TEXT NOT NULL,    -- ประเภทงาน เช่น ติดตั้งอลูมิเนียม
  contract_amount     DECIMAL(15,2) NOT NULL,
  retention_pct       DECIMAL(5,2) DEFAULT 5,
  withholding_tax_pct DECIMAL(5,2) DEFAULT 3,
  site_note           TEXT,             -- หมายเหตุเฉพาะงานนี้
  status              TEXT DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')),
  start_date          DATE,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (subcontractor_id, site_id)
);

-- การเบิกเงิน
CREATE TABLE labor_payments (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contract_id         UUID NOT NULL REFERENCES labor_contracts(id) ON DELETE RESTRICT,
  payment_number      TEXT UNIQUE NOT NULL DEFAULT '',  -- AUTO: PY-YYYYMM-NNN
  payment_date        DATE NOT NULL,
  work_description    TEXT,            -- รายละเอียดงวด
  progress_pct        DECIMAL(5,2),   -- % สะสมรวม ณ วันเบิก
  gross_amount        DECIMAL(15,2) NOT NULL,
  withholding_tax     DECIMAL(15,2) DEFAULT 0,   -- gross × 3%
  retention_amount    DECIMAL(15,2) DEFAULT 0,   -- gross × 5% (ถ้าอยู่ใน period)
  net_amount          DECIMAL(15,2) NOT NULL,    -- gross - withholding - retention = ยอดโอน
  is_retention_release BOOLEAN DEFAULT FALSE,    -- TRUE = การเบิกคืนประกันผลงาน
  status              TEXT DEFAULT 'pending' CHECK (status IN ('pending','paid')),
  paid_date           DATE,
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Auto PY-YYYYMM-NNN trigger
CREATE FUNCTION generate_payment_number() ...
```

### Retention Logic

```
retention ถูกหักทุกงวดตลอดโครงการ และ 6 เดือนหลังไซท์จบ

is_in_retention_period = 
  site.end_date IS NULL  -- ไซท์ยังไม่จบ
  OR 
  today < site.end_date + INTERVAL '6 months'

retention_amount = 
  IF is_in_retention_period THEN gross × retention_pct
  ELSE 0

net_amount = gross - withholding_tax - retention_amount
```

### View: labor_contract_summary

```sql
CREATE VIEW labor_contract_summary AS
SELECT
  lc.*,
  ls.name AS subcontractor_name, ls.subcontractor_number,
  s.name AS site_name, s.site_number, s.status AS site_status,
  s.end_date AS site_end_date,
  s.contract_value AS site_contract_value,
  -- Progress comparison
  COALESCE(SUM(lp.gross_amount) FILTER (WHERE NOT lp.is_retention_release), 0) AS total_paid_gross,
  COALESCE(SUM(lp.retention_amount) FILTER (WHERE NOT lp.is_retention_release), 0) AS total_retention_held,
  COALESCE(SUM(lp.net_amount) FILTER (WHERE NOT lp.is_retention_release), 0) AS total_paid_net,
  CASE WHEN lc.contract_amount > 0
    THEN ROUND(SUM(lp.gross_amount) FILTER (WHERE NOT lp.is_retention_release) / lc.contract_amount * 100, 1)
    ELSE 0 END AS contractor_billing_pct,
  -- Retention release date
  s.end_date + INTERVAL '6 months' AS retention_release_date,
  s.end_date IS NOT NULL AND NOW() >= s.end_date + INTERVAL '6 months' AS retention_releasable
FROM labor_contracts lc
JOIN labor_subcontractors ls ON lc.subcontractor_id = ls.id
JOIN sites s ON lc.site_id = s.id
LEFT JOIN labor_payments lp ON lp.contract_id = lc.id
GROUP BY lc.id, ls.name, ls.subcontractor_number,
  s.name, s.site_number, s.status, s.end_date, s.contract_value;
```

### UI: LaborContractors.jsx

```
Tab: ผู้รับเหมาค่าแรง
├── Sub-tab 1: ผู้รับเหมา
│   ├── CRUD: LC-YYYY-NNN | ชื่อ | ผู้ติดต่อ | โทร | อีเมล
│   └── Search + Add/Edit/Delete
│
├── Sub-tab 2: สัญญา
│   ├── Filter: ไซท์ / ผู้รับเหมา / สถานะ
│   ├── Card per contract:
│   │   ├── LC-NNN · ชื่อ → ไซท์ · ประเภทงาน
│   │   ├── Progress bar: % เบิกของเรา (ผู้รับเหมา) vs % ไซท์ (เรา → ลูกค้า)
│   │   ├── มูลค่าสัญญา | จ่ายแล้ว | คงเหลือ | ประกันค้างอยู่
│   │   ├── Badge: 🔴 retention ครบกำหนดคืน (ถ้า releasable)
│   │   └── ปุ่ม: เบิกเงิน | คืนประกัน (ถ้า releasable) | แก้ไข
│   └── ปุ่ม: + เพิ่มสัญญา
│
└── Sub-tab 3: การเบิก
    ├── Filter: ไซท์ / ผู้รับเหมา / สถานะ / ช่วงวันที่
    ├── ตาราง: PY-NNN | ผู้รับเหมา | ไซท์ | งวด | % สะสม
    │         | ยอดเบิก | หักภาษี | หักประกัน | ยอดโอน | สถานะ
    └── คลิกแถว → preview + ปุ่ม Download PDF
```

### Payment Form Modal → PDF

```
ขั้นตอน: กดเบิก → กรอก form → preview → confirm → บันทึก + download PDF

Form fields:
- รายละเอียดงวด, progress_pct (สะสม), gross_amount
- withholding_tax (auto = gross × 3%, แก้ได้)
- retention_amount (auto คำนวณตาม period, แก้ได้)
- net_amount (auto = gross - tax - retention)
- paid_date, notes

PDF layout:
┌─────────────────────────────────────────┐
│  FACADE X — ใบเบิกเงินผู้รับเหมาค่าแรง  │
│  เลขที่: PY-202606-001   วันที่: xx/xx  │
├─────────────────────────────────────────┤
│  ผู้รับเหมา: xxx    LC-2026-001         │
│  ไซท์งาน:   xxx    FX-2026-001         │
│  ประเภทงาน: ติดตั้งอลูมิเนียม           │
│  Progress สะสม: 60%                     │
├─────────────────────────────────────────┤
│  ยอดเบิกครั้งนี้:          300,000.00  │
│  หักภาษี ณ ที่จ่าย (3%):    (9,000.00) │
│  หักประกันผลงาน (5%):      (15,000.00) │
│  ────────────────────────────────────  │
│  ยอดโอน:                  276,000.00  │
├─────────────────────────────────────────┤
│  ยอดสัญญา:              1,000,000.00  │
│  เบิกสะสม (gross):         300,000.00  │
│  คงเหลือ:                 700,000.00  │
│  ประกันผลงานค้างอยู่:       15,000.00  │
├─────────────────────────────────────────┤
│  ลายเซ็นผู้รับเหมา    ลายเซ็นผู้อนุมัติ│
└─────────────────────────────────────────┘

Library: jsPDF (npm install jspdf)
```

---

## 3. Audit Log

### Database Schema

```sql
CREATE TABLE audit_logs (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  table_name  TEXT NOT NULL,
  record_id   UUID,
  action      TEXT NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
  user_email  TEXT,
  changed_at  TIMESTAMPTZ DEFAULT NOW(),
  old_values  JSONB,
  new_values  JSONB
);
CREATE INDEX idx_audit_table ON audit_logs(table_name);
CREATE INDEX idx_audit_record ON audit_logs(record_id);
CREATE INDEX idx_audit_time ON audit_logs(changed_at DESC);
```

### Implementation: Frontend logging

ทุก mutation (insert/update/delete) เพิ่ม log call:
```js
async function auditLog(table, recordId, action, oldValues, newValues) {
  const { data: { session } } = await supabase.auth.getSession()
  await supabase.from('audit_logs').insert({
    table_name: table, record_id: recordId, action,
    user_email: session?.user?.email,
    old_values: oldValues || null,
    new_values: newValues || null,
  })
}
```

Tables ที่ track: sites, expenses, incomes, labor_contracts, labor_payments, workers, salary_records

### UI: Log viewer

อยู่ใน tab HR → section "ประวัติการแก้ไข"
- Filter: table / user / วันที่
- แสดง: เวลา | ผู้ใช้ | ตาราง | action | สิ่งที่เปลี่ยน

---

## Tech Stack เพิ่มเติม
- `jspdf` — PDF generation
- Supabase existing client

## Files Summary

| Action | File |
|--------|------|
| Create | `src/pages/LaborContractors.jsx` |
| Create | `src/pages/HR.jsx` |
| Create | `src/lib/audit.js` |
| Create | `src/lib/pdf.js` |
| Modify | `src/App.jsx` |
| Modify | `src/pages/Assign.jsx` |
| Modify | `src/hooks/useSupabase.js` |
| DB | labor_subcontractors, labor_contracts, labor_payments, audit_logs tables + views |
