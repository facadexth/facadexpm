-- supabase/migrations/2026-09-01-02-cheque-tracking.sql
-- Cheque tracking: a cheque is now a first-class entity that can cover
-- several expenses (write one cheque to a supplier for multiple bills).
-- Marking a cheque "cashed" cascades to every expense still in
-- check_issued linked to it, flipping them to check_cleared in one go
-- instead of updating each expense row by hand. Paid-tier feature (new
-- 'cheque_tracking' module), same toggle-per-tenant pattern as every
-- other module.
CREATE TABLE cheques (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  cheque_no   TEXT NOT NULL,
  bank        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','cashed')),
  cashed_at   TIMESTAMPTZ,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
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

ALTER TABLE tenant_modules DROP CONSTRAINT tenant_modules_module_key_check;
ALTER TABLE tenant_modules ADD CONSTRAINT tenant_modules_module_key_check
  CHECK (module_key IN ('payroll','labor_subcontractors','purchase_orders','client_deposits','quotations','invoices','cheque_tracking'));

ALTER TABLE package_modules DROP CONSTRAINT package_modules_module_key_check;
ALTER TABLE package_modules ADD CONSTRAINT package_modules_module_key_check
  CHECK (module_key IN ('payroll','labor_subcontractors','purchase_orders','client_deposits','quotations','invoices','cheque_tracking'));

-- "Must be on paid version" -- every paid tier (Solo and up), not Free.
INSERT INTO package_modules (package_id, module_key)
SELECT id, 'cheque_tracking' FROM packages WHERE name IN ('Solo','Pro Team','Business','Enterprise');

-- Backfill: an already-active paid tenant's tenant_modules snapshot was
-- computed before this module existed -- grant it now to anyone whose
-- current package already includes it, same as a brand-new subscriber
-- to that tier would get on activation.
INSERT INTO tenant_modules (tenant_id, module_key)
SELECT t.id, 'cheque_tracking' FROM tenants t
JOIN package_modules pm ON pm.package_id = t.package_id AND pm.module_key = 'cheque_tracking'
ON CONFLICT (tenant_id, module_key) DO NOTHING;
