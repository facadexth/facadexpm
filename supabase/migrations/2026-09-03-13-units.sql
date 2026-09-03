-- supabase/migrations/2026-09-03-13-units.sql
-- A per-tenant list of known unit-of-measure strings (ตร.ม., ชิ้น, กก. ...)
-- feeding a dropdown-with-inline-add reused across catalog_items,
-- quotation_items, and purchase_order_items (sell-side and buy-side).
-- Deliberately just a flat name list, not tied to any conversion/base-
-- unit system -- kept separate from the (not-yet-built) inventory
-- module's own unit-of-measure design, which is a different, bigger
-- concern (see docs/superpowers/specs/2026-09-01-inventory-module-design.md).
--
-- unit columns on catalog_items/quotation_items/purchase_order_items
-- stay plain TEXT (no FK/schema change to those tables) -- this table
-- only supplies the dropdown's known-values list; picking or adding a
-- unit just writes its name as a string, same as typing it always did.
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

-- Backfill from every unit string already in use, so existing tenants
-- see their own past values in the dropdown immediately.
INSERT INTO units (tenant_id, name)
SELECT DISTINCT tenant_id, unit FROM (
  SELECT tenant_id, unit FROM catalog_items WHERE unit IS NOT NULL AND unit != ''
  UNION
  SELECT tenant_id, unit FROM quotation_items WHERE unit IS NOT NULL AND unit != ''
  UNION
  SELECT tenant_id, unit FROM purchase_order_items WHERE unit IS NOT NULL AND unit != ''
) x
ON CONFLICT (tenant_id, name) DO NOTHING;
