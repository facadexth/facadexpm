-- supabase/migrations/2026-08-22-05-quotation-items.sql
-- Quotation line items — same shape as purchase_order_items, plus an
-- optional catalog_item_id back-reference to the sell-side price list
-- (ON DELETE SET NULL: deleting a catalog item must never take a
-- historical quotation line with it).
CREATE TABLE quotation_items (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  quotation_id     UUID NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  catalog_item_id  UUID REFERENCES catalog_items(id) ON DELETE SET NULL,
  description      TEXT NOT NULL,
  unit             TEXT,
  quantity         NUMERIC NOT NULL DEFAULT 1,
  unit_price       NUMERIC NOT NULL DEFAULT 0,
  line_total       NUMERIC NOT NULL DEFAULT 0,
  sort_order       INT NOT NULL DEFAULT 0,
  tenant_id        UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_quotation_items_quotation_id ON quotation_items(quotation_id);
CREATE INDEX idx_quotation_items_tenant_id ON quotation_items(tenant_id);

ALTER TABLE quotation_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON quotation_items FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('quotations'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('quotations'));
