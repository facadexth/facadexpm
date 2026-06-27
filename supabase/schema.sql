-- ================================================================
-- FACADE X — Supabase Database Schema
-- Run this in: Supabase Dashboard > SQL Editor > New Query
-- ================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------
-- SITES — ไซท์งานทั้งหมด
-- ----------------------------------------------------------------
CREATE TABLE sites (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  site_number   TEXT UNIQUE NOT NULL,          -- AUTO: FX-2026-001
  name          TEXT NOT NULL,
  note          TEXT,                           -- ชื่อย่อ / หมายเหตุ
  status        TEXT DEFAULT 'Ongoing'
                CHECK (status IN ('Ongoing','Finished','On Hold')),
  start_date    DATE,
  end_date      DATE,
  contract_value DECIMAL(15,2) DEFAULT 0,       -- มูลค่างานรวม

  -- แผนต้นทุน (plan_type = 'value' หรือ 'percent')
  plan_type     TEXT DEFAULT 'value' CHECK (plan_type IN ('value','percent')),
  plan_aluminum  DECIMAL(15,2) DEFAULT 0,       -- ค่าอลูมิเนียม/เหล็ก
  plan_glass     DECIMAL(15,2) DEFAULT 0,       -- ค่ากระจก
  plan_equipment DECIMAL(15,2) DEFAULT 0,       -- ค่าอุปกรณ์
  plan_rubber    DECIMAL(15,2) DEFAULT 0,       -- ยางและซิลิโคน
  plan_labor     DECIMAL(15,2) DEFAULT 0,       -- ค่าแรง (sub-contract)

  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-generate site_number: FX-YYYY-NNN
CREATE OR REPLACE FUNCTION generate_site_number()
RETURNS TRIGGER AS $$
DECLARE
  year_part TEXT := TO_CHAR(NOW(), 'YYYY');
  seq_num   INT;
BEGIN
  SELECT COUNT(*) + 1 INTO seq_num
  FROM sites
  WHERE site_number LIKE 'FX-' || year_part || '-%';
  NEW.site_number := 'FX-' || year_part || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_site_number
  BEFORE INSERT ON sites
  FOR EACH ROW
  WHEN (NEW.site_number IS NULL OR NEW.site_number = '')
  EXECUTE FUNCTION generate_site_number();


-- ----------------------------------------------------------------
-- EXPENSE_CATEGORIES — หมวดค่าใช้จ่าย (แก้ไข/เพิ่ม/ลบได้)
-- ----------------------------------------------------------------
CREATE TABLE expense_categories (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  color      TEXT DEFAULT '#6c63ff',
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Default categories
INSERT INTO expense_categories (name, color, sort_order) VALUES
  ('ค่ากระจก',             '#4ecdc4', 1),
  ('ค่าอลูมิเนียม/เหล็ก', '#6c63ff', 2),
  ('ค่าอุปกรณ์',           '#ffd166', 3),
  ('ค่าแรง/เงินเดือน',    '#ff6b6b', 4),
  ('ค่าซิลิโคน/ยาง',      '#a29bfe', 5),
  ('ค่าใช้จ่ายสำนักงาน',  '#74b9ff', 6),
  ('เบ็ดเตล็ด',            '#9e9ec8', 7),
  ('ค่าของ',               '#fd79a8', 8);


-- ----------------------------------------------------------------
-- EXPENSES — รายจ่าย
-- ----------------------------------------------------------------
CREATE TABLE expenses (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  date            DATE NOT NULL,                -- วันที่สั่งซื้อ/วางบิล
  description     TEXT,                         -- รายละเอียด
  site_id         UUID REFERENCES sites(id) ON DELETE SET NULL,
  category_id     UUID REFERENCES expense_categories(id) ON DELETE SET NULL,
  supplier        TEXT,                         -- บริษัทผู้จำหน่าย
  amount          DECIMAL(15,2) NOT NULL DEFAULT 0, -- มูลค่า (รวม VAT)

  -- การชำระเงิน
  payment_method  TEXT DEFAULT 'transfer'
                  CHECK (payment_method IN ('transfer','check','cash')),
  check_date      DATE,                         -- วันที่ชำระ/วันที่บนเช็ค
  status          TEXT DEFAULT 'pending'
                  CHECK (status IN ('paid','pending','check_issued','check_cleared')),
  payer           TEXT,                         -- ผู้จ่าย
  invoice_no      TEXT,                         -- เลขที่ใบกำกับ
  notes           TEXT,

  -- Sub-contract labor tracking
  is_subcontract  BOOLEAN DEFAULT FALSE,        -- TRUE = ค่าแรงช่างภายนอก

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);


-- ----------------------------------------------------------------
-- INCOMES — รายรับ
-- ----------------------------------------------------------------
CREATE TABLE incomes (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  invoice_no      TEXT,                         -- เลขที่ใบแจ้งหนี้ (auto ถ้าเว้นว่าง)
  date            DATE NOT NULL,                -- วันที่รับเงิน
  site_id         UUID REFERENCES sites(id) ON DELETE SET NULL,
  client_name     TEXT,                         -- ชื่อลูกค้า/บริษัท
  description     TEXT,                         -- รายละเอียด/งวดที่เบิก
  amount_no_vat   DECIMAL(15,2) DEFAULT 0,      -- มูลค่าก่อน VAT
  vat             DECIMAL(15,2) DEFAULT 0,      -- VAT
  tax_withheld    DECIMAL(15,2) DEFAULT 0,      -- ภาษีถูกหัก ณ ที่จ่าย
  retention       DECIMAL(15,2) DEFAULT 0,      -- เงิน retention
  received_amount DECIMAL(15,2) DEFAULT 0,      -- ยอดที่ได้รับจริง

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-generate invoice_no: IV-YYMM-NNN
CREATE OR REPLACE FUNCTION generate_invoice_no()
RETURNS TRIGGER AS $$
DECLARE
  prefix TEXT := 'IV' || TO_CHAR(NOW(), 'YYMM') || '-';
  seq_num INT;
BEGIN
  IF NEW.invoice_no IS NULL OR NEW.invoice_no = '' THEN
    SELECT COUNT(*) + 1 INTO seq_num
    FROM incomes WHERE invoice_no LIKE prefix || '%';
    NEW.invoice_no := prefix || LPAD(seq_num::TEXT, 3, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoice_no
  BEFORE INSERT ON incomes
  FOR EACH ROW EXECUTE FUNCTION generate_invoice_no();


-- ----------------------------------------------------------------
-- WORKERS — ช่างและพนักงาน
-- ----------------------------------------------------------------
CREATE TABLE workers (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name                  TEXT NOT NULL,
  nickname              TEXT,
  position              TEXT,                   -- ตำแหน่ง: หัวหน้าช่าง, ช่างฝีมือ, ฯลฯ
  monthly_salary        DECIMAL(15,2) DEFAULT 0,
  -- daily_rate คำนวณจาก monthly_salary / 26 (วันทำงานต่อเดือน)
  has_social_security   BOOLEAN DEFAULT TRUE,
  annual_leave_days     INT DEFAULT 6,           -- วันลาที่ได้รับต่อปี
  monthly_contribution  DECIMAL(15,2) DEFAULT 0, -- เงินสมทบ
  status                TEXT DEFAULT 'active'
                        CHECK (status IN ('active','inactive')),
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Computed view for daily rate
CREATE OR REPLACE VIEW workers_with_rate AS
SELECT *,
  ROUND(monthly_salary / 26, 2) AS daily_rate,
  ROUND(monthly_salary * 0.05 / 100 * 750, 0) AS social_security_amount
FROM workers;


-- ----------------------------------------------------------------
-- WORKER_ASSIGNMENTS — Assign ช่างรายวัน
-- ----------------------------------------------------------------
CREATE TABLE worker_assignments (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  worker_id   UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  site_id     UUID REFERENCES sites(id) ON DELETE SET NULL,
  date        DATE NOT NULL,
  -- type: site = ทำงานที่ไซท์, leave = ลา, office = งานออฟฟิศ, holiday = หยุด
  type        TEXT DEFAULT 'site'
              CHECK (type IN ('site','leave','office','holiday','subcontract')),
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (worker_id, date)  -- 1 คน 1 วัน 1 assignment
);


-- ----------------------------------------------------------------
-- SALARY_RECORDS — เงินเดือนรายเดือน
-- ----------------------------------------------------------------
CREATE TABLE salary_records (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  worker_id             UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  month                 INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  year                  INT NOT NULL,
  base_salary           DECIMAL(15,2) DEFAULT 0,
  contribution          DECIMAL(15,2) DEFAULT 0,  -- เงินสมทบ
  phone_allowance       DECIMAL(15,2) DEFAULT 0,
  ot_amount             DECIMAL(15,2) DEFAULT 0,
  special_allowance     DECIMAL(15,2) DEFAULT 0,  -- เงินพิเศษ/ค่าจอดรถ
  advance_deduction     DECIMAL(15,2) DEFAULT 0,  -- เบิกล่วงหน้า
  social_security_ded   DECIMAL(15,2) DEFAULT 0,  -- ประกันสังคม
  leave_deduction       DECIMAL(15,2) DEFAULT 0,  -- หักวันลา
  loan_deduction        DECIMAL(15,2) DEFAULT 0,  -- หักเงินกู้
  net_pay               DECIMAL(15,2) DEFAULT 0,
  paid_date             DATE,
  notes                 TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (worker_id, month, year)
);


-- ----------------------------------------------------------------
-- VIEWS — สำหรับ Dashboard
-- ----------------------------------------------------------------

-- รายจ่ายพร้อมชื่อไซท์และหมวด
CREATE OR REPLACE VIEW expenses_view AS
SELECT
  e.*,
  s.name        AS site_name,
  s.site_number AS site_number,
  s.status      AS site_status,
  ec.name       AS category_name,
  ec.color      AS category_color
FROM expenses e
LEFT JOIN sites s ON e.site_id = s.id
LEFT JOIN expense_categories ec ON e.category_id = ec.id;

-- รายรับพร้อมชื่อไซท์
CREATE OR REPLACE VIEW incomes_view AS
SELECT
  i.*,
  s.name        AS site_name,
  s.site_number AS site_number
FROM incomes i
LEFT JOIN sites s ON i.site_id = s.id;

-- สรุปต้นทุนและรายรับต่อไซท์
CREATE OR REPLACE VIEW site_financial_summary AS
SELECT
  s.id,
  s.site_number,
  s.name,
  s.status,
  s.start_date,
  s.end_date,
  s.contract_value,
  COALESCE(SUM(e.amount), 0)          AS total_expense,
  COALESCE(SUM(i.received_amount), 0) AS total_income,
  COALESCE(SUM(i.received_amount), 0) - COALESCE(SUM(e.amount), 0) AS gross_profit,
  CASE WHEN s.contract_value > 0
    THEN ROUND(COALESCE(SUM(i.received_amount), 0) / s.contract_value * 100, 1)
    ELSE NULL
  END AS billing_pct,
  -- ยอดค้างจ่าย (pending + check_issued)
  COALESCE(SUM(CASE WHEN e.status IN ('pending','check_issued') THEN e.amount ELSE 0 END), 0) AS outstanding_expense
FROM sites s
LEFT JOIN expenses e ON e.site_id = s.id
LEFT JOIN incomes i ON i.site_id = s.id
GROUP BY s.id, s.site_number, s.name, s.status, s.start_date, s.end_date, s.contract_value;

-- ยอดที่ต้องชำระตามช่วงเวลา (สำหรับ Dashboard cash forecast)
CREATE OR REPLACE VIEW payment_forecast AS
SELECT
  DATE_TRUNC('month', COALESCE(check_date, date)) AS forecast_month,
  SUM(amount)                                      AS total_due,
  COUNT(*)                                         AS invoice_count,
  payment_method,
  status
FROM expenses
WHERE status IN ('pending','check_issued')
GROUP BY 1, 4, 5
ORDER BY 1;

-- ค่าแรงช่างต่อไซท์ (จาก assignments × daily_rate)
CREATE OR REPLACE VIEW labor_cost_by_site AS
SELECT
  wa.site_id,
  s.name        AS site_name,
  s.site_number,
  wa.worker_id,
  w.name        AS worker_name,
  w.nickname,
  COUNT(*)      AS days_worked,
  ROUND(w.monthly_salary / 26 * COUNT(*), 2) AS labor_cost
FROM worker_assignments wa
JOIN workers w ON wa.worker_id = w.id
JOIN sites s ON wa.site_id = s.id
WHERE wa.type = 'site'
GROUP BY wa.site_id, s.name, s.site_number, wa.worker_id, w.name, w.nickname, w.monthly_salary;


-- ----------------------------------------------------------------
-- ROW LEVEL SECURITY (เปิดเมื่อใช้ Supabase Auth)
-- ----------------------------------------------------------------
-- ALTER TABLE sites         ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE expenses      ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE incomes       ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE workers       ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE worker_assignments ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE salary_records     ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE expense_categories ENABLE ROW LEVEL SECURITY;
-- (เพิ่ม policies ตาม use case: anon read / authenticated full access)


-- ----------------------------------------------------------------
-- INDEXES — เพิ่ม performance
-- ----------------------------------------------------------------
CREATE INDEX idx_expenses_site_id    ON expenses(site_id);
CREATE INDEX idx_expenses_date       ON expenses(date);
CREATE INDEX idx_expenses_status     ON expenses(status);
CREATE INDEX idx_expenses_check_date ON expenses(check_date);
CREATE INDEX idx_incomes_site_id     ON incomes(site_id);
CREATE INDEX idx_incomes_date        ON incomes(date);
CREATE INDEX idx_assignments_worker  ON worker_assignments(worker_id);
CREATE INDEX idx_assignments_site    ON worker_assignments(site_id);
CREATE INDEX idx_assignments_date    ON worker_assignments(date);
