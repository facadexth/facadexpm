-- PO deposit deduction (หักมัดจำ). Spec: docs/superpowers/specs/2026-10-06-po-deposit-deduction-design.md
-- Additive only. No columns added to expenses (expenses_view e.* freezes).

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS deposit_hint JSONB;   -- [{ref, amount_no_vat}] read from a scanned supplier document

CREATE TABLE supplier_deposits (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id          UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  expense_id         UUID NOT NULL UNIQUE REFERENCES expenses(id) ON DELETE RESTRICT,
  deposit_invoice_no TEXT NOT NULL CHECK (btrim(deposit_invoice_no) <> ''),
  created_by         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX supplier_deposits_invoice_uq ON supplier_deposits (tenant_id, lower(btrim(deposit_invoice_no)));
CREATE INDEX idx_supplier_deposits_tenant ON supplier_deposits(tenant_id);

CREATE TABLE po_deposit_applications (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  deposit_id    UUID NOT NULL REFERENCES supplier_deposits(id) ON DELETE RESTRICT,
  po_id         UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  amount_no_vat NUMERIC NOT NULL CHECK (amount_no_vat > 0),
  vat           NUMERIC NOT NULL DEFAULT 0 CHECK (vat >= 0),
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pda_deposit ON po_deposit_applications(deposit_id);
CREATE INDEX idx_pda_po ON po_deposit_applications(po_id);
CREATE INDEX idx_pda_tenant ON po_deposit_applications(tenant_id);

ALTER TABLE supplier_deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE po_deposit_applications ENABLE ROW LEVEL SECURITY;

-- Reads need only role/tenant/module; every write also needs tenant_can_write() (expired/unpaid tenants are read-only).
CREATE POLICY admin_read ON supplier_deposits FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));
CREATE POLICY admin_insert ON supplier_deposits FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders') AND tenant_can_write());
CREATE POLICY admin_update ON supplier_deposits FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders') AND tenant_can_write())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders') AND tenant_can_write());
CREATE POLICY admin_delete ON supplier_deposits FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders') AND tenant_can_write());
-- applications: clients may only READ; rows are written by the receive RPC (definer)
CREATE POLICY admin_read ON po_deposit_applications FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));

REVOKE ALL ON po_deposit_applications FROM PUBLIC, anon, authenticated;
REVOKE ALL ON supplier_deposits FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON supplier_deposits TO authenticated;
GRANT SELECT ON po_deposit_applications TO authenticated;

-- A deposit must reference a same-tenant expense that has the VAT split (needed for the math).
CREATE OR REPLACE FUNCTION sd_validate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE e RECORD;
BEGIN
  SELECT tenant_id, amount, amount_no_vat, vat, supplier_id, po_id INTO e FROM expenses WHERE id = NEW.expense_id;
  IF NOT FOUND OR e.tenant_id IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'cross_tenant_reference'; END IF;
  IF e.amount_no_vat IS NULL OR e.vat IS NULL OR e.amount_no_vat <= 0 THEN RAISE EXCEPTION 'deposit_expense_needs_vat_split'; END IF;
  IF round(e.amount_no_vat + e.vat - e.amount, 2) <> 0 THEN RAISE EXCEPTION 'deposit_expense_bad_split'; END IF;
  IF e.supplier_id IS NULL THEN RAISE EXCEPTION 'deposit_expense_needs_supplier'; END IF;
  IF e.po_id IS NOT NULL THEN RAISE EXCEPTION 'deposit_expense_is_po_generated'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sd_validate_trg BEFORE INSERT OR UPDATE ON supplier_deposits FOR EACH ROW EXECUTE FUNCTION sd_validate();

-- Server-side lock: a deposit expense that has applications keeps its amounts and supplier.
CREATE OR REPLACE FUNCTION expenses_block_deposit_edit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (NEW.amount IS DISTINCT FROM OLD.amount OR NEW.amount_no_vat IS DISTINCT FROM OLD.amount_no_vat
      OR NEW.vat IS DISTINCT FROM OLD.vat OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
      OR NEW.po_id IS DISTINCT FROM OLD.po_id)
     AND EXISTS (SELECT 1 FROM po_deposit_applications a JOIN supplier_deposits d ON d.id = a.deposit_id WHERE d.expense_id = OLD.id) THEN
    RAISE EXCEPTION 'deposit_in_use';
  END IF;
  IF NEW.po_id IS NOT NULL AND NEW.po_id IS DISTINCT FROM OLD.po_id
     AND EXISTS (SELECT 1 FROM supplier_deposits WHERE expense_id = OLD.id) THEN
    RAISE EXCEPTION 'deposit_expense_is_po_generated';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER expenses_block_deposit_edit_trg BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION expenses_block_deposit_edit();

-- A deposit that has applications keeps its expense, number, tenant and id.
CREATE OR REPLACE FUNCTION sd_lock_when_applied() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (NEW.expense_id IS DISTINCT FROM OLD.expense_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.deposit_invoice_no IS DISTINCT FROM OLD.deposit_invoice_no OR NEW.id IS DISTINCT FROM OLD.id)
     AND EXISTS (SELECT 1 FROM po_deposit_applications WHERE deposit_id = OLD.id) THEN
    RAISE EXCEPTION 'deposit_in_use';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sd_lock_when_applied_trg BEFORE UPDATE ON supplier_deposits FOR EACH ROW EXECUTE FUNCTION sd_lock_when_applied();

-- A received PO that has deposit applications cannot be moved away from 'received' (un-receive / cancel):
-- the applications would stay behind (clients cannot delete them) and a re-receive would double-count or
-- strand the deposit. The receive RPC itself goes ordered -> received and is unaffected.
CREATE OR REPLACE FUNCTION po_block_unreceive_with_deposits() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.status = 'received' AND NEW.status IS DISTINCT FROM 'received'
     AND EXISTS (SELECT 1 FROM po_deposit_applications WHERE po_id = OLD.id) THEN
    RAISE EXCEPTION 'po_has_deposit_applications';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER po_block_unreceive_with_deposits_trg BEFORE UPDATE OF status ON purchase_orders FOR EACH ROW EXECUTE FUNCTION po_block_unreceive_with_deposits();
