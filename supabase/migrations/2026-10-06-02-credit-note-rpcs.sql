-- Supplier credit note RPCs (confirm / void / settle).
-- Definer-rights functions so the scn_/scni_ lock triggers (which only restrict
-- current_user = 'authenticated') do not block these functions' own writes.
-- Each re-checks role + tenant. plpgsql functions are atomic: any failure
-- (e.g. insufficient_stock from record_stock_movement) rolls back everything.

CREATE OR REPLACE FUNCTION confirm_supplier_credit_note(p_id UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  cn supplier_credit_notes%ROWTYPE;
  it RECORD;
  v_wac NUMERIC;
  v_exp UUID;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders')) THEN
    RAISE EXCEPTION 'insufficient_privilege';
  END IF;
  SELECT * INTO cn FROM supplier_credit_notes WHERE id = p_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'credit_note_not_found'; END IF;
  IF cn.status <> 'draft' THEN RAISE EXCEPTION 'not_draft'; END IF;
  IF NOT EXISTS (SELECT 1 FROM supplier_credit_note_items WHERE credit_note_id = p_id AND tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'no_items';
  END IF;

  FOR it IN SELECT * FROM supplier_credit_note_items
            WHERE credit_note_id = p_id AND tenant_id = v_tenant
              AND inventory_item_id IS NOT NULL LOOP
    SELECT weighted_average_cost INTO v_wac FROM inventory_stock_balances
      WHERE inventory_item_id = it.inventory_item_id AND site_id = cn.site_id
        AND tenant_id = v_tenant;
    PERFORM record_stock_movement(it.inventory_item_id, cn.site_id, 'purchase_return',
      it.quantity, COALESCE(v_wac, 0), 'supplier_credit_note', p_id, 'ใบลดหนี้ ' || cn.doc_number);
  END LOOP;

  INSERT INTO expenses (tenant_id, date, site_id, category_id, supplier_id, description,
                        amount, amount_no_vat, vat, invoice_no, status, notes)
  VALUES (v_tenant, cn.doc_date, cn.site_id, cn.category_id, cn.supplier_id,
          'ใบลดหนี้ ' || cn.doc_number,
          -cn.amount, -cn.amount_no_vat, -cn.vat, cn.doc_number,
          CASE WHEN cn.settlement_status = 'owed' THEN 'pending' ELSE 'paid' END,
          cn.notes)
  RETURNING id INTO v_exp;

  UPDATE supplier_credit_notes
     SET status = 'confirmed', expense_id = v_exp, confirmed_at = now()
   WHERE id = p_id;
  RETURN v_exp;
END $$;

CREATE OR REPLACE FUNCTION void_supplier_credit_note(p_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  cn supplier_credit_notes%ROWTYPE;
  mv RECORD;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders')) THEN
    RAISE EXCEPTION 'insufficient_privilege';
  END IF;
  SELECT * INTO cn FROM supplier_credit_notes WHERE id = p_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'credit_note_not_found'; END IF;
  IF cn.status <> 'confirmed' THEN RAISE EXCEPTION 'not_confirmed'; END IF;

  -- Re-post stock at the cost stored on each original movement.
  FOR mv IN SELECT inventory_item_id, quantity, unit_cost FROM stock_movements
            WHERE tenant_id = v_tenant AND reference_type = 'supplier_credit_note'
              AND reference_id = p_id AND movement_type = 'purchase_return' LOOP
    PERFORM record_stock_movement(mv.inventory_item_id, cn.site_id, 'purchase_in',
      mv.quantity, mv.unit_cost, 'supplier_credit_note_void', p_id, 'ยกเลิกใบลดหนี้ ' || cn.doc_number);
  END LOOP;

  -- Clear the link first so FK action order cannot matter, then drop the expense.
  UPDATE supplier_credit_notes SET status = 'void', expense_id = NULL WHERE id = p_id;
  DELETE FROM expenses WHERE id = cn.expense_id AND tenant_id = v_tenant;
END $$;

CREATE OR REPLACE FUNCTION set_credit_note_settlement(p_id UUID, p_settlement TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  cn supplier_credit_notes%ROWTYPE;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders')) THEN
    RAISE EXCEPTION 'insufficient_privilege';
  END IF;
  IF p_settlement IS NULL OR p_settlement NOT IN ('owed', 'offset', 'refunded') THEN
    RAISE EXCEPTION 'bad_settlement';
  END IF;
  SELECT * INTO cn FROM supplier_credit_notes WHERE id = p_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'credit_note_not_found'; END IF;
  IF cn.status <> 'confirmed' THEN RAISE EXCEPTION 'not_confirmed'; END IF;
  UPDATE supplier_credit_notes
     SET settlement_status = p_settlement,
         settled_at = CASE WHEN p_settlement = 'owed' THEN NULL ELSE now() END
   WHERE id = p_id;
  UPDATE expenses SET status = CASE WHEN p_settlement = 'owed' THEN 'pending' ELSE 'paid' END
   WHERE id = cn.expense_id AND tenant_id = v_tenant;
END $$;

REVOKE ALL ON FUNCTION confirm_supplier_credit_note(UUID), void_supplier_credit_note(UUID),
  set_credit_note_settlement(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION confirm_supplier_credit_note(UUID), void_supplier_credit_note(UUID),
  set_credit_note_settlement(UUID, TEXT) TO authenticated;
