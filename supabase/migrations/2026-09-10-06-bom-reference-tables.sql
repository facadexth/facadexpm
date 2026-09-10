-- supabase/migrations/2026-09-10-06-bom-reference-tables.sql
-- BOM Template Engine, part 1 of 3: the small reference catalogs. All
-- three ALTER columns are nullable -- existing aluminum_profiles rows and
-- the procurement-side PO flow that already reads this table (PurchaseOrders.jsx,
-- inventoryCost.js) are completely unaffected. See spec Decisions 2-4.
ALTER TABLE aluminum_profiles ADD COLUMN family TEXT;
ALTER TABLE aluminum_profiles ADD COLUMN series TEXT;
ALTER TABLE aluminum_profiles ADD COLUMN thickness_mm NUMERIC;

CREATE TABLE aluminum_finishes (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id    UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name         TEXT NOT NULL,
  price_per_kg NUMERIC NOT NULL,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_aluminum_finishes_tenant_id ON aluminum_finishes(tenant_id);
ALTER TABLE aluminum_finishes ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON aluminum_finishes FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'));

CREATE TABLE bom_glass_types (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name          TEXT NOT NULL,
  price_per_sqm NUMERIC NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bom_glass_types_tenant_id ON bom_glass_types(tenant_id);
ALTER TABLE bom_glass_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON bom_glass_types FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'));
