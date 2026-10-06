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

CREATE POLICY admin_full_access ON supplier_deposits FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));
-- applications: clients may only READ; rows are written by the receive RPC (definer)
CREATE POLICY admin_read ON po_deposit_applications FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));

GRANT SELECT, INSERT, UPDATE, DELETE ON supplier_deposits TO authenticated;
GRANT SELECT ON po_deposit_applications TO authenticated;

-- A deposit must reference a same-tenant expense that has the VAT split (needed for the math).
CREATE OR REPLACE FUNCTION sd_validate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE e RECORD;
BEGIN
  SELECT tenant_id, amount_no_vat, vat, supplier_id INTO e FROM expenses WHERE id = NEW.expense_id;
  IF NOT FOUND OR e.tenant_id IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'cross_tenant_reference'; END IF;
  IF e.amount_no_vat IS NULL OR e.vat IS NULL OR e.amount_no_vat <= 0 THEN RAISE EXCEPTION 'deposit_expense_needs_vat_split'; END IF;
  IF e.supplier_id IS NULL THEN RAISE EXCEPTION 'deposit_expense_needs_supplier'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sd_validate_trg BEFORE INSERT OR UPDATE ON supplier_deposits FOR EACH ROW EXECUTE FUNCTION sd_validate();

-- Server-side lock: a deposit expense that has applications keeps its amounts and supplier.
CREATE OR REPLACE FUNCTION expenses_block_deposit_edit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (NEW.amount IS DISTINCT FROM OLD.amount OR NEW.amount_no_vat IS DISTINCT FROM OLD.amount_no_vat
      OR NEW.vat IS DISTINCT FROM OLD.vat OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id)
     AND EXISTS (SELECT 1 FROM po_deposit_applications a JOIN supplier_deposits d ON d.id = a.deposit_id WHERE d.expense_id = OLD.id) THEN
    RAISE EXCEPTION 'deposit_in_use';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER expenses_block_deposit_edit_trg BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION expenses_block_deposit_edit();
