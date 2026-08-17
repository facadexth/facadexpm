-- supabase/migrations/2026-08-17-01-purchase-orders-tables.sql
-- Purchase Orders (Phase 1): itemized orders tied to a site/supplier/
-- category, with a status lifecycle (ordered/received/cancelled) and a
-- reference back to the expense created on receipt. See
-- docs/superpowers/specs/2026-08-17-purchase-orders-design.md.

CREATE TABLE purchase_orders (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  po_number       TEXT NOT NULL UNIQUE DEFAULT '',   -- AUTO: PO-2026-001
  site_id         UUID NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  supplier_id     UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  category_id     UUID NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
  date            DATE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ordered'
                  CHECK (status IN ('ordered','received','cancelled')),
  notes           TEXT,
  received_date   DATE,
  expense_id      UUID REFERENCES expenses(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE TABLE purchase_order_items (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  po_id           UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  description     TEXT NOT NULL,
  quantity        NUMERIC NOT NULL DEFAULT 1,
  unit            TEXT,
  unit_price      NUMERIC NOT NULL DEFAULT 0,
  line_total      NUMERIC NOT NULL DEFAULT 0,
  sort_order      INT NOT NULL DEFAULT 0,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_purchase_orders_site_id ON purchase_orders(site_id);
CREATE INDEX idx_purchase_orders_supplier_id ON purchase_orders(supplier_id);
CREATE INDEX idx_purchase_orders_status ON purchase_orders(status);
CREATE INDEX idx_purchase_orders_tenant_id ON purchase_orders(tenant_id);
CREATE INDEX idx_purchase_order_items_po_id ON purchase_order_items(po_id);
CREATE INDEX idx_purchase_order_items_tenant_id ON purchase_order_items(tenant_id);

-- Auto-numbering, same pattern as generate_site_number()/generate_supplier_number()
-- (MAX(existing suffix)+1, not COUNT(*)+1 — see the comment above
-- generate_site_number() in schema.sql for why COUNT(*)+1 breaks when a
-- row is deleted). Matches those functions' lack of tenant_id scoping —
-- an existing, consistent quirk across every numbering trigger in this
-- app, not something to fix only here.
CREATE OR REPLACE FUNCTION generate_po_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  year_part TEXT := TO_CHAR(NOW(), 'YYYY');
  seq_num   INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(po_number FROM 'PO-\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM purchase_orders
  WHERE po_number LIKE 'PO-' || year_part || '-%';
  NEW.po_number := 'PO-' || year_part || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_po_number
  BEFORE INSERT ON purchase_orders
  FOR EACH ROW
  WHEN (NEW.po_number IS NULL OR NEW.po_number = '')
  EXECUTE FUNCTION generate_po_number();

-- purchase_orders-module RLS: single ADMIN+-only full-access policy,
-- tenant-scoped AND gated on has_module_access('purchase_orders') for
-- both reads and writes — same shape as labor_subcontractors.
ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON purchase_orders FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));

ALTER TABLE purchase_order_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON purchase_order_items FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));
