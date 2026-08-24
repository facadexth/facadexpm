-- The single source of truth for how much of each quotation line has been
-- billed, tracked per physical unit -- see
-- docs/superpowers/specs/2026-08-24-invoice-module-design.md, Data Model.
-- Rows are seeded LAZILY by the app (first time the invoice item-selection
-- screen opens for a quotation), never at quotation-acceptance time -- this
-- table gates on the 'invoices' module, but acceptance is a
-- 'quotations'-only action that must keep working for tenants without
-- 'invoices' at all.
CREATE TABLE quotation_item_units (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  quotation_item_id UUID NOT NULL REFERENCES quotation_items(id) ON DELETE CASCADE,
  unit_index        INT NOT NULL,
  unit_qty          NUMERIC NOT NULL,
  cumulative_pct    NUMERIC NOT NULL DEFAULT 0 CHECK (cumulative_pct BETWEEN 0 AND 100),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id         UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  UNIQUE (quotation_item_id, unit_index)
);

CREATE INDEX idx_quotation_item_units_quotation_item_id ON quotation_item_units(quotation_item_id);
CREATE INDEX idx_quotation_item_units_tenant_id ON quotation_item_units(tenant_id);

ALTER TABLE quotation_item_units ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON quotation_item_units FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'));
