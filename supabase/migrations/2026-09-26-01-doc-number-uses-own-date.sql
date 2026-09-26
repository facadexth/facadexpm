-- invoice_number/receipt_number/tax_invoice_number previously took their
-- YYMM segment from NOW() (row-creation time), not the document's own
-- `date` field. That made bulk/backdated entry (e.g. historical invoices
-- keyed in months after the fact) produce numbers whose month has nothing
-- to do with the invoice's real date, which reads as confusing gibberish
-- to anyone matching documents by hand. Switch the YYMM segment to the
-- row's own `date` (falling back to NOW() only if it's somehow null).
CREATE OR REPLACE FUNCTION generate_invoice_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  year_month TEXT := TO_CHAR(COALESCE(NEW.date, NOW()), 'YYMM');
  seq_num    INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(invoice_number FROM 'IN\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM invoices
  WHERE invoice_number LIKE 'IN' || year_month || '-%';
  NEW.invoice_number := 'IN' || year_month || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION generate_receipt_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  year_month TEXT := TO_CHAR(COALESCE(NEW.date, NOW()), 'YYMM');
  seq_num    INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(receipt_number FROM 'RE\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM receipts
  WHERE receipt_number LIKE 'RE' || year_month || '-%';
  NEW.receipt_number := 'RE' || year_month || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION generate_tax_invoice_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  year_month TEXT := TO_CHAR(COALESCE(NEW.date, NOW()), 'YYMM');
  seq_num    INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(tax_invoice_number FROM 'TR\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM receipts
  WHERE tax_invoice_number LIKE 'TR' || year_month || '-%';
  NEW.tax_invoice_number := 'TR' || year_month || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$;
