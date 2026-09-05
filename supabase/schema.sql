-- ================================================================
-- FACADE X — Supabase Database Schema
-- Run this in: Supabase Dashboard > SQL Editor > New Query
--
-- Regenerated 2026-08-15 directly from the live production database
-- (yyzbgdmgyvvypfcjuhtr) via introspection — every table, column,
-- constraint, trigger, function, view, and index below was read back
-- from Postgres system catalogs (information_schema / pg_catalog),
-- not hand-maintained. The previous version of this file had drifted
-- significantly from production (wrong column names on `sites`, an
-- unfixed number-generator bug on `incomes`, and 9 entire tables —
-- auth/roles, clients, suppliers, subcontractor billing, audit log —
-- missing outright). Keep this file in sync going forward by
-- introspecting the live DB again rather than hand-editing guesses.
--
-- ⚠️ PARTIALLY STALE: RLS is ENABLED on all 19 tables in production, with
-- policies matching the app's OWNER > ADMIN > WORKER role model. As of
-- 2026-08-16, all 19 tables below carry accurate, tenant-scoped policy
-- definitions inline:
--   - 12 core tables — expense_categories, clients, suppliers, sites,
--     expenses, incomes, company_holidays, audit_logs, user_roles,
--     app_settings, calendar_sync, site_phases — tenant-scope reads,
--     gate writes on tenant_can_write() (read-only lockout on an
--     expired trial, not a full block). See
--     supabase/migrations/2026-08-16-09-tenant-scoped-rls-core.sql.
--   - 7 module-gated tables — workers, worker_assignments, worker_ot,
--     salary_records (payroll module), labor_subcontractors,
--     labor_contracts, labor_payments (labor_subcontractors module) —
--     tenant-scope AND module-gate both reads and writes via
--     has_module_access() (a full block when the module isn't
--     purchased/trialing, deliberately not the read/write split used
--     on the 12 core tables above). See
--     supabase/migrations/2026-08-16-10-tenant-scoped-rls-modules.sql.
--
-- ⚠️ NOT RUNNABLE TOP-TO-BOTTOM as of 2026-08-16: tenant_id columns below
-- use DEFAULT current_tenant_id(), but that function (defined near
-- user_roles, further down this file) depends on user_roles.tenant_id,
-- which in turn depends on the tenants table. In production this
-- ordering is handled correctly via the three-pass migration
-- supabase/migrations/2026-08-16-07-tenant-id-backfill.sql (tenants →
-- add/backfill tenant_id everywhere → create current_tenant_id() → set
-- it as DEFAULT). This file was NOT reordered to match, to keep this
-- change reviewable as a column-by-column diff; treat it as
-- documentation of the current shape, not a from-scratch bootstrap
-- script, until someone does that reorder.
-- ================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------
-- EXPENSE_CATEGORIES — หมวดค่าใช้จ่าย (แก้ไข/เพิ่ม/ลบได้)
-- ----------------------------------------------------------------
-- name uniqueness is scoped per tenant, not global (see
-- 2026-08-17-10-fix-expense-categories-global-unique-name.sql) — the
-- contractor-type starter-template seed gives every tenant of the same
-- trade identical category names, which a global UNIQUE(name) would
-- have rejected on the second such signup.
CREATE TABLE expense_categories (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name       TEXT NOT NULL,
  color      TEXT DEFAULT '#6c63ff',
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  tenant_id  UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  UNIQUE (tenant_id, name)
);

CREATE INDEX idx_expense_categories_tenant_id ON expense_categories(tenant_id);

-- Group A core-table RLS (see supabase/migrations/2026-08-16-09-tenant-scoped-rls-core.sql):
-- reads are ADMIN+ and tenant-scoped only (an expired trial can still view
-- its own data, per spec §4); writes are additionally gated by
-- tenant_can_write(), hence 4 single-command policies instead of FOR ALL.
ALTER TABLE expense_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_reads ON expense_categories FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id());
CREATE POLICY admin_inserts ON expense_categories FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_updates ON expense_categories FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_deletes ON expense_categories FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

-- Starter categories — adjust to the business before going live with a
-- new company; these 8 are FacadeX's own (production currently has 12,
-- 4 more were added later through the UI).
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
-- CLIENTS — ผู้ว่าจ้าง / ลูกค้า
-- ----------------------------------------------------------------
CREATE TABLE clients (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_number   TEXT NOT NULL DEFAULT '',    -- AUTO: CL-2026-001
  name            TEXT NOT NULL,
  contact_person  TEXT,
  position        TEXT,
  phone           TEXT,
  email           TEXT,
  address         TEXT,
  province        TEXT,
  notes           TEXT,
  tax_id          TEXT,
  client_type     TEXT CHECK (client_type IN ('DEVELOPER','ENDUSER','ผู้รับเหมา')),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  -- Per-tenant, not global -- generate_client_number()'s MAX() runs
  -- under the caller's own RLS (tenant-scoped), so the uniqueness
  -- constraint must match or a brand-new tenant's first-ever client
  -- ("CL-2026-001") can collide with another tenant's. See
  -- 2026-09-01-05-scope-document-numbers-per-tenant.sql.
  UNIQUE (tenant_id, client_number)
);

CREATE INDEX idx_clients_name ON clients(name);
CREATE INDEX idx_clients_tenant_id ON clients(tenant_id);

-- Group A core-table RLS (see supabase/migrations/2026-08-16-09-tenant-scoped-rls-core.sql).
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_reads ON clients FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id());
CREATE POLICY admin_inserts ON clients FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_updates ON clients FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_deletes ON clients FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

-- ----------------------------------------------------------------
-- SUPPLIERS — ผู้จำหน่ายวัสดุ
-- ----------------------------------------------------------------
CREATE TABLE suppliers (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  supplier_number TEXT NOT NULL DEFAULT '',    -- AUTO: SP-2026-001
  name            TEXT NOT NULL,
  contact_person  TEXT,
  phone           TEXT,
  email           TEXT,
  category        JSONB,                              -- e.g. ["กระจก","อลูมิเนียม"]
  payment_terms   TEXT,                                -- legacy free-text note, not used for propagation
  address         TEXT,
  notes           TEXT,
  default_payment_method TEXT DEFAULT 'transfer'
                  CHECK (default_payment_method IN ('transfer','check')),
  credit_days     INTEGER,                             -- NULL = no credit terms (immediate/cash-like)
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  -- Per-tenant, not global -- see 2026-09-01-05-scope-document-numbers-per-tenant.sql.
  UNIQUE (tenant_id, supplier_number)
);

CREATE INDEX idx_suppliers_name ON suppliers(name);
CREATE INDEX idx_suppliers_tenant_id ON suppliers(tenant_id);

-- Group A core-table RLS (see supabase/migrations/2026-08-16-09-tenant-scoped-rls-core.sql).
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_reads ON suppliers FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id());
CREATE POLICY admin_inserts ON suppliers FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_updates ON suppliers FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_deletes ON suppliers FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

-- ----------------------------------------------------------------
-- CONTRACTOR_TYPES / CONTRACTOR_TYPE_CATEGORIES /
-- CONTRACTOR_TYPE_CATEGORY_SUPPLIERS — shared reference data for
-- contractor-type starter templates (see
-- docs/superpowers/specs/2026-08-17-contractor-type-starter-templates-design.md).
-- Not tenant-scoped — every tenant reads the same rows once, at signup,
-- to seed their own expense_categories/suppliers (above). See
-- supabase/migrations/2026-08-17-07-contractor-type-templates.sql.
-- Row-level seed content (10 contractor types × their material/labor
-- categories × one default supplier per material category) lives in
-- supabase/migrations/2026-08-17-08-seed-contractor-type-content.sql,
-- not duplicated here — schema.sql documents structure, not bulk seed
-- data (compare the expense_categories starter rows above, which are
-- few enough to inline; these 61 rows are not).
-- ----------------------------------------------------------------
CREATE TABLE contractor_types (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT NOT NULL UNIQUE,
  label_th    TEXT NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0
);

-- UNIQUE(contractor_type_id, name): the signup trigger seeds every
-- matching row into a new tenant's expense_categories, which itself has
-- UNIQUE(tenant_id, name) — a duplicate name within one contractor type
-- here would make signup fail for every tenant of that type. Enforced
-- here so a bad hand-edit to this reference data fails immediately
-- (admin-only, safe) instead of at a real customer's signup.
CREATE TABLE contractor_type_categories (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_type_id  UUID NOT NULL REFERENCES contractor_types(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  color               TEXT NOT NULL DEFAULT '#6c63ff',
  sort_order          INT NOT NULL DEFAULT 0,
  UNIQUE (contractor_type_id, name)
);

-- Kept as its own table (rather than a supplier_name column on
-- contractor_type_categories) so a category can carry more than one
-- candidate supplier later without a schema change — v1 only ever
-- inserts one row per material category, and zero rows for a labor
-- category (that absence is what marks it as labor — no separate flag).
CREATE TABLE contractor_type_category_suppliers (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_template_id  UUID NOT NULL REFERENCES contractor_type_categories(id) ON DELETE CASCADE,
  supplier_name          TEXT NOT NULL,
  sort_order             INT NOT NULL DEFAULT 0
);

-- Shared reference data: readable pre-tenant, since it's needed by the
-- signup form's dropdown — so this must NOT be
-- tenant_can_write()/current_tenant_id() gated. No write policy — content
-- is maintained directly via SQL.
--
-- contractor_types specifically must also be readable by the `anon` role
-- (see 2026-08-17-12-contractor-types-anon-readable.sql): the signup
-- form's dropdown fetches this BEFORE the visitor is authenticated, so
-- supabase-js is using the anon API key and PostgREST evaluates RLS as
-- `anon`, not `authenticated`, at that point — a policy scoped to
-- `authenticated` only left the dropdown seeing zero rows for every real
-- signup visitor. contractor_type_categories/
-- contractor_type_category_suppliers don't need this: the signup trigger
-- itself runs SECURITY DEFINER and bypasses RLS entirely, and the only
-- other reader (Settings.jsx) always has a session.
ALTER TABLE contractor_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY anyone_reads_contractor_types ON contractor_types FOR SELECT TO anon, authenticated USING (true);

ALTER TABLE contractor_type_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY anyone_reads_contractor_type_categories ON contractor_type_categories FOR SELECT TO authenticated USING (true);

ALTER TABLE contractor_type_category_suppliers ENABLE ROW LEVEL SECURITY;
CREATE POLICY anyone_reads_contractor_type_category_suppliers ON contractor_type_category_suppliers FOR SELECT TO authenticated USING (true);

-- ----------------------------------------------------------------
-- SITES — ไซท์งานทั้งหมด
-- ----------------------------------------------------------------
CREATE TABLE sites (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  site_number    TEXT NOT NULL,                 -- AUTO: FX-2026-001
  name           TEXT NOT NULL,
  notes          TEXT,
  status         TEXT DEFAULT 'Ongoing'
                 CHECK (status IN ('Ongoing','Completed','On Hold','Cancelled')),
  start_date     DATE,
  end_date       DATE,
  contract_value NUMERIC DEFAULT 0,             -- มูลค่างานรวม (VAT-inclusive ground truth, used in billing_pct)
  has_vat        BOOLEAN DEFAULT true,          -- ผู้ใช้กรอก contract_value_no_vat + เลือกนี้; contract_value ถูกคำนวณ
  contract_value_no_vat NUMERIC,                -- มูลค่าก่อน VAT ที่ผู้ใช้กรอก
  plan_type      TEXT DEFAULT 'value' CHECK (plan_type IN ('value','percent')),

  -- ค่าเริ่มต้นสำหรับรายรับของไซท์นี้ — ใช้ auto-fill ฟอร์มเพิ่มรายรับ (Income.jsx)
  default_vat_pct           NUMERIC DEFAULT 7,
  default_tax_withheld_pct  NUMERIC DEFAULT 3,
  default_retention_pct     NUMERIC DEFAULT 0,
  default_retention_period_days INTEGER,               -- client retention due date = end_date + this many days; NULL until set explicitly
  default_deposit_pct       NUMERIC DEFAULT 0,          -- see site_deposit_summary; 0 = no deposit tracked for this site
  retention_released         BOOLEAN NOT NULL DEFAULT false,
  retention_released_date    DATE,

  -- แผนต้นทุน
  cost_aluminum  NUMERIC DEFAULT 0,
  cost_glass     NUMERIC DEFAULT 0,
  cost_equipment NUMERIC DEFAULT 0,
  cost_rubber    NUMERIC DEFAULT 0,
  cost_labor     NUMERIC DEFAULT 0,
  cost_other     NUMERIC DEFAULT 0,

  client_id      UUID REFERENCES clients(id),
  client_name    TEXT,                          -- legacy free-text (predates clients table)
  location       TEXT,
  distance_km    NUMERIC,                       -- ระยะทางเที่ยวเดียวจากโรงงาน (คิดค่าเดินทาง)
  map_url        TEXT,                          -- ลิงก์ Google Maps
  lat            NUMERIC(9,6),
  lng            NUMERIC(9,6),

  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  -- Per-tenant, not global -- see 2026-09-01-05-scope-document-numbers-per-tenant.sql.
  UNIQUE (tenant_id, site_number)
);

CREATE INDEX idx_sites_client_id ON sites(client_id);
CREATE INDEX idx_sites_tenant_id ON sites(tenant_id);

-- Group A core-table RLS (see supabase/migrations/2026-08-16-09-tenant-scoped-rls-core.sql).
ALTER TABLE sites ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_reads ON sites FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id());
CREATE POLICY admin_inserts ON sites FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_updates ON sites FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_deletes ON sites FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

-- ----------------------------------------------------------------
-- EXPENSES — รายจ่าย
-- ----------------------------------------------------------------
CREATE TABLE expenses (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  date            DATE NOT NULL,                -- วันที่สั่งซื้อ/วางบิล
  description     TEXT,
  site_id         UUID REFERENCES sites(id) ON DELETE SET NULL,
  category_id     UUID REFERENCES expense_categories(id) ON DELETE RESTRICT,  -- was SET NULL; silently orphaned expenses on category delete despite Categories.jsx's UI promising deletion would be blocked instead — see 2026-08-18-03
  supplier        TEXT,                         -- ชื่อผู้จำหน่าย (free text, legacy)
  supplier_id     UUID REFERENCES suppliers(id),
  po_id           UUID REFERENCES purchase_orders(id) ON DELETE SET NULL, -- FK to purchase_orders — set only by the PO receive flow
  amount          NUMERIC NOT NULL DEFAULT 0,    -- มูลค่า (รวม VAT)
  amount_no_vat   NUMERIC,                       -- มูลค่าก่อน VAT (nullable — เฉพาะที่มาจาก Excel import ใหม่)
  vat             NUMERIC,                       -- มูลค่า VAT (nullable, เดียวกัน)

  payment_method  TEXT DEFAULT 'transfer'
                  CHECK (payment_method IN ('transfer','check','cash','credit')),
  check_date      DATE,
  billing_date    DATE,                         -- วันวางบิล (credit)
  due_date        DATE,                         -- วันครบกำหนด (credit)
  status          TEXT DEFAULT 'pending'
                  CHECK (status IN ('awaiting_billing','paid','pending','check_issued','check_cleared')),
  payer           TEXT,
  invoice_no      TEXT,
  notes           TEXT,
  is_subcontract  BOOLEAN DEFAULT FALSE,        -- TRUE = ค่าแรงช่างภายนอก

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_expenses_site_id    ON expenses(site_id);
CREATE INDEX idx_expenses_date       ON expenses(date);
CREATE INDEX idx_expenses_status     ON expenses(status);
CREATE INDEX idx_expenses_check_date ON expenses(check_date);
CREATE INDEX idx_expenses_category_id ON expenses(category_id);
CREATE INDEX idx_expenses_supplier_id ON expenses(supplier_id);
CREATE INDEX idx_expenses_tenant_id ON expenses(tenant_id);
CREATE INDEX idx_expenses_po_id ON expenses(po_id);

-- Group A core-table RLS (see supabase/migrations/2026-08-16-09-tenant-scoped-rls-core.sql).
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_reads ON expenses FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id());
CREATE POLICY admin_inserts ON expenses FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_updates ON expenses FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_deletes ON expenses FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

-- ----------------------------------------------------------------
-- INCOMES — รายรับ
-- ----------------------------------------------------------------
CREATE TABLE incomes (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  invoice_no      TEXT,                         -- เลขที่ใบแจ้งหนี้ (auto ถ้าเว้นว่าง)
  date            DATE NOT NULL,
  site_id         UUID REFERENCES sites(id) ON DELETE SET NULL,
  client_name     TEXT,
  description     TEXT,
  amount_no_vat   NUMERIC DEFAULT 0,
  vat             NUMERIC DEFAULT 0,
  tax_withheld    NUMERIC DEFAULT 0,
  retention       NUMERIC DEFAULT 0,
  income_type     TEXT NOT NULL DEFAULT 'ปกติ' CHECK (income_type IN ('ปกติ', 'มัดจำ')),
  deposit_deduction NUMERIC DEFAULT 0,
  received_amount NUMERIC DEFAULT 0,

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_incomes_site_id ON incomes(site_id);
CREATE INDEX idx_incomes_date    ON incomes(date);
CREATE INDEX idx_incomes_tenant_id ON incomes(tenant_id);

-- Group A core-table RLS (see supabase/migrations/2026-08-16-09-tenant-scoped-rls-core.sql).
ALTER TABLE incomes ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_reads ON incomes FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id());
CREATE POLICY admin_inserts ON incomes FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_updates ON incomes FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_deletes ON incomes FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

-- ----------------------------------------------------------------
-- WORKERS — ช่างและพนักงาน
-- ----------------------------------------------------------------
CREATE TABLE workers (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name                  TEXT NOT NULL,
  nickname              TEXT,
  position              TEXT,
  monthly_salary        NUMERIC DEFAULT 0,
  has_social_security   BOOLEAN DEFAULT TRUE,
  annual_leave_days     INT DEFAULT 6,           -- วันลากิจที่ได้รับต่อปี (โควต้า leave_personal)
  monthly_contribution  NUMERIC DEFAULT 0,
  status                TEXT DEFAULT 'active' CHECK (status IN ('active','inactive')),
  email                 TEXT,                    -- ผูกกับ user_roles.user_email (login account)
  show_in_assign        BOOLEAN NOT NULL DEFAULT true, -- ซ่อนจาก roster ของ Assign โดยไม่กระทบข้อมูล assignment เดิม
  annual_sick_leave_days INT NOT NULL DEFAULT 30, -- วันลาป่วยที่ได้รับต่อปี (โควต้า leave_sick)
  id_card_number        TEXT,                    -- เลขประจำตัวประชาชน 13 หลัก
  address                TEXT,
  id_card_photo_path     TEXT,                    -- storage path in worker-id-cards bucket, not a public URL
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  tenant_id             UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_workers_tenant_id ON workers(tenant_id);

-- Payroll-module RLS (see supabase/migrations/2026-08-16-10-tenant-scoped-rls-modules.sql):
-- tenant-scoped AND gated on has_module_access('payroll') for both reads
-- and writes (a full block when the module isn't purchased/trialing —
-- unlike the core tables' read/write split above). ADMIN+ sees all
-- workers in the tenant; a WORKER account sees only their own row
-- (matched via workers.email = auth.email()).
ALTER TABLE workers ENABLE ROW LEVEL SECURITY;

CREATE POLICY worker_reads_own_profile ON workers FOR SELECT TO authenticated
  USING (
    tenant_id = current_tenant_id() AND has_module_access('payroll')
    AND (is_admin_or_owner() OR email = auth.email())
  );
CREATE POLICY admin_writes_workers ON workers FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'));
CREATE POLICY admin_updates_workers ON workers FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'));
CREATE POLICY admin_deletes_workers ON workers FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'));

-- ----------------------------------------------------------------
-- WORKER_ASSIGNMENTS — Assign ช่างรายวัน
-- ----------------------------------------------------------------
CREATE TABLE worker_assignments (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  worker_id   UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  site_id     UUID REFERENCES sites(id) ON DELETE SET NULL,
  date        DATE NOT NULL,
  -- site=ที่ไซท์, factory=ผลิตที่โรงงานให้ไซท์, office=ออฟฟิศ, holiday=หยุด,
  -- subcontract, leave=ลา (legacy, pre sick/personal split — kept for
  -- historical rows only, UI no longer creates new 'leave' rows),
  -- leave_sick=ลาป่วย (ไม่หักเงิน/โควต้า), leave_personal=ลากิจ (หักทั้งคู่)
  type        TEXT DEFAULT 'site'
              CHECK (type IN ('site','leave','office','holiday','subcontract','factory','leave_sick','leave_personal')),
  -- shift: morning/evening — 1 กะ = 0.5 วัน (เช้า+บ่าย = เต็มวัน)
  shift       TEXT NOT NULL DEFAULT 'morning' CHECK (shift IN ('morning','evening')),
  ot_hours    NUMERIC DEFAULT 0,                 -- legacy field, superseded by worker_ot table
  notes       TEXT,
  confirmed_at TIMESTAMPTZ,
  confirmed_by TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  UNIQUE (worker_id, date, shift)                -- 1 คน 1 วัน 1 กะ
);

CREATE INDEX idx_assignments_worker ON worker_assignments(worker_id);
CREATE INDEX idx_assignments_site   ON worker_assignments(site_id);
CREATE INDEX idx_assignments_date   ON worker_assignments(date);
CREATE INDEX idx_worker_assignments_tenant_id ON worker_assignments(tenant_id);

-- Payroll-module RLS (see supabase/migrations/2026-08-16-10-tenant-scoped-rls-modules.sql):
-- same shape as workers above — tenant-scoped AND gated on
-- has_module_access('payroll'); a WORKER sees only their own assignments.
ALTER TABLE worker_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY worker_reads_own ON worker_assignments FOR SELECT TO authenticated
  USING (
    tenant_id = current_tenant_id() AND has_module_access('payroll')
    AND (is_admin_or_owner() OR worker_id IN (SELECT id FROM workers WHERE email = auth.email()))
  );
CREATE POLICY admin_inserts ON worker_assignments FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'));
CREATE POLICY admin_updates ON worker_assignments FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'));
CREATE POLICY admin_deletes ON worker_assignments FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'));

-- ----------------------------------------------------------------
-- WORKER_OT — OT รายวัน (แยกจาก shift เช้า/บ่าย, สูงสุด 1 ช่วง/คน/วัน)
-- ----------------------------------------------------------------
CREATE TABLE worker_ot (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id     UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  site_id       UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date          DATE NOT NULL,
  start_time    TIME NOT NULL,
  end_time      TIME NOT NULL,
  ot_hours      NUMERIC NOT NULL,
  is_overnight  BOOLEAN NOT NULL DEFAULT false,  -- end_time falls on date+1 when true
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  UNIQUE (worker_id, date),
  CHECK (is_overnight OR end_time > start_time)
);

CREATE INDEX idx_worker_ot_site ON worker_ot(site_id);
CREATE INDEX idx_worker_ot_date ON worker_ot(date);
CREATE INDEX idx_worker_ot_tenant_id ON worker_ot(tenant_id);

-- Payroll-module RLS (see supabase/migrations/2026-08-16-10-tenant-scoped-rls-modules.sql):
-- same shape as workers/worker_assignments above — tenant-scoped AND
-- gated on has_module_access('payroll'); a WORKER sees only their own OT.
ALTER TABLE worker_ot ENABLE ROW LEVEL SECURITY;

CREATE POLICY worker_reads_own ON worker_ot FOR SELECT TO authenticated
  USING (
    tenant_id = current_tenant_id() AND has_module_access('payroll')
    AND (is_admin_or_owner() OR worker_id IN (SELECT id FROM workers WHERE email = auth.email()))
  );
CREATE POLICY admin_inserts ON worker_ot FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'));
CREATE POLICY admin_updates ON worker_ot FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'));
CREATE POLICY admin_deletes ON worker_ot FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'));

-- ----------------------------------------------------------------
-- COMPANY_HOLIDAYS — ปฏิทินวันหยุดบริษัท (ไม่ auto-mark worker_assignments;
-- Sunday shifts also pay this rate but are computed inline, not stored here)
-- ----------------------------------------------------------------
CREATE TABLE company_holidays (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date       DATE NOT NULL,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  tenant_id  UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  -- Per-tenant, not global -- a global UNIQUE(date) meant only one
  -- tenant across the whole platform could ever mark a given date as a
  -- holiday. See 2026-09-01-05-scope-document-numbers-per-tenant.sql.
  UNIQUE (tenant_id, date)
);

CREATE INDEX idx_company_holidays_date ON company_holidays(date);
CREATE INDEX idx_company_holidays_tenant_id ON company_holidays(tenant_id);

-- Group B core-table RLS (see supabase/migrations/2026-08-16-09-tenant-scoped-rls-core.sql):
-- any staff member of the tenant reads (shared calendar, not financial
-- data); only ADMIN+ writes, additionally gated by tenant_can_write().
ALTER TABLE company_holidays ENABLE ROW LEVEL SECURITY;

CREATE POLICY staff_reads ON company_holidays FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id());
CREATE POLICY admin_writes_holidays ON company_holidays FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_updates_holidays ON company_holidays FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_deletes_holidays ON company_holidays FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

-- ----------------------------------------------------------------
-- SALARY_RECORDS — เงินเดือนรายเดือน
-- ----------------------------------------------------------------
CREATE TABLE salary_records (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  worker_id             UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  month                 INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  year                  INT NOT NULL,
  base_salary           NUMERIC DEFAULT 0,
  contribution          NUMERIC DEFAULT 0,
  phone_allowance       NUMERIC DEFAULT 0,
  ot_amount             NUMERIC DEFAULT 0,       -- also carries the holiday-work bonus (no dedicated column)
  special_allowance     NUMERIC DEFAULT 0,
  advance_deduction     NUMERIC DEFAULT 0,
  social_security_ded   NUMERIC DEFAULT 0,
  leave_deduction       NUMERIC DEFAULT 0,       -- leave_personal only; leave_sick never deducts
  loan_deduction        NUMERIC DEFAULT 0,
  office_days           NUMERIC DEFAULT 0,       -- informational only -- never affects net_pay, never written to expenses
  office_cost           NUMERIC DEFAULT 0,       -- monthly_salary/26 * office_days, same formula as labor_cost_by_site
  net_pay               NUMERIC DEFAULT 0,
  paid_date             DATE,
  notes                 TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  tenant_id             UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  UNIQUE (worker_id, month, year)
);

CREATE INDEX idx_salary_records_tenant_id ON salary_records(tenant_id);

-- Payroll-module RLS (see supabase/migrations/2026-08-16-10-tenant-scoped-rls-modules.sql):
-- same shape as workers/worker_assignments/worker_ot above — tenant-scoped
-- AND gated on has_module_access('payroll'); a WORKER sees only their own
-- salary records.
ALTER TABLE salary_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY worker_reads_own ON salary_records FOR SELECT TO authenticated
  USING (
    tenant_id = current_tenant_id() AND has_module_access('payroll')
    AND (is_admin_or_owner() OR worker_id IN (SELECT id FROM workers WHERE email = auth.email()))
  );
CREATE POLICY admin_writes ON salary_records FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'));
CREATE POLICY admin_updates ON salary_records FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'));
CREATE POLICY admin_deletes ON salary_records FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'));

-- ----------------------------------------------------------------
-- PURCHASE_ORDERS — ใบสั่งซื้อ
-- ----------------------------------------------------------------
CREATE TABLE purchase_orders (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  po_number       TEXT NOT NULL DEFAULT '',   -- AUTO: PO-2026-001
  site_id         UUID NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  supplier_id     UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  category_id     UUID NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
  date            DATE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ordered'
                  CHECK (status IN ('ordered','received','cancelled')),
  has_vat         BOOLEAN NOT NULL DEFAULT true,
  price_includes_vat BOOLEAN NOT NULL DEFAULT false,  -- entered unit_price already includes VAT; only meaningful when has_vat
  notes           TEXT,
  received_date   DATE,
  expense_id      UUID REFERENCES expenses(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  -- Per-tenant, not global -- see 2026-09-01-05-scope-document-numbers-per-tenant.sql.
  UNIQUE (tenant_id, po_number)
);

CREATE TABLE purchase_order_items (
  id                     UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  po_id                  UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  description            TEXT NOT NULL,
  quantity               NUMERIC NOT NULL DEFAULT 1,
  unit                   TEXT,
  unit_price             NUMERIC NOT NULL DEFAULT 0,
  line_total             NUMERIC NOT NULL DEFAULT 0,
  sort_order             INT NOT NULL DEFAULT 0,
  tenant_id              UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  inventory_item_id      UUID REFERENCES inventory_items(id) ON DELETE SET NULL,
  aluminum_profile_id    UUID REFERENCES aluminum_profiles(id) ON DELETE SET NULL,
  rod_length_m           NUMERIC,
  glass_width_m          NUMERIC,
  glass_height_m         NUMERIC
);

CREATE INDEX idx_purchase_orders_site_id ON purchase_orders(site_id);
CREATE INDEX idx_purchase_orders_supplier_id ON purchase_orders(supplier_id);
CREATE INDEX idx_purchase_orders_status ON purchase_orders(status);
CREATE INDEX idx_purchase_orders_tenant_id ON purchase_orders(tenant_id);
CREATE INDEX idx_purchase_order_items_po_id ON purchase_order_items(po_id);
CREATE INDEX idx_purchase_order_items_tenant_id ON purchase_order_items(tenant_id);
CREATE INDEX idx_purchase_order_items_inventory_item_id ON purchase_order_items(inventory_item_id);

-- Auto-numbering, same pattern as generate_site_number()/generate_supplier_number()
-- (MAX(existing suffix)+1, not COUNT(*)+1 — see the comment above
-- generate_site_number() in schema.sql for why COUNT(*)+1 breaks when a
-- row is deleted). Matches those functions' lack of tenant_id scoping —
-- an existing, consistent quirk across every numbering trigger in this
-- app, not something to fix only here.
CREATE OR REPLACE FUNCTION generate_po_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  year_part TEXT := TO_CHAR(NOW(), 'YYYY');
  seq_num   INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(po_number FROM 'PO-\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM purchase_orders
  WHERE po_number LIKE 'PO-' || year_part || '-%';
  NEW.po_number := 'PO-' || year_part || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_po_number
  BEFORE INSERT ON purchase_orders
  FOR EACH ROW
  WHEN (NEW.po_number IS NULL OR NEW.po_number = '')
  EXECUTE FUNCTION generate_po_number();

-- purchase_orders-module RLS: single ADMIN+-only full-access policy,
-- tenant-scoped AND gated on has_module_access('purchase_orders') for
-- both reads and writes — same shape as labor_subcontractors.
ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON purchase_orders FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));

ALTER TABLE purchase_order_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON purchase_order_items FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));

-- ================================================================
-- INVENTORY_ITEMS + INVENTORY_ITEM_UNIT_FACTORS
-- ================================================================
-- Phase 1 buying-side module gates on 'purchase_orders', not a new module key (see the Phase 1 plan's Ruling A).

CREATE TABLE inventory_items (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id             UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name                  TEXT NOT NULL,
  base_unit             TEXT NOT NULL,
  active                BOOLEAN NOT NULL DEFAULT true,
  unit_conversion_mode  TEXT NOT NULL DEFAULT 'plain' CHECK (unit_conversion_mode IN ('plain', 'aluminum_profile', 'glass_dimension')),
  reference_area_sqm    NUMERIC,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_inventory_items_tenant_id ON inventory_items(tenant_id);

ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON inventory_items FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));

CREATE TABLE inventory_item_unit_factors (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  inventory_item_id   UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  unit_name           TEXT NOT NULL,
  factor_to_base      NUMERIC NOT NULL,
  UNIQUE (inventory_item_id, unit_name)
);

CREATE INDEX idx_inventory_item_unit_factors_tenant_id ON inventory_item_unit_factors(tenant_id);
CREATE INDEX idx_inventory_item_unit_factors_item_id ON inventory_item_unit_factors(inventory_item_id);

ALTER TABLE inventory_item_unit_factors ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON inventory_item_unit_factors FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));

-- ================================================================
-- ALUMINUM_PROFILES (for dual-unit conversion of aluminum materials)
-- See docs/superpowers/plans/2026-09-05-inventory-dual-unit-conversion-plan.md
-- ================================================================

CREATE TABLE aluminum_profiles (
  id                     UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id              UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name                   TEXT NOT NULL,
  linear_weight_kg_per_m NUMERIC NOT NULL,
  default_length_m       NUMERIC NOT NULL DEFAULT 6.4,
  active                 BOOLEAN NOT NULL DEFAULT true,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_aluminum_profiles_tenant_id ON aluminum_profiles(tenant_id);

ALTER TABLE aluminum_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON aluminum_profiles FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));

-- ================================================================
-- INVENTORY_STOCK_BALANCES + STOCK_MOVEMENTS + RECORD_STOCK_MOVEMENT()
-- ================================================================
-- Stock ledger: running qty + weighted-avg cost per item/site (Phase 1 buying-side).
-- Added by supabase/migrations/2026-09-05-07-inventory-stock-ledger.sql.

CREATE TABLE inventory_stock_balances (
  id                     UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id              UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  inventory_item_id      UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  site_id                UUID NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  quantity_on_hand       NUMERIC NOT NULL DEFAULT 0,
  weighted_average_cost  NUMERIC NOT NULL DEFAULT 0,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (inventory_item_id, site_id)
);

CREATE INDEX idx_inventory_stock_balances_tenant_id ON inventory_stock_balances(tenant_id);
CREATE INDEX idx_inventory_stock_balances_site_id ON inventory_stock_balances(site_id);

ALTER TABLE inventory_stock_balances ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON inventory_stock_balances FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));

CREATE TABLE stock_movements (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  inventory_item_id   UUID NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  site_id             UUID NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  movement_type       TEXT NOT NULL CHECK (movement_type IN
                        ('purchase_in', 'transfer_in', 'transfer_out', 'sale_out', 'sale_reversal', 'adjustment')),
  quantity            NUMERIC NOT NULL,
  unit_cost           NUMERIC,
  reference_type      TEXT,
  reference_id        UUID,
  notes               TEXT,
  created_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_stock_movements_tenant_id ON stock_movements(tenant_id);
CREATE INDEX idx_stock_movements_item_site ON stock_movements(inventory_item_id, site_id);
CREATE INDEX idx_stock_movements_reference ON stock_movements(reference_type, reference_id);

ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON stock_movements FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));

-- record_stock_movement(): the ONLY writer of stock_movements/inventory_stock_balances.
-- See the Phase 1 plan's Ruling D on why it re-checks tenant ownership itself.
--
-- Atomically posts one stock_movements row and recalculates the
-- affected (item, site) balance's weighted-average cost, per
-- docs/superpowers/specs/2026-09-01-inventory-module-design.md's
-- Business Logic > Purchasing formula:
--   new_wac = (old_qty*old_wac + moved_qty*unit_cost) / (old_qty + moved_qty)
-- SECURITY DEFINER (like perform_worker_checkin(), schema.sql) so it
-- must re-verify privilege AND that both FK inputs belong to the
-- caller's own tenant before writing anything (Ruling D) -- RLS is
-- bypassed inside this function, nothing here can be assumed safe.
CREATE OR REPLACE FUNCTION record_stock_movement(
  p_inventory_item_id UUID,
  p_site_id UUID,
  p_movement_type TEXT,
  p_quantity NUMERIC,
  p_unit_cost NUMERIC,
  p_reference_type TEXT,
  p_reference_id UUID,
  p_notes TEXT
)
RETURNS TABLE(movement_id UUID, new_quantity_on_hand NUMERIC, new_weighted_average_cost NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := current_tenant_id();
  v_movement_id UUID;
  v_old_qty NUMERIC;
  v_old_wac NUMERIC;
  v_new_qty NUMERIC;
  v_new_wac NUMERIC;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders')) THEN
    RAISE EXCEPTION 'insufficient_privilege';
  END IF;

  IF p_movement_type NOT IN ('purchase_in', 'transfer_in', 'transfer_out') THEN
    RAISE EXCEPTION 'unsupported_movement_type: %', p_movement_type;
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity must be positive';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM inventory_items WHERE id = p_inventory_item_id AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'inventory_item not found for this tenant';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM sites WHERE id = p_site_id AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'site not found for this tenant';
  END IF;

  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by)
  VALUES (v_tenant_id, p_inventory_item_id, p_site_id, p_movement_type, p_quantity, p_unit_cost, p_reference_type, p_reference_id, p_notes, auth.email())
  RETURNING id INTO v_movement_id;

  SELECT quantity_on_hand, weighted_average_cost INTO v_old_qty, v_old_wac
  FROM inventory_stock_balances
  WHERE inventory_item_id = p_inventory_item_id AND site_id = p_site_id
  FOR UPDATE;

  IF NOT FOUND THEN
    v_old_qty := 0;
    v_old_wac := 0;
  END IF;

  IF p_movement_type IN ('purchase_in', 'transfer_in') THEN
    v_new_qty := v_old_qty + p_quantity;
    IF v_new_qty = 0 THEN
      v_new_wac := 0;
    ELSE
      v_new_wac := (v_old_qty * v_old_wac + p_quantity * COALESCE(p_unit_cost, 0)) / v_new_qty;
    END IF;
  ELSE
    v_new_qty := v_old_qty - p_quantity;
    v_new_wac := v_old_wac;
  END IF;

  INSERT INTO inventory_stock_balances (tenant_id, inventory_item_id, site_id, quantity_on_hand, weighted_average_cost, updated_at)
  VALUES (v_tenant_id, p_inventory_item_id, p_site_id, v_new_qty, v_new_wac, now())
  ON CONFLICT (inventory_item_id, site_id) DO UPDATE
    SET quantity_on_hand = v_new_qty, weighted_average_cost = v_new_wac, updated_at = now();

  RETURN QUERY SELECT v_movement_id, v_new_qty, v_new_wac;
END;
$$;

GRANT EXECUTE ON FUNCTION record_stock_movement(UUID, UUID, TEXT, NUMERIC, NUMERIC, TEXT, UUID, TEXT) TO authenticated;

-- Missing REVOKE fixed in final-review fix bundle (Fix 4) -- Postgres grants
-- EXECUTE to PUBLIC by default, so this closes that gap to match the
-- convention every other SECURITY DEFINER function in this file follows
-- (e.g. perform_worker_checkin()).
REVOKE EXECUTE ON FUNCTION record_stock_movement(UUID, UUID, TEXT, NUMERIC, NUMERIC, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_stock_movement(UUID, UUID, TEXT, NUMERIC, NUMERIC, TEXT, UUID, TEXT) TO authenticated;

-- ----------------------------------------------------------------
-- CATALOG_ITEMS — รายการสินค้า/บริการสำหรับใบเสนอราคา (sell-side price list)
-- ----------------------------------------------------------------
-- Sell-side price list only — no cost price, no per-item VAT, no stock
-- quantity. See "Non-Goals" in the design spec for why: the user's
-- buy-side materials and sell-side deliverables are different kinds of
-- things with no 1:1 mapping, so a unified buy/sell catalog with margin
-- tracking would model a business shape that doesn't match how this
-- company actually works. Added by
-- supabase/migrations/2026-08-22-03-catalog-items.sql.
CREATE TABLE catalog_items (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name               TEXT NOT NULL,
  unit               TEXT,
  default_unit_price NUMERIC NOT NULL DEFAULT 0,
  description        TEXT,
  active             BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id          UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_catalog_items_tenant_id ON catalog_items(tenant_id);

ALTER TABLE catalog_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON catalog_items FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('quotations'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('quotations'));

-- ----------------------------------------------------------------
-- BANK_ACCOUNTS — บัญชีธนาคารสำหรับรับชำระเงิน (แยก VAT/ไม่มี VAT)
-- ----------------------------------------------------------------
-- Multiple bank accounts per tenant, each categorized VAT or non-VAT,
-- with at most one default per category. quotations/invoices record
-- which account was selected (bank_account_id below), not just
-- live-computed at print time. Added by
-- supabase/migrations/2026-09-03-12-bank-accounts.sql, which also
-- backfills the old single tenants.bank_name/bank_account_name/
-- bank_account_no fields (left in place, no longer read/written by
-- the app) into one bank_accounts row per tenant that had one set.
CREATE TABLE bank_accounts (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  bank_name     TEXT NOT NULL,
  account_name  TEXT NOT NULL,
  account_no    TEXT NOT NULL,
  vat_category  TEXT NOT NULL CHECK (vat_category IN ('vat','non_vat')),
  is_default    BOOLEAN NOT NULL DEFAULT false,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bank_accounts_tenant_id ON bank_accounts(tenant_id);
-- At most one default account per (tenant, vat_category).
CREATE UNIQUE INDEX idx_bank_accounts_one_default_per_category
  ON bank_accounts(tenant_id, vat_category) WHERE is_default = true;

ALTER TABLE bank_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON bank_accounts FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id());

-- ----------------------------------------------------------------
-- UNITS — รายการหน่วยนับ (ใช้ร่วมกันทั้งฝั่งซื้อและฝั่งขาย)
-- ----------------------------------------------------------------
-- A per-tenant list of known unit-of-measure strings feeding a
-- dropdown-with-inline-add reused across catalog_items, quotation_items,
-- and purchase_order_items. Deliberately a flat name list, not tied to
-- any conversion/base-unit system -- unit columns on those tables stay
-- plain TEXT, this table only supplies the dropdown's known values.
-- Added by supabase/migrations/2026-09-03-13-units.sql.
CREATE TABLE units (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX idx_units_tenant_id ON units(tenant_id);

ALTER TABLE units ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON units FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id());

-- ----------------------------------------------------------------
-- QUOTATIONS — ใบเสนอราคา
-- ----------------------------------------------------------------
-- Quotation header. status lifecycle: draft/sent/accepted/rejected/
-- expired. has_vat + price_includes_vat mirror purchase_orders' shape
-- exactly. Added by supabase/migrations/2026-08-22-04-quotations.sql.
CREATE TABLE quotations (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  quotation_number    TEXT NOT NULL DEFAULT '',   -- AUTO: QT-2026-001
  client_id           UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  site_id             UUID REFERENCES sites(id) ON DELETE SET NULL,
  date                DATE NOT NULL,
  valid_until         DATE,
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','sent','accepted','rejected','expired')),
  has_vat             BOOLEAN NOT NULL DEFAULT true,
  price_includes_vat  BOOLEAN NOT NULL DEFAULT false,
  discount_amount     NUMERIC,
  discount_pct        NUMERIC,
  payment_terms       TEXT,
  notes               TEXT,
  revision            INTEGER NOT NULL DEFAULT 1, -- bumped on every edit save; counter only, no snapshot history — added by supabase/migrations/2026-08-22-07-quotation-revision-tracking.sql
  -- true from the first time this quotation is ever sent, and stays true
  -- even after a pull-back-to-edit sets status back to 'draft' -- editing
  -- a quotation that's never been sent is normal draft iteration (no
  -- revision snapshot/bump); editing one that's ever_sent is a real
  -- revision. Added by
  -- supabase/migrations/2026-09-03-11-quotation-item-description-and-ever-sent.sql.
  ever_sent           BOOLEAN NOT NULL DEFAULT false,
  -- Added by supabase/migrations/2026-09-03-12-bank-accounts.sql.
  bank_account_id     UUID REFERENCES bank_accounts(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  -- Per-tenant, not global -- see 2026-09-01-05-scope-document-numbers-per-tenant.sql.
  UNIQUE (tenant_id, quotation_number)
);

CREATE INDEX idx_quotations_client_id ON quotations(client_id);
CREATE INDEX idx_quotations_site_id ON quotations(site_id);
CREATE INDEX idx_quotations_status ON quotations(status);
CREATE INDEX idx_quotations_tenant_id ON quotations(tenant_id);

-- Auto-numbering: identical pattern to generate_po_number()
-- (search this file for "generate_po_number") — QT- + year +
-- zero-padded per-year sequence.
CREATE OR REPLACE FUNCTION generate_quotation_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  year_part TEXT := TO_CHAR(NOW(), 'YYYY');
  seq_num   INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(quotation_number FROM 'QT-\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM quotations
  WHERE quotation_number LIKE 'QT-' || year_part || '-%';
  NEW.quotation_number := 'QT-' || year_part || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_quotation_number
  BEFORE INSERT ON quotations
  FOR EACH ROW
  WHEN (NEW.quotation_number IS NULL OR NEW.quotation_number = '')
  EXECUTE FUNCTION generate_quotation_number();

-- quotations-module RLS: single ADMIN+-only full-access policy,
-- tenant-scoped AND gated on has_module_access('quotations') for both
-- reads and writes — same shape as purchase_orders.
ALTER TABLE quotations ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON quotations FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('quotations'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('quotations'));

-- ----------------------------------------------------------------
-- QUOTATION_ITEMS — รายการในใบเสนอราคา
-- ----------------------------------------------------------------
-- Same shape as purchase_order_items, plus an optional catalog_item_id
-- back-reference to the sell-side price list (ON DELETE SET NULL:
-- deleting a catalog item must never take a historical quotation line
-- with it). Added by supabase/migrations/2026-08-22-05-quotation-items.sql.
CREATE TABLE quotation_items (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  quotation_id     UUID NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  catalog_item_id  UUID REFERENCES catalog_items(id) ON DELETE SET NULL,
  description      TEXT NOT NULL,
  unit             TEXT,
  quantity         NUMERIC NOT NULL DEFAULT 1,
  unit_price       NUMERIC NOT NULL DEFAULT 0,
  line_total       NUMERIC NOT NULL DEFAULT 0,
  sort_order       INT NOT NULL DEFAULT 0,
  tenant_id        UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  -- 'note' rows are a free-text "additional info" line, not a priced
  -- item -- e.g. a description sitting under a specific item, or a
  -- section separator. Added by
  -- supabase/migrations/2026-09-03-10-quotation-items-item-type.sql.
  -- 'item_description' is a note-type row attached to the item
  -- immediately before it (by position, not FK -- it's only ever
  -- created glued to that item, e.g. by the catalog picker), distinct
  -- from a standalone/section 'note'. Both render identically on the
  -- printed document. Widened by
  -- supabase/migrations/2026-09-03-11-quotation-item-description-and-ever-sent.sql.
  item_type        TEXT NOT NULL DEFAULT 'item' CHECK (item_type IN ('item','note','item_description'))
);

CREATE INDEX idx_quotation_items_quotation_id ON quotation_items(quotation_id);
CREATE INDEX idx_quotation_items_tenant_id ON quotation_items(tenant_id);

ALTER TABLE quotation_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON quotation_items FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('quotations'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('quotations'));

-- ----------------------------------------------------------------
-- QUOTATION_ITEM_UNITS — quotation item unit progress ledger
-- ----------------------------------------------------------------
-- The single source of truth for how much of each quotation line has been
-- billed, tracked per physical unit. Rows are seeded LAZILY by the app
-- (first time the invoice item-selection screen opens for a quotation),
-- never at quotation-acceptance time.
CREATE TABLE quotation_item_units (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  quotation_item_id UUID NOT NULL REFERENCES quotation_items(id) ON DELETE CASCADE,
  unit_index        INT NOT NULL,
  unit_qty          NUMERIC NOT NULL,
  cumulative_pct    NUMERIC NOT NULL DEFAULT 0 CHECK (cumulative_pct BETWEEN 0 AND 100),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id         UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  UNIQUE (quotation_item_id, unit_index)
);

CREATE INDEX idx_quotation_item_units_quotation_item_id ON quotation_item_units(quotation_item_id);
CREATE INDEX idx_quotation_item_units_tenant_id ON quotation_item_units(tenant_id);

-- Guards against a real bug hit in production: a direct-SQL write (e.g. a
-- data-migration backfill) computing cumulative_pct via raw Postgres
-- NUMERIC division can produce ~20 decimal digits, which does not
-- round-trip exactly through a JS float64 -- the browser's optimistic
-- lock (`.eq('cumulative_pct', valueItReadEarlier)`) then permanently
-- fails to match, since the value JS sends back is never bit-identical
-- to what's actually stored. The app's own JS code (waterfall() in
-- invoiceCalc.js) never produces this on its own -- float64 arithmetic
-- self-limits to ~17 significant digits, which always round-trips fine.
-- Rounding to 9 decimal places is still vastly more precision than
-- money math needs (a difference of 0.000000001% of even a
-- 100M-baht contract is a fraction of a millisatang) while guaranteeing
-- every stored value fits exactly in a float64.
-- See 2026-08-29-10-fix-cumulative-pct-precision.sql.
CREATE OR REPLACE FUNCTION round_quotation_item_units_cumulative_pct()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.cumulative_pct := ROUND(NEW.cumulative_pct, 9);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_round_cumulative_pct
  BEFORE INSERT OR UPDATE ON quotation_item_units
  FOR EACH ROW
  EXECUTE FUNCTION round_quotation_item_units_cumulative_pct();

ALTER TABLE quotation_item_units ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON quotation_item_units FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'));

-- ----------------------------------------------------------------
-- INVOICES — ใบแจ้งหนี้
-- ----------------------------------------------------------------
-- Header + auto-numbering. Added by
-- supabase/migrations/2026-08-24-03-invoices.sql.
CREATE TABLE invoices (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  invoice_number      TEXT NOT NULL DEFAULT '',
  quotation_id        UUID NOT NULL REFERENCES quotations(id) ON DELETE RESTRICT,
  site_id             UUID NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  date                DATE NOT NULL,
  status              TEXT NOT NULL DEFAULT 'unpaid'
                      CHECK (status IN ('unpaid','paid','void')),
  has_vat             BOOLEAN NOT NULL,
  price_includes_vat  BOOLEAN NOT NULL,
  subtotal            NUMERIC NOT NULL DEFAULT 0,
  vat                 NUMERIC NOT NULL DEFAULT 0,
  total               NUMERIC NOT NULL DEFAULT 0,
  notes               TEXT,
  paid_date           DATE,
  income_id           UUID REFERENCES incomes(id) ON DELETE SET NULL,
  -- Added by supabase/migrations/2026-09-03-12-bank-accounts.sql.
  bank_account_id     UUID REFERENCES bank_accounts(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  -- Per-tenant, not global -- see 2026-09-01-05-scope-document-numbers-per-tenant.sql.
  UNIQUE (tenant_id, invoice_number)
);

CREATE INDEX idx_invoices_quotation_id ON invoices(quotation_id);
CREATE INDEX idx_invoices_site_id ON invoices(site_id);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_tenant_id ON invoices(tenant_id);

-- incomes.source_invoice_id -- added here (not inline on incomes' own
-- CREATE TABLE above) because it references invoices, which is defined
-- after incomes in this file. See
-- 2026-08-29-05-incomes-source-invoice-id.sql: the automated
-- handleMarkPaid dedup key, replacing a SELECT-then-INSERT keyed on the
-- freeform invoice_no text column (which real manual income entries can
-- legitimately share) with a real UNIQUE constraint, matching how
-- receipts.invoice_id already works. NULL for every manually-entered
-- income row.
ALTER TABLE incomes ADD COLUMN source_invoice_id UUID REFERENCES invoices(id);
ALTER TABLE incomes ADD CONSTRAINT incomes_source_invoice_id_unique UNIQUE (source_invoice_id);

-- Auto-numbering: identical pattern to generate_quotation_number()
-- INV- + year + zero-padded per-year sequence.
CREATE OR REPLACE FUNCTION generate_invoice_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  year_part TEXT := TO_CHAR(NOW(), 'YYYY');
  seq_num   INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(invoice_number FROM 'INV-\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM invoices
  WHERE invoice_number LIKE 'INV-' || year_part || '-%';
  NEW.invoice_number := 'INV-' || year_part || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_invoice_number
  BEFORE INSERT ON invoices
  FOR EACH ROW
  WHEN (NEW.invoice_number IS NULL OR NEW.invoice_number = '')
  EXECUTE FUNCTION generate_invoice_number();

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON invoices FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'));

-- INVOICE_ITEMS — บรรทัดใบแจ้งหนี้
-- Added by supabase/migrations/2026-08-24-04-invoice-items.sql.
CREATE TABLE invoice_items (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  invoice_id         UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  quotation_item_id  UUID NOT NULL REFERENCES quotation_items(id) ON DELETE RESTRICT,
  description        TEXT NOT NULL,
  unit               TEXT,
  unit_price         NUMERIC NOT NULL,
  draw_qty           NUMERIC NOT NULL,
  line_total         NUMERIC NOT NULL,
  sort_order         INT NOT NULL DEFAULT 0,
  tenant_id          UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_invoice_items_invoice_id ON invoice_items(invoice_id);
CREATE INDEX idx_invoice_items_tenant_id ON invoice_items(tenant_id);

ALTER TABLE invoice_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON invoice_items FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'));

-- INVOICE_ITEM_DRAWS — ประวัติการเรียกเก็บต่อหน่วย
-- Per-unit audit trail. Added by
-- supabase/migrations/2026-08-24-05-invoice-item-draws.sql.
CREATE TABLE invoice_item_draws (
  id                      UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  invoice_item_id         UUID NOT NULL REFERENCES invoice_items(id) ON DELETE CASCADE,
  quotation_item_unit_id  UUID NOT NULL REFERENCES quotation_item_units(id) ON DELETE RESTRICT,
  prior_pct               NUMERIC NOT NULL,
  target_pct              NUMERIC NOT NULL,
  amount                  NUMERIC NOT NULL,
  tenant_id               UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_invoice_item_draws_invoice_item_id ON invoice_item_draws(invoice_item_id);
CREATE INDEX idx_invoice_item_draws_unit_id ON invoice_item_draws(quotation_item_unit_id);
CREATE INDEX idx_invoice_item_draws_tenant_id ON invoice_item_draws(tenant_id);

ALTER TABLE invoice_item_draws ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON invoice_item_draws FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'));

-- ----------------------------------------------------------------
-- RECEIPTS — ใบเสร็จรับเงิน/ใบกำกับภาษี (combined document, dual numbering)
-- ----------------------------------------------------------------
-- One physical document (ใบเสร็จรับเงิน/ใบกำกับภาษี combined), printed with
-- two independently-sequential numbers -- Thai tax practice expects the tax
-- invoice series to be its own unbroken sequence even when printed on the
-- same page as the receipt. invoice_id is UNIQUE because payment is
-- single-shot -- at most one receipt can ever exist per invoice.
CREATE TABLE receipts (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  receipt_number      TEXT NOT NULL DEFAULT '',
  tax_invoice_number  TEXT NOT NULL DEFAULT '',
  invoice_id          UUID NOT NULL UNIQUE REFERENCES invoices(id) ON DELETE RESTRICT,
  date                DATE NOT NULL,
  amount              NUMERIC NOT NULL,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  -- Per-tenant, not global -- see 2026-09-01-05-scope-document-numbers-per-tenant.sql.
  UNIQUE (tenant_id, receipt_number),
  UNIQUE (tenant_id, tax_invoice_number)
);

CREATE INDEX idx_receipts_invoice_id ON receipts(invoice_id);
CREATE INDEX idx_receipts_tenant_id ON receipts(tenant_id);

CREATE OR REPLACE FUNCTION generate_receipt_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  year_part TEXT := TO_CHAR(NOW(), 'YYYY');
  seq_num   INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(receipt_number FROM 'RCP-\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM receipts
  WHERE receipt_number LIKE 'RCP-' || year_part || '-%';
  NEW.receipt_number := 'RCP-' || year_part || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_receipt_number
  BEFORE INSERT ON receipts
  FOR EACH ROW
  WHEN (NEW.receipt_number IS NULL OR NEW.receipt_number = '')
  EXECUTE FUNCTION generate_receipt_number();

CREATE OR REPLACE FUNCTION generate_tax_invoice_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  year_part TEXT := TO_CHAR(NOW(), 'YYYY');
  seq_num   INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(tax_invoice_number FROM 'TIN-\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM receipts
  WHERE tax_invoice_number LIKE 'TIN-' || year_part || '-%';
  NEW.tax_invoice_number := 'TIN-' || year_part || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tax_invoice_number
  BEFORE INSERT ON receipts
  FOR EACH ROW
  WHEN (NEW.tax_invoice_number IS NULL OR NEW.tax_invoice_number = '')
  EXECUTE FUNCTION generate_tax_invoice_number();

ALTER TABLE receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON receipts FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'));

-- Full snapshot history — every edit of an existing quotation writes its
-- pre-edit state (header + items, as JSONB) here tagged with the revision
-- it was at. The live quotations/quotation_items rows are always the
-- current revision; only past ones live here. Added by
-- supabase/migrations/2026-08-24-01-quotation-revision-history.sql.
CREATE TABLE quotation_revisions (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  quotation_id  UUID NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  revision      INTEGER NOT NULL,
  snapshot      JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_quotation_revisions_quotation_id ON quotation_revisions(quotation_id);
CREATE INDEX idx_quotation_revisions_tenant_id ON quotation_revisions(tenant_id);

ALTER TABLE quotation_revisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON quotation_revisions FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('quotations'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('quotations'));

-- ----------------------------------------------------------------
-- PURCHASE_ORDER_ATTACHMENTS — เอกสารแนบใบสั่งซื้อ (ใบเสนอราคา, รูปสินค้า)
-- ----------------------------------------------------------------
-- Reference-only files (supplier quotations, product photos) — never
-- parsed, just stored for viewing/downloading. See
-- supabase/migrations/2026-08-17-06-purchase-order-attachments.sql.
CREATE TABLE purchase_order_attachments (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  po_id       UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  file_path   TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_po_attachments_po_id ON purchase_order_attachments(po_id);
CREATE INDEX idx_po_attachments_tenant_id ON purchase_order_attachments(tenant_id);

ALTER TABLE purchase_order_attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON purchase_order_attachments FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));

-- Storage: files live in the private `po-attachments` bucket (public =
-- false) under a tenant-prefixed path ({tenant_id}/{po_id}/...). Bucket
-- creation and its RLS policy (po_attachments_tenant_access on
-- storage.objects) are infrastructure DDL, not part of this table-by-
-- table narrative — see the migration above for the full definition.

-- Same pattern for sites — see 2026-08-19-01-site-attachments.sql. Unlike
-- PO attachments, sites is a core (non-gated) feature, so no
-- has_module_access() check on either the table or bucket policy.
CREATE TABLE site_attachments (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  site_id     UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  file_path   TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_site_attachments_site_id ON site_attachments(site_id);
CREATE INDEX idx_site_attachments_tenant_id ON site_attachments(tenant_id);

ALTER TABLE site_attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON site_attachments FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id());

-- Storage: private `site-attachments` bucket, tenant-prefixed path
-- ({tenant_id}/{site_id}/...), bucket RLS (site_attachments_tenant_access)
-- — see the migration above for the full definition.

-- ----------------------------------------------------------------
-- LABOR_SUBCONTRACTORS — ผู้รับเหมาช่วง (ทีมงานภายนอก)
-- ----------------------------------------------------------------
CREATE TABLE labor_subcontractors (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  subcontractor_number  TEXT NOT NULL DEFAULT '',   -- AUTO: LC-2026-001
  name                  TEXT NOT NULL,
  contact_person        TEXT,
  phone                 TEXT,
  email                 TEXT,
  notes                 TEXT,
  id_card_number        TEXT,                       -- เลขประจำตัวประชาชน 13 หลัก, for the WHT certificate's payee section
  address                TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  tenant_id             UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  -- Per-tenant, not global -- see 2026-09-01-05-scope-document-numbers-per-tenant.sql.
  UNIQUE (tenant_id, subcontractor_number)
);

CREATE INDEX idx_labor_sub_name ON labor_subcontractors(name);
CREATE INDEX idx_labor_subcontractors_tenant_id ON labor_subcontractors(tenant_id);

-- labor_subcontractors-module RLS (see
-- supabase/migrations/2026-08-16-10-tenant-scoped-rls-modules.sql):
-- single ADMIN+-only full-access policy, tenant-scoped AND gated on
-- has_module_access('labor_subcontractors') for both reads and writes
-- (a full block when the module isn't purchased/trialing).
ALTER TABLE labor_subcontractors ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON labor_subcontractors FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('labor_subcontractors'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('labor_subcontractors'));

-- ----------------------------------------------------------------
-- LABOR_CONTRACTS — สัญญาผู้รับเหมาช่วงต่อไซท์
-- ----------------------------------------------------------------
CREATE TABLE labor_contracts (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  subcontractor_id      UUID NOT NULL REFERENCES labor_subcontractors(id),
  site_id               UUID NOT NULL REFERENCES sites(id),
  work_description      TEXT NOT NULL,
  contract_amount       NUMERIC NOT NULL,
  retention_pct         NUMERIC DEFAULT 5,
  withholding_tax_pct   NUMERIC DEFAULT 3,
  site_note             TEXT,
  status                TEXT DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')),
  start_date            DATE,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  tenant_id             UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  UNIQUE (subcontractor_id, site_id)
);

CREATE INDEX idx_labor_contract_site ON labor_contracts(site_id);
CREATE INDEX idx_labor_contract_sub  ON labor_contracts(subcontractor_id);
CREATE INDEX idx_labor_contracts_tenant_id ON labor_contracts(tenant_id);

-- labor_subcontractors-module RLS (see
-- supabase/migrations/2026-08-16-10-tenant-scoped-rls-modules.sql): same
-- admin_full_access shape as labor_subcontractors above.
ALTER TABLE labor_contracts ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON labor_contracts FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('labor_subcontractors'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('labor_subcontractors'));

-- ----------------------------------------------------------------
-- LABOR_PAYMENTS — งวดจ่ายผู้รับเหมาช่วง (รวมการคืน retention)
-- ----------------------------------------------------------------
CREATE TABLE labor_payments (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contract_id           UUID NOT NULL REFERENCES labor_contracts(id),
  payment_number        TEXT NOT NULL DEFAULT '',   -- AUTO: PY2608-001
  payment_date          DATE NOT NULL,
  work_description      TEXT,
  progress_pct          NUMERIC,
  gross_amount          NUMERIC NOT NULL,
  withholding_tax       NUMERIC DEFAULT 0,
  retention_amount      NUMERIC DEFAULT 0,
  net_amount            NUMERIC NOT NULL,
  is_retention_release  BOOLEAN DEFAULT FALSE,   -- TRUE = งวดนี้คือการคืนเงิน retention ที่ถูกหักไว้ก่อนหน้า
  status                TEXT DEFAULT 'pending' CHECK (status IN ('pending','paid')),
  paid_date             DATE,
  notes                 TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  tenant_id             UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  -- Per-tenant, not global -- see 2026-09-01-05-scope-document-numbers-per-tenant.sql.
  UNIQUE (tenant_id, payment_number)
);

CREATE INDEX idx_labor_payment_contract ON labor_payments(contract_id);
CREATE INDEX idx_labor_payment_date     ON labor_payments(payment_date);
CREATE INDEX idx_labor_payments_tenant_id ON labor_payments(tenant_id);

-- labor_subcontractors-module RLS (see
-- supabase/migrations/2026-08-16-10-tenant-scoped-rls-modules.sql): same
-- admin_full_access shape as labor_subcontractors/labor_contracts above.
ALTER TABLE labor_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON labor_payments FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('labor_subcontractors'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('labor_subcontractors'));

-- ----------------------------------------------------------------
-- AUDIT_LOGS — ประวัติการแก้ไขข้อมูล (INSERT/UPDATE/DELETE)
-- ----------------------------------------------------------------
CREATE TABLE audit_logs (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  table_name  TEXT NOT NULL,
  record_id   UUID,
  action      TEXT NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
  user_email  TEXT,
  changed_at  TIMESTAMPTZ DEFAULT NOW(),
  old_values  JSONB,
  new_values  JSONB,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_audit_record ON audit_logs(record_id);
CREATE INDEX idx_audit_table  ON audit_logs(table_name);
CREATE INDEX idx_audit_time   ON audit_logs(changed_at DESC);
CREATE INDEX idx_audit_logs_tenant_id ON audit_logs(tenant_id);

-- Group C core-table RLS (see supabase/migrations/2026-08-16-09-tenant-scoped-rls-core.sql):
-- ADMIN+ reads their own tenant's rows; any authenticated write within
-- the tenant is logged automatically (system_insert), still gated by
-- tenant_can_write() since a write-locked tenant can't mutate anything
-- to log in the first place. No UPDATE/DELETE policy for anyone —
-- audit log rows are append-only by design.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_read ON audit_logs FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id());
CREATE POLICY system_insert ON audit_logs FOR INSERT TO authenticated
  WITH CHECK (tenant_id = current_tenant_id() AND tenant_can_write());

-- ----------------------------------------------------------------
-- TENANTS — แบ่งแยกข้อมูล SaaS (บริษัท/องค์กรในระบบ)
-- ----------------------------------------------------------------
-- owner_user_id is bookkeeping only (who created the tenant) — never read
-- by any RLS policy or app query. Nullable with ON DELETE SET NULL: a
-- pre-existing trigger (handle_user_role_deleted) auto-deletes a user's
-- auth.users row whenever their user_roles row is deleted, which would
-- otherwise fail with an FK violation whenever that user happens to be a
-- still-existing tenant's owner_user_id (e.g. via UserManagement.jsx's
-- "delete user" action on the tenant's founding OWNER).
CREATE TABLE tenants (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name        TEXT NOT NULL,
  owner_user_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  plan                TEXT NOT NULL DEFAULT 'trial' CHECK (plan IN ('trial','active','expired')),
  trial_ends_at       TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Nullable: existing tenants (including FacadeX's own bootstrap tenant)
  -- have no contractor type set — nothing back-assigns one. Added by
  -- supabase/migrations/2026-08-17-07-contractor-type-templates.sql.
  contractor_type_id  UUID REFERENCES contractor_types(id)
);

-- Company profile for client-facing document letterheads (Quotation now,
-- Invoice later). All nullable — existing tenants simply have an incomplete
-- letterhead until an OWNER fills these in via Settings. Covered by tenants'
-- EXISTING RLS (member_reads_own_tenant / owner_updates_own_tenant) — no new
-- policy needed for plain columns. Added by
-- supabase/migrations/2026-08-22-01-tenant-company-profile.sql.
ALTER TABLE tenants
  ADD COLUMN address           TEXT,
  ADD COLUMN tax_id            TEXT,
  ADD COLUMN phone             TEXT,
  ADD COLUMN logo_url          TEXT,
  ADD COLUMN bank_name         TEXT,
  ADD COLUMN bank_account_name TEXT,
  ADD COLUMN bank_account_no   TEXT;

-- Default boilerplate text for new quotations' "เงื่อนไขการชำระเงิน" and
-- "หมายเหตุ" — set once per tenant in Settings, pre-fills every new
-- quotation, editable per document same as today. Added by
-- supabase/migrations/2026-08-22-06-quotation-default-templates.sql.
ALTER TABLE tenants
  ADD COLUMN default_payment_terms TEXT,
  ADD COLUMN default_notes         TEXT;

-- Company email/website for the new document-header contact line (spec:
-- docs/superpowers/specs/2026-09-04-document-header-pagination-design.md).
-- Same nullable-column pattern as address/tax_id/phone from
-- 2026-08-22-01-tenant-company-profile.sql. Added by
-- supabase/migrations/2026-09-04-01-tenant-contact-fields.sql.
ALTER TABLE tenants
  ADD COLUMN email   TEXT,
  ADD COLUMN website TEXT;

-- Per-tenant document header style overrides (spec:
-- docs/superpowers/specs/2026-09-04-document-style-customizer-design.md).
-- NULL means "use DEFAULT_DOCUMENT_STYLE" (src/lib/documentStyle.js).
-- Added by supabase/migrations/2026-09-04-02-tenant-document-style.sql.
ALTER TABLE tenants
  ADD COLUMN document_style JSONB;

-- ----------------------------------------------------------------
-- TENANT_MODULES — รูปแบบ/โมดูลที่เปิดใช้งานต่อบริษัท
-- ----------------------------------------------------------------
CREATE TABLE tenant_modules (
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  module_key TEXT NOT NULL CHECK (module_key IN ('payroll','labor_subcontractors','purchase_orders','client_deposits','quotations','invoices','cheque_tracking')),
  enabled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, module_key)
);

-- Bootstrap seed (supabase/migrations/2026-08-16-14-seed-bootstrap-tenant-modules.sql):
-- the FacadeX bootstrap tenant (see the tenants comment above) has
-- plan='active' but an expired trial, so it needs explicit tenant_modules
-- rows to keep Payroll/HR/Assign and labor subcontractors unlocked —
-- ON CONFLICT DO NOTHING, safe to replay.
--   INSERT INTO tenant_modules (tenant_id, module_key)
--   SELECT id, 'payroll' FROM tenants WHERE company_name = 'Facade X'
--   UNION ALL
--   SELECT id, 'labor_subcontractors' FROM tenants WHERE company_name = 'Facade X'
--   ON CONFLICT (tenant_id, module_key) DO NOTHING;
--
-- purchase_orders bootstrap seed (supabase/migrations/2026-08-17-03-purchase-orders-module-key.sql):
-- same reasoning, same tenant, new module.
--   INSERT INTO tenant_modules (tenant_id, module_key)
--   SELECT id, 'purchase_orders' FROM tenants WHERE company_name = 'Facade X'
--   ON CONFLICT (tenant_id, module_key) DO NOTHING;

-- Tenant management Phase 1 -- see
-- docs/superpowers/specs/2026-08-29-tenant-management-page-design.md and
-- 2026-08-29-11-tenant-management-packages.sql. platform_admins is a
-- flat allowlist (no role/tenant scoping -- it's the root of trust for
-- everything below it). packages/package_modules are just named,
-- reusable module bundles over the existing tenant_modules module_key
-- values -- assigning a tenant to a package syncs tenant_modules to
-- match, so has_module_access() below is completely unaffected by any
-- of this; packages are a management convenience, not a parallel
-- access-control system.
CREATE TABLE platform_admins (
  user_email  TEXT PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO platform_admins (user_email) VALUES ('contact@facadex.co.th');

ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
CREATE POLICY platform_admins_read_own ON platform_admins FOR SELECT TO authenticated
  USING (user_email = auth.email());

CREATE TABLE packages (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL UNIQUE,
  sort_order     INT NOT NULL DEFAULT 0,
  price_monthly  NUMERIC, -- NULL = "Custom / contact us" (Enterprise)
  price_yearly   NUMERIC, -- total annual price, not a monthly-equivalent
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE package_modules (
  package_id  UUID NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  module_key  TEXT NOT NULL CHECK (module_key IN
    ('payroll','labor_subcontractors','purchase_orders','client_deposits','quotations','invoices','cheque_tracking')),
  PRIMARY KEY (package_id, module_key)
);

-- Added here (not inline on tenants' own CREATE TABLE above) because it
-- references packages, defined after tenants in this file.
ALTER TABLE tenants ADD COLUMN package_id UUID REFERENCES packages(id) ON DELETE SET NULL;

-- 5-tier pricing (2026-08-29-13-package-pricing-5-tier.sql), exact
-- supersets of each other (Free ⊂ Solo ⊂ Pro Team ⊂ Business =
-- Enterprise -- Enterprise has the same modules as Business today; no
-- more module keys exist to differentiate it further, its real
-- distinction would be seat limits/custom terms which aren't built).
-- Real prices, but scope-limited to what's actually enforceable: this
-- app has zero seat/usage-limit infrastructure (no admin/worker/site
-- counting, no per-month quotation caps) despite an external pricing
-- deck describing such limits -- not promised here. Retention also
-- stays ungated (module: null in App.jsx, unchanged) even though that
-- deck shows it as Business-and-up, since paywalling something
-- currently free for the one real tenant was never explicitly decided.
INSERT INTO packages (name, sort_order, price_monthly, price_yearly) VALUES
  ('Free', 1, 0, 0),
  ('Solo', 2, 990, 9480),
  ('Pro Team', 3, 2990, 28680),
  ('Business', 4, 6990, 67080),
  ('Enterprise', 5, NULL, NULL);

INSERT INTO package_modules (package_id, module_key)
SELECT id, 'quotations' FROM packages WHERE name = 'Free';

INSERT INTO package_modules (package_id, module_key)
SELECT id, m FROM packages, unnest(ARRAY['quotations','invoices','cheque_tracking']) m
WHERE name = 'Solo';

INSERT INTO package_modules (package_id, module_key)
SELECT id, m FROM packages,
  unnest(ARRAY['quotations','invoices','purchase_orders','client_deposits','cheque_tracking']) m
WHERE name = 'Pro Team';

INSERT INTO package_modules (package_id, module_key)
SELECT id, m FROM packages,
  unnest(ARRAY['quotations','invoices','purchase_orders','client_deposits','payroll','labor_subcontractors','cheque_tracking']) m
WHERE name = 'Business';

INSERT INTO package_modules (package_id, module_key)
SELECT id, m FROM packages,
  unnest(ARRAY['quotations','invoices','purchase_orders','client_deposits','payroll','labor_subcontractors','cheque_tracking']) m
WHERE name = 'Enterprise';

ALTER TABLE packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE package_modules ENABLE ROW LEVEL SECURITY;
CREATE POLICY platform_admin_full_access ON packages FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()))
  WITH CHECK (EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()));
CREATE POLICY platform_admin_full_access ON package_modules FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()))
  WITH CHECK (EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()));

-- packages/package_modules were platform-admin-only (no SELECT for regular
-- tenant users at all) -- needed to build a live tier-comparison view for
-- tenants (Settings.jsx). Pricing/limits/module lists are not sensitive
-- (equivalent to a public pricing page), so opened broadly to any
-- authenticated user; write access stays platform-admin-only via the
-- platform_admin_full_access (FOR ALL) policy above.
CREATE POLICY authenticated_read ON packages FOR SELECT TO authenticated USING (true);
CREATE POLICY authenticated_read ON package_modules FOR SELECT TO authenticated USING (true);

-- Seat/site limits per package tier (2026-08-29-14-package-seat-limits.sql).
-- Scoped to totals only (Admins/Workers/Sites), NOT monthly document-count
-- limits (e.g. "10 ใบเสนอราคา/เดือน") -- a rolling time-window count,
-- meaningfully harder, left for later.
--
-- "Admin" = user_roles rows with role IN ('OWNER','ADMIN'). "Worker" = the
-- `workers` HR/payroll table -- a completely separate concept from a
-- WORKER-role login account (uncounted here). "Site" = sites with
-- status='Ongoing' only -- completed/cancelled projects don't count
-- against the limit forever.
ALTER TABLE packages ADD COLUMN max_admins  INT; -- NULL = unlimited
ALTER TABLE packages ADD COLUMN max_workers INT;
ALTER TABLE packages ADD COLUMN max_sites   INT;

UPDATE packages SET max_admins = 1,  max_workers = 5,    max_sites = 1  WHERE name = 'Free';
UPDATE packages SET max_admins = 3,  max_workers = 20,   max_sites = 3  WHERE name = 'Solo';
UPDATE packages SET max_admins = 10, max_workers = NULL, max_sites = 10 WHERE name = 'Pro Team';
UPDATE packages SET max_admins = 25, max_workers = NULL, max_sites = NULL WHERE name = 'Business';
UPDATE packages SET max_admins = NULL, max_workers = NULL, max_sites = NULL WHERE name = 'Enterprise';

-- A tenant with no package assigned (package_id IS NULL, e.g. still on
-- trial before ever picking one) gets no limit -- the LEFT JOIN makes
-- v_limit NULL for them, same as an explicitly-unlimited tier.
-- p_inclusive distinguishes two different points in a row's lifecycle
-- that both call this function: the RLS INSERT policies below check
-- BEFORE the new row exists (p_inclusive=false, "<" -- count of existing
-- rows must be strictly under the limit to allow one more), while
-- check_seat_limit_after_statement()'s AFTER-statement trigger checks
-- AFTER the row(s) are already committed and counted (p_inclusive=true,
-- "<=" -- the new total may legally equal the limit). Reusing the same
-- "<" for both (the original bug, fixed in
-- 2026-09-05-05-fix-seat-limit-off-by-one.sql) rejected a tenant's exact
-- LAST allowed seat on any tiered plan -- e.g. a Free-tier tenant's very
-- first site, since Free's max_sites=1 makes "first" and "last" the same
-- seat.
CREATE FUNCTION tenant_under_seat_limit(p_kind TEXT, p_inclusive BOOLEAN DEFAULT false)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := current_tenant_id();
  v_limit NUMERIC;
  v_count NUMERIC;
BEGIN
  SELECT CASE p_kind
    WHEN 'admins'  THEN p.max_admins
    WHEN 'workers' THEN p.max_workers
    WHEN 'sites'   THEN p.max_sites
  END INTO v_limit
  FROM tenants t
  LEFT JOIN packages p ON p.id = t.package_id
  WHERE t.id = v_tenant_id;

  IF v_limit IS NULL THEN
    RETURN true;
  END IF;

  CASE p_kind
    WHEN 'admins' THEN
      SELECT count(*) INTO v_count FROM user_roles
      WHERE tenant_id = v_tenant_id AND role IN ('OWNER','ADMIN');
    WHEN 'workers' THEN
      SELECT count(*) INTO v_count FROM workers WHERE tenant_id = v_tenant_id;
    WHEN 'sites' THEN
      SELECT count(*) INTO v_count FROM sites
      WHERE tenant_id = v_tenant_id AND status = 'Ongoing';
  END CASE;

  RETURN CASE WHEN p_inclusive THEN v_count <= v_limit ELSE v_count < v_limit END;
END;
$$;

REVOKE EXECUTE ON FUNCTION tenant_under_seat_limit(TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION tenant_under_seat_limit(TEXT, BOOLEAN) TO authenticated;

-- Read-only seat usage/limits for the caller's own tenant, callable by any
-- authenticated tenant member (not just OWNER/ADMIN) -- lets
-- UserManagement.jsx/HR.jsx/Sites.jsx render a friendly pre-submit warning
-- without exposing the `packages` table itself (platform-admin-only).
CREATE OR REPLACE FUNCTION tenant_seat_status()
RETURNS TABLE(kind TEXT, used BIGINT, max_allowed INT)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := current_tenant_id();
  v_max_admins INT;
  v_max_workers INT;
  v_max_sites INT;
BEGIN
  SELECT p.max_admins, p.max_workers, p.max_sites
  INTO v_max_admins, v_max_workers, v_max_sites
  FROM tenants t LEFT JOIN packages p ON p.id = t.package_id
  WHERE t.id = v_tenant_id;

  RETURN QUERY SELECT 'admins'::TEXT,
    (SELECT count(*) FROM user_roles WHERE tenant_id = v_tenant_id AND role IN ('OWNER','ADMIN')), v_max_admins
  UNION ALL SELECT 'workers'::TEXT,
    (SELECT count(*) FROM workers WHERE tenant_id = v_tenant_id), v_max_workers
  UNION ALL SELECT 'sites'::TEXT,
    (SELECT count(*) FROM sites WHERE tenant_id = v_tenant_id AND status = 'Ongoing'), v_max_sites;
END;
$$;

REVOKE EXECUTE ON FUNCTION tenant_seat_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION tenant_seat_status() TO authenticated;

-- Redefined here (not inline on user_roles/workers/sites' own CREATE POLICY
-- above) because tenant_under_seat_limit() is defined after those tables in
-- this file. Admin-seat limit only applies when the new row is itself an
-- OWNER/ADMIN invite -- a WORKER-role login account isn't an "Admin" here.
DROP POLICY owner_inserts ON user_roles;
CREATE POLICY owner_inserts ON user_roles FOR INSERT TO authenticated
  WITH CHECK (
    is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write()
    AND (role NOT IN ('OWNER','ADMIN') OR tenant_under_seat_limit('admins'))
  );

DROP POLICY admin_writes_workers ON workers;
CREATE POLICY admin_writes_workers ON workers FOR INSERT TO authenticated
  WITH CHECK (
    is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll')
    AND tenant_under_seat_limit('workers')
  );

DROP POLICY admin_inserts ON sites;
CREATE POLICY admin_inserts ON sites FOR INSERT TO authenticated
  WITH CHECK (
    is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write()
    AND tenant_under_seat_limit('sites')
  );

-- The real admin-invite flow (UserManagement.jsx) never hits owner_inserts
-- above: handle_new_user() (SECURITY DEFINER, bypasses RLS) always creates
-- the user_roles row as WORKER first, then the app's own
-- upsert(onConflict: user_email) resolves as an UPDATE since the row
-- already exists. This is the actual enforcement point for promotion
-- (WORKER -> ADMIN/OWNER). "old.id = user_roles.id" must stay qualified
-- with the outer table name -- an unqualified "id" on the right resolves
-- to the subquery's own "old" alias (innermost scope wins), making the
-- EXISTS always true regardless of which row is being updated.
DROP POLICY owner_updates ON user_roles;
CREATE POLICY owner_updates ON user_roles FOR UPDATE TO authenticated
  USING (is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (
    is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write()
    AND (
      role NOT IN ('OWNER','ADMIN')
      OR EXISTS (SELECT 1 FROM user_roles old WHERE old.id = user_roles.id AND old.role IN ('OWNER','ADMIN'))
      OR tenant_under_seat_limit('admins')
    )
  );

-- Closes a loophole in the ongoing-site limit: since tenant_under_seat_limit
-- only counts status='Ongoing' sites, a tenant at the cap could mark an
-- Ongoing site Completed (frees a "slot"), create a new Ongoing site, then
-- flip the Completed one back to Ongoing via UPDATE -- ungated by the
-- INSERT-only policy above. Same no-op exemption: only blocks when status
-- is actually transitioning INTO Ongoing from something else.
DROP POLICY admin_updates ON sites;
CREATE POLICY admin_updates ON sites FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (
    is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write()
    AND (
      status IS DISTINCT FROM 'Ongoing'
      OR EXISTS (SELECT 1 FROM sites old WHERE old.id = sites.id AND old.status = 'Ongoing')
      OR tenant_under_seat_limit('sites')
    )
  );

-- Closes a batch-insert/batch-update bypass: RLS WITH CHECK is evaluated
-- per-row against a per-statement snapshot, so sibling rows within the SAME
-- multi-row INSERT/UPDATE never see each other's pending changes -- e.g. a
-- single 3-row batch insert of new Ongoing sites can all pass a max_sites=1
-- cap independently, each seeing the same pre-statement count of 0.
-- Directly reachable via ExcelUpload.jsx's bulk .insert(rows), not just a
-- crafted API call. Fixed with an AFTER ... FOR EACH STATEMENT trigger that
-- re-validates the aggregate once after the whole batch lands -- if it
-- fails, the entire statement (all rows) rolls back. Reuses
-- tenant_under_seat_limit() unchanged.
CREATE OR REPLACE FUNCTION check_seat_limit_after_statement()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_kind TEXT := TG_ARGV[0];
BEGIN
  IF NOT tenant_under_seat_limit(v_kind, true) THEN
    RAISE EXCEPTION 'Package % limit exceeded for this tenant', v_kind
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_seat_limit_sites AFTER INSERT OR UPDATE ON sites
  FOR EACH STATEMENT EXECUTE FUNCTION check_seat_limit_after_statement('sites');
CREATE TRIGGER trg_seat_limit_user_roles AFTER INSERT OR UPDATE ON user_roles
  FOR EACH STATEMENT EXECUTE FUNCTION check_seat_limit_after_statement('admins');
CREATE TRIGGER trg_seat_limit_workers AFTER INSERT ON workers
  FOR EACH STATEMENT EXECUTE FUNCTION check_seat_limit_after_statement('workers');

-- check_seat_limit_after_statement() is a trigger function (RETURNS
-- TRIGGER), never meant to be called directly -- Postgres itself already
-- blocks invoking it outside a trigger context, so this isn't exploitable,
-- but every other SECURITY DEFINER function added this session got an
-- explicit REVOKE/GRANT and this one was missed. Closes a security-advisor
-- warning and matches the established pattern. Verified live: trigger
-- firing is unaffected (it doesn't go through the caller's own EXECUTE
-- grant), both a legitimate insert and the batch-bypass block still work.
REVOKE EXECUTE ON FUNCTION check_seat_limit_after_statement() FROM PUBLIC, anon, authenticated;

-- Every RLS policy in this file scopes reads/writes to the caller's own
-- tenant via current_tenant_id() -- these two functions are the only
-- place a caller can ever see or touch another tenant's row, and only
-- when they're in platform_admins (re-checked inside the function body,
-- not just assumed from the caller's own role, since SECURITY DEFINER
-- bypasses tenants/tenant_modules RLS entirely for these two calls).
-- plan_expires_at / tenant_status_log -- Phase 2 (paid status). No
-- payment gateway exists, so this is purely a manual admin toggle +
-- expiry date; tenant_status_log is a "who changed what, when" audit
-- trail only, no amount/payment-channel tracking (confirmed with the
-- user). tenant_status_log has no current_tenant_id() scoping (it's
-- platform-admin meta-data, not tenant-owned data), so unlike
-- tenants/tenant_modules it's readable directly by any platform admin --
-- no SECURITY DEFINER wrapper needed for reads, same shape as
-- packages/package_modules above.
ALTER TABLE tenants ADD COLUMN plan_expires_at TIMESTAMPTZ;

CREATE TABLE tenant_status_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan             TEXT NOT NULL CHECK (plan IN ('trial','active','expired')),
  plan_expires_at  TIMESTAMPTZ,
  changed_by       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE tenant_status_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY platform_admin_full_access ON tenant_status_log FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()))
  WITH CHECK (EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()));

CREATE INDEX idx_tenant_status_log_tenant_id ON tenant_status_log(tenant_id);

CREATE FUNCTION platform_list_tenants()
RETURNS TABLE (
  id UUID, company_name TEXT, plan TEXT, trial_ends_at TIMESTAMPTZ, plan_expires_at TIMESTAMPTZ,
  package_id UUID, package_name TEXT, created_at TIMESTAMPTZ
)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT t.id, t.company_name, t.plan, t.trial_ends_at, t.plan_expires_at, t.package_id, p.name, t.created_at
  FROM tenants t
  LEFT JOIN packages p ON p.id = t.package_id
  WHERE EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email())
  ORDER BY t.company_name;
$$;

CREATE FUNCTION platform_set_tenant_package(p_tenant_id UUID, p_package_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()) THEN
    RAISE EXCEPTION 'not a platform admin';
  END IF;

  UPDATE tenants SET package_id = p_package_id WHERE id = p_tenant_id;

  DELETE FROM tenant_modules
  WHERE tenant_id = p_tenant_id
    AND module_key NOT IN (SELECT module_key FROM package_modules WHERE package_id = p_package_id);

  INSERT INTO tenant_modules (tenant_id, module_key)
  SELECT p_tenant_id, module_key FROM package_modules WHERE package_id = p_package_id
  ON CONFLICT (tenant_id, module_key) DO NOTHING;
END;
$$;

CREATE FUNCTION platform_set_tenant_status(p_tenant_id UUID, p_plan TEXT, p_plan_expires_at TIMESTAMPTZ)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()) THEN
    RAISE EXCEPTION 'not a platform admin';
  END IF;

  UPDATE tenants SET plan = p_plan, plan_expires_at = p_plan_expires_at WHERE id = p_tenant_id;

  INSERT INTO tenant_status_log (tenant_id, plan, plan_expires_at, changed_by)
  VALUES (p_tenant_id, p_plan, p_plan_expires_at, auth.email());
END;
$$;

REVOKE EXECUTE ON FUNCTION platform_list_tenants() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION platform_set_tenant_package(UUID, UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION platform_set_tenant_status(UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION platform_list_tenants() TO authenticated;
GRANT EXECUTE ON FUNCTION platform_set_tenant_package(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION platform_set_tenant_status(UUID, TEXT, TIMESTAMPTZ) TO authenticated;

-- has_module_access(): true for every module during an active trial
-- (trial_ends_at > now()), regardless of tenant_modules contents;
-- once the trial ends, true only for modules explicitly enabled in
-- tenant_modules. SECURITY DEFINER so it can read tenants/tenant_modules
-- regardless of the caller's own RLS visibility into those tables.
-- NOTE: plan='active' alone does NOT grant module access — modules are
-- paid add-ons on top of the base plan, not automatically included when
-- a plan is active. A future billing/plan-upgrade flow converting a
-- trial to a paid plan with modules must also write the corresponding
-- tenant_modules rows, or it will silently lock out functionality (see
-- 2026-08-16-14-seed-bootstrap-tenant-modules.sql for exactly this bug).
CREATE OR REPLACE FUNCTION has_module_access(p_module_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT trial_ends_at > now() FROM tenants WHERE id = current_tenant_id())
    OR EXISTS (
      SELECT 1 FROM tenant_modules
      WHERE tenant_id = current_tenant_id() AND module_key = p_module_key
    ),
    false
  );
$$;

-- Spec §4: an expired trial (no active plan) can still READ core data
-- but loses WRITE access until a plan is purchased. Distinct from
-- has_module_access(), which fully blocks reads too — modules and
-- core tables degrade differently by design, not by accident.
CREATE OR REPLACE FUNCTION tenant_can_write()
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT trial_ends_at > now() OR plan = 'active' FROM tenants WHERE id = current_tenant_id()),
    false
  );
$$;

-- ── tenants: any member of the tenant can read their own tenant row
-- (needed for the trial-countdown banner); only OWNER can update it
-- (plan changes land here once billing ships — sub-project 3, not
-- built yet, but least-privilege now costs nothing). No INSERT/DELETE
-- policy for `authenticated` — rows are only ever created by the
-- SECURITY DEFINER signup trigger, which bypasses RLS. ──
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

CREATE POLICY member_reads_own_tenant ON tenants FOR SELECT TO authenticated
  USING (id = current_tenant_id());

CREATE POLICY owner_updates_own_tenant ON tenants FOR UPDATE TO authenticated
  USING (is_owner() AND id = current_tenant_id())
  WITH CHECK (is_owner() AND id = current_tenant_id());

-- ── tenant_modules: any member can read their tenant's enabled
-- modules (needed by useTenant.js). No write policy for
-- `authenticated` yet — enabling a paid module is a billing-flow
-- action (sub-project 3, not built), so writes stay service-role-only
-- until that ships. ──
ALTER TABLE tenant_modules ENABLE ROW LEVEL SECURITY;

CREATE POLICY member_reads_own_modules ON tenant_modules FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id());

-- ----------------------------------------------------------------
-- USER_ROLES — สิทธิ์การใช้งาน ผูกกับ Supabase Auth ผ่าน user_email
-- RLS: read is scoped to the caller's own tenant (2026-08-16 — the
-- previous read_all_roles policy was USING (true), leaking every
-- tenant's email+role roster to every authenticated user under
-- multi-tenancy; fixed by
-- supabase/migrations/2026-08-16-09-tenant-scoped-rls-core.sql). Only
-- OWNER can write, additionally gated by tenant_can_write().
-- ----------------------------------------------------------------
CREATE TABLE user_roles (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_email TEXT NOT NULL UNIQUE,
  role       TEXT NOT NULL CHECK (role IN ('OWNER','ADMIN','WORKER')),
  status     VARCHAR DEFAULT 'approved' CHECK (status IN ('pending','approved')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  -- No DEFAULT current_tenant_id() here (unlike every other table): a
  -- brand-new signup has no user_roles row yet, so current_tenant_id()
  -- would resolve to NULL at exactly the moment the signup trigger needs
  -- to create this first row — it must set tenant_id explicitly instead
  -- (see the tenant-aware signup trigger).
  tenant_id  UUID NOT NULL REFERENCES tenants(id)
);

CREATE INDEX idx_user_roles_tenant_id ON user_roles(tenant_id);

-- current_tenant_id() resolves the calling session's tenant via
-- user_roles.user_email = auth.email(). SECURITY DEFINER so it can read
-- user_roles regardless of the caller's own RLS visibility into that
-- table; STABLE since it only depends on the current row/session, not
-- on statement-level mutations. Used as DEFAULT on every tenant-scoped
-- table below except user_roles itself (see note on that column).
CREATE OR REPLACE FUNCTION current_tenant_id()
RETURNS UUID
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT tenant_id FROM user_roles WHERE user_email = auth.email();
$$;

-- current_user_role()/is_admin_or_owner()/is_owner() — the original
-- (pre-multi-tenancy) RLS-helper functions from the 2026-08-15 rollout,
-- reused unchanged by every policy above and below that checks role.
-- Same SECURITY DEFINER + fixed search_path shape as current_tenant_id().
CREATE OR REPLACE FUNCTION current_user_role()
RETURNS TEXT
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT role FROM user_roles WHERE user_email = auth.email();
$$;

CREATE OR REPLACE FUNCTION is_admin_or_owner()
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT COALESCE(current_user_role() IN ('ADMIN','OWNER'), false);
$$;

CREATE OR REPLACE FUNCTION is_owner()
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT COALESCE(current_user_role() = 'OWNER', false);
$$;

-- Locked down to `authenticated` only (anon has no legitimate reason to
-- call these directly via /rest/v1/rpc/*) — see
-- 2026-08-16-05-security-advisor-fixes.sql.
REVOKE EXECUTE ON FUNCTION current_user_role() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION is_admin_or_owner() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION is_owner() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION current_user_role() TO authenticated;
GRANT EXECUTE ON FUNCTION is_admin_or_owner() TO authenticated;
GRANT EXECUTE ON FUNCTION is_owner() TO authenticated;

-- GPS-verified worker check-in/check-out functions.
-- Both perform_worker_* functions run SECURITY DEFINER so a WORKER-role
-- caller (who has no direct write access to worker_checkins/
-- worker_assignments/worker_ot, and no read access to app_settings) can
-- still confirm their OWN attendance through a narrow, server-validated
-- path. v_worker_id is ALWAYS resolved from auth.email() internally --
-- never trust a client-supplied worker id -- so a worker can only ever
-- check themselves in/out.
CREATE OR REPLACE FUNCTION haversine_distance_m(lat1 NUMERIC, lng1 NUMERIC, lat2 NUMERIC, lng2 NUMERIC)
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
SET search_path = public   -- required: Supabase's security advisor flags
                           -- function_search_path_mutable otherwise (2026-09-03-07)
AS $$
  -- Standard haversine formula, earth radius 6371000m. Returns meters.
  SELECT 6371000 * 2 * asin(sqrt(
    sin(radians(lat2 - lat1) / 2) ^ 2 +
    cos(radians(lat1)) * cos(radians(lat2)) * sin(radians(lng2 - lng1) / 2) ^ 2
  ));
$$;

CREATE OR REPLACE FUNCTION perform_worker_checkin(p_site_id UUID, p_lat NUMERIC, p_lng NUMERIC)
RETURNS TABLE(success BOOLEAN, distance_m NUMERIC, radius_m NUMERIC, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := current_tenant_id();
  v_worker_id UUID;
  v_site_lat NUMERIC;
  v_site_lng NUMERIC;
  v_radius NUMERIC;
  v_distance NUMERIC;
  v_today DATE := CURRENT_DATE;
BEGIN
  SELECT id INTO v_worker_id FROM workers WHERE email = auth.email() AND tenant_id = v_tenant_id;
  IF v_worker_id IS NULL THEN
    RETURN QUERY SELECT false, NULL::NUMERIC, NULL::NUMERIC, 'ไม่พบข้อมูลพนักงานที่ผูกกับบัญชีนี้'::TEXT;
    RETURN;
  END IF;

  SELECT lat, lng INTO v_site_lat, v_site_lng FROM sites WHERE id = p_site_id AND tenant_id = v_tenant_id;
  IF v_site_lat IS NULL OR v_site_lng IS NULL THEN
    RETURN QUERY SELECT false, NULL::NUMERIC, NULL::NUMERIC, 'ไซท์งานนี้ยังไม่ได้ตั้งพิกัด — ติดต่อสำนักงาน'::TEXT;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM worker_assignments
    WHERE worker_id = v_worker_id AND site_id = p_site_id AND date = v_today AND type = 'site' AND tenant_id = v_tenant_id
  ) THEN
    RETURN QUERY SELECT false, NULL::NUMERIC, NULL::NUMERIC, 'ไม่พบตารางงานของคุณที่ไซท์นี้วันนี้ — ติดต่อสำนักงาน'::TEXT;
    RETURN;
  END IF;

  SELECT COALESCE((SELECT value::numeric FROM app_settings WHERE tenant_id = v_tenant_id AND key = 'checkin_radius_m'), 200)
    INTO v_radius;
  v_distance := haversine_distance_m(p_lat, p_lng, v_site_lat, v_site_lng);

  IF v_distance > v_radius THEN
    RETURN QUERY SELECT false, v_distance, v_radius,
      format('คุณอยู่ห่างจากไซท์งาน %s เมตร ต้องอยู่ในระยะ %s เมตรจึงจะเช็คอินได้', round(v_distance), round(v_radius))::TEXT;
    RETURN;
  END IF;

  INSERT INTO worker_checkins (tenant_id, worker_id, site_id, date, checkin_at, checkin_lat, checkin_lng, checkin_distance_m)
  VALUES (v_tenant_id, v_worker_id, p_site_id, v_today, now(), p_lat, p_lng, v_distance)
  ON CONFLICT (worker_id, site_id, date) DO UPDATE
    SET checkin_at = now(), checkin_lat = p_lat, checkin_lng = p_lng, checkin_distance_m = v_distance;

  -- First confirmation wins -- don't clobber an admin override that may
  -- already be set (confirmed_by = admin's email, not 'checkin').
  UPDATE worker_assignments
  SET confirmed_at = now(), confirmed_by = 'checkin'
  WHERE worker_id = v_worker_id AND site_id = p_site_id AND date = v_today
    AND type = 'site' AND confirmed_at IS NULL AND tenant_id = v_tenant_id;

  RETURN QUERY SELECT true, v_distance, v_radius, 'เช็คอินสำเร็จ'::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION perform_worker_checkout(
  p_site_id UUID, p_lat NUMERIC, p_lng NUMERIC,
  p_ot_start TIME DEFAULT NULL, p_ot_end TIME DEFAULT NULL,
  p_ot_hours NUMERIC DEFAULT NULL, p_ot_is_overnight BOOLEAN DEFAULT false, p_ot_notes TEXT DEFAULT NULL
)
RETURNS TABLE(success BOOLEAN, distance_m NUMERIC, radius_m NUMERIC, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := current_tenant_id();
  v_worker_id UUID;
  v_site_lat NUMERIC;
  v_site_lng NUMERIC;
  v_radius NUMERIC;
  v_distance NUMERIC;
  v_today DATE := CURRENT_DATE;
BEGIN
  SELECT id INTO v_worker_id FROM workers WHERE email = auth.email() AND tenant_id = v_tenant_id;
  IF v_worker_id IS NULL THEN
    RETURN QUERY SELECT false, NULL::NUMERIC, NULL::NUMERIC, 'ไม่พบข้อมูลพนักงานที่ผูกกับบัญชีนี้'::TEXT;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM worker_checkins
    WHERE worker_id = v_worker_id AND site_id = p_site_id AND date = v_today AND tenant_id = v_tenant_id
  ) THEN
    RETURN QUERY SELECT false, NULL::NUMERIC, NULL::NUMERIC, 'ยังไม่ได้เช็คอินวันนี้ — เช็คอินก่อนจึงจะเช็คเอาท์ได้'::TEXT;
    RETURN;
  END IF;

  SELECT lat, lng INTO v_site_lat, v_site_lng FROM sites WHERE id = p_site_id AND tenant_id = v_tenant_id;
  IF v_site_lat IS NULL OR v_site_lng IS NULL THEN
    RETURN QUERY SELECT false, NULL::NUMERIC, NULL::NUMERIC, 'ไซท์งานนี้ยังไม่ได้ตั้งพิกัด — ติดต่อสำนักงาน'::TEXT;
    RETURN;
  END IF;

  SELECT COALESCE((SELECT value::numeric FROM app_settings WHERE tenant_id = v_tenant_id AND key = 'checkin_radius_m'), 200)
    INTO v_radius;
  v_distance := haversine_distance_m(p_lat, p_lng, v_site_lat, v_site_lng);

  IF v_distance > v_radius THEN
    RETURN QUERY SELECT false, v_distance, v_radius,
      format('คุณอยู่ห่างจากไซท์งาน %s เมตร ต้องอยู่ในระยะ %s เมตรจึงจะเช็คเอาท์ได้', round(v_distance), round(v_radius))::TEXT;
    RETURN;
  END IF;

  UPDATE worker_checkins
  SET checkout_at = now(), checkout_lat = p_lat, checkout_lng = p_lng, checkout_distance_m = v_distance
  WHERE worker_id = v_worker_id AND site_id = p_site_id AND date = v_today AND tenant_id = v_tenant_id;

  -- OT fields are optional -- the frontend (Task 7) decides whether the
  -- checkout time crosses the regular-shift-end setting and only passes
  -- these when it does. Trust level here matches admin-typed OT today
  -- (CellEditPopup.jsx): the number isn't re-derived server-side from
  -- p_ot_start/p_ot_end, same as an admin's manual entry isn't either.
  --
  -- The DO UPDATE ... WHERE guard (added 2026-09-03-07) means an auto-OT entry
  -- can only ever overwrite ANOTHER auto-OT entry, identified by the exact
  -- sentinel note TodayCheckinCard.jsx writes. Admin-entered OT for the same
  -- worker/day -- any other notes value, NULL included -- is left completely
  -- alone and the insert silently no-ops; the checkout itself still succeeds.
  -- KNOWN, DELIBERATELY PARKED: two auto entries for the same worker on the
  -- same day (two different sites) still clobber each other.
  IF p_ot_hours IS NOT NULL THEN
    INSERT INTO worker_ot (worker_id, site_id, date, start_time, end_time, ot_hours, is_overnight, notes, tenant_id)
    VALUES (v_worker_id, p_site_id, v_today, p_ot_start, p_ot_end, p_ot_hours, p_ot_is_overnight, p_ot_notes, v_tenant_id)
    ON CONFLICT (worker_id, date) DO UPDATE
      SET site_id = EXCLUDED.site_id, start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time,
          ot_hours = EXCLUDED.ot_hours, is_overnight = EXCLUDED.is_overnight, notes = EXCLUDED.notes
      WHERE worker_ot.notes = 'auto จากเช็คเอาท์';
  END IF;

  RETURN QUERY SELECT true, v_distance, v_radius, 'เช็คเอาท์สำเร็จ'::TEXT;
END;
$$;

REVOKE EXECUTE ON FUNCTION perform_worker_checkin(UUID, NUMERIC, NUMERIC) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION perform_worker_checkout(UUID, NUMERIC, NUMERIC, TIME, TIME, NUMERIC, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION perform_worker_checkin(UUID, NUMERIC, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION perform_worker_checkout(UUID, NUMERIC, NUMERIC, TIME, TIME, NUMERIC, BOOLEAN, TEXT) TO authenticated;

-- Small SECURITY DEFINER getter so a WORKER-role user can read the
-- tenant's regular_shift_end_time setting (app_settings.admin_reads
-- requires is_admin_or_owner(), so a worker can't SELECT it directly).
-- Task 7 (MySchedule check-in/out) needs this value client-side to
-- decide whether checkout crosses into OT territory before deciding
-- whether to pass p_ot_* params to perform_worker_checkout at all.
CREATE OR REPLACE FUNCTION get_regular_shift_end_time()
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT value FROM app_settings WHERE tenant_id = current_tenant_id() AND key = 'regular_shift_end_time'), '17:00');
$$;

REVOKE EXECUTE ON FUNCTION get_regular_shift_end_time() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_regular_shift_end_time() TO authenticated;

-- WORKER-safe site name lookup, matching this feature's established
-- SECURITY DEFINER pattern (see perform_worker_checkin/checkout):
-- `sites` itself is admin/owner-read-only (admin_reads policy), and
-- MySchedule.jsx (the WORKER-only schedule view -- see its header
-- comment: "no cost figures, RLS also enforces this") has no legitimate
-- read path to site names at all today, so every site-name lookup on
-- that page silently returns nothing. Rather than adding a WORKER SELECT
-- policy directly on `sites` (which would also expose contract_value and
-- other financial columns to any direct-table query, not just the
-- name/number this needs), this function returns only the 3 safe columns,
-- scoped to sites the calling worker currently has an assignment at.
CREATE OR REPLACE FUNCTION get_my_site_names()
RETURNS TABLE(id UUID, site_number TEXT, name TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT s.id, s.site_number, s.name
  FROM sites s
  JOIN worker_assignments wa ON wa.site_id = s.id AND wa.tenant_id = current_tenant_id()
  JOIN workers w ON w.id = wa.worker_id AND w.tenant_id = current_tenant_id()
  WHERE w.email = auth.email() AND s.tenant_id = current_tenant_id();
$$;

REVOKE EXECUTE ON FUNCTION get_my_site_names() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_my_site_names() TO authenticated;

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;

-- Group D core-table RLS (see supabase/migrations/2026-08-16-09-tenant-scoped-rls-core.sql).
CREATE POLICY read_all_roles ON user_roles FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id());
CREATE POLICY owner_inserts ON user_roles FOR INSERT TO authenticated
  WITH CHECK (is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY owner_updates ON user_roles FOR UPDATE TO authenticated
  USING (is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY owner_deletes ON user_roles FOR DELETE TO authenticated
  USING (is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

-- New Supabase Auth signups are assigned a role/tenant automatically.
-- Two signup paths share this trigger:
--   1. Self-serve company signup (Login.jsx signup mode) —
--      raw_user_meta_data has NO invited_tenant_id → create a new
--      tenant with a 14-day trial, caller becomes its OWNER. Also seeds
--      that new tenant's app_settings (travel_rate_per_km,
--      holiday_pay_multiplier) with the same defaults as the global seed
--      below (2026-08-16-15-signup-seeds-app-settings.sql) — app_settings
--      became per-tenant (PK (tenant_id, key)) and a brand-new trial
--      tenant can use the payroll module immediately, so without this
--      seed travel-cost/holiday-pay calculations would silently read
--      missing rows instead of failing loudly.
--   2. Admin-invited teammate (UserManagement.jsx) — passes
--      invited_tenant_id in auth.signUp's options.data → joins that
--      existing tenant as WORKER (UserManagement.jsx's own follow-up
--      upsert then sets the actually-chosen role, same as today). Does
--      NOT seed app_settings — it's joining a tenant that should already
--      have its own settings.
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_tenant_id UUID;
  v_invited_tenant_id UUID;
  v_contractor_type_id UUID;
BEGIN
  v_invited_tenant_id := (new.raw_user_meta_data->>'invited_tenant_id')::UUID;

  IF v_invited_tenant_id IS NOT NULL THEN
    v_tenant_id := v_invited_tenant_id;
  ELSE
    v_contractor_type_id := (new.raw_user_meta_data->>'contractor_type_id')::UUID;

    INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at, contractor_type_id)
    VALUES (
      COALESCE(new.raw_user_meta_data->>'company_name', new.email),
      new.id, 'trial', now() + interval '14 days', v_contractor_type_id
    )
    RETURNING id INTO v_tenant_id;

    INSERT INTO app_settings (tenant_id, key, value) VALUES
      (v_tenant_id, 'travel_rate_per_km', '20'),
      (v_tenant_id, 'holiday_pay_multiplier', '1.5')
    ON CONFLICT (tenant_id, key) DO NOTHING;

    -- Seed expense_categories + suppliers from the chosen contractor
    -- type's shared template rows (contractor_type_categories /
    -- contractor_type_category_suppliers). Only the newly-created tenant
    -- branch seeds — same reasoning as the app_settings seed above.
    -- Skipped entirely when contractor_type_id is absent/NULL (old
    -- client code or Task 4's dropdown not yet shipped): the tenant
    -- starts blank, exactly as it did before this change.
    IF v_contractor_type_id IS NOT NULL THEN
      INSERT INTO expense_categories (name, color, sort_order, tenant_id)
      SELECT name, color, sort_order, v_tenant_id
      FROM contractor_type_categories
      WHERE contractor_type_id = v_contractor_type_id;

      INSERT INTO suppliers (name, tenant_id)
      SELECT s.supplier_name, v_tenant_id
      FROM contractor_type_category_suppliers s
      JOIN contractor_type_categories c ON c.id = s.category_template_id
      WHERE c.contractor_type_id = v_contractor_type_id;
    END IF;
  END IF;

  INSERT INTO public.user_roles (user_email, role, status, tenant_id)
  VALUES (
    new.email,
    CASE WHEN v_invited_tenant_id IS NULL THEN 'OWNER' ELSE 'WORKER' END,
    'approved',
    v_tenant_id
  )
  ON CONFLICT (user_email) DO NOTHING;

  RETURN new;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- Deleting the auth account removes the role row, and vice versa —
-- kept in sync both directions.
CREATE OR REPLACE FUNCTION handle_auth_user_deleted()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  DELETE FROM public.user_roles WHERE user_email = OLD.email;
  RETURN OLD;
END;
$$;

CREATE TRIGGER on_auth_user_deleted
  AFTER DELETE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_auth_user_deleted();

CREATE OR REPLACE FUNCTION handle_user_role_deleted()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  DELETE FROM auth.users WHERE email = OLD.user_email;
  RETURN OLD;
END;
$$;

CREATE TRIGGER on_user_role_deleted
  AFTER DELETE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION handle_user_role_deleted();

-- These three are only ever invoked by Postgres's own trigger machinery
-- (which runs as the function owner regardless of EXECUTE grants) — no
-- role needs direct EXECUTE to call them via /rest/v1/rpc/*. Supabase's
-- project bootstrap grants EXECUTE directly to anon/authenticated
-- (separately from PUBLIC, and re-applied to new functions via ALTER
-- DEFAULT PRIVILEGES), so both must be revoked explicitly — REVOKE ...
-- FROM PUBLIC alone does not touch those grants.
REVOKE EXECUTE ON FUNCTION handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION handle_auth_user_deleted() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION handle_user_role_deleted() FROM PUBLIC, anon, authenticated;

-- Same pattern for the tenant-entitlement helper functions: used inside
-- RLS policies (which need `authenticated` to retain EXECUTE for policy
-- evaluation to work), but anon has no legitimate reason to call them
-- directly via /rest/v1/rpc/*.
REVOKE EXECUTE ON FUNCTION current_tenant_id() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION has_module_access(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION tenant_can_write() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION current_tenant_id() TO authenticated;
GRANT EXECUTE ON FUNCTION has_module_access(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION tenant_can_write() TO authenticated;

-- Bootstrap: after creating the very first account through the app's
-- Signup page, promote it to OWNER manually (the in-app User Management
-- page itself requires OWNER to access, so the first account can't do
-- this through the UI):
--   UPDATE user_roles SET role = 'OWNER' WHERE user_email = 'you@example.com';

-- ----------------------------------------------------------------
-- APP_SETTINGS — ค่าตั้งค่าระบบ (key/value)
-- ----------------------------------------------------------------
-- key was PRIMARY KEY alone before multi-tenancy; each tenant now needs
-- its own travel_rate_per_km etc., so the PK became (tenant_id, key).
CREATE TABLE app_settings (
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  tenant_id  UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  PRIMARY KEY (tenant_id, key)
);

CREATE INDEX idx_app_settings_tenant_id ON app_settings(tenant_id);

-- Group A core-table RLS (see supabase/migrations/2026-08-16-09-tenant-scoped-rls-core.sql).
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_reads ON app_settings FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id());
CREATE POLICY admin_inserts ON app_settings FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_updates ON app_settings FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_deletes ON app_settings FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

INSERT INTO app_settings (key, value) VALUES ('travel_rate_per_km', '20') ON CONFLICT (tenant_id, key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('holiday_pay_multiplier', '1.5') ON CONFLICT (tenant_id, key) DO NOTHING;

-- ----------------------------------------------------------------
-- CALENDAR_SYNC — mapping ระหว่าง assignment วันที่/ไซท์ กับ Google
-- Calendar event (สำหรับฟีเจอร์ sync อัตโนมัติที่ยังไม่เปิดใช้งานจริง)
-- ----------------------------------------------------------------
CREATE TABLE calendar_sync (
  site_id          UUID NOT NULL REFERENCES sites(id),
  assignment_date  DATE NOT NULL,
  google_event_id  TEXT NOT NULL,
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  tenant_id        UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  PRIMARY KEY (site_id, assignment_date)
);

CREATE INDEX idx_calendar_sync_tenant_id ON calendar_sync(tenant_id);

-- Group A core-table RLS (see supabase/migrations/2026-08-16-09-tenant-scoped-rls-core.sql).
ALTER TABLE calendar_sync ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_reads ON calendar_sync FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id());
CREATE POLICY admin_inserts ON calendar_sync FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_updates ON calendar_sync FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_deletes ON calendar_sync FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

-- ----------------------------------------------------------------
-- SITE_PHASES — เฟสงานต่อไซท์ (Gantt / S-curve), auto-seed 7 เฟส
-- มาตรฐานทุกครั้งที่สร้างไซท์ใหม่
-- ----------------------------------------------------------------
CREATE TABLE site_phases (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  site_id             UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  sort_order          INT NOT NULL DEFAULT 0,
  start_date          DATE,
  end_date            DATE,
  status              TEXT NOT NULL DEFAULT 'not_started'
                      CHECK (status IN ('not_started','in_progress','done')),
  billing_weight_pct  NUMERIC NOT NULL DEFAULT 0,   -- น้ำหนักเฟสนี้ต่อมูลค่างานรวม (รวมกัน 100%)
  depends_on_phase_id UUID REFERENCES site_phases(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_site_phases_site_id ON site_phases(site_id);
CREATE INDEX idx_site_phases_depends_on ON site_phases(depends_on_phase_id);
CREATE INDEX idx_site_phases_tenant_id ON site_phases(tenant_id);

-- Group A core-table RLS (see supabase/migrations/2026-08-16-09-tenant-scoped-rls-core.sql).
ALTER TABLE site_phases ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_reads ON site_phases FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id());
CREATE POLICY admin_inserts ON site_phases FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_updates ON site_phases FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_deletes ON site_phases FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

CREATE OR REPLACE FUNCTION seed_site_phases()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
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
$$;

CREATE TRIGGER trg_seed_site_phases
  AFTER INSERT ON sites
  FOR EACH ROW EXECUTE FUNCTION seed_site_phases();

-- ----------------------------------------------------------------
-- NUMBER GENERATORS — auto-assign เลขที่ให้ sites/clients/suppliers/
-- labor_subcontractors/incomes/labor_payments ตอน INSERT ถ้ายังว่าง
-- ทุกฟังก์ชันใช้ MAX(existing suffix)+1 (ไม่ใช่ COUNT(*)+1 ซึ่งพังถ้ามี
-- แถวถูกลบไปแล้วเลขที่ชนกัน — บั๊กนี้เคยเกิดจริงและถูกแก้แล้วทุกจุด)
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION generate_site_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  year_part TEXT := TO_CHAR(NOW(), 'YYYY');
  seq_num   INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(site_number FROM 'FX-\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM sites
  WHERE site_number LIKE 'FX-' || year_part || '-%';
  NEW.site_number := 'FX-' || year_part || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_site_number
  BEFORE INSERT ON sites
  FOR EACH ROW
  WHEN (NEW.site_number IS NULL OR NEW.site_number = '')
  EXECUTE FUNCTION generate_site_number();

CREATE OR REPLACE FUNCTION generate_client_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  year_part TEXT := TO_CHAR(NOW(), 'YYYY');
  seq_num   INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(client_number FROM 'CL-\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM clients
  WHERE client_number LIKE 'CL-' || year_part || '-%';
  NEW.client_number := 'CL-' || year_part || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_client_number
  BEFORE INSERT ON clients
  FOR EACH ROW
  WHEN (NEW.client_number IS NULL OR NEW.client_number = '')
  EXECUTE FUNCTION generate_client_number();

CREATE OR REPLACE FUNCTION generate_supplier_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  year_part TEXT := TO_CHAR(NOW(), 'YYYY');
  seq_num   INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(supplier_number FROM 'SP-\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM suppliers
  WHERE supplier_number LIKE 'SP-' || year_part || '-%';
  NEW.supplier_number := 'SP-' || year_part || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_supplier_number
  BEFORE INSERT ON suppliers
  FOR EACH ROW
  WHEN (NEW.supplier_number IS NULL OR NEW.supplier_number = '')
  EXECUTE FUNCTION generate_supplier_number();

-- When a supplier's default payment method or credit days changes, propagate
-- to that supplier's still-unpaid expenses only — rows already marked 'paid'
-- are a settled financial record and must not be silently rewritten.
-- billing_date is backfilled from the expense's order date if not already
-- set, then due_date is recomputed from the new credit_days (or cleared if
-- the supplier no longer has credit terms). See
-- 2026-08-16-02-supplier-payment-method.sql.
CREATE OR REPLACE FUNCTION propagate_supplier_payment_method()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.default_payment_method IS DISTINCT FROM OLD.default_payment_method)
     OR (NEW.credit_days IS DISTINCT FROM OLD.credit_days) THEN
    UPDATE expenses
    SET payment_method = NEW.default_payment_method,
        billing_date = COALESCE(billing_date, date),
        due_date = CASE
          WHEN NEW.credit_days IS NOT NULL THEN COALESCE(billing_date, date) + NEW.credit_days
          ELSE NULL
        END,
        updated_at = NOW()
    WHERE supplier_id = NEW.id
      AND status <> 'paid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_propagate_supplier_payment_method
AFTER UPDATE ON suppliers
FOR EACH ROW
EXECUTE FUNCTION propagate_supplier_payment_method();

CREATE OR REPLACE FUNCTION generate_subcontractor_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  year_part TEXT := TO_CHAR(NOW(), 'YYYY');
  seq_num   INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(subcontractor_number FROM 'LC-\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM labor_subcontractors
  WHERE subcontractor_number LIKE 'LC-' || year_part || '-%';
  NEW.subcontractor_number := 'LC-' || year_part || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_subcontractor_number
  BEFORE INSERT ON labor_subcontractors
  FOR EACH ROW
  WHEN (NEW.subcontractor_number IS NULL OR NEW.subcontractor_number = '')
  EXECUTE FUNCTION generate_subcontractor_number();

CREATE OR REPLACE FUNCTION generate_invoice_no()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  prefix  TEXT := 'IV' || TO_CHAR(NOW(), 'YYMM') || '-';
  seq_num INT;
BEGIN
  IF NEW.invoice_no IS NULL OR NEW.invoice_no = '' THEN
    SELECT COALESCE(MAX(SUBSTRING(invoice_no FROM 'IV\d{4}-(\d+)$')::INT), 0) + 1
    INTO seq_num
    FROM incomes WHERE invoice_no LIKE prefix || '%';
    NEW.invoice_no := prefix || LPAD(seq_num::TEXT, 3, '0');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_invoice_no
  BEFORE INSERT ON incomes
  FOR EACH ROW EXECUTE FUNCTION generate_invoice_no();

CREATE OR REPLACE FUNCTION generate_payment_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  prefix  TEXT := 'PY' || TO_CHAR(NOW(), 'YYMM') || '-';
  seq_num INT;
BEGIN
  IF NEW.payment_number IS NULL OR NEW.payment_number = '' THEN
    SELECT COALESCE(MAX(SUBSTRING(payment_number FROM 'PY\d{4}-(\d+)$')::INT), 0) + 1
    INTO seq_num
    FROM labor_payments WHERE payment_number LIKE prefix || '%';
    NEW.payment_number := prefix || LPAD(seq_num::TEXT, 3, '0');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_payment_number
  BEFORE INSERT ON labor_payments
  FOR EACH ROW EXECUTE FUNCTION generate_payment_number();

-- ----------------------------------------------------------------
-- VIEWS
-- ----------------------------------------------------------------

CREATE OR REPLACE VIEW expenses_view WITH (security_invoker = true) AS
SELECT
  e.*,
  s.name              AS site_name,
  s.site_number,
  s.status            AS site_status,
  ec.name             AS category_name,
  ec.color            AS category_color,
  sup.name            AS supplier_name,
  sup.supplier_number,
  sup.category        AS supplier_category
FROM expenses e
LEFT JOIN sites s ON e.site_id = s.id
LEFT JOIN expense_categories ec ON e.category_id = ec.id
LEFT JOIN suppliers sup ON e.supplier_id = sup.id;
-- Re-declared further down (after `cheques` exists) with cheque_id and
-- the joined cheque_no/bank/status appended -- see
-- 2026-09-01-03-fix-expenses-view-missing-cheque-columns.sql. Left as-is
-- here (not the final definition) because expenses.cheque_id and the
-- cheques table itself are both only defined later in this file, and
-- forward-referencing them here would break a fresh `psql < schema.sql`
-- run.

-- Explicit column list (not i.*) -- CREATE OR REPLACE VIEW freezes the
-- output column list at (re)creation time and never picks up columns
-- added to the base table afterward via ALTER TABLE. tenant_id/
-- income_type/deposit_deduction/source_invoice_id were all added to
-- `incomes` after this view's original i.* definition and were silently
-- missing from every SELECT until 2026-08-30-05-fix-incomes-view-missing-
-- columns.sql -- found live via the Income page's "หักมัดจำ" column
-- always showing "-" regardless of real deposit deductions, and (more
-- seriously) Income.jsx's edit form reading the always-undefined
-- income_type and silently reverting any "มัดจำ" row back to "ปกติ" on
-- save.
CREATE OR REPLACE VIEW incomes_view WITH (security_invoker = true) AS
SELECT
  i.id, i.invoice_no, i.date, i.site_id, i.client_name, i.description,
  i.amount_no_vat, i.vat, i.tax_withheld, i.retention, i.received_amount,
  i.created_at, i.updated_at,
  s.name AS site_name, s.site_number,
  i.tenant_id, i.income_type, i.deposit_deduction, i.source_invoice_id
FROM incomes i
LEFT JOIN sites s ON i.site_id = s.id;

-- total_expense/total_income are pre-aggregated in their own subqueries
-- before joining — joining expenses and incomes directly in one query (both
-- one-to-many from sites) produces a cartesian product per site, multiplying
-- each sum by the other table's row count for that site. Discovered live on
-- FX-2026-001: total_income showed ฿394,395,518 (real ฿3,585,414 × 110
-- expense rows), see 2026-08-16-01-fix-site-financial-summary-fanout.sql.
--
-- invoiced_amount must be comparable to sites.contract_value, which is
-- VAT-INCLUSIVE, and must respect the quotation's header-level discount
-- (quotation_items.unit_price / line_total are stored UNDISCOUNTED) --
-- see 2026-08-25-01-invoiced-amount-discount-vat-fix.sql. Without both
-- corrections a fully-billed site read as ~93.5% and any discounted
-- quotation read higher still.
CREATE OR REPLACE VIEW site_financial_summary WITH (security_invoker = true) AS
WITH quotation_discount AS (
  -- Mirrors quotationCalc.js's calcQuotationTotals discount math exactly:
  -- discount_pct takes precedence over discount_amount if both are set,
  -- and the multiplier is clamped so a discount larger than the raw total
  -- can never produce a negative price.
  SELECT q.id AS quotation_id,
         CASE
           WHEN COALESCE(q.discount_pct, 0) <> 0 THEN GREATEST(0, 1 - q.discount_pct / 100)
           WHEN q.discount_amount IS NOT NULL AND COALESCE(qt.raw_total, 0) > 0
             THEN GREATEST(0, (qt.raw_total - q.discount_amount) / qt.raw_total)
           ELSE 1
         END AS price_multiplier
  FROM quotations q
  LEFT JOIN (
    SELECT quotation_id, SUM(line_total) AS raw_total
    FROM quotation_items
    GROUP BY quotation_id
  ) qt ON qt.quotation_id = q.id
),
-- Real, already-tracked labor cost -- see
-- 2026-08-29-01-site-labor-cost-in-financial-summary.sql and
-- 2026-08-29-02-subcontractor-labor-cost-from-real-expenses.sql. Worker
-- cost is accrual by days/hours worked (labor_cost_by_site +
-- ot_cost_by_site) -- no real `expenses` row is ever created for it, so
-- it's added on top of exp.total_expense below. Subcontractor cost is
-- real, actually-paid `expenses` rows (is_subcontract = true, written by
-- LaborContractors.jsx's handleMarkPaid) -- those rows are already
-- counted inside exp.total_expense, so subcontractor_labor_cost is NOT
-- added again; it's exposed only as a labeled subset for display.
-- sites.cost_labor is no longer read here -- superseded by these two real
-- numbers.
worker_cost AS (
  SELECT site_id, SUM(labor_cost) AS labor_cost
  FROM labor_cost_by_site
  GROUP BY site_id
),
worker_ot AS (
  SELECT site_id, SUM(ot_cost) AS ot_cost
  FROM ot_cost_by_site
  GROUP BY site_id
),
subcontractor_cost AS (
  SELECT site_id, SUM(amount) AS subcontractor_labor_cost
  FROM expenses
  WHERE is_subcontract = true
  GROUP BY site_id
)
SELECT
  s.id, s.site_number, s.name, s.status, s.start_date, s.end_date, s.contract_value,
  s.client_id, s.client_name, s.location,
  s.cost_aluminum, s.cost_glass, s.cost_equipment, s.cost_rubber, s.cost_labor, s.cost_other,
  c.name            AS client_display_name,
  c.client_number,
  COALESCE(exp.total_expense, 0)
    + COALESCE(wc.labor_cost, 0) + COALESCE(wo.ot_cost, 0)             AS total_expense,
  COALESCE(inc.total_income, 0)                                       AS total_income,
  COALESCE(inc.total_income, 0)
    - (COALESCE(exp.total_expense, 0)
       + COALESCE(wc.labor_cost, 0) + COALESCE(wo.ot_cost, 0))         AS gross_profit,
  CASE WHEN s.contract_value > 0
    THEN ROUND(COALESCE(inc.total_income, 0) / s.contract_value * 100, 1)
    ELSE NULL
  END AS billing_pct,
  COALESCE(exp.outstanding_expense, 0) AS outstanding_expense,
  s.distance_km,
  s.map_url,
  c.contact_person AS client_contact_person,
  c.phone          AS client_phone,
  s.has_vat, s.contract_value_no_vat,
  s.default_vat_pct, s.default_tax_withheld_pct, s.default_retention_pct,
  s.default_retention_period_days, s.default_deposit_pct,
  COALESCE(inv.invoiced_amount, 0) AS invoiced_amount,
  CASE WHEN s.contract_value > 0
    THEN ROUND(COALESCE(inv.invoiced_amount, 0) / s.contract_value * 100, 1)
    ELSE NULL
  END AS invoiced_pct,
  -- Appended at the end: CREATE OR REPLACE VIEW requires existing column
  -- name/position to stay stable, so new columns must land last.
  COALESCE(wc.labor_cost, 0) + COALESCE(wo.ot_cost, 0) AS worker_labor_cost,
  COALESCE(sc.subcontractor_labor_cost, 0)             AS subcontractor_labor_cost,
  -- GPS check-in coordinates (added 2026-09-03-05). SiteForm's edit mode is
  -- populated from THIS view, not from `sites` -- without these two columns
  -- every site edit silently wrote lat/lng back as NULL.
  s.lat, s.lng
FROM sites s
LEFT JOIN clients c ON s.client_id = c.id
LEFT JOIN (
  SELECT site_id,
         SUM(amount) AS total_expense,
         SUM(CASE WHEN status IN ('pending','check_issued') THEN amount ELSE 0 END) AS outstanding_expense
  FROM expenses
  GROUP BY site_id
) exp ON exp.site_id = s.id
LEFT JOIN (
  SELECT site_id, SUM(received_amount) AS total_income
  FROM incomes
  GROUP BY site_id
) inc ON inc.site_id = s.id
LEFT JOIN worker_cost wc ON wc.site_id = s.id
LEFT JOIN worker_ot wo ON wo.site_id = s.id
LEFT JOIN subcontractor_cost sc ON sc.site_id = s.id
LEFT JOIN (
  SELECT q.site_id,
         SUM(
           qiu.cumulative_pct / 100 * qiu.unit_qty * qi.unit_price
           * COALESCE(qd.price_multiplier, 1)
           * CASE WHEN q.has_vat AND NOT q.price_includes_vat THEN 1.07 ELSE 1 END
         ) AS invoiced_amount
  FROM quotation_item_units qiu
  JOIN quotation_items qi ON qi.id = qiu.quotation_item_id
  JOIN quotations q ON q.id = qi.quotation_id
  LEFT JOIN quotation_discount qd ON qd.quotation_id = q.id
  WHERE q.site_id IS NOT NULL
  GROUP BY q.site_id
) inv ON inv.site_id = s.id;

-- Client retention due-date tracking -- see
-- 2026-08-19-02-site-retention-tracking.sql. Deliberately separate from
-- the labor subcontractor retention system (contractor_summary), which
-- hardcodes site.end_date + 6 months and is untouched by this feature.
CREATE VIEW site_retention_summary WITH (security_invoker = true) AS
SELECT
  s.id AS site_id,
  s.site_number,
  s.name,
  s.end_date,
  s.default_retention_period_days,
  s.retention_released,
  s.retention_released_date,
  COALESCE(SUM(i.retention), 0) AS total_retention,
  CASE
    WHEN s.end_date IS NOT NULL AND s.default_retention_period_days IS NOT NULL
    THEN (s.end_date + (s.default_retention_period_days || ' days')::INTERVAL)::DATE
    ELSE NULL
  END AS due_date
FROM sites s
LEFT JOIN incomes i ON i.site_id = s.id
GROUP BY s.id, s.site_number, s.name, s.end_date, s.default_retention_period_days,
         s.retention_released, s.retention_released_date;

-- Client deposit (มัดจำ) tracking -- see
-- 2026-08-19-03-client-deposit-tracking.sql. Separate money flow from
-- site_retention_summary above -- a deposit is collected once upfront and
-- progressively deducted from later income, retention is withheld from
-- every income and returned once at project close.
CREATE VIEW site_deposit_summary WITH (security_invoker = true) AS
SELECT
  s.id AS site_id,
  s.site_number,
  s.name,
  s.default_deposit_pct,
  COALESCE(SUM(i.amount_no_vat) FILTER (WHERE i.income_type = 'มัดจำ'), 0) AS total_deposit,
  COALESCE(SUM(i.deposit_deduction), 0)                                    AS total_deducted,
  COALESCE(SUM(i.amount_no_vat) FILTER (WHERE i.income_type = 'มัดจำ'), 0)
    - COALESCE(SUM(i.deposit_deduction), 0)                                AS remaining_balance
FROM sites s
LEFT JOIN incomes i ON i.site_id = s.id
GROUP BY s.id, s.site_number, s.name, s.default_deposit_pct;

-- WORKER-safe site info — billing_pct as a progress proxy, no money columns.
--
-- security_invoker = true (2026-08-18-01): the 2026-08-15-04 migration
-- (whose rationale used to live in this comment) computed billing_pct
-- directly from sites+incomes specifically to restore this view's
-- owner-rights RLS bypass after site_financial_summary went
-- invoker-rights — chasing a misdiagnosed symptom (`SET ROLE anon;
-- SELECT * FROM sites_progress;` returning 0 rows, which is actually
-- correct: anon has no tenant and should see nothing). The real effect
-- was every AUTHENTICATED user, from ANY tenant, could see every OTHER
-- tenant's sites through this view, since owner-rights bypasses RLS for
-- authenticated callers too. This view is only ever queried from inside
-- the authenticated Dashboard (behind login) — it was never meant to be
-- world-readable. See
-- supabase/migrations/2026-08-18-01-fix-sites-progress-cross-tenant-leak.sql.
CREATE OR REPLACE VIEW sites_progress WITH (security_invoker = true) AS
SELECT
  s.id,
  s.site_number,
  s.name,
  s.status,
  s.start_date,
  s.end_date,
  CASE WHEN s.contract_value > 0
    THEN ROUND(COALESCE(SUM(i.received_amount), 0) / s.contract_value * 100, 1)
    ELSE NULL
  END AS billing_pct
FROM sites s
LEFT JOIN incomes i ON i.site_id = s.id
GROUP BY s.id, s.site_number, s.name, s.status, s.start_date, s.end_date, s.contract_value;

-- forecast_month = COALESCE(check_date, due_date, date): cheque rows key
-- off check_date, credit-term rows off due_date, everything else off the
-- plain transaction date. MUST match src/lib/expenseFilters.js's 'due'
-- dateField filter exactly, or the Dashboard's "ยอดที่ต้องชำระ" total and
-- clicking through to Expenses filtered by that month disagree -- see
-- 2026-09-01-01-fix-payment-forecast-coalesce-order.sql (originally
-- COALESCE(check_date, date), never consulting due_date at all) and
-- 2026-09-02-05-fix-payment-forecast-check-date-priority.sql (that fix's
-- own COALESCE(due_date, check_date, date) had the priority backwards --
-- a cheque-linked expense can carry a stale due_date left over from
-- before it was linked, e.g. auto-filled from a credit term while
-- payment_method was still 'transfer' and never cleared; check_date is
-- the one actually kept in sync with the cheque via
-- expense_sync_check_date_from_cheque, so it must win).
CREATE OR REPLACE VIEW payment_forecast WITH (security_invoker = true) AS
SELECT
  DATE_TRUNC('month', COALESCE(check_date, due_date, date)) AS forecast_month,
  SUM(amount)                                      AS total_due,
  COUNT(*)                                         AS invoice_count,
  payment_method,
  status
FROM expenses
WHERE status IN ('pending','check_issued')
GROUP BY 1, 4, 5
ORDER BY 1;

-- half-day counting (each shift row = 0.5 day); includes factory production
-- A 'site'-type shift only counts toward payroll once confirmed (a real
-- check-in, or an admin override -- see 2026-09-03-01/02 and
-- docs/superpowers/specs/2026-09-01-worker-checkin-checkout-design.md).
-- 'factory' rows are untouched -- there's no site to check in at, they
-- keep counting immediately as before.
CREATE OR REPLACE VIEW labor_cost_by_site WITH (security_invoker = true) AS
SELECT
  wa.site_id,
  s.name        AS site_name,
  s.site_number,
  wa.worker_id,
  w.name        AS worker_name,
  w.nickname,
  COUNT(*) * 0.5 AS days_worked,
  ROUND(w.monthly_salary / 26 * (COUNT(*) * 0.5), 2) AS labor_cost
FROM worker_assignments wa
JOIN workers w ON wa.worker_id = w.id
JOIN sites s ON wa.site_id = s.id
WHERE wa.type = 'factory' OR (wa.type = 'site' AND wa.confirmed_at IS NOT NULL)
GROUP BY wa.site_id, s.name, s.site_number, wa.worker_id, w.name, w.nickname, w.monthly_salary;

-- ต้นทุน OT ต่อไซท์ (all-time) — mirrors labor_cost_by_site's shape/grouping
CREATE OR REPLACE VIEW ot_cost_by_site WITH (security_invoker = true) AS
SELECT
  o.site_id,
  s.name AS site_name,
  s.site_number,
  o.worker_id,
  w.name AS worker_name,
  w.nickname,
  SUM(o.ot_hours) AS ot_hours,
  ROUND(SUM(o.ot_hours * (w.monthly_salary / 26 / 8) * 1.5), 2) AS ot_cost
FROM worker_ot o
JOIN workers w ON o.worker_id = w.id
JOIN sites s ON o.site_id = s.id
GROUP BY o.site_id, s.name, s.site_number, o.worker_id, w.name, w.nickname;

-- travel cost per site: distance x 2 (round trip) x rate, once per distinct 'site' workday
-- Gated on confirmed_at the same way labor_cost_by_site is (2026-09-03-08) --
-- same underlying rows, same money. A site day nobody showed up for must not
-- bill a round trip. There's no `factory` branch to preserve here: this view
-- already counts type='site' only (factory work happens at the company's own
-- factory, so there's no travel to pay for).
CREATE OR REPLACE VIEW site_travel_cost WITH (security_invoker = true) AS
SELECT wa.site_id,
       COUNT(DISTINCT wa.date) AS travel_days,
       s.distance_km,
       ROUND(COUNT(DISTINCT wa.date) * COALESCE(s.distance_km, 0) * 2
             * (SELECT value::numeric FROM app_settings WHERE key = 'travel_rate_per_km'), 2) AS travel_cost
FROM worker_assignments wa
JOIN sites s ON wa.site_id = s.id
WHERE wa.type = 'site' AND wa.confirmed_at IS NOT NULL
GROUP BY wa.site_id, s.distance_km;

CREATE OR REPLACE VIEW workers_with_rate WITH (security_invoker = true) AS
SELECT
  id, name, nickname, position, monthly_salary, has_social_security,
  annual_leave_days, monthly_contribution, status, created_at, updated_at,
  ROUND(monthly_salary / 26, 2) AS daily_rate,
  ROUND(monthly_salary * 0.05 / 100 * 750, 0) AS social_security_amount,
  email, show_in_assign, annual_sick_leave_days,
  id_card_number, address, id_card_photo_path
FROM workers;

-- สรุปสัญญาผู้รับเหมาช่วง: บิลแล้ว/จ่ายแล้ว/retention คงเหลือ/% ความคืบหน้า
CREATE OR REPLACE VIEW labor_contract_summary WITH (security_invoker = true) AS
SELECT
  lc.id, lc.subcontractor_id, lc.site_id, lc.work_description, lc.contract_amount,
  lc.retention_pct, lc.withholding_tax_pct, lc.site_note, lc.status, lc.start_date,
  ls.name AS subcontractor_name,
  ls.subcontractor_number,
  s.name AS site_name,
  s.site_number,
  s.status AS site_status,
  s.end_date AS site_end_date,
  s.contract_value AS site_contract_value,
  COALESCE(SUM(lp.gross_amount) FILTER (WHERE NOT lp.is_retention_release), 0)     AS total_billed_gross,
  COALESCE(SUM(lp.retention_amount) FILTER (WHERE NOT lp.is_retention_release), 0) AS total_retention_held,
  COALESCE(SUM(lp.net_amount) FILTER (WHERE NOT lp.is_retention_release), 0)       AS total_paid_net,
  COALESCE(SUM(lp.net_amount) FILTER (WHERE lp.is_retention_release AND lp.status = 'paid'), 0) AS retention_released,
  CASE WHEN lc.contract_amount > 0
    THEN ROUND(COALESCE(SUM(lp.gross_amount) FILTER (WHERE NOT lp.is_retention_release), 0) / lc.contract_amount * 100, 1)
    ELSE 0
  END AS contractor_billing_pct,
  s.end_date + INTERVAL '6 months' AS retention_release_date,
  (s.end_date IS NOT NULL AND NOW() >= s.end_date + INTERVAL '6 months') AS retention_releasable,
  lc.contract_amount - COALESCE(SUM(lp.gross_amount) FILTER (WHERE NOT lp.is_retention_release), 0) AS remaining_amount
FROM labor_contracts lc
JOIN labor_subcontractors ls ON lc.subcontractor_id = ls.id
JOIN sites s ON lc.site_id = s.id
LEFT JOIN labor_payments lp ON lp.contract_id = lc.id
GROUP BY lc.id, lc.subcontractor_id, lc.site_id, lc.work_description, lc.contract_amount,
  lc.retention_pct, lc.withholding_tax_pct, lc.site_note, lc.status, lc.start_date,
  ls.name, ls.subcontractor_number, s.name, s.site_number, s.status, s.end_date, s.contract_value;

-- Storage: public `tenant-logos` bucket for the company-logo PDF
-- letterhead, owner-only writes, tenant-prefixed path
-- ({tenant_id}/logo.<ext>) — see
-- supabase/migrations/2026-08-22-01-tenant-company-profile.sql for the
-- bucket creation. The policy below is the FIXED shape (single FOR ALL) —
-- the original had separate INSERT/UPDATE/DELETE policies with no SELECT
-- policy at all, reasoning that a public bucket's reads bypass RLS
-- entirely so SELECT wasn't needed. True for the public GET/CDN read
-- path, but NOT true for `INSERT/UPDATE ... RETURNING *` (which is what
-- Supabase's Storage API always issues) -- that RETURNING still needs a
-- SELECT policy to read the row back within the same statement, so every
-- logo upload failed with a row-level-security error even for a genuine
-- tenant OWNER. See 2026-09-02-03-fix-tenant-logos-missing-select-policy.sql.
INSERT INTO storage.buckets (id, name, public) VALUES ('tenant-logos', 'tenant-logos', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY tenant_logos_owner_access ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'tenant-logos' AND is_owner() AND (storage.foldername(name))[1] = current_tenant_id()::text)
  WITH CHECK (bucket_id = 'tenant-logos' AND is_owner() AND (storage.foldername(name))[1] = current_tenant_id()::text);

-- Flat "what have we actually sold" report — every line item from an
-- ACCEPTED quotation only, joined to client/site names. Added by
-- supabase/migrations/2026-08-24-02-sales-report-view.sql.
CREATE VIEW sales_report_view WITH (security_invoker = true) AS
SELECT
  qi.id,
  qi.quotation_id,
  q.quotation_number,
  q.date,
  q.client_id,
  c.name AS client_name,
  q.site_id,
  s.name AS site_name,
  s.site_number,
  qi.catalog_item_id,
  qi.description,
  qi.unit,
  qi.quantity,
  qi.unit_price,
  qi.line_total,
  qi.tenant_id
FROM quotation_items qi
JOIN quotations q ON q.id = qi.quotation_id
LEFT JOIN clients c ON c.id = q.client_id
LEFT JOIN sites s ON s.id = q.site_id
WHERE q.status = 'accepted';

-- Tracks each attempted Omise payment (Phase B self-service billing,
-- 2026-08-30-06-payment-intents-table.sql). The omise-webhook Edge
-- Function uses omise_charge_id to know which tenant/package to activate
-- on a confirmed successful charge (see supabase/functions/omise-webhook
-- and supabase/functions/omise-create-charge).
CREATE TABLE payment_intents (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id        UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  package_id       UUID NOT NULL REFERENCES packages(id),
  amount           NUMERIC NOT NULL, -- baht, not satang -- converted when calling Omise
  omise_source_id  TEXT,
  omise_charge_id  TEXT UNIQUE,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','successful','failed','expired')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at     TIMESTAMPTZ,
  -- Proration (2026-08-30-09): computed once at charge-creation time
  -- (preserve billing anniversary on an upgrade, fresh +1 month otherwise)
  -- so the webhook / zero-cost activation path just applies it verbatim.
  target_plan_expires_at TIMESTAMPTZ
);

CREATE INDEX idx_payment_intents_tenant_id ON payment_intents(tenant_id);
CREATE INDEX idx_payment_intents_omise_charge_id ON payment_intents(omise_charge_id);

ALTER TABLE payment_intents ENABLE ROW LEVEL SECURITY;

-- Tenant members can see their own tenant's payment attempts.
CREATE POLICY member_reads_own ON payment_intents FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id());

-- Starting a payment is an admin/owner-level action (billing).
CREATE POLICY admin_inserts ON payment_intents FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id());

-- No UPDATE policy for `authenticated` -- only the webhook (service_role,
-- which bypasses RLS entirely) ever transitions status away from 'pending'.

-- Self-service function for the tenant-facing UpgradeModal: an admin/owner
-- who explicitly declines the tier picker gets downgraded to Free
-- immediately. Free is genuinely free forever, so plan='active' with
-- plan_expires_at=NULL, not 'expired'. Mirrors
-- platform_set_tenant_package()'s module-sync exactly, but doesn't
-- require platform_admins membership since this is a legitimate tenant
-- self-service action, not an admin override. Added by
-- 2026-08-30-07-tenant-downgrade-to-free.sql.
CREATE OR REPLACE FUNCTION tenant_downgrade_to_free()
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := current_tenant_id();
  v_free_package_id UUID;
BEGIN
  IF NOT is_admin_or_owner() THEN
    RAISE EXCEPTION 'only an admin/owner can change the tenant package';
  END IF;

  SELECT id INTO v_free_package_id FROM packages WHERE name = 'Free';
  IF v_free_package_id IS NULL THEN
    RAISE EXCEPTION 'Free package not found';
  END IF;

  UPDATE tenants SET package_id = v_free_package_id, plan = 'active', plan_expires_at = NULL
  WHERE id = v_tenant_id;

  DELETE FROM tenant_modules
  WHERE tenant_id = v_tenant_id
    AND module_key NOT IN (SELECT module_key FROM package_modules WHERE package_id = v_free_package_id);

  INSERT INTO tenant_modules (tenant_id, module_key)
  SELECT v_tenant_id, module_key FROM package_modules WHERE package_id = v_free_package_id
  ON CONFLICT (tenant_id, module_key) DO NOTHING;

  INSERT INTO tenant_status_log (tenant_id, plan, plan_expires_at, changed_by)
  VALUES (v_tenant_id, 'active', NULL, auth.email() || ' (self-service downgrade)');
END;
$$;

REVOKE EXECUTE ON FUNCTION tenant_downgrade_to_free() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION tenant_downgrade_to_free() TO authenticated;

-- Scheduled (no-charge) downgrades: an active paying tenant can pick a
-- cheaper tier without a proration reimbursement, but the switch itself
-- doesn't happen until the current paid cycle actually ends -- they keep
-- their current tier's access until plan_expires_at, then the cheaper
-- tier applies automatically. omise-create-charge (Edge Function) is
-- separately guarded to reject any downgrade-or-equal package selection
-- -- that endpoint is for price INCREASES only. Added by
-- 2026-08-30-10-scheduled-downgrade.sql.
ALTER TABLE tenants ADD COLUMN pending_package_id UUID REFERENCES packages(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION tenant_schedule_downgrade(p_package_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := current_tenant_id();
  v_current_package_id UUID;
  v_current_price NUMERIC;
  v_target_price NUMERIC;
BEGIN
  IF NOT is_admin_or_owner() THEN
    RAISE EXCEPTION 'only an admin/owner can change the tenant package';
  END IF;

  SELECT package_id INTO v_current_package_id
  FROM tenants
  WHERE id = v_tenant_id AND plan = 'active' AND plan_expires_at IS NOT NULL AND plan_expires_at > now();

  IF v_current_package_id IS NULL THEN
    RAISE EXCEPTION 'no active paid plan with time remaining to schedule a downgrade against';
  END IF;

  SELECT price_monthly INTO v_current_price FROM packages WHERE id = v_current_package_id;
  SELECT price_monthly INTO v_target_price FROM packages WHERE id = p_package_id;

  IF v_target_price IS NULL THEN
    RAISE EXCEPTION 'target package has no payable monthly price (Custom/Enterprise) -- contact us directly';
  END IF;
  IF v_target_price > v_current_price THEN
    RAISE EXCEPTION 'this is a higher-priced package -- use the upgrade flow instead';
  END IF;
  IF p_package_id = v_current_package_id THEN
    RAISE EXCEPTION 'already on this package';
  END IF;

  UPDATE tenants SET pending_package_id = p_package_id WHERE id = v_tenant_id;
END;
$$;

CREATE OR REPLACE FUNCTION tenant_cancel_pending_downgrade()
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT is_admin_or_owner() THEN
    RAISE EXCEPTION 'only an admin/owner can change the tenant package';
  END IF;

  UPDATE tenants SET pending_package_id = NULL WHERE id = current_tenant_id();
END;
$$;

-- Called opportunistically by useTenant.js on load (this app has no
-- cron/scheduled-job infrastructure -- trial_ends_at is already handled
-- the same lazy/on-load way). A no-op unless a downgrade is actually
-- pending AND the paid-through date has passed, so it's safe to call
-- unconditionally and open to any tenant member (not gated to
-- admin/owner) -- it only ever executes a change an admin/owner already
-- approved when scheduling it.
CREATE OR REPLACE FUNCTION tenant_apply_pending_downgrade()
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := current_tenant_id();
  v_pending_package_id UUID;
  v_plan_expires_at TIMESTAMPTZ;
  v_target_price NUMERIC;
  v_new_plan_expires_at TIMESTAMPTZ;
BEGIN
  SELECT pending_package_id, plan_expires_at INTO v_pending_package_id, v_plan_expires_at
  FROM tenants WHERE id = v_tenant_id;

  IF v_pending_package_id IS NULL OR v_plan_expires_at IS NULL OR v_plan_expires_at > now() THEN
    RETURN;
  END IF;

  SELECT price_monthly INTO v_target_price FROM packages WHERE id = v_pending_package_id;
  -- Free is free forever (matches tenant_downgrade_to_free()'s semantics);
  -- a still-paid cheaper tier keeps the already-passed plan_expires_at as
  -- is -- no new cycle is fabricated since no new payment was made, so
  -- the tenant lands in the same "needs to pick/pay for a plan" state as
  -- any other lapsed-active tenant, just now defaulted onto the cheaper
  -- tier.
  v_new_plan_expires_at := CASE WHEN v_target_price = 0 THEN NULL ELSE v_plan_expires_at END;

  UPDATE tenants
  SET package_id = v_pending_package_id, pending_package_id = NULL, plan_expires_at = v_new_plan_expires_at
  WHERE id = v_tenant_id;

  DELETE FROM tenant_modules
  WHERE tenant_id = v_tenant_id
    AND module_key NOT IN (SELECT module_key FROM package_modules WHERE package_id = v_pending_package_id);

  INSERT INTO tenant_modules (tenant_id, module_key)
  SELECT v_tenant_id, module_key FROM package_modules WHERE package_id = v_pending_package_id
  ON CONFLICT (tenant_id, module_key) DO NOTHING;

  INSERT INTO tenant_status_log (tenant_id, plan, plan_expires_at, changed_by)
  VALUES (v_tenant_id, 'active', v_new_plan_expires_at, 'scheduled-downgrade (auto-applied)');
END;
$$;

REVOKE EXECUTE ON FUNCTION tenant_schedule_downgrade(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION tenant_cancel_pending_downgrade() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION tenant_apply_pending_downgrade() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION tenant_schedule_downgrade(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION tenant_cancel_pending_downgrade() TO authenticated;
GRANT EXECUTE ON FUNCTION tenant_apply_pending_downgrade() TO authenticated;

-- Platform billing receipt (FacadeX -> tenant), distinct from the app's
-- own client-facing Invoice/Receipt module (a tenant's receipts to THEIR
-- clients). Issued automatically by omise-webhook on a confirmed
-- successful subscription payment; emailed via Resend. Added by
-- 2026-08-30-08-subscription-receipts-table.sql.
CREATE TABLE subscription_receipts (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  receipt_number    TEXT NOT NULL UNIQUE DEFAULT '',
  payment_intent_id UUID NOT NULL REFERENCES payment_intents(id),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  package_name      TEXT NOT NULL, -- snapshot at time of issue
  amount            NUMERIC NOT NULL, -- VAT-inclusive baht, matches payment_intents.amount
  issued_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  email_to          TEXT,
  email_sent_at     TIMESTAMPTZ,
  email_error       TEXT
);

CREATE INDEX idx_subscription_receipts_tenant_id ON subscription_receipts(tenant_id);

-- Same MAX(existing)+1 pattern as generate_site_number()/generate_po_number()
-- -- never COUNT(*)+1 (breaks on delete).
CREATE OR REPLACE FUNCTION generate_receipt_number()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public
AS $$
DECLARE
  year_part TEXT := TO_CHAR(NOW(), 'YYYY');
  seq_num   INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(receipt_number FROM 'RCT-\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM subscription_receipts
  WHERE receipt_number LIKE 'RCT-' || year_part || '-%';
  NEW.receipt_number := 'RCT-' || year_part || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_receipt_number
  BEFORE INSERT ON subscription_receipts
  FOR EACH ROW
  WHEN (NEW.receipt_number IS NULL OR NEW.receipt_number = '')
  EXECUTE FUNCTION generate_receipt_number();

ALTER TABLE subscription_receipts ENABLE ROW LEVEL SECURITY;

-- Tenant members can see their own subscription receipts (billing history).
CREATE POLICY member_reads_own ON subscription_receipts FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id());
-- No INSERT/UPDATE policy for `authenticated` -- only the webhook
-- (service_role) ever creates these.

-- Cheque tracking (2026-09-01-02): a cheque is a first-class entity that
-- can cover several expenses (one cheque, multiple bills). Marking it
-- cashed cascades to every linked expense still in check_issued, flipping
-- them to check_cleared in one go. Paid-tier feature (cheque_tracking
-- module, see package_modules above).
CREATE TABLE cheques (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  cheque_no   TEXT NOT NULL,
  bank        TEXT NOT NULL,
  -- issued -> received (signed for, see document_receipts below) -> cashed.
  -- "received" is optional and never gates cashing.
  status      TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','received','cashed')),
  cashed_at   TIMESTAMPTZ,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The cheque date is a property of the physical cheque, not of any one
  -- expense it pays -- every expense linked to it must show the same
  -- date. See the cascade triggers below (2026-09-01-04).
  check_date  DATE
);

CREATE INDEX idx_cheques_tenant_id ON cheques(tenant_id);

-- Same shape as purchase_orders: single ADMIN+-only full-access policy,
-- tenant-scoped and gated on has_module_access('cheque_tracking').
ALTER TABLE cheques ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON cheques FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('cheque_tracking'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('cheque_tracking'));

-- Nullable: only set when payment_method='check'. check_date stays on
-- expenses itself (unaffected -- still feeds payment_forecast's
-- COALESCE(due_date, check_date, date)); cheque_id only carries identity
-- (no., bank, cashed status), not scheduling.
ALTER TABLE expenses ADD COLUMN cheque_id UUID REFERENCES cheques(id) ON DELETE SET NULL;
CREATE INDEX idx_expenses_cheque_id ON expenses(cheque_id);

-- Cascades a cheque's cash-in to every linked expense. Runs as the
-- calling user (no SECURITY DEFINER) -- marking a cheque cashed is
-- something an admin/owner could already do by hand, row by row, so this
-- just automates it under their own existing expenses UPDATE policy
-- (is_admin_or_owner() + tenant_can_write()), nothing it couldn't do
-- unassisted.
CREATE OR REPLACE FUNCTION cheque_cascade_status()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'cashed' AND OLD.status IS DISTINCT FROM 'cashed' THEN
    UPDATE expenses SET status = 'check_cleared'
    WHERE cheque_id = NEW.id AND status = 'check_issued';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_cheque_cascade_status
  AFTER UPDATE OF status ON cheques
  FOR EACH ROW
  EXECUTE FUNCTION cheque_cascade_status();

-- cheques.check_date is the single source of truth for "when is this
-- cheque due" -- these two triggers keep expenses.check_date (still what
-- payment_forecast/expenseFilters read) in sync with it automatically:
-- editing a cheque's date cascades to every expense already linked to
-- it, and linking an expense to a cheque pulls the cheque's date onto
-- it immediately (BEFORE trigger, so it applies even on the very same
-- INSERT/UPDATE that sets cheque_id, before any independently-typed
-- check_date on that row is ever written).
CREATE OR REPLACE FUNCTION cheque_cascade_check_date()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  IF NEW.check_date IS DISTINCT FROM OLD.check_date THEN
    UPDATE expenses SET check_date = NEW.check_date WHERE cheque_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_cheque_cascade_check_date
  AFTER UPDATE OF check_date ON cheques
  FOR EACH ROW
  EXECUTE FUNCTION cheque_cascade_check_date();

-- Also forces expenses.status to follow the linked cheque's own status
-- (issued -> check_issued, cashed -> check_cleared) the moment cheque_id is
-- set/changed -- same "single source of truth, no independent drift" logic
-- as check_date, added in 2026-09-01-06-expense-status-follows-cheque.sql.
-- Fires on EVERY update (not just "OF cheque_id") so the invariant holds no
-- matter which code path writes status -- including a plain status-only
-- write that never touches cheque_id at all (e.g. the quick status-toggle
-- dialog in Expenses.jsx), closing a gap the narrower "OF cheque_id" trigger
-- left open.
CREATE OR REPLACE FUNCTION expense_sync_check_date_from_cheque()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public
AS $$
DECLARE
  v_cheque_date DATE;
  v_cheque_status TEXT;
BEGIN
  IF NEW.cheque_id IS NOT NULL THEN
    SELECT check_date, status INTO v_cheque_date, v_cheque_status FROM cheques WHERE id = NEW.cheque_id;
    NEW.check_date := v_cheque_date;
    NEW.status := CASE WHEN v_cheque_status = 'cashed' THEN 'check_cleared' ELSE 'check_issued' END;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_expense_sync_check_date
  BEFORE INSERT OR UPDATE ON expenses
  FOR EACH ROW
  EXECUTE FUNCTION expense_sync_check_date_from_cheque();

-- Re-declares expenses_view (see the earlier, now-superseded definition
-- above) now that cheques/expenses.cheque_id both exist -- explicit
-- column list (not e.*) preserving the exact prior output order (CREATE
-- OR REPLACE VIEW cannot reorder/rename/remove existing output columns),
-- with cheque_id and the joined cheque_no/bank/status appended at the
-- very end. See 2026-09-01-03-fix-expenses-view-missing-cheque-columns.sql.
CREATE OR REPLACE VIEW expenses_view WITH (security_invoker = true) AS
SELECT
  e.id, e.date, e.description, e.site_id, e.category_id, e.supplier, e.amount,
  e.payment_method, e.check_date, e.status, e.payer, e.invoice_no, e.notes,
  e.is_subcontract, e.created_at, e.updated_at, e.supplier_id, e.billing_date,
  e.due_date, e.amount_no_vat, e.vat, e.tenant_id, e.po_id,
  s.name              AS site_name,
  s.site_number,
  s.status            AS site_status,
  ec.name             AS category_name,
  ec.color            AS category_color,
  sup.name            AS supplier_name,
  sup.supplier_number,
  sup.category        AS supplier_category,
  e.cheque_id,
  c.cheque_no,
  c.bank              AS cheque_bank,
  c.status            AS cheque_status
FROM expenses e
LEFT JOIN sites s ON e.site_id = s.id
LEFT JOIN expense_categories ec ON e.category_id = ec.id
LEFT JOIN suppliers sup ON e.supplier_id = sup.id
LEFT JOIN cheques c ON e.cheque_id = c.id;

-- General-purpose "document receipt" system (2026-09-02-01): capture a
-- signature (drawn on a tablet/mobile/laptop handed to the other party) as
-- proof a document was physically received. Deliberately generic
-- (document_type + document_id, no rigid FK to a single table) so it can be
-- reused for other document types later. v1 wired up cheques only;
-- 2026-09-02-06 extended the CHECK to also allow quotation/invoice.
CREATE TABLE document_receipts (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  document_type   TEXT NOT NULL CHECK (document_type IN ('cheque', 'quotation', 'invoice')),
  document_id     UUID NOT NULL,
  signer_name     TEXT NOT NULL,
  signer_note     TEXT,
  signature_path  TEXT NOT NULL,
  signed_by       TEXT NOT NULL,
  signed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_document_receipts_document ON document_receipts(tenant_id, document_type, document_id);

ALTER TABLE document_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON document_receipts FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id());

-- Storage: private `document-receipts` bucket, tenant-prefixed path, bucket
-- RLS independent of the table's own RLS -- same pattern as
-- site-attachments/po-attachments.
INSERT INTO storage.buckets (id, name, public) VALUES ('document-receipts', 'document-receipts', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY document_receipts_tenant_access ON storage.objects FOR ALL TO authenticated
  USING (
    bucket_id = 'document-receipts'
    AND is_admin_or_owner()
    AND (storage.foldername(name))[1] = current_tenant_id()::text
  )
  WITH CHECK (
    bucket_id = 'document-receipts'
    AND is_admin_or_owner()
    AND (storage.foldername(name))[1] = current_tenant_id()::text
  );

-- Remote signing (2026-09-02-02): a secure, unguessable link (/sign/<id>)
-- lets someone sign for a document on their own device without an account
-- or physical handoff. The public page never talks to the DB with the
-- anon key -- it goes through the sign-link Edge Function (service role),
-- the only thing allowed to validate a link and write the signature. No
-- RLS policy here ever grants anon access; this table is authenticated-
-- only (staff create/view their own links), and the Edge Function
-- bypasses RLS entirely via the service role.
CREATE TABLE document_receipt_links (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  document_type   TEXT NOT NULL CHECK (document_type IN ('cheque', 'quotation', 'invoice')),
  document_id     UUID NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  signed_at       TIMESTAMPTZ,
  receipt_id      UUID REFERENCES document_receipts(id)
);

CREATE INDEX idx_document_receipt_links_document ON document_receipt_links(tenant_id, document_type, document_id);

ALTER TABLE document_receipt_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON document_receipt_links FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id());

-- ----------------------------------------------------------------
-- WORKER_CHECKINS — Location-based worker check-in/check-out (see
-- docs/superpowers/specs/2026-09-01-worker-checkin-checkout-design.md).
-- sites gains coordinates; worker_assignments gains a confirmation gate
-- (set by a successful check-in or an admin override, see Task 2/6);
-- worker_checkins is the actual attendance event log, kept separate from
-- the plan. No RLS write policy is granted here for the worker's own
-- rows -- the only write path is the SECURITY DEFINER functions in
-- 2026-09-03-02, which independently re-validate distance server-side.
-- ----------------------------------------------------------------
CREATE TABLE worker_checkins (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  worker_id           UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  site_id             UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date                DATE NOT NULL,
  checkin_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  checkin_lat         NUMERIC(9,6) NOT NULL,
  checkin_lng         NUMERIC(9,6) NOT NULL,
  checkin_distance_m  NUMERIC NOT NULL,
  checkout_at         TIMESTAMPTZ,
  checkout_lat        NUMERIC(9,6),
  checkout_lng        NUMERIC(9,6),
  checkout_distance_m NUMERIC,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (worker_id, site_id, date)
);

CREATE INDEX idx_worker_checkins_tenant_id ON worker_checkins(tenant_id);
CREATE INDEX idx_worker_checkins_worker_date ON worker_checkins(worker_id, date);

ALTER TABLE worker_checkins ENABLE ROW LEVEL SECURITY;
-- Reads: same shape as worker_ot/salary_records -- admin sees everything,
-- a worker sees only their own rows. Writes are NOT granted here at all --
-- the only write path is the SECURITY DEFINER functions in Task 2, which
-- bypass RLS. This keeps direct table access (e.g. a stray client-side
-- .insert() call) impossible even for a WORKER's own rows -- they must go
-- through the distance-validating function.
CREATE POLICY admin_full_access ON worker_checkins FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id());
CREATE POLICY worker_reads_own ON worker_checkins FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id() AND worker_id IN (SELECT id FROM workers WHERE email = auth.email()));

-- Personal saved signature (2026-09-02-07) -- draw once in Settings, reused
-- automatically wherever a document already has a blank staff-side
-- signature line, showing whoever is CURRENTLY viewing/printing the
-- document -- not tied to a specific document instance, same convenience
-- model as a scanned signature stamp. Available to every role (not gated
-- by is_admin_or_owner() like document_receipts is) -- this is each
-- person's own signature, not an admin action on someone else's document.
CREATE TABLE user_signatures (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  user_email      TEXT NOT NULL,
  signature_path  TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_email)
);

ALTER TABLE user_signatures ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_signature_access ON user_signatures FOR ALL TO authenticated
  USING (tenant_id = current_tenant_id() AND user_email = auth.email())
  WITH CHECK (tenant_id = current_tenant_id() AND user_email = auth.email());

-- Path convention: {tenant_id}/{user_email}/signature.png -- email must be
-- its own folder segment (not baked into the filename) or
-- storage.foldername() has nothing at index 2 to compare against
-- auth.email() with.
INSERT INTO storage.buckets (id, name, public) VALUES ('user-signatures', 'user-signatures', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY user_signatures_own_access ON storage.objects FOR ALL TO authenticated
  USING (
    bucket_id = 'user-signatures'
    AND (storage.foldername(name))[1] = current_tenant_id()::text
    AND (storage.foldername(name))[2] = auth.email()
  )
  WITH CHECK (
    bucket_id = 'user-signatures'
    AND (storage.foldername(name))[1] = current_tenant_id()::text
    AND (storage.foldername(name))[2] = auth.email()
  );

-- Path convention: {tenant_id}/{worker_id}/id-card.{ext} -- worker_id, not
-- email, since a worker record doesn't necessarily have a linked login
-- account. Private bucket + ADMIN/OWNER-only access, matching who can
-- already write the workers table itself (admin_writes_workers/
-- admin_updates_workers) -- ID card number + photo is sensitive PII, kept
-- to the same access level as the rest of a worker's payroll record, not
-- opened up to the worker's own login even if one exists.
INSERT INTO storage.buckets (id, name, public) VALUES ('worker-id-cards', 'worker-id-cards', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY worker_id_cards_admin_access ON storage.objects FOR ALL TO authenticated
  USING (
    bucket_id = 'worker-id-cards'
    AND (storage.foldername(name))[1] = current_tenant_id()::text
    AND is_admin_or_owner()
    AND has_module_access('payroll')
  )
  WITH CHECK (
    bucket_id = 'worker-id-cards'
    AND (storage.foldername(name))[1] = current_tenant_id()::text
    AND is_admin_or_owner()
    AND has_module_access('payroll')
  );

-- Print/download tracking (2026-09-02-08) -- every PDF/JPG export of a
-- quotation, invoice, or receipt logs one row here. The document's own
-- "ต้นฉบับ" (original) badge is derived from the row count at render time
-- (see printTagFor() in lib/pdf.js): the first export shows "ต้นฉบับ",
-- every export after that shows "สำเนาที่ N" instead -- so a document
-- can't be reprinted multiple times all claiming to be the one original,
-- and there's an audit trail (who, when) if a copy count is ever
-- questioned. Any tenant member can log/view prints (not gated to
-- ADMIN/OWNER like document_receipts) -- printing isn't an admin-only
-- action on these pages (canEdit gates editing, not viewing/downloading).
CREATE TABLE document_prints (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  document_type TEXT NOT NULL CHECK (document_type IN ('quotation', 'invoice', 'receipt')),
  document_id   UUID NOT NULL,
  format        TEXT NOT NULL CHECK (format IN ('pdf', 'jpg')),
  printed_by    TEXT NOT NULL,
  printed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_document_prints_document ON document_prints(tenant_id, document_type, document_id);

ALTER TABLE document_prints ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_access ON document_prints FOR ALL TO authenticated
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Work-completion photos attached to an invoice (2026-09-02-04), printed
-- as their own document ("รูปประกอบการส่งงาน") -- a photo + short
-- description per item, 6 to an A4 page. Separate from
-- AttachmentsSection's generic reference-only file attachments because
-- each photo here carries its own caption and print order.
CREATE TABLE invoice_photos (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  invoice_id    UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  photo_path    TEXT NOT NULL,
  description   TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_invoice_photos_invoice_id ON invoice_photos(invoice_id);
CREATE INDEX idx_invoice_photos_tenant_id ON invoice_photos(tenant_id);

ALTER TABLE invoice_photos ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON invoice_photos FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id());

INSERT INTO storage.buckets (id, name, public) VALUES ('invoice-photos', 'invoice-photos', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY invoice_photos_tenant_access ON storage.objects FOR ALL TO authenticated
  USING (
    bucket_id = 'invoice-photos'
    AND is_admin_or_owner()
    AND (storage.foldername(name))[1] = current_tenant_id()::text
  )
  WITH CHECK (
    bucket_id = 'invoice-photos'
    AND is_admin_or_owner()
    AND (storage.foldername(name))[1] = current_tenant_id()::text
  );
