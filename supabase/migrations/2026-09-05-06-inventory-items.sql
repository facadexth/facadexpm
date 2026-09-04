-- ============================================================
-- Inventory module Phase 1, part 1/3: item definitions.
-- See docs/superpowers/specs/2026-09-01-inventory-module-design.md
-- and docs/superpowers/plans/2026-09-05-inventory-phase1-plan.md.
-- ============================================================

CREATE TABLE inventory_items (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name        TEXT NOT NULL,
  base_unit   TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
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
