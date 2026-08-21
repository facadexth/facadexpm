-- supabase/migrations/2026-08-22-04-quotations.sql
-- Quotation (ใบเสนอราคา) header. status lifecycle: draft/sent/accepted/
-- rejected/expired. has_vat + price_includes_vat mirror purchase_orders'
-- shape exactly (see 2026-08-18-02-purchase-orders-price-includes-vat.sql).
CREATE TABLE quotations (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  quotation_number    TEXT NOT NULL UNIQUE DEFAULT '',   -- AUTO: QT-2026-001
  client_id           UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  site_id             UUID REFERENCES sites(id) ON DELETE SET NULL,
  date                DATE NOT NULL,
  valid_until         DATE,
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','sent','accepted','rejected','expired')),
  has_vat             BOOLEAN NOT NULL DEFAULT true,
  price_includes_vat  BOOLEAN NOT NULL DEFAULT false,
  discount_amount     NUMERIC,
  discount_pct        NUMERIC,
  payment_terms       TEXT,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_quotations_client_id ON quotations(client_id);
CREATE INDEX idx_quotations_site_id ON quotations(site_id);
CREATE INDEX idx_quotations_status ON quotations(status);
CREATE INDEX idx_quotations_tenant_id ON quotations(tenant_id);

-- Auto-numbering: identical pattern to generate_po_number()
-- (supabase/schema.sql:658) — QT- + year + zero-padded per-year sequence.
CREATE OR REPLACE FUNCTION generate_quotation_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  year_part TEXT := TO_CHAR(NOW(), 'YYYY');
  seq_num   INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(quotation_number FROM 'QT-\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM quotations
  WHERE quotation_number LIKE 'QT-' || year_part || '-%';
  NEW.quotation_number := 'QT-' || year_part || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_quotation_number
  BEFORE INSERT ON quotations
  FOR EACH ROW
  WHEN (NEW.quotation_number IS NULL OR NEW.quotation_number = '')
  EXECUTE FUNCTION generate_quotation_number();

-- quotations-module RLS: single ADMIN+-only full-access policy,
-- tenant-scoped AND gated on has_module_access('quotations') for both
-- reads and writes — same shape as purchase_orders.
ALTER TABLE quotations ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON quotations FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('quotations'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('quotations'));
