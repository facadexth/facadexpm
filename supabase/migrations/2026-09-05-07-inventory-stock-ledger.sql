-- Stock ledger: inventory_stock_balances (running qty + weighted-avg cost per
-- item/site), stock_movements (transaction audit log), and record_stock_movement()
-- (atomic writer for both tables, SECURITY DEFINER to enforce tenant boundary).
-- Per Ruling D in the Phase 1 plan, the function must re-verify tenant ownership
-- before writing anything (RLS is bypassed by SECURITY DEFINER).

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
