-- supabase/migrations/2026-10-17-01-payroll-structure.sql
-- Payroll rework, part 1: configurable pay items, periods with a DB-enforced
-- lock, per-item salary lines, advances, SCB bank-export settings.
-- Spec: docs/superpowers/specs/2026-10-17-payroll-payslip-design.md

-- ── bypass switch for SECURITY DEFINER maintenance (demo reset, backfill, RPCs) ──
CREATE OR REPLACE FUNCTION payroll_bypass_on()
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(current_setting('chang.payroll_bypass', true), '') = 'on';
$$;
-- called only from SECURITY DEFINER functions and triggers, never by clients
REVOKE ALL ON FUNCTION payroll_bypass_on() FROM PUBLIC, anon, authenticated;

-- ── pay_items ──
CREATE TABLE pay_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  side        TEXT NOT NULL CHECK (side IN ('earning','deduction')),
  method      TEXT NOT NULL CHECK (method IN ('fixed_per_worker','manual_monthly','percent_of_item','base_pay','ot','sso','unpaid_leave','advances')),
  params      JSONB NOT NULL DEFAULT '{}'::jsonb,
  sso_base    BOOLEAN NOT NULL DEFAULT false,
  rounding    TEXT NOT NULL DEFAULT 'none' CHECK (rounding IN ('none','ceil','round')),
  applies_to  TEXT NOT NULL DEFAULT 'all' CHECK (applies_to IN ('all','monthly','daily')),
  sort_order  INT NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT true,
  system_key  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pay_items_method_side CHECK (
       (method IN ('base_pay','ot') AND side = 'earning')
    OR (method IN ('sso','unpaid_leave','advances') AND side = 'deduction')
    OR method IN ('fixed_per_worker','manual_monthly','percent_of_item'))
);
CREATE UNIQUE INDEX pay_items_one_system_method ON pay_items (tenant_id, method)
  WHERE method IN ('base_pay','ot','sso','unpaid_leave','advances');
CREATE UNIQUE INDEX pay_items_system_key ON pay_items (tenant_id, system_key) WHERE system_key IS NOT NULL;
CREATE INDEX pay_items_tenant ON pay_items (tenant_id, sort_order);

-- SECURITY DEFINER trigger fn; called only as a trigger, never by clients
CREATE OR REPLACE FUNCTION pay_items_protect_system()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF payroll_bypass_on() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'DELETE' THEN
    -- tenant being deleted: let the cascade through
    IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = OLD.tenant_id) THEN RETURN OLD; END IF;
    IF OLD.method IN ('base_pay','ot','sso','unpaid_leave','advances') THEN
      RAISE EXCEPTION 'รายการระบบลบไม่ได้ (ซ่อนได้แทน)' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.method IS DISTINCT FROM OLD.method
     AND OLD.method IN ('base_pay','ot','sso','unpaid_leave','advances') THEN
    RAISE EXCEPTION 'เปลี่ยนวิธีคิดของรายการระบบไม่ได้' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.system_key IS DISTINCT FROM OLD.system_key THEN
    RAISE EXCEPTION 'เปลี่ยนรหัสระบบของรายการไม่ได้' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pay_items_protect_system() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER pay_items_protect_system BEFORE DELETE OR UPDATE ON pay_items
  FOR EACH ROW EXECUTE FUNCTION pay_items_protect_system();

-- ── per-worker amounts for fixed_per_worker items ──
CREATE TABLE worker_pay_item_amounts (
  worker_id   UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  pay_item_id UUID NOT NULL REFERENCES pay_items(id) ON DELETE CASCADE,
  amount      NUMERIC NOT NULL DEFAULT 0 CHECK (amount >= 0),
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  PRIMARY KEY (worker_id, pay_item_id)
);

-- ── workers: code, bank, pay type ──
ALTER TABLE workers
  ADD COLUMN employee_code     TEXT,
  ADD COLUMN bank_code         TEXT CHECK (bank_code ~ '^[0-9]{3}$'),
  ADD COLUMN bank_account_no   TEXT CHECK (bank_account_no ~ '^[0-9]{1,25}$'),
  ADD COLUMN bank_account_name TEXT,
  ADD COLUMN bank_branch_code  TEXT CHECK (bank_branch_code ~ '^[0-9]{4}$'),
  ADD COLUMN pay_type          TEXT NOT NULL DEFAULT 'monthly' CHECK (pay_type IN ('monthly','daily')),
  ADD COLUMN daily_wage        NUMERIC CHECK (daily_wage IS NULL OR daily_wage >= 0);
CREATE UNIQUE INDEX workers_employee_code ON workers (tenant_id, employee_code) WHERE employee_code IS NOT NULL;

-- ── payroll_periods ──
CREATE TABLE payroll_periods (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  year           INT NOT NULL,
  month          INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','closed')),
  confirmed_by   TEXT, confirmed_at TIMESTAMPTZ,
  closed_by      TEXT, closed_at    TIMESTAMPTZ,
  paid_date      DATE,
  reopen_reason  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, year, month)
);

CREATE OR REPLACE FUNCTION payroll_period_for(p_tenant UUID, p_year INT, p_month INT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id UUID;
BEGIN
  INSERT INTO payroll_periods (tenant_id, year, month) VALUES (p_tenant, p_year, p_month)
  ON CONFLICT (tenant_id, year, month) DO NOTHING;
  SELECT id INTO v_id FROM payroll_periods WHERE tenant_id = p_tenant AND year = p_year AND month = p_month;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION payroll_period_for(UUID, INT, INT) FROM PUBLIC, anon, authenticated;

-- ── salary_records: header row, now tied to a period ──
ALTER TABLE salary_records
  ADD COLUMN period_id UUID REFERENCES payroll_periods(id),
  ADD COLUMN facts     JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ── advances (before lines: lines reference them) ──
CREATE TABLE salary_advances (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  worker_id     UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  title         TEXT NOT NULL CHECK (length(btrim(title)) > 0),
  amount        NUMERIC NOT NULL CHECK (amount > 0),
  installments  INT NOT NULL CHECK (installments BETWEEN 1 AND 60),
  start_year    INT NOT NULL,
  start_month   INT NOT NULL CHECK (start_month BETWEEN 1 AND 12),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','settled')),
  requested_by  TEXT NOT NULL DEFAULT auth.email(),
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by   TEXT, approved_at TIMESTAMPTZ,
  reject_reason TEXT
);
CREATE INDEX salary_advances_worker ON salary_advances (worker_id, status);

-- ── salary_record_lines ──
CREATE TABLE salary_record_lines (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  salary_record_id UUID NOT NULL REFERENCES salary_records(id) ON DELETE CASCADE,
  pay_item_id      UUID REFERENCES pay_items(id) ON DELETE SET NULL,
  advance_id       UUID REFERENCES salary_advances(id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  side             TEXT NOT NULL CHECK (side IN ('earning','deduction')),
  sort_order       INT NOT NULL DEFAULT 0,
  amount           NUMERIC NOT NULL,
  quantity         NUMERIC,
  rate             NUMERIC,
  note             TEXT,
  is_manual        BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX salary_record_lines_record ON salary_record_lines (salary_record_id);
CREATE INDEX salary_record_lines_advance ON salary_record_lines (advance_id) WHERE advance_id IS NOT NULL;

-- ── bank export settings (one row per tenant) ──
CREATE TABLE payroll_bank_settings (
  tenant_id     UUID PRIMARY KEY DEFAULT current_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  bank          TEXT NOT NULL DEFAULT 'scb' CHECK (bank IN ('scb')),
  product       TEXT NOT NULL DEFAULT 'SPN' CHECK (product IN ('SPN','SPS','PAY')),
  debit_account TEXT CHECK (debit_account ~ '^[0-9]{10}$'),
  fee_account   TEXT CHECK (fee_account ~ '^[0-9]{10}$'),
  fee_charge    TEXT NOT NULL DEFAULT 'OUR' CHECK (fee_charge IN ('OUR','BEN')),
  system_ref    TEXT CHECK (system_ref IS NULL OR system_ref ~ '^[A-Za-z0-9]{1,18}$'),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── triggers: period assignment, lock, net ──
CREATE OR REPLACE FUNCTION salary_records_set_period()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  NEW.period_id := payroll_period_for(NEW.tenant_id, NEW.year, NEW.month);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION salary_records_set_period() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER salary_records_set_period BEFORE INSERT OR UPDATE ON salary_records
  FOR EACH ROW EXECUTE FUNCTION salary_records_set_period();

CREATE OR REPLACE FUNCTION payroll_assert_open(p_period UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_status TEXT;
BEGIN
  IF p_period IS NULL OR payroll_bypass_on() THEN RETURN; END IF;
  SELECT status INTO v_status FROM payroll_periods WHERE id = p_period;
  IF v_status IN ('confirmed','closed') THEN
    RAISE EXCEPTION 'เงินเดือนเดือนนี้ยืนยันหรือปิดงวดแล้ว แก้ไขไม่ได้' USING ERRCODE = 'check_violation';
  END IF;
END $$;
REVOKE ALL ON FUNCTION payroll_assert_open(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION salary_records_lock()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- tenant being deleted: let the cascade through
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM tenants WHERE id = OLD.tenant_id) THEN RETURN OLD; END IF;
  IF TG_OP IN ('UPDATE','DELETE') THEN PERFORM payroll_assert_open(OLD.period_id); END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN PERFORM payroll_assert_open(NEW.period_id); RETURN NEW; END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION salary_records_lock() FROM PUBLIC, anon, authenticated;
-- runs after set_period (trigger names fire alphabetically: _lock < _set_period would be wrong)
CREATE TRIGGER salary_records_zz_lock BEFORE INSERT OR UPDATE OR DELETE ON salary_records
  FOR EACH ROW EXECUTE FUNCTION salary_records_lock();

CREATE OR REPLACE FUNCTION salary_record_lines_lock()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_period UUID;
BEGIN
  SELECT period_id INTO v_period FROM salary_records
   WHERE id = COALESCE(NEW.salary_record_id, OLD.salary_record_id);
  PERFORM payroll_assert_open(v_period);  -- NULL (parent already gone in a cascade) passes
  RETURN COALESCE(NEW, OLD);
END $$;
REVOKE ALL ON FUNCTION salary_record_lines_lock() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER salary_record_lines_lock BEFORE INSERT OR UPDATE OR DELETE ON salary_record_lines
  FOR EACH ROW EXECUTE FUNCTION salary_record_lines_lock();

CREATE OR REPLACE FUNCTION salary_record_lines_net()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_rec UUID := COALESCE(NEW.salary_record_id, OLD.salary_record_id);
BEGIN
  UPDATE salary_records r SET net_pay = COALESCE((
    SELECT round(sum(CASE WHEN l.side = 'earning' THEN l.amount ELSE -l.amount END), 2)
      FROM salary_record_lines l WHERE l.salary_record_id = v_rec), 0)
   WHERE r.id = v_rec;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION salary_record_lines_net() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER salary_record_lines_net AFTER INSERT OR UPDATE OR DELETE ON salary_record_lines
  FOR EACH ROW EXECUTE FUNCTION salary_record_lines_net();

-- ── default items: seed per tenant (mirror of src/lib/payroll/defaultItems.js) ──
CREATE OR REPLACE FUNCTION seed_default_pay_items(p_tenant UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_salary UUID; v_contrib UUID;
BEGIN
  INSERT INTO pay_items (tenant_id, system_key, name, side, method, params, sso_base, rounding, applies_to, sort_order) VALUES
    (p_tenant, 'salary',              'เงินเดือน',          'earning',   'base_pay',         '{}',                                   true,  'none',  'all',     10),
    (p_tenant, 'contribution',        'สมทบ',              'earning',   'percent_of_item',  '{"percent":5}',                        true,  'none',  'monthly', 20),
    (p_tenant, 'phone',               'โทรศัพท์',           'earning',   'fixed_per_worker', '{}',                                   true,  'none',  'all',     30),
    (p_tenant, 'ot',                  'OT',                'earning',   'ot',               '{"multiplier":1.5}',                   false, 'ceil',  'all',     40),
    (p_tenant, 'parking',             'เงินพิเศษค่าจอดรถ',   'earning',   'fixed_per_worker', '{}',                                   false, 'none',  'all',     50),
    (p_tenant, 'sso',                 'ประกันสังคม',         'deduction', 'sso',              '{"rate":0.05,"cap":875}',              false, 'round', 'all',     110),
    (p_tenant, 'house',               'ค่าบ้าน',            'deduction', 'fixed_per_worker', '{}',                                   false, 'none',  'all',     120),
    (p_tenant, 'advances',            'เบิกล่วงหน้า',        'deduction', 'advances',         '{}',                                   false, 'none',  'all',     130),
    (p_tenant, 'student_loan',        'กยศ',               'deduction', 'manual_monthly',   '{}',                                   false, 'none',  'all',     140),
    (p_tenant, 'unpaid_leave',        'ลาไม่รับค่าจ้าง',      'deduction', 'unpaid_leave',     '{"daily_rate_rounding":"ceil"}',       false, 'none',  'monthly', 150),
    (p_tenant, 'contribution_deduct', 'หักเงินสมทบ',        'deduction', 'percent_of_item',  '{"percent":100}',                      false, 'none',  'monthly', 160)
  ON CONFLICT (tenant_id, system_key) WHERE system_key IS NOT NULL DO NOTHING;

  SELECT id INTO v_salary  FROM pay_items WHERE tenant_id = p_tenant AND system_key = 'salary';
  SELECT id INTO v_contrib FROM pay_items WHERE tenant_id = p_tenant AND system_key = 'contribution';
  UPDATE pay_items SET params = params || jsonb_build_object('of_item_id', v_salary)
   WHERE tenant_id = p_tenant AND system_key = 'contribution' AND NOT params ? 'of_item_id';
  UPDATE pay_items SET params = params || jsonb_build_object('of_item_id', v_contrib)
   WHERE tenant_id = p_tenant AND system_key = 'contribution_deduct' AND NOT params ? 'of_item_id';
END $$;
REVOKE ALL ON FUNCTION seed_default_pay_items(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION tenants_seed_pay_items()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM seed_default_pay_items(NEW.id);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION tenants_seed_pay_items() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER tenants_seed_pay_items AFTER INSERT ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_seed_pay_items();

DO $$ DECLARE t UUID; BEGIN
  FOR t IN SELECT id FROM tenants LOOP PERFORM seed_default_pay_items(t); END LOOP;
END $$;

-- existing rows get their period
UPDATE salary_records SET period_id = payroll_period_for(tenant_id, year, month) WHERE period_id IS NULL;

-- ── RLS ──
ALTER TABLE pay_items               ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_pay_item_amounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_periods         ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_record_lines     ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_advances         ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_bank_settings   ENABLE ROW LEVEL SECURITY;

-- admin/owner manage the structure; everyone in the tenant with payroll may read item names
CREATE POLICY tenant_read ON pay_items FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id() AND has_module_access('payroll'));
CREATE POLICY admin_write ON pay_items FOR ALL TO authenticated
  USING (tenant_id = current_tenant_id() AND has_module_access('payroll') AND is_admin_or_owner())
  WITH CHECK (tenant_id = current_tenant_id() AND has_module_access('payroll') AND is_admin_or_owner());

CREATE POLICY admin_all ON worker_pay_item_amounts FOR ALL TO authenticated
  USING (tenant_id = current_tenant_id() AND has_module_access('payroll') AND is_admin_or_owner())
  WITH CHECK (tenant_id = current_tenant_id() AND has_module_access('payroll') AND is_admin_or_owner());

-- periods: read-only to clients; transitions only through RPCs (migration -02)
CREATE POLICY tenant_read ON payroll_periods FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id() AND has_module_access('payroll'));

-- lines: admins read all; a worker reads own lines in confirmed/closed periods; writes via RPC only
CREATE POLICY read_lines ON salary_record_lines FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id() AND has_module_access('payroll') AND (
    is_admin_or_owner() OR EXISTS (
      SELECT 1 FROM salary_records r
      JOIN payroll_periods p ON p.id = r.period_id
      JOIN workers w ON w.id = r.worker_id
      WHERE r.id = salary_record_lines.salary_record_id
        AND p.status IN ('confirmed','closed') AND w.email = auth.email())));

-- salary_records: worker sees own rows only once confirmed; all writes via RPC
DROP POLICY IF EXISTS worker_reads_own ON salary_records;
CREATE POLICY worker_reads_own ON salary_records FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id() AND has_module_access('payroll') AND (
    is_admin_or_owner() OR (
      worker_id IN (SELECT id FROM workers WHERE email = auth.email())
      AND period_id IN (SELECT id FROM payroll_periods WHERE status IN ('confirmed','closed')))));
DROP POLICY IF EXISTS admin_writes  ON salary_records;
DROP POLICY IF EXISTS admin_updates ON salary_records;
DROP POLICY IF EXISTS admin_deletes ON salary_records;

-- advances
CREATE POLICY read_advances ON salary_advances FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id() AND has_module_access('payroll') AND (
    is_admin_or_owner() OR worker_id IN (SELECT id FROM workers WHERE email = auth.email())));
CREATE POLICY request_advance ON salary_advances FOR INSERT TO authenticated
  WITH CHECK (tenant_id = current_tenant_id() AND has_module_access('payroll')
    AND status = 'pending' AND approved_by IS NULL AND requested_by = auth.email()
    AND (is_admin_or_owner() OR worker_id IN (SELECT id FROM workers WHERE email = auth.email())));
CREATE POLICY admin_delete_open ON salary_advances FOR DELETE TO authenticated
  USING (tenant_id = current_tenant_id() AND has_module_access('payroll') AND is_admin_or_owner() AND status IN ('pending','rejected'));

CREATE POLICY admin_all ON payroll_bank_settings FOR ALL TO authenticated
  USING (tenant_id = current_tenant_id() AND has_module_access('payroll') AND is_admin_or_owner())
  WITH CHECK (tenant_id = current_tenant_id() AND has_module_access('payroll') AND is_admin_or_owner());
