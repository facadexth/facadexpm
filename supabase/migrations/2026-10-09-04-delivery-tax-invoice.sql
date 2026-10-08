-- ============================================================
-- Supplier tax invoice per delivery (ใบกำกับภาษี 1 ใบต่อ 1 การส่งของ): schema + guards.
-- Spec: docs/superpowers/specs/2026-10-08-per-delivery-tax-invoice-design.md
-- Plan: docs/superpowers/plans/2026-10-08-per-delivery-tax-invoice-plan.md (Task 3)
-- Requires (live): 2026-10-08-01..02, 2026-10-09-01..03. Additive only.
-- Two columns (no view selects purchase_orders.* or suppliers.*: checked live 2026-10-08; clients already hold
-- table-level INSERT/UPDATE on both tables, so the PO form and the supplier page can set them).
-- New link table: SELECT-only for clients; 2026-10-09-05's RPCs write it. po_id is a plain copy (NO FK): a second
-- purchase_orders <-> supplier_tax_invoices path would make existing many-to-many embeds ambiguous. No FK to expenses.
-- ============================================================

SET LOCAL lock_timeout = '5s';

ALTER TABLE purchase_orders ADD COLUMN tax_invoice_mode TEXT NOT NULL DEFAULT 'po'
  CONSTRAINT po_tax_invoice_mode_check CHECK (tax_invoice_mode IN ('po', 'delivery'));
ALTER TABLE suppliers ADD COLUMN default_tax_invoice_mode TEXT NOT NULL DEFAULT 'po'
  CONSTRAINT suppliers_default_tax_invoice_mode_check CHECK (default_tax_invoice_mode IN ('po', 'delivery'));

CREATE TABLE supplier_tax_invoice_receipts (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  invoice_id     UUID NOT NULL,
  receipt_id     UUID NOT NULL,
  po_id          UUID NOT NULL,      -- plain copy of po_receipts.po_id (checked by sti_link_kind_guard)
  active         BOOLEAN NOT NULL DEFAULT true,
  goods_subtotal NUMERIC,            -- the receipt's goods value when the invoice posted
  goods_vat      NUMERIC,
  CONSTRAINT stirc_invoice_fk FOREIGN KEY (invoice_id) REFERENCES supplier_tax_invoices(id) ON DELETE CASCADE,
  CONSTRAINT stirc_receipt_fk FOREIGN KEY (receipt_id) REFERENCES po_receipts(id) ON DELETE RESTRICT,
  CONSTRAINT stirc_invoice_receipt_uq UNIQUE (invoice_id, receipt_id),
  CONSTRAINT stirc_finite_check CHECK (
    (goods_subtotal IS NULL OR (goods_subtotal > '-Infinity'::numeric AND goods_subtotal < 'Infinity'::numeric))
    AND (goods_vat IS NULL OR (goods_vat > '-Infinity'::numeric AND goods_vat < 'Infinity'::numeric)))
);
-- a receipt belongs to at most one non-void invoice (drafts included), same rule as stip_po_active_uq
CREATE UNIQUE INDEX stirc_receipt_active_uq ON supplier_tax_invoice_receipts (receipt_id) WHERE active;
CREATE INDEX idx_stirc_receipt ON supplier_tax_invoice_receipts(receipt_id);   -- ON DELETE RESTRICT lookups
CREATE INDEX idx_stirc_po ON supplier_tax_invoice_receipts(po_id);
CREATE INDEX idx_stirc_tenant ON supplier_tax_invoice_receipts(tenant_id);

ALTER TABLE supplier_tax_invoice_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_read ON supplier_tax_invoice_receipts FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));
REVOKE ALL ON supplier_tax_invoice_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON supplier_tax_invoice_receipts TO authenticated;

-- An invoice links POs OR receipts, never both; a receipt link must match its receipt (tenant, PO).
-- The invoice row is locked first so two links of different kinds cannot be added concurrently.
CREATE OR REPLACE FUNCTION sti_link_kind_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM 1 FROM supplier_tax_invoices WHERE id = NEW.invoice_id FOR UPDATE;
  IF TG_TABLE_NAME = 'supplier_tax_invoice_receipts' THEN
    IF EXISTS (SELECT 1 FROM supplier_tax_invoice_pos WHERE invoice_id = NEW.invoice_id) THEN RAISE EXCEPTION 'invoice_mixed_links'; END IF;
    IF NOT EXISTS (SELECT 1 FROM supplier_tax_invoices i WHERE i.id = NEW.invoice_id AND i.tenant_id = NEW.tenant_id)
       OR NOT EXISTS (SELECT 1 FROM po_receipts r WHERE r.id = NEW.receipt_id AND r.tenant_id = NEW.tenant_id AND r.po_id = NEW.po_id) THEN
      RAISE EXCEPTION 'cross_tenant_reference';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM supplier_tax_invoice_receipts WHERE invoice_id = NEW.invoice_id) THEN RAISE EXCEPTION 'invoice_mixed_links'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stirc_link_kind_guard_trg BEFORE INSERT OR UPDATE OF invoice_id, receipt_id, po_id ON supplier_tax_invoice_receipts
  FOR EACH ROW EXECUTE FUNCTION sti_link_kind_guard();
CREATE TRIGGER stip_link_kind_guard_trg BEFORE INSERT OR UPDATE OF invoice_id ON supplier_tax_invoice_pos
  FOR EACH ROW EXECUTE FUNCTION sti_link_kind_guard();

-- The mode is set before the first receipt / active PO-level invoice only (owner Q1). A 'delivery' PO is received
-- only through receive_po_lines (flag app.po_receipt_rpc): the old whole-PO receive leaves no receipt to invoice.
CREATE OR REPLACE FUNCTION po_tax_invoice_mode_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.tax_invoice_mode IS DISTINCT FROM OLD.tax_invoice_mode
     AND (OLD.status NOT IN ('draft', 'ordered')
          OR EXISTS (SELECT 1 FROM po_receipts WHERE po_id = OLD.id)
          OR EXISTS (SELECT 1 FROM supplier_tax_invoice_pos WHERE po_id = OLD.id AND active)) THEN
    RAISE EXCEPTION 'po_mode_locked';
  END IF;
  IF NEW.tax_invoice_mode = 'delivery' AND NEW.status IN ('received', 'partially_received')
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status)
     AND COALESCE(current_setting('app.po_receipt_rpc', true), '') <> 'on' THEN
    RAISE EXCEPTION 'po_delivery_needs_receipt';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER po_tax_invoice_mode_guard_trg BEFORE INSERT OR UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION po_tax_invoice_mode_guard();

REVOKE ALL ON FUNCTION sti_link_kind_guard(), po_tax_invoice_mode_guard() FROM PUBLIC, anon, authenticated;
