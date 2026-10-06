-- ============================================================
-- Supplier credit notes (purchase returns) + PEAK mapping columns.
-- Spec: docs/superpowers/specs/2026-10-06-supplier-credit-note-peak-export-design.md
-- Additive only, except widening the stock_movements type CHECK and
-- CREATE OR REPLACE of record_stock_movement() (a superset).
-- Does NOT touch expenses/expenses_view (e.* freezes its column list).
-- ============================================================

ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS peak_contact_no TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS tax_id TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS branch_no TEXT;
ALTER TABLE expense_categories ADD COLUMN IF NOT EXISTS peak_account_code TEXT;

CREATE TABLE supplier_credit_notes (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  supplier_id         UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  site_id             UUID NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  doc_number          TEXT NOT NULL,
  doc_date            DATE NOT NULL,
  po_id               UUID REFERENCES purchase_orders(id) ON DELETE SET NULL,
  original_expense_id UUID REFERENCES expenses(id) ON DELETE SET NULL,
  category_id         UUID NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
  amount_no_vat       NUMERIC NOT NULL CHECK (amount_no_vat >= 0),
  vat                 NUMERIC NOT NULL DEFAULT 0 CHECK (vat >= 0),
  amount              NUMERIC NOT NULL CHECK (amount >= 0),
  CONSTRAINT scn_amount_sum_check CHECK (round(amount_no_vat + vat - amount, 2) = 0),
  settlement_status   TEXT NOT NULL DEFAULT 'owed' CHECK (settlement_status IN ('owed', 'offset', 'refunded')),
  settled_at          TIMESTAMPTZ,
  notes               TEXT,
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'void')),
  expense_id          UUID REFERENCES expenses(id) ON DELETE SET NULL,
  created_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at        TIMESTAMPTZ,
  UNIQUE (tenant_id, supplier_id, doc_number)
);
CREATE INDEX idx_scn_tenant ON supplier_credit_notes(tenant_id);
CREATE INDEX idx_scn_supplier ON supplier_credit_notes(supplier_id);

CREATE TABLE supplier_credit_note_items (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  credit_note_id    UUID NOT NULL REFERENCES supplier_credit_notes(id) ON DELETE CASCADE,
  inventory_item_id UUID REFERENCES inventory_items(id) ON DELETE RESTRICT,
  description       TEXT NOT NULL,
  quantity          NUMERIC NOT NULL CHECK (quantity > 0),
  unit              TEXT,
  unit_price        NUMERIC NOT NULL DEFAULT 0
);
CREATE INDEX idx_scni_note ON supplier_credit_note_items(credit_note_id);

ALTER TABLE supplier_credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_credit_note_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON supplier_credit_notes FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));
CREATE POLICY admin_full_access ON supplier_credit_note_items FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders')
    AND EXISTS (SELECT 1 FROM supplier_credit_notes n WHERE n.id = credit_note_id))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders')
    AND EXISTS (SELECT 1 FROM supplier_credit_notes n WHERE n.id = credit_note_id));

-- Lock rules apply only to direct client access (current_user = 'authenticated').
-- SECURITY DEFINER RPCs run as the function owner and stay unrestricted.
CREATE OR REPLACE FUNCTION scn_block_edit_when_posted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'authenticated' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.status <> 'draft' OR NEW.expense_id IS NOT NULL OR NEW.confirmed_at IS NOT NULL
         OR NEW.settled_at IS NOT NULL OR NEW.settlement_status <> 'owed' THEN
        RAISE EXCEPTION 'credit_note_locked';
      END IF;
    ELSIF TG_OP = 'UPDATE' THEN
      IF OLD.status <> 'draft' OR NEW.status <> 'draft'
         OR NEW.expense_id IS DISTINCT FROM OLD.expense_id
         OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
         OR NEW.settled_at IS DISTINCT FROM OLD.settled_at
         OR NEW.settlement_status IS DISTINCT FROM OLD.settlement_status THEN
        RAISE EXCEPTION 'credit_note_locked';
      END IF;
    ELSIF TG_OP = 'DELETE' THEN
      IF OLD.status <> 'draft' THEN
        RAISE EXCEPTION 'credit_note_locked';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scn_lock_insert BEFORE INSERT ON supplier_credit_notes
  FOR EACH ROW EXECUTE FUNCTION scn_block_edit_when_posted();
CREATE TRIGGER scn_lock_update BEFORE UPDATE OR DELETE ON supplier_credit_notes
  FOR EACH ROW EXECUTE FUNCTION scn_block_edit_when_posted();

-- Items can only change while the parent note is a draft.
CREATE OR REPLACE FUNCTION scni_block_edit_when_posted() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF current_user = 'authenticated' THEN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      SELECT status INTO v_status FROM supplier_credit_notes WHERE id = OLD.credit_note_id;
      IF v_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'credit_note_locked'; END IF;
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      SELECT status INTO v_status FROM supplier_credit_notes WHERE id = NEW.credit_note_id;
      IF v_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'credit_note_locked'; END IF;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scni_lock BEFORE INSERT OR UPDATE OR DELETE ON supplier_credit_note_items
  FOR EACH ROW EXECUTE FUNCTION scni_block_edit_when_posted();

-- Cross-tenant reference validation (applies to everyone, including RPCs).
CREATE OR REPLACE FUNCTION scn_validate_refs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM suppliers WHERE id = NEW.supplier_id AND tenant_id = NEW.tenant_id)
     OR NOT EXISTS (SELECT 1 FROM sites WHERE id = NEW.site_id AND tenant_id = NEW.tenant_id)
     OR NOT EXISTS (SELECT 1 FROM expense_categories WHERE id = NEW.category_id AND tenant_id = NEW.tenant_id)
     OR (NEW.po_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM purchase_orders WHERE id = NEW.po_id AND tenant_id = NEW.tenant_id))
     OR (NEW.original_expense_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM expenses WHERE id = NEW.original_expense_id AND tenant_id = NEW.tenant_id))
  THEN
    RAISE EXCEPTION 'cross_tenant_reference';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scn_validate_refs BEFORE INSERT OR UPDATE ON supplier_credit_notes
  FOR EACH ROW EXECUTE FUNCTION scn_validate_refs();

CREATE OR REPLACE FUNCTION scni_validate_refs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.inventory_item_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM inventory_items WHERE id = NEW.inventory_item_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'cross_tenant_reference';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scni_validate_refs BEFORE INSERT OR UPDATE ON supplier_credit_note_items
  FOR EACH ROW EXECUTE FUNCTION scni_validate_refs();

-- New stock movement type
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_movement_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check
  CHECK (movement_type IN ('purchase_in', 'transfer_in', 'transfer_out', 'sale_out', 'sale_reversal', 'adjustment', 'purchase_return'));

-- record_stock_movement(): identical to 2026-09-05-15 plus purchase_return
-- (decrease at the item's current average cost; refuses to go below zero).
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
  v_stored_qty NUMERIC;
  v_stored_cost NUMERIC;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders')) THEN
    RAISE EXCEPTION 'insufficient_privilege';
  END IF;

  IF p_movement_type NOT IN ('purchase_in', 'transfer_in', 'transfer_out', 'adjustment', 'sale_out', 'sale_reversal', 'purchase_return') THEN
    RAISE EXCEPTION 'unsupported_movement_type: %', p_movement_type;
  END IF;

  IF p_movement_type = 'adjustment' THEN
    IF p_quantity IS NULL OR p_quantity < 0 THEN
      RAISE EXCEPTION 'adjustment quantity (new absolute count) must be zero or positive';
    END IF;
  ELSE
    IF p_quantity IS NULL OR p_quantity <= 0 THEN
      RAISE EXCEPTION 'quantity must be positive';
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM inventory_items WHERE id = p_inventory_item_id AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'inventory_item not found for this tenant';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM sites WHERE id = p_site_id AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'site not found for this tenant';
  END IF;

  SELECT quantity_on_hand, weighted_average_cost INTO v_old_qty, v_old_wac
  FROM inventory_stock_balances
  WHERE inventory_item_id = p_inventory_item_id AND site_id = p_site_id
  FOR UPDATE;

  IF NOT FOUND THEN
    v_old_qty := 0;
    v_old_wac := 0;
  END IF;

  IF p_movement_type = 'adjustment' THEN
    v_new_qty := p_quantity;
    v_new_wac := COALESCE(p_unit_cost, v_old_wac);
    v_stored_qty := p_quantity - v_old_qty;
    v_stored_cost := v_new_wac;
  ELSIF p_movement_type IN ('purchase_in', 'transfer_in', 'sale_reversal') THEN
    v_new_qty := v_old_qty + p_quantity;
    IF v_new_qty = 0 THEN
      v_new_wac := 0;
    ELSE
      v_new_wac := (v_old_qty * v_old_wac + p_quantity * COALESCE(p_unit_cost, 0)) / v_new_qty;
    END IF;
    v_stored_qty := p_quantity;
    v_stored_cost := p_unit_cost;
  ELSIF p_movement_type = 'purchase_return' THEN
    IF p_quantity > v_old_qty THEN
      RAISE EXCEPTION 'insufficient_stock';
    END IF;
    v_new_qty := v_old_qty - p_quantity;
    v_new_wac := v_old_wac;
    v_stored_qty := p_quantity;
    v_stored_cost := COALESCE(p_unit_cost, v_old_wac);
  ELSE -- transfer_out, sale_out
    v_new_qty := v_old_qty - p_quantity;
    v_new_wac := v_old_wac;
    v_stored_qty := p_quantity;
    v_stored_cost := p_unit_cost;
  END IF;

  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by)
  VALUES (v_tenant_id, p_inventory_item_id, p_site_id, p_movement_type, v_stored_qty, v_stored_cost, p_reference_type, p_reference_id, p_notes, auth.email())
  RETURNING id INTO v_movement_id;

  INSERT INTO inventory_stock_balances (tenant_id, inventory_item_id, site_id, quantity_on_hand, weighted_average_cost, updated_at)
  VALUES (v_tenant_id, p_inventory_item_id, p_site_id, v_new_qty, v_new_wac, now())
  ON CONFLICT (inventory_item_id, site_id) DO UPDATE
    SET quantity_on_hand = v_new_qty, weighted_average_cost = v_new_wac, updated_at = now();

  RETURN QUERY SELECT v_movement_id, v_new_qty, v_new_wac;
END;
$$;
