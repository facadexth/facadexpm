-- ============================================================
-- Inventory dual-unit conversion for glass & aluminum.
-- See docs/superpowers/specs/2026-09-05-inventory-dual-unit-conversion-design.md
-- and docs/superpowers/plans/2026-09-05-inventory-dual-unit-conversion-plan.md.
-- ============================================================

ALTER TABLE inventory_items ADD COLUMN unit_conversion_mode TEXT NOT NULL DEFAULT 'plain'
  CHECK (unit_conversion_mode IN ('plain', 'aluminum_profile', 'glass_dimension'));
ALTER TABLE inventory_items ADD COLUMN reference_area_sqm NUMERIC;

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

ALTER TABLE purchase_order_items ADD COLUMN aluminum_profile_id UUID REFERENCES aluminum_profiles(id) ON DELETE SET NULL;
ALTER TABLE purchase_order_items ADD COLUMN rod_length_m NUMERIC;
ALTER TABLE purchase_order_items ADD COLUMN glass_width_m NUMERIC;
ALTER TABLE purchase_order_items ADD COLUMN glass_height_m NUMERIC;
