-- supabase/migrations/2026-08-24-06-receipts.sql
-- One physical document (ใบเสร็จรับเงิน/ใบกำกับภาษี combined), printed with
-- two independently-sequential numbers -- Thai tax practice expects the tax
-- invoice series to be its own unbroken sequence even when printed on the
-- same page as the receipt. invoice_id is UNIQUE because payment is
-- single-shot -- at most one receipt can ever exist per invoice.
CREATE TABLE receipts (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  receipt_number      TEXT NOT NULL UNIQUE DEFAULT '',
  tax_invoice_number  TEXT NOT NULL UNIQUE DEFAULT '',
  invoice_id          UUID NOT NULL UNIQUE REFERENCES invoices(id) ON DELETE RESTRICT,
  date                DATE NOT NULL,
  amount              NUMERIC NOT NULL,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_receipts_invoice_id ON receipts(invoice_id);
CREATE INDEX idx_receipts_tenant_id ON receipts(tenant_id);

CREATE OR REPLACE FUNCTION generate_receipt_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  year_part TEXT := TO_CHAR(NOW(), 'YYYY');
  seq_num   INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(receipt_number FROM 'RCP-\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM receipts
  WHERE receipt_number LIKE 'RCP-' || year_part || '-%';
  NEW.receipt_number := 'RCP-' || year_part || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_receipt_number
  BEFORE INSERT ON receipts
  FOR EACH ROW
  WHEN (NEW.receipt_number IS NULL OR NEW.receipt_number = '')
  EXECUTE FUNCTION generate_receipt_number();

CREATE OR REPLACE FUNCTION generate_tax_invoice_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  year_part TEXT := TO_CHAR(NOW(), 'YYYY');
  seq_num   INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(tax_invoice_number FROM 'TIN-\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM receipts
  WHERE tax_invoice_number LIKE 'TIN-' || year_part || '-%';
  NEW.tax_invoice_number := 'TIN-' || year_part || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tax_invoice_number
  BEFORE INSERT ON receipts
  FOR EACH ROW
  WHEN (NEW.tax_invoice_number IS NULL OR NEW.tax_invoice_number = '')
  EXECUTE FUNCTION generate_tax_invoice_number();

ALTER TABLE receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON receipts FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'));
