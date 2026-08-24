-- invoice_items table
-- Task 2 of invoice module
-- description/unit/unit_price are snapshotted at invoice-creation time (not
-- read live from quotation_items), same reasoning as invoices.has_vat --
-- an invoice's printed numbers must never silently shift if the source
-- quotation is ever revisited. draw_qty is the total unit-equivalents this
-- invoice billed for this line, across all its quotation_item_units rows.
CREATE TABLE invoice_items (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  invoice_id         UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  quotation_item_id  UUID NOT NULL REFERENCES quotation_items(id) ON DELETE RESTRICT,
  description        TEXT NOT NULL,
  unit               TEXT,
  unit_price         NUMERIC NOT NULL,
  draw_qty           NUMERIC NOT NULL,
  line_total         NUMERIC NOT NULL,
  sort_order         INT NOT NULL DEFAULT 0,
  tenant_id          UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_invoice_items_invoice_id ON invoice_items(invoice_id);
CREATE INDEX idx_invoice_items_tenant_id ON invoice_items(tenant_id);

ALTER TABLE invoice_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON invoice_items FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'));
