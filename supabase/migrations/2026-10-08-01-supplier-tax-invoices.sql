-- ============================================================
-- Supplier tax invoice matching (ใบกำกับภาษีผู้ขาย): schema, locks, private helpers.
-- Spec: docs/superpowers/specs/2026-10-06-supplier-tax-invoice-matching-design.md
-- Plan: docs/superpowers/plans/2026-10-07-supplier-tax-invoice-matching-plan.md
-- Requires (apply first): 2026-10-06-01..03 (credit notes, purchase_return),
--                         2026-10-07-01..02 (supplier deposits, receive_po_with_deposits).
-- Additive, except the widened stock_movements type CHECK.
-- No column on expenses (expenses_view e.* freezes). No view created.
-- Clients get SELECT only; all writes go through 2026-10-08-02's RPCs.
-- ============================================================

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS stock_from_invoice BOOLEAN NOT NULL DEFAULT false;
-- (If Task 2 Step 1 q4 found a view on purchase_orders.*, re-create it here.)

CREATE TABLE supplier_tax_invoices (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  supplier_id    UUID NOT NULL,
  invoice_no     TEXT NOT NULL CHECK (btrim(invoice_no) <> ''),
  invoice_date   DATE NOT NULL,
  net_before_vat NUMERIC NOT NULL CHECK (net_before_vat >= 0),
  vat            NUMERIC NOT NULL DEFAULT 0 CHECK (vat >= 0),
  grand_total    NUMERIC NOT NULL CHECK (grand_total >= 0),
  match_diff     NUMERIC,
  match_note     TEXT,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'void')),
  post_result    JSONB,
  void_reason    TEXT,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_by      TEXT,
  posted_at      TIMESTAMPTZ,
  voided_by      TEXT,
  voided_at      TIMESTAMPTZ,
  CONSTRAINT sti_total_sum_check CHECK (round(net_before_vat + vat - grand_total, 2) = 0),
  CONSTRAINT sti_supplier_fk FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX sti_invoice_no_active_uq ON supplier_tax_invoices (tenant_id, supplier_id, lower(btrim(invoice_no))) WHERE status <> 'void';
CREATE INDEX idx_sti_tenant ON supplier_tax_invoices(tenant_id);
CREATE INDEX idx_sti_supplier ON supplier_tax_invoices(supplier_id);

CREATE TABLE supplier_tax_invoice_items (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  invoice_id        UUID NOT NULL,
  sort_order        INT NOT NULL DEFAULT 0,
  description       TEXT NOT NULL CHECK (btrim(description) <> ''),
  qty               NUMERIC NOT NULL CHECK (qty > 0),
  unit              TEXT,
  unit_price        NUMERIC NOT NULL CHECK (unit_price >= 0),
  discount_pct      NUMERIC NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 100),
  amount            NUMERIC NOT NULL CHECK (amount >= 0),
  inventory_item_id UUID,
  site_id           UUID,
  base_qty          NUMERIC,
  base_unit_cost    NUMERIC,
  CONSTRAINT stii_invoice_fk FOREIGN KEY (invoice_id) REFERENCES supplier_tax_invoices(id) ON DELETE CASCADE,
  CONSTRAINT stii_item_fk FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE RESTRICT,
  CONSTRAINT stii_site_fk FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE RESTRICT,
  CONSTRAINT stii_stock_fields_check CHECK (
    (inventory_item_id IS NULL AND site_id IS NULL AND base_qty IS NULL AND base_unit_cost IS NULL)
    OR (inventory_item_id IS NOT NULL AND site_id IS NOT NULL AND base_qty > 0 AND base_unit_cost >= 0))
);
CREATE INDEX idx_stii_invoice ON supplier_tax_invoice_items(invoice_id);
CREATE INDEX idx_stii_tenant ON supplier_tax_invoice_items(tenant_id);

-- expense_id has NO foreign key on purpose (PostgREST would see a second
-- purchase_orders<->expenses path through this table). The RPCs own its integrity.
CREATE TABLE supplier_tax_invoice_pos (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id          UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  invoice_id         UUID NOT NULL,
  po_id              UUID NOT NULL,
  active             BOOLEAN NOT NULL DEFAULT true,
  po_subtotal        NUMERIC,
  expense_id         UUID,
  prev_invoice_no    TEXT,
  stamped_invoice_no TEXT,
  CONSTRAINT stip_invoice_fk FOREIGN KEY (invoice_id) REFERENCES supplier_tax_invoices(id) ON DELETE CASCADE,
  CONSTRAINT stip_po_fk FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  CONSTRAINT stip_invoice_po_uq UNIQUE (invoice_id, po_id)
);
-- Ruling A5: a PO belongs to at most one non-void invoice (drafts included).
CREATE UNIQUE INDEX stip_po_active_uq ON supplier_tax_invoice_pos (po_id) WHERE active;
CREATE INDEX idx_stip_tenant ON supplier_tax_invoice_pos(tenant_id);

-- What post reversed, so void can restore it. po_id/item/site are plain copies (no FK, see above).
CREATE TABLE supplier_tax_invoice_reversals (
  id                   UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  seq                  BIGINT GENERATED ALWAYS AS IDENTITY,
  tenant_id            UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  invoice_id           UUID NOT NULL,
  po_id                UUID NOT NULL,
  source_movement_id   UUID NOT NULL,
  reversal_movement_id UUID NOT NULL,
  restored_movement_id UUID,
  inventory_item_id    UUID NOT NULL,
  site_id              UUID NOT NULL,
  quantity             NUMERIC NOT NULL CHECK (quantity > 0),
  unit_cost            NUMERIC NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stir_invoice_fk FOREIGN KEY (invoice_id) REFERENCES supplier_tax_invoices(id) ON DELETE RESTRICT,
  CONSTRAINT stir_source_fk FOREIGN KEY (source_movement_id) REFERENCES stock_movements(id) ON DELETE RESTRICT,
  CONSTRAINT stir_reversal_fk FOREIGN KEY (reversal_movement_id) REFERENCES stock_movements(id) ON DELETE RESTRICT,
  CONSTRAINT stir_restored_fk FOREIGN KEY (restored_movement_id) REFERENCES stock_movements(id) ON DELETE RESTRICT
);
CREATE INDEX idx_stir_invoice ON supplier_tax_invoice_reversals(invoice_id);
CREATE INDEX idx_stir_po ON supplier_tax_invoice_reversals(po_id);
CREATE INDEX idx_stir_tenant ON supplier_tax_invoice_reversals(tenant_id);

ALTER TABLE supplier_tax_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_tax_invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_tax_invoice_pos ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_tax_invoice_reversals ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_read ON supplier_tax_invoices FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));
CREATE POLICY admin_read ON supplier_tax_invoice_items FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));
CREATE POLICY admin_read ON supplier_tax_invoice_pos FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));
CREATE POLICY admin_read ON supplier_tax_invoice_reversals FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));

REVOKE ALL ON supplier_tax_invoices, supplier_tax_invoice_items, supplier_tax_invoice_pos, supplier_tax_invoice_reversals FROM anon, authenticated;
GRANT SELECT ON supplier_tax_invoices, supplier_tax_invoice_items, supplier_tax_invoice_pos, supplier_tax_invoice_reversals TO authenticated;

-- New movement type (keep every type q1 listed; add receipt_reversal).
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_movement_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check
  CHECK (movement_type IN ('purchase_in', 'transfer_in', 'transfer_out', 'sale_out', 'sale_reversal', 'adjustment', 'purchase_return', 'receipt_reversal'));

-- ── pure math (mirrored in src/lib/supplierTaxInvoice.js) ──
CREATE OR REPLACE FUNCTION _sti_tolerance(p_base NUMERIC) RETURNS NUMERIC
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT LEAST(abs(COALESCE(p_base, 0)) * 0.01, 5)
$$;

-- = record_stock_movement purchase_in: new qty 0 -> 0.
CREATE OR REPLACE FUNCTION _sti_wac_after_in(q NUMERIC, w NUMERIC, a NUMERIC, c NUMERIC) RETURNS NUMERIC
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE WHEN q + a = 0 THEN 0 ELSE (q * w + a * COALESCE(c, 0)) / (q + a) END
$$;

-- Exact inverse of a receipt (ruling A2): balance <= 0 keeps WAC; never negative.
CREATE OR REPLACE FUNCTION _sti_wac_after_reversal(q NUMERIC, w NUMERIC, r NUMERIC, c NUMERIC) RETURNS NUMERIC
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE WHEN q - r <= 0 THEN w ELSE GREATEST((q * w - r * COALESCE(c, 0)) / (q - r), 0) END
$$;

-- PO goods value ex-VAT. MUST equal receive_po_with_deposits' v_sub (2026-10-07-02 lines 33-39)
-- and calcPoTotals().subtotal in src/lib/poTotals.js. NULL when the PO is not the tenant's.
CREATE OR REPLACE FUNCTION _po_goods_subtotal(p_po_id UUID, p_tenant UUID) RETURNS NUMERIC
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_has_vat BOOLEAN; v_incl BOOLEAN; v_raw NUMERIC;
BEGIN
  SELECT has_vat, price_includes_vat INTO v_has_vat, v_incl FROM purchase_orders WHERE id = p_po_id AND tenant_id = p_tenant;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(line_total), 0) INTO v_raw FROM purchase_order_items WHERE po_id = p_po_id AND tenant_id = p_tenant;
  IF NOT v_has_vat THEN RETURN v_raw;
  ELSIF v_incl THEN RETURN round(round(v_raw, 2) / 1.07, 2);
  ELSE RETURN v_raw;
  END IF;
END $$;

-- True when the PO is linked to a POSTED invoice.
CREATE OR REPLACE FUNCTION _po_tax_invoiced(p_po_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM supplier_tax_invoice_pos l JOIN supplier_tax_invoices i ON i.id = l.invoice_id
                  WHERE l.po_id = p_po_id AND l.active AND i.status = 'posted')
$$;

-- Writer of receipt_reversal movements for the definer RPCs. NOT the only possible writer: stock_movements
-- stays tenant-admin-writable by RLS policy (pre-existing, for every movement type).
CREATE OR REPLACE FUNCTION _stock_receipt_reversal(
  p_tenant UUID, p_item UUID, p_site UUID, p_qty NUMERIC, p_unit_cost NUMERIC,
  p_reference_type TEXT, p_reference_id UUID, p_notes TEXT, p_at TIMESTAMPTZ
) RETURNS TABLE(movement_id UUID, new_quantity_on_hand NUMERIC, new_weighted_average_cost NUMERIC)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_old_qty NUMERIC; v_old_wac NUMERIC; v_new_qty NUMERIC; v_new_wac NUMERIC; v_id UUID;
BEGIN
  IF p_tenant IS NULL OR p_tenant IS DISTINCT FROM current_tenant_id() THEN RAISE EXCEPTION 'insufficient_privilege'; END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN RAISE EXCEPTION 'quantity must be positive'; END IF;
  IF NOT EXISTS (SELECT 1 FROM inventory_items WHERE id = p_item AND tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'inventory_item not found for this tenant';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM sites WHERE id = p_site AND tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'site not found for this tenant';
  END IF;
  SELECT quantity_on_hand, weighted_average_cost INTO v_old_qty, v_old_wac
    FROM inventory_stock_balances WHERE inventory_item_id = p_item AND site_id = p_site FOR UPDATE;
  IF NOT FOUND THEN v_old_qty := 0; v_old_wac := 0; END IF;
  v_new_qty := v_old_qty - p_qty;
  v_new_wac := _sti_wac_after_reversal(v_old_qty, v_old_wac, p_qty, p_unit_cost);

  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost,
                               reference_type, reference_id, notes, created_by, created_at)
  VALUES (p_tenant, p_item, p_site, 'receipt_reversal', p_qty, COALESCE(p_unit_cost, 0),
          p_reference_type, p_reference_id, p_notes, auth.email(), COALESCE(p_at, now()))
  RETURNING id INTO v_id;

  INSERT INTO inventory_stock_balances (tenant_id, inventory_item_id, site_id, quantity_on_hand, weighted_average_cost, updated_at)
  VALUES (p_tenant, p_item, p_site, v_new_qty, v_new_wac, now())
  ON CONFLICT (inventory_item_id, site_id) DO UPDATE
    SET quantity_on_hand = v_new_qty, weighted_average_cost = v_new_wac, updated_at = now();

  RETURN QUERY SELECT v_id, v_new_qty, v_new_wac;
END $$;

-- ── locks (ruling A14) ──
CREATE OR REPLACE FUNCTION po_block_when_tax_invoiced() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (NEW.status IS DISTINCT FROM OLD.status OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
      OR NEW.site_id IS DISTINCT FROM OLD.site_id OR NEW.has_vat IS DISTINCT FROM OLD.has_vat
      OR NEW.price_includes_vat IS DISTINCT FROM OLD.price_includes_vat
      OR NEW.stock_from_invoice IS DISTINCT FROM OLD.stock_from_invoice)
     AND _po_tax_invoiced(OLD.id) THEN
    RAISE EXCEPTION 'po_tax_invoiced';
  END IF;
  IF OLD.status = 'received' AND NEW.stock_from_invoice IS DISTINCT FROM OLD.stock_from_invoice THEN
    RAISE EXCEPTION 'po_stock_flag_locked';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER po_block_when_tax_invoiced_trg BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION po_block_when_tax_invoiced();

CREATE OR REPLACE FUNCTION poi_block_when_tax_invoiced() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Take the parent PO row lock FIRST (FOR SHARE), so a concurrent post (which locks the PO
  -- FOR UPDATE) either finishes before this check (we then see it) or waits for us. Without it
  -- an item edit could slip between the post's check and its commit. Under READ COMMITTED each
  -- statement below gets a fresh snapshot after the lock is granted. Two POs (UPDATE moving an
  -- item between POs) are locked in id order to avoid deadlocks.
  IF TG_OP = 'INSERT' THEN
    PERFORM 1 FROM purchase_orders WHERE id = NEW.po_id FOR SHARE;
    IF _po_tax_invoiced(NEW.po_id) THEN RAISE EXCEPTION 'po_tax_invoiced'; END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.po_id IS DISTINCT FROM NEW.po_id THEN
      PERFORM 1 FROM purchase_orders WHERE id IN (OLD.po_id, NEW.po_id) ORDER BY id FOR SHARE;
    ELSE
      PERFORM 1 FROM purchase_orders WHERE id = NEW.po_id FOR SHARE;
    END IF;
    IF _po_tax_invoiced(OLD.po_id) OR _po_tax_invoiced(NEW.po_id) THEN RAISE EXCEPTION 'po_tax_invoiced'; END IF;
    RETURN NEW;
  ELSE
    PERFORM 1 FROM purchase_orders WHERE id = OLD.po_id FOR SHARE;
    IF _po_tax_invoiced(OLD.po_id) THEN RAISE EXCEPTION 'po_tax_invoiced'; END IF;
    RETURN OLD;
  END IF;
END $$;
CREATE TRIGGER poi_block_when_tax_invoiced_trg BEFORE INSERT OR UPDATE OR DELETE ON purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION poi_block_when_tax_invoiced();

REVOKE ALL ON FUNCTION _sti_tolerance(NUMERIC), _sti_wac_after_in(NUMERIC, NUMERIC, NUMERIC, NUMERIC),
  _sti_wac_after_reversal(NUMERIC, NUMERIC, NUMERIC, NUMERIC), _po_goods_subtotal(UUID, UUID), _po_tax_invoiced(UUID),
  _stock_receipt_reversal(UUID, UUID, UUID, NUMERIC, NUMERIC, TEXT, UUID, TEXT, TIMESTAMPTZ),
  po_block_when_tax_invoiced(), poi_block_when_tax_invoiced()
  FROM PUBLIC, anon, authenticated;

-- Identity sequence of the reversals table: not usable by clients (name resolved, so the REVOKE cannot fail).
DO $$
DECLARE v_seq TEXT := pg_get_serial_sequence('public.supplier_tax_invoice_reversals', 'seq');
BEGIN
  IF v_seq IS NULL THEN RAISE EXCEPTION 'identity sequence of supplier_tax_invoice_reversals.seq not found'; END IF;
  EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated', v_seq);
END $$;
