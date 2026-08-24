-- invoices table + auto-numbering
-- Task 2 of invoice module
CREATE TABLE invoices (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  invoice_number      TEXT NOT NULL UNIQUE DEFAULT '',
  quotation_id        UUID NOT NULL REFERENCES quotations(id) ON DELETE RESTRICT,
  site_id             UUID NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  date                DATE NOT NULL,
  status              TEXT NOT NULL DEFAULT 'unpaid'
                      CHECK (status IN ('unpaid','paid','void')),
  has_vat             BOOLEAN NOT NULL,
  price_includes_vat  BOOLEAN NOT NULL,
  subtotal            NUMERIC NOT NULL DEFAULT 0,
  vat                 NUMERIC NOT NULL DEFAULT 0,
  total               NUMERIC NOT NULL DEFAULT 0,
  notes               TEXT,
  paid_date           DATE,
  income_id           UUID REFERENCES incomes(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_invoices_quotation_id ON invoices(quotation_id);
CREATE INDEX idx_invoices_site_id ON invoices(site_id);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_tenant_id ON invoices(tenant_id);

-- Auto-numbering: identical pattern to generate_quotation_number()
-- (supabase/schema.sql, search generate_quotation_number) -- INV- + year +
-- zero-padded per-year sequence.
CREATE OR REPLACE FUNCTION generate_invoice_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  year_part TEXT := TO_CHAR(NOW(), 'YYYY');
  seq_num   INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(invoice_number FROM 'INV-\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM invoices
  WHERE invoice_number LIKE 'INV-' || year_part || '-%';
  NEW.invoice_number := 'INV-' || year_part || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_invoice_number
  BEFORE INSERT ON invoices
  FOR EACH ROW
  WHEN (NEW.invoice_number IS NULL OR NEW.invoice_number = '')
  EXECUTE FUNCTION generate_invoice_number();

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON invoices FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'));
