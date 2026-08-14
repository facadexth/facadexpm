-- Fix the same COUNT(*)-based gap bug (already fixed for site_number and
-- client_number) in the four remaining auto-number generators: any prior
-- deletion of a current-period row leaves a gap, and COUNT(*)+1 then
-- regenerates an already-used number, colliding with a still-existing row.
-- Switch all four to MAX(existing numeric suffix)+1, immune to gaps.

CREATE OR REPLACE FUNCTION generate_invoice_no()
RETURNS TRIGGER AS $$
DECLARE
  prefix TEXT := 'IV' || TO_CHAR(NOW(), 'YYMM') || '-';
  seq_num INT;
BEGIN
  IF NEW.invoice_no IS NULL OR NEW.invoice_no = '' THEN
    SELECT COALESCE(MAX(SUBSTRING(invoice_no FROM 'IV\d{4}-(\d+)$')::INT), 0) + 1
    INTO seq_num
    FROM incomes WHERE invoice_no LIKE prefix || '%';
    NEW.invoice_no := prefix || LPAD(seq_num::TEXT, 3, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION generate_supplier_number()
RETURNS TRIGGER AS $$
DECLARE
  year_part TEXT := TO_CHAR(NOW(), 'YYYY');
  seq_num   INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(supplier_number FROM 'SP-\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM suppliers
  WHERE supplier_number LIKE 'SP-' || year_part || '-%';
  NEW.supplier_number := 'SP-' || year_part || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION generate_subcontractor_number()
RETURNS TRIGGER AS $$
DECLARE
  year_part TEXT := TO_CHAR(NOW(), 'YYYY');
  seq_num   INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(subcontractor_number FROM 'LC-\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM labor_subcontractors
  WHERE subcontractor_number LIKE 'LC-' || year_part || '-%';
  NEW.subcontractor_number := 'LC-' || year_part || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION generate_payment_number()
RETURNS TRIGGER AS $$
DECLARE
  prefix TEXT := 'PY' || TO_CHAR(NOW(), 'YYMM') || '-';
  seq_num INT;
BEGIN
  IF NEW.payment_number IS NULL OR NEW.payment_number = '' THEN
    SELECT COALESCE(MAX(SUBSTRING(payment_number FROM 'PY\d{4}-(\d+)$')::INT), 0) + 1
    INTO seq_num
    FROM labor_payments WHERE payment_number LIKE prefix || '%';
    NEW.payment_number := prefix || LPAD(seq_num::TEXT, 3, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
