-- invoice_item_draws table (per-unit audit trail)
-- Task 2 of invoice module
-- Records exactly which quotation_item_units row moved from what % to
-- what %, and for how much money, on this invoice -- powers the
-- "ประวัติการเรียกเก็บ" history shown per unit in โหมดละเอียด, and is what
-- Task 8's void handler reads to reverse a mistaken invoice's ledger effect.
CREATE TABLE invoice_item_draws (
  id                      UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  invoice_item_id         UUID NOT NULL REFERENCES invoice_items(id) ON DELETE CASCADE,
  quotation_item_unit_id  UUID NOT NULL REFERENCES quotation_item_units(id) ON DELETE RESTRICT,
  prior_pct               NUMERIC NOT NULL,
  target_pct              NUMERIC NOT NULL,
  amount                  NUMERIC NOT NULL,
  tenant_id               UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_invoice_item_draws_invoice_item_id ON invoice_item_draws(invoice_item_id);
CREATE INDEX idx_invoice_item_draws_unit_id ON invoice_item_draws(quotation_item_unit_id);
CREATE INDEX idx_invoice_item_draws_tenant_id ON invoice_item_draws(tenant_id);

ALTER TABLE invoice_item_draws ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON invoice_item_draws FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'));
