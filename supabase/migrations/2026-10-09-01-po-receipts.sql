-- ============================================================
-- PO-centric deposits and partial receipts (มัดจำจากใบสั่งซื้อ / รับของบางส่วน): schema + locks.
-- Spec: docs/superpowers/specs/2026-10-07-po-deposit-and-partial-receipt-design.md
-- Plan: docs/superpowers/plans/2026-10-07-po-deposit-and-partial-receipt-plan.md (Task 3)
-- Requires (live): 2026-10-07-01..02, 2026-10-08-01..02.
-- Additive except the widened purchase_orders status CHECK. No column on expenses / purchase_orders (expenses_view e.* freezes).
-- New tables are SELECT-only for clients; 2026-10-09-02's RPCs write them.
-- po_receipts.expense_id and expense_splits.* have NO foreign key to expenses on purpose: another
-- purchase_orders<->expenses path would make existing unnamed PostgREST embeds ambiguous.
-- ============================================================

ALTER TABLE purchase_orders DROP CONSTRAINT purchase_orders_status_check;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_status_check
  CHECK (status IN ('draft', 'ordered', 'partially_received', 'received', 'cancelled'));

CREATE TABLE po_receipts (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  po_id          UUID NOT NULL,
  seq            INT NOT NULL CHECK (seq > 0),
  received_date  DATE NOT NULL,
  received_by    TEXT,
  goods_subtotal NUMERIC NOT NULL,
  goods_vat      NUMERIC NOT NULL DEFAULT 0,
  expense_id     UUID,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT po_receipts_po_fk FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  CONSTRAINT po_receipts_seq_uq UNIQUE (po_id, seq),
  -- NaN sorts above everything in PG, so `< 'Infinity'` rejects NaN and Infinity
  CONSTRAINT po_receipts_finite_check CHECK (goods_subtotal > '-Infinity'::numeric AND goods_subtotal < 'Infinity'::numeric
                                         AND goods_vat > '-Infinity'::numeric AND goods_vat < 'Infinity'::numeric)
);
CREATE INDEX idx_po_receipts_tenant ON po_receipts(tenant_id);
CREATE INDEX idx_po_receipts_expense ON po_receipts(expense_id) WHERE expense_id IS NOT NULL;

CREATE TABLE po_receipt_items (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  receipt_id        UUID NOT NULL,
  po_item_id        UUID NOT NULL,
  quantity          NUMERIC NOT NULL,
  line_total        NUMERIC NOT NULL,
  base_qty          NUMERIC,
  unit_cost         NUMERIC,
  stock_movement_id UUID,
  CONSTRAINT po_receipt_items_receipt_fk FOREIGN KEY (receipt_id) REFERENCES po_receipts(id) ON DELETE RESTRICT,
  CONSTRAINT po_receipt_items_item_fk FOREIGN KEY (po_item_id) REFERENCES purchase_order_items(id) ON DELETE RESTRICT,
  CONSTRAINT po_receipt_items_movement_fk FOREIGN KEY (stock_movement_id) REFERENCES stock_movements(id) ON DELETE RESTRICT,
  CONSTRAINT po_receipt_items_item_uq UNIQUE (po_item_id)          -- R1: a line is received once, in full
);
CREATE INDEX idx_pri_receipt ON po_receipt_items(receipt_id);
CREATE INDEX idx_pri_tenant ON po_receipt_items(tenant_id);
CREATE INDEX idx_pri_movement ON po_receipt_items(stock_movement_id) WHERE stock_movement_id IS NOT NULL;

ALTER TABLE supplier_deposits ADD COLUMN po_id UUID;
ALTER TABLE supplier_deposits ADD COLUMN pct_of_po NUMERIC;
ALTER TABLE supplier_deposits ADD CONSTRAINT supplier_deposits_po_fk FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE RESTRICT;
ALTER TABLE supplier_deposits ADD CONSTRAINT supplier_deposits_pct_check CHECK (pct_of_po IS NULL OR (pct_of_po > 0 AND pct_of_po <= 100));
CREATE UNIQUE INDEX supplier_deposits_po_uq ON supplier_deposits (po_id) WHERE po_id IS NOT NULL;   -- R6: one deposit per PO

ALTER TABLE po_deposit_applications ADD COLUMN receipt_id UUID;
ALTER TABLE po_deposit_applications ADD CONSTRAINT pda_receipt_fk FOREIGN KEY (receipt_id) REFERENCES po_receipts(id) ON DELETE RESTRICT;
CREATE INDEX idx_pda_receipt ON po_deposit_applications(receipt_id) WHERE receipt_id IS NOT NULL;

-- R3 audit trail: which bill a split part came from (split_payment writes it; tax-invoice void follows it).
CREATE TABLE expense_splits (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  source_expense_id UUID NOT NULL,
  new_expense_id    UUID NOT NULL UNIQUE,
  paid_amount       NUMERIC NOT NULL CHECK (paid_amount > 0 AND paid_amount < 'Infinity'::numeric),
  paid_date         DATE NOT NULL,
  payment_method    TEXT NOT NULL,
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_expense_splits_source ON expense_splits(source_expense_id);
CREATE INDEX idx_expense_splits_tenant ON expense_splits(tenant_id);

ALTER TABLE po_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE po_receipt_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_splits ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_read ON po_receipts FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));
CREATE POLICY admin_read ON po_receipt_items FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));
CREATE POLICY admin_read ON expense_splits FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));
REVOKE ALL ON po_receipts, po_receipt_items, expense_splits FROM PUBLIC, anon, authenticated;
GRANT SELECT ON po_receipts, po_receipt_items, expense_splits TO authenticated;

-- A deposit may name the PO it was paid for: same tenant, same supplier as its expense. Applied -> frozen.
CREATE OR REPLACE FUNCTION sd_validate_po() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_po_tenant UUID; v_po_sup UUID; v_e_sup UUID;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.po_id IS DISTINCT FROM OLD.po_id OR NEW.pct_of_po IS DISTINCT FROM OLD.pct_of_po)
     AND EXISTS (SELECT 1 FROM po_deposit_applications WHERE deposit_id = OLD.id) THEN
    RAISE EXCEPTION 'deposit_in_use';
  END IF;
  IF NEW.po_id IS NOT NULL THEN
    SELECT tenant_id, supplier_id INTO v_po_tenant, v_po_sup FROM purchase_orders WHERE id = NEW.po_id;
    IF NOT FOUND OR v_po_tenant IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'cross_tenant_reference'; END IF;
    SELECT supplier_id INTO v_e_sup FROM expenses WHERE id = NEW.expense_id;
    IF v_po_sup IS DISTINCT FROM v_e_sup THEN RAISE EXCEPTION 'deposit_wrong_supplier'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sd_validate_po_trg BEFORE INSERT OR UPDATE ON supplier_deposits FOR EACH ROW EXECUTE FUNCTION sd_validate_po();

-- Receipts / the PO's own deposit freeze the PO's money (the PO edit path is not atomic). Status moves only
-- through receive_po_lines (transaction-local flag app.po_receipt_rpc='on'); the legacy ordered -> received of a PO
-- WITHOUT receipts (old client's receive_po_with_deposits) keeps working.
CREATE OR REPLACE FUNCTION po_block_when_receipted() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rcpt BOOLEAN; v_dep BOOLEAN; v_code TEXT;
BEGIN
  IF COALESCE(current_setting('app.po_receipt_rpc', true), '') = 'on' THEN RETURN NEW; END IF;
  IF NEW.status = 'partially_received' AND OLD.status IS DISTINCT FROM 'partially_received' THEN RAISE EXCEPTION 'po_status_rpc_only'; END IF;
  v_rcpt := EXISTS (SELECT 1 FROM po_receipts WHERE po_id = OLD.id);
  v_dep  := EXISTS (SELECT 1 FROM supplier_deposits WHERE po_id = OLD.id);
  IF NOT (v_rcpt OR v_dep) THEN RETURN NEW; END IF;
  v_code := CASE WHEN v_rcpt THEN 'po_has_receipts' ELSE 'po_has_deposit' END;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'ordered' AND NEW.status = 'received' AND NOT v_rcpt) THEN
    RAISE EXCEPTION '%', v_code;
  END IF;
  IF NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR NEW.site_id IS DISTINCT FROM OLD.site_id
     OR NEW.category_id IS DISTINCT FROM OLD.category_id OR NEW.has_vat IS DISTINCT FROM OLD.has_vat
     OR NEW.price_includes_vat IS DISTINCT FROM OLD.price_includes_vat OR NEW.stock_from_invoice IS DISTINCT FROM OLD.stock_from_invoice THEN
    RAISE EXCEPTION '%', v_code;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER po_block_when_receipted_trg BEFORE UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION po_block_when_receipted();

CREATE OR REPLACE FUNCTION poi_block_when_receipted() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_po UUID := CASE WHEN TG_OP = 'INSERT' THEN NEW.po_id ELSE OLD.po_id END;
        v_po2 UUID := CASE WHEN TG_OP = 'UPDATE' THEN NEW.po_id ELSE NULL END;
BEGIN
  -- parent PO lock first (FOR SHARE), so create_po_deposit / receive_po_lines (FOR UPDATE) are seen or wait for us
  PERFORM 1 FROM purchase_orders WHERE id IN (v_po, v_po2) ORDER BY id FOR SHARE;
  IF EXISTS (SELECT 1 FROM po_receipts WHERE po_id IN (v_po, v_po2)) THEN RAISE EXCEPTION 'po_has_receipts'; END IF;
  IF EXISTS (SELECT 1 FROM supplier_deposits WHERE po_id IN (v_po, v_po2)) THEN RAISE EXCEPTION 'po_has_deposit'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER poi_block_when_receipted_trg BEFORE INSERT OR UPDATE OR DELETE ON purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION poi_block_when_receipted();

-- No un-receive in v1: a receipt bill or a split part cannot be deleted from the app (admin SQL only).
CREATE OR REPLACE FUNCTION expenses_block_receipt_bill_delete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM po_receipts WHERE expense_id = OLD.id) THEN RAISE EXCEPTION 'expense_is_receipt_bill'; END IF;
  IF EXISTS (SELECT 1 FROM expense_splits WHERE new_expense_id = OLD.id OR source_expense_id = OLD.id) THEN RAISE EXCEPTION 'expense_is_split_part'; END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER expenses_block_receipt_bill_delete_trg BEFORE DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION expenses_block_receipt_bill_delete();

REVOKE ALL ON FUNCTION sd_validate_po(), po_block_when_receipted(), poi_block_when_receipted(), expenses_block_receipt_bill_delete()
  FROM PUBLIC, anon, authenticated;
