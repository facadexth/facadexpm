-- supabase/migrations/2026-09-09-01-site-name-and-yymm-numbering.sql
-- Two changes, bundled because they land together:
--
-- 1. quotations.site_name -- free-text site/project name captured at
--    quotation time. Quotations are created BEFORE a site formally
--    exists (site_id only gets set later, when the quotation is
--    accepted and converted into a site -- see acceptRow flow in
--    Quotations.jsx), so there's no sites row to read a name from yet.
--    This column is purely descriptive (no FK) -- it's read back by the
--    frontend to suffix saved document filenames, never used in any
--    query or constraint.
--
-- 2. Document numbering switches from PREFIX-YYYY-NNN (yearly reset) to
--    PREFIXYYMM-NNN (monthly reset) for every site-related document,
--    and three prefixes change along with the format:
--      quotations:   QT-YYYY-NNN  -> QTYYMM-NNN   (prefix unchanged)
--      purchase_orders: PO-YYYY-NNN -> POYYMM-NNN (prefix unchanged)
--      invoices:     INV-YYYY-NNN -> INYYMM-NNN   (INV -> IN)
--      receipts.receipt_number:     RCP-YYYY-NNN -> REYYMM-NNN (RCP -> RE)
--      receipts.tax_invoice_number: TIN-YYYY-NNN -> TRYYMM-NNN (TIN -> TR)
--    subscription_receipts (SaaS platform billing, unrelated to
--    construction sites) is intentionally left untouched.
--
--    No backfill -- existing rows keep their old-format numbers; only
--    rows inserted from now on get the new format. Safe to apply
--    directly: the per-tenant UNIQUE constraints (see
--    2026-09-01-05-scope-document-numbers-per-tenant.sql) don't care
--    what shape the string is, and the new format can never collide
--    with an old one (old always contains a 4-digit year segment
--    that's never a valid month).
ALTER TABLE quotations ADD COLUMN site_name TEXT;

CREATE OR REPLACE FUNCTION generate_quotation_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  year_month TEXT := TO_CHAR(NOW(), 'YYMM');
  seq_num    INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(quotation_number FROM 'QT\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM quotations
  WHERE quotation_number LIKE 'QT' || year_month || '-%';
  NEW.quotation_number := 'QT' || year_month || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION generate_po_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  year_month TEXT := TO_CHAR(NOW(), 'YYMM');
  seq_num    INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(po_number FROM 'PO\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM purchase_orders
  WHERE po_number LIKE 'PO' || year_month || '-%';
  NEW.po_number := 'PO' || year_month || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION generate_invoice_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  year_month TEXT := TO_CHAR(NOW(), 'YYMM');
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
  year_month TEXT := TO_CHAR(NOW(), 'YYMM');
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
  year_month TEXT := TO_CHAR(NOW(), 'YYMM');
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
