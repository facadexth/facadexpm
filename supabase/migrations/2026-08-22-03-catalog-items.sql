-- supabase/migrations/2026-08-22-03-catalog-items.sql
-- Sell-side price list only — no cost price, no per-item VAT, no stock
-- quantity. See "Non-Goals" in the design spec for why: the user's
-- buy-side materials and sell-side deliverables are different kinds of
-- things with no 1:1 mapping, so a unified buy/sell catalog with margin
-- tracking would model a business shape that doesn't match how this
-- company actually works.
CREATE TABLE catalog_items (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name               TEXT NOT NULL,
  unit               TEXT,
  default_unit_price NUMERIC NOT NULL DEFAULT 0,
  active             BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id          UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_catalog_items_tenant_id ON catalog_items(tenant_id);

ALTER TABLE catalog_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON catalog_items FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('quotations'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('quotations'));
