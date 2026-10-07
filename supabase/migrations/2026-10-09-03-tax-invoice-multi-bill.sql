-- ============================================================
-- Tax-invoice matching for POs with several bills (receipts / split payments). Requires 2026-10-08-01..02, 2026-10-09-01..02.
-- post_supplier_tax_invoice / void_supplier_tax_invoice are re-created VERBATIM from 2026-10-08-02 plus ONE line each
-- (marked "-- 2026-10-09-03"). Same signatures, same grants: the deployed client is unaffected.
-- KNOWN LIMIT (same as 2026-10-08-01): post/void lock the PO rows first, then the bills. A bulk client UPDATE on
-- expenses (no PO lock) that touches several bills of a PO being posted/voided can lock in the other order and
-- deadlock: Postgres aborts one side with 40P01, the data stays correct, and the user retries.
-- ============================================================

SET LOCAL lock_timeout = '5s';

CREATE TABLE supplier_tax_invoice_expense_stamps (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id          UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  invoice_id         UUID NOT NULL,
  po_id              UUID NOT NULL,      -- plain copy, no FK (see 2026-10-08-01)
  expense_id         UUID NOT NULL,      -- plain copy, no FK (PostgREST ambiguity)
  prev_invoice_no    TEXT,
  stamped_invoice_no TEXT,
  CONSTRAINT stie_invoice_fk FOREIGN KEY (invoice_id) REFERENCES supplier_tax_invoices(id) ON DELETE CASCADE,
  CONSTRAINT stie_invoice_expense_uq UNIQUE (invoice_id, expense_id)
);
CREATE INDEX idx_stie_tenant ON supplier_tax_invoice_expense_stamps(tenant_id);
ALTER TABLE supplier_tax_invoice_expense_stamps ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_read ON supplier_tax_invoice_expense_stamps FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));
REVOKE ALL ON supplier_tax_invoice_expense_stamps FROM PUBLIC, anon, authenticated;
GRANT SELECT ON supplier_tax_invoice_expense_stamps TO authenticated;

-- Every bill of each linked PO other than purchase_orders.expense_id (which step (c) of post already stamps):
-- later receipts' bills and split parts. Deposit and credit-note rows are never bills.
CREATE OR REPLACE FUNCTION _sti_stamp_other_bills(p_id UUID, p_tenant UUID, p_invoice_no TEXT) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE k RECORD; v_n INT := 0;
BEGIN
  FOR k IN SELECT e.id, e.invoice_no, e.po_id
             FROM supplier_tax_invoice_pos l
             JOIN purchase_orders p ON p.id = l.po_id AND p.tenant_id = p_tenant
             JOIN expenses e ON e.po_id = p.id AND e.tenant_id = p_tenant
            WHERE l.invoice_id = p_id AND l.tenant_id = p_tenant
              AND e.id IS DISTINCT FROM p.expense_id
              AND NOT EXISTS (SELECT 1 FROM supplier_tax_invoice_pos x WHERE x.invoice_id = p_id AND x.expense_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM supplier_deposits sd WHERE sd.expense_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM supplier_credit_notes cn WHERE cn.expense_id = e.id)
            ORDER BY e.id
            FOR UPDATE OF e LOOP
    UPDATE expenses
       SET invoice_no = p_invoice_no,
           notes = concat_ws(' | ', NULLIF(btrim(notes), ''),
                     'ใบกำกับภาษี ' || p_invoice_no || ' (เลขเดิม: ' || COALESCE(NULLIF(btrim(k.invoice_no), ''), '-') || ')')
     WHERE id = k.id;
    INSERT INTO supplier_tax_invoice_expense_stamps (tenant_id, invoice_id, po_id, expense_id, prev_invoice_no, stamped_invoice_no)
    VALUES (p_tenant, p_id, k.po_id, k.id, k.invoice_no, p_invoice_no);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

-- Undo of the above, plus bills split off any stamped bill AFTER the post (split_payment copies invoice_no).
-- Only splits made at/after the invoice's posted_at are followed: a bill split off BEFORE the post either still
-- carries po_id (then it was stamped itself and has its own stamp row) or was detached from the PO (never ours).
CREATE OR REPLACE FUNCTION _sti_unstamp_other_bills(p_id UUID, p_tenant UUID, p_invoice_no TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE k RECORD; v_warn JSONB := '[]'::jsonb; v_posted TIMESTAMPTZ;
BEGIN
  SELECT posted_at INTO v_posted FROM supplier_tax_invoices WHERE id = p_id AND tenant_id = p_tenant;
  FOR k IN SELECT * FROM supplier_tax_invoice_expense_stamps WHERE invoice_id = p_id AND tenant_id = p_tenant ORDER BY expense_id LOOP
    UPDATE expenses
       SET invoice_no = k.prev_invoice_no,
           notes = concat_ws(' | ', NULLIF(btrim(notes), ''), 'ยกเลิกใบกำกับภาษี ' || p_invoice_no)
     WHERE id = k.expense_id AND tenant_id = p_tenant AND invoice_no IS NOT DISTINCT FROM k.stamped_invoice_no;
    IF NOT FOUND THEN
      v_warn := v_warn || jsonb_build_object('code', 'expense_changed', 'blocking', false, 'po_id', k.po_id, 'expense_id', k.expense_id);
    END IF;
  END LOOP;
  FOR k IN
    WITH RECURSIVE src AS (
      SELECT expense_id, prev_invoice_no, stamped_invoice_no FROM supplier_tax_invoice_pos
       WHERE invoice_id = p_id AND tenant_id = p_tenant AND expense_id IS NOT NULL AND stamped_invoice_no IS NOT NULL
      UNION ALL
      SELECT expense_id, prev_invoice_no, stamped_invoice_no FROM supplier_tax_invoice_expense_stamps
       WHERE invoice_id = p_id AND tenant_id = p_tenant),
    d AS (
      SELECT s.new_expense_id AS expense_id, src.prev_invoice_no, src.stamped_invoice_no
        FROM expense_splits s JOIN src ON s.source_expense_id = src.expense_id
       WHERE s.tenant_id = p_tenant AND s.created_at >= v_posted
      UNION
      SELECT s.new_expense_id, d.prev_invoice_no, d.stamped_invoice_no
        FROM expense_splits s JOIN d ON s.source_expense_id = d.expense_id
       WHERE s.tenant_id = p_tenant AND s.created_at >= v_posted)
    SELECT * FROM d WHERE d.expense_id NOT IN (SELECT expense_id FROM src) ORDER BY expense_id
  LOOP
    UPDATE expenses
       SET invoice_no = k.prev_invoice_no,
           notes = concat_ws(' | ', NULLIF(btrim(notes), ''), 'ยกเลิกใบกำกับภาษี ' || p_invoice_no)
     WHERE id = k.expense_id AND tenant_id = p_tenant AND invoice_no IS NOT DISTINCT FROM k.stamped_invoice_no;
    IF NOT FOUND THEN v_warn := v_warn || jsonb_build_object('code','expense_changed','blocking',false,'po_id',(SELECT po_id FROM expenses WHERE id = k.expense_id),'expense_id',k.expense_id); END IF;   -- 2026-10-09-03
  END LOOP;
  RETURN v_warn;
END $$;

-- ── post: verbatim from 2026-10-08-02 (lines 317-441) + one line ──
CREATE OR REPLACE FUNCTION post_supplier_tax_invoice(p_id UUID, p_expected_revision INT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  inv supplier_tax_invoices%ROWTYPE;
  v_chk JSONB; v_block TEXT; v_keys JSONB; v_result JSONB; v_created JSONB := '[]'::jsonb;
  v_at TIMESTAMPTZ;
  l RECORD; r RECORD; k RECORD; mv RECORD; rv RECORD;
  v_prev TEXT; v_sub NUMERIC; v_warns JSONB := '[]'::jsonb;
  v_lines INT := 0; v_revs INT := 0; v_stamped INT := 0;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders') AND tenant_can_write()) THEN RAISE EXCEPTION 'insufficient_privilege'; END IF;
  SELECT * INTO inv FROM supplier_tax_invoices WHERE id = p_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invoice_not_found'; END IF;
  IF inv.status <> 'draft' THEN RAISE EXCEPTION 'not_draft'; END IF;
  -- the draft changed after the preview the user looked at (or no revision was passed)
  IF p_expected_revision IS DISTINCT FROM inv.revision THEN RAISE EXCEPTION 'stale_preview'; END IF;

  -- fixed lock order: invoice -> POs by id -> balances by (item, site)
  PERFORM 1 FROM purchase_orders
   WHERE tenant_id = v_tenant AND id IN (SELECT po_id FROM supplier_tax_invoice_pos WHERE invoice_id = p_id)
   ORDER BY id FOR UPDATE;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('item', t.inventory_item_id, 'site', t.site_id)), '[]'::jsonb)
    INTO v_keys FROM _sti_touched_keys(p_id, v_tenant) t;
  -- Make sure every touched (item, site) has a balance row BEFORE locking, in (item, site) order: the locks below then
  -- always land on existing rows (no lost update / deadlock between two posts on a brand-new key). `created` remembers
  -- which rows we made, so the snapshot still says "did not exist" (before 0@0, no stamp) and void restores exactly that.
  WITH ins AS (
    INSERT INTO inventory_stock_balances (tenant_id, inventory_item_id, site_id, quantity_on_hand, weighted_average_cost, updated_at)
    SELECT v_tenant, t.inventory_item_id, t.site_id, 0, 0, now() FROM _sti_touched_keys(p_id, v_tenant) t
     ORDER BY t.inventory_item_id, t.site_id
    ON CONFLICT (inventory_item_id, site_id) DO NOTHING
    RETURNING inventory_item_id, site_id)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('item', ins.inventory_item_id, 'site', ins.site_id)), '[]'::jsonb) INTO v_created FROM ins;
  PERFORM 1 FROM inventory_stock_balances b
   WHERE b.tenant_id = v_tenant
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_keys) e
                  WHERE (e->>'item')::uuid = b.inventory_item_id AND (e->>'site')::uuid = b.site_id)
   ORDER BY b.inventory_item_id, b.site_id FOR UPDATE;

  v_chk := _sti_check(p_id, v_tenant);
  SELECT t.e->>'code' INTO v_block
    FROM jsonb_array_elements(v_chk->'checks') WITH ORDINALITY AS t(e, ord)
   WHERE (t.e->>'blocking')::boolean ORDER BY t.ord LIMIT 1;
  IF v_block IS NOT NULL THEN RAISE EXCEPTION '%', v_block; END IF;

  v_at := (inv.invoice_date + time '12:00') AT TIME ZONE 'Asia/Bangkok';   -- ruling A4

  -- Snapshot the pre-post balance of every touched (item, site) so void can restore it exactly (ruling C1).
  -- Void exactness needs: no stock movement on these keys between post and void (else void_inexact).
  INSERT INTO supplier_tax_invoice_snapshots (tenant_id, invoice_id, inventory_item_id, site_id, before_qty, before_wac, before_updated_at)
  SELECT v_tenant, p_id, t.inventory_item_id, t.site_id, COALESCE(b.quantity_on_hand, 0), COALESCE(b.weighted_average_cost, 0),
         CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_created) e
                            WHERE (e->>'item')::uuid = t.inventory_item_id AND (e->>'site')::uuid = t.site_id)
              THEN NULL ELSE b.updated_at END
    FROM _sti_touched_keys(p_id, v_tenant) t
    LEFT JOIN inventory_stock_balances b ON b.inventory_item_id = t.inventory_item_id AND b.site_id = t.site_id AND b.tenant_id = v_tenant;

  -- (a) invoice lines first, so the common case never dips below zero
  FOR l IN SELECT * FROM _sti_stock_lines(p_id, v_tenant) LOOP
    SELECT * INTO mv FROM record_stock_movement(l.inventory_item_id, l.site_id, 'purchase_in', l.base_qty, l.base_unit_cost,
                                                'supplier_tax_invoice', p_id, 'ใบกำกับ ' || inv.invoice_no);
    UPDATE stock_movements SET created_at = v_at WHERE id = mv.movement_id AND tenant_id = v_tenant;
    UPDATE supplier_tax_invoice_items SET posted_movement_id = mv.movement_id WHERE id = l.line_id AND tenant_id = v_tenant;
    v_lines := v_lines + 1;
  END LOOP;

  -- (b) reverse the linked POs' real receipts at their original cost
  FOR r IN SELECT * FROM _sti_receipt_movements(p_id, v_tenant) LOOP
    SELECT * INTO rv FROM _stock_receipt_reversal(v_tenant, r.inventory_item_id, r.site_id, r.quantity, r.unit_cost,
      'supplier_tax_invoice', p_id, 'กลับรายการรับเข้า ' || r.po_number || ' (ใบกำกับ ' || inv.invoice_no || ')', v_at);
    INSERT INTO supplier_tax_invoice_reversals (tenant_id, invoice_id, po_id, source_movement_id, reversal_movement_id,
                                                inventory_item_id, site_id, quantity, unit_cost)
    VALUES (v_tenant, p_id, r.po_id, r.movement_id, rv.movement_id, r.inventory_item_id, r.site_id, r.quantity, r.unit_cost);
    v_revs := v_revs + 1;
  END LOOP;

  -- Stamp every touched balance row with a post-unique updated_at, then record the post-post state incl. that stamp.
  UPDATE inventory_stock_balances b SET updated_at = clock_timestamp()
    FROM supplier_tax_invoice_snapshots s
   WHERE s.invoice_id = p_id AND s.tenant_id = v_tenant AND b.tenant_id = v_tenant
     AND b.inventory_item_id = s.inventory_item_id AND b.site_id = s.site_id;
  UPDATE supplier_tax_invoice_snapshots s
     SET after_qty = COALESCE((SELECT b.quantity_on_hand FROM inventory_stock_balances b
                                WHERE b.inventory_item_id = s.inventory_item_id AND b.site_id = s.site_id AND b.tenant_id = v_tenant), 0),
         after_wac = COALESCE((SELECT b.weighted_average_cost FROM inventory_stock_balances b
                                WHERE b.inventory_item_id = s.inventory_item_id AND b.site_id = s.site_id AND b.tenant_id = v_tenant), 0),
         after_updated_at = (SELECT b.updated_at FROM inventory_stock_balances b
                              WHERE b.inventory_item_id = s.inventory_item_id AND b.site_id = s.site_id AND b.tenant_id = v_tenant)
   WHERE s.invoice_id = p_id AND s.tenant_id = v_tenant;

  -- (c) stamp the invoice number on each PO's expense; amounts untouched (ruling A6)
  FOR k IN SELECT l2.id AS link_id, p.id AS po_id, p.expense_id
             FROM supplier_tax_invoice_pos l2 JOIN purchase_orders p ON p.id = l2.po_id AND p.tenant_id = v_tenant
            WHERE l2.invoice_id = p_id ORDER BY p.id LOOP
    v_sub := _po_goods_subtotal(k.po_id, v_tenant);
    UPDATE supplier_tax_invoice_pos SET po_subtotal = v_sub WHERE id = k.link_id;
    IF k.expense_id IS NOT NULL THEN
      SELECT invoice_no INTO v_prev FROM expenses WHERE id = k.expense_id AND tenant_id = v_tenant FOR UPDATE;
      IF FOUND THEN
        UPDATE expenses
           SET invoice_no = inv.invoice_no,
               notes = concat_ws(' | ', NULLIF(btrim(notes), ''),
                         'ใบกำกับภาษี ' || inv.invoice_no || ' (เลขเดิม: ' || COALESCE(NULLIF(btrim(v_prev), ''), '-') || ')')
         WHERE id = k.expense_id AND tenant_id = v_tenant;
        UPDATE supplier_tax_invoice_pos
           SET expense_id = k.expense_id, prev_invoice_no = v_prev, stamped_invoice_no = inv.invoice_no
         WHERE id = k.link_id;
        v_stamped := v_stamped + 1;
      ELSE
        -- the PO points at an expense that no longer exists: say so instead of silently skipping
        v_warns := v_warns || jsonb_build_object('code', 'expense_missing', 'blocking', false, 'po_id', k.po_id);
      END IF;
    END IF;
  END LOOP;
  v_stamped := v_stamped + _sti_stamp_other_bills(p_id, v_tenant, inv.invoice_no);   -- 2026-10-09-03

  v_result := jsonb_build_object(
    'lines_posted', v_lines, 'receipts_reversed', v_revs, 'expenses_stamped', v_stamped,
    'po_sum', v_chk->'po_sum', 'diff', v_chk->'diff', 'checks', (v_chk->'checks') || v_warns,
    'negative', _sti_negatives(v_tenant, v_keys));
  UPDATE supplier_tax_invoices
     SET status = 'posted', posted_at = now(), posted_by = auth.email(), match_diff = (v_chk->>'diff')::numeric, post_result = v_result
   WHERE id = p_id;
  RETURN v_result;
END $$;

-- ── void: verbatim from 2026-10-08-02 (lines 444-529) + one line ──
CREATE OR REPLACE FUNCTION void_supplier_tax_invoice(p_id UUID, p_reason TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  inv supplier_tax_invoices%ROWTYPE;
  v_keys JSONB; v_warn JSONB := '[]'::jsonb; v_exact JSONB := '[]'::jsonb;
  r RECORD; m RECORD; k RECORD; mv RECORD; sn RECORD; q NUMERIC; w NUMERIC; u TIMESTAMPTZ;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders') AND tenant_can_write()) THEN RAISE EXCEPTION 'insufficient_privilege'; END IF;
  IF COALESCE(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'void_reason_required'; END IF;
  SELECT * INTO inv FROM supplier_tax_invoices WHERE id = p_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invoice_not_found'; END IF;
  IF inv.status <> 'posted' THEN RAISE EXCEPTION 'not_posted'; END IF;

  PERFORM 1 FROM purchase_orders
   WHERE tenant_id = v_tenant AND id IN (SELECT po_id FROM supplier_tax_invoice_pos WHERE invoice_id = p_id)
   ORDER BY id FOR UPDATE;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('item', x.inventory_item_id, 'site', x.site_id)), '[]'::jsonb) INTO v_keys
    FROM (SELECT inventory_item_id, site_id FROM supplier_tax_invoice_reversals WHERE invoice_id = p_id AND tenant_id = v_tenant
          UNION
          SELECT inventory_item_id, site_id FROM supplier_tax_invoice_items
           WHERE invoice_id = p_id AND tenant_id = v_tenant AND posted_movement_id IS NOT NULL) x;
  PERFORM 1 FROM inventory_stock_balances b
   WHERE b.tenant_id = v_tenant AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_keys) e
                  WHERE (e->>'item')::uuid = b.inventory_item_id AND (e->>'site')::uuid = b.site_id)
   ORDER BY b.inventory_item_id, b.site_id FOR UPDATE;

  -- Exactness (ruling C1): a key whose balance still equals the post-post snapshot is restored to the pre-post
  -- snapshot after the compensating movements are written. A key that moved since is voided by the formulas
  -- and reported as void_inexact (never blocks).
  FOR sn IN SELECT * FROM supplier_tax_invoice_snapshots WHERE invoice_id = p_id AND tenant_id = v_tenant
             ORDER BY inventory_item_id, site_id LOOP
    SELECT quantity_on_hand, weighted_average_cost, updated_at INTO q, w, u FROM inventory_stock_balances
     WHERE inventory_item_id = sn.inventory_item_id AND site_id = sn.site_id AND tenant_id = v_tenant;
    IF NOT FOUND THEN q := 0; w := 0; u := NULL; END IF;
    -- exact only if nothing touched the balance since post: numbers AND the post-unique stamp must match
    IF sn.after_qty IS NOT NULL AND q = sn.after_qty AND w = sn.after_wac AND u IS NOT DISTINCT FROM sn.after_updated_at THEN
      v_exact := v_exact || jsonb_build_object('item', sn.inventory_item_id, 'site', sn.site_id);
    ELSE
      v_warn := v_warn || jsonb_build_object('code', 'void_inexact', 'blocking', false, 'inventory_item_id', sn.inventory_item_id, 'site_id', sn.site_id);
    END IF;
  END LOOP;

  -- (1) put the PO receipts back at their original cost, newest reversal first
  FOR r IN SELECT * FROM supplier_tax_invoice_reversals WHERE invoice_id = p_id AND tenant_id = v_tenant ORDER BY seq DESC LOOP
    SELECT * INTO mv FROM record_stock_movement(r.inventory_item_id, r.site_id, 'purchase_in', r.quantity, r.unit_cost,
                                                'supplier_tax_invoice_void', p_id, 'ยกเลิกใบกำกับ ' || inv.invoice_no || ' (คืนรับเข้าใบสั่งซื้อ)');
    UPDATE supplier_tax_invoice_reversals SET restored_movement_id = mv.movement_id WHERE id = r.id;
  END LOOP;

  -- (2) take the invoice lines back out (exact inverse)
  -- BY THE MOVEMENT IDS post stored on the lines (a hand-made movement carrying the invoice reference is never touched)
  FOR m IN SELECT sm.id, sm.inventory_item_id, sm.site_id, sm.quantity, sm.unit_cost
             FROM supplier_tax_invoice_items i
             JOIN stock_movements sm ON sm.id = i.posted_movement_id AND sm.tenant_id = v_tenant
            WHERE i.invoice_id = p_id AND i.tenant_id = v_tenant
            ORDER BY sm.created_at DESC, sm.id DESC LOOP
    PERFORM _stock_receipt_reversal(v_tenant, m.inventory_item_id, m.site_id, m.quantity, m.unit_cost,
                                    'supplier_tax_invoice_void', p_id, 'ยกเลิกใบกำกับ ' || inv.invoice_no, now());
  END LOOP;

  UPDATE inventory_stock_balances b
     SET quantity_on_hand = s.before_qty, weighted_average_cost = s.before_wac, updated_at = COALESCE(s.before_updated_at, now())
    FROM supplier_tax_invoice_snapshots s
   WHERE s.invoice_id = p_id AND s.tenant_id = v_tenant AND b.tenant_id = v_tenant
     AND b.inventory_item_id = s.inventory_item_id AND b.site_id = s.site_id
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_exact) e
                  WHERE (e->>'item')::uuid = s.inventory_item_id AND (e->>'site')::uuid = s.site_id);

  -- (3) restore expense numbers only where still ours (ruling A6)
  FOR k IN SELECT * FROM supplier_tax_invoice_pos
            WHERE invoice_id = p_id AND tenant_id = v_tenant AND expense_id IS NOT NULL AND stamped_invoice_no IS NOT NULL
            ORDER BY po_id LOOP
    UPDATE expenses
       SET invoice_no = k.prev_invoice_no,
           notes = concat_ws(' | ', NULLIF(btrim(notes), ''), 'ยกเลิกใบกำกับภาษี ' || inv.invoice_no)
     WHERE id = k.expense_id AND tenant_id = v_tenant AND invoice_no IS NOT DISTINCT FROM k.stamped_invoice_no;
    IF NOT FOUND THEN v_warn := v_warn || jsonb_build_object('code', 'expense_changed', 'blocking', false, 'po_id', k.po_id); END IF;
  END LOOP;
  v_warn := v_warn || _sti_unstamp_other_bills(p_id, v_tenant, inv.invoice_no);   -- 2026-10-09-03

  UPDATE supplier_tax_invoice_pos SET active = false WHERE invoice_id = p_id AND tenant_id = v_tenant;
  UPDATE supplier_tax_invoices
     SET status = 'void', voided_at = now(), voided_by = auth.email(), void_reason = btrim(p_reason)
   WHERE id = p_id;
  RETURN jsonb_build_object('warnings', v_warn, 'negative', _sti_negatives(v_tenant, v_keys));
END $$;

REVOKE ALL ON FUNCTION _sti_stamp_other_bills(UUID, UUID, TEXT), _sti_unstamp_other_bills(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION post_supplier_tax_invoice(UUID, INT), void_supplier_tax_invoice(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION post_supplier_tax_invoice(UUID, INT), void_supplier_tax_invoice(UUID, TEXT) TO authenticated;
