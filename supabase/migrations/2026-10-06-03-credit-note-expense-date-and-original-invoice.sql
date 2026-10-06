-- Credit note: booking date for the negative expense + reference to the original tax invoice.
-- Additive. expense_date NULL = use doc_date (previous behaviour).
-- The lock/validation triggers (scn_block_edit_when_posted, scn_validate_refs) only compare
-- status/expense_id/confirmed_at/settled_at/settlement_status and tenant refs, so the new
-- columns need no trigger change (they are only writable while the note is a draft).

ALTER TABLE supplier_credit_notes
  ADD COLUMN IF NOT EXISTS expense_date DATE,
  ADD COLUMN IF NOT EXISTS original_invoice_no TEXT,
  ADD COLUMN IF NOT EXISTS original_invoice_date DATE;

CREATE OR REPLACE FUNCTION public.confirm_supplier_credit_note(p_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant UUID := current_tenant_id();
  cn supplier_credit_notes%ROWTYPE;
  it RECORD;
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
    PERFORM record_stock_movement(it.inventory_item_id, cn.site_id, 'purchase_return',
      it.quantity, NULL, 'supplier_credit_note', p_id, 'ใบลดหนี้ ' || cn.doc_number);
  END LOOP;

  INSERT INTO expenses (tenant_id, date, site_id, category_id, supplier_id, description,
                        amount, amount_no_vat, vat, invoice_no, status, notes)
  VALUES (v_tenant, COALESCE(cn.expense_date, cn.doc_date), cn.site_id, cn.category_id, cn.supplier_id,
          'ใบลดหนี้ ' || cn.doc_number,
          -cn.amount, -cn.amount_no_vat, -cn.vat, cn.doc_number,
          CASE WHEN cn.settlement_status = 'owed' THEN 'pending' ELSE 'paid' END,
          cn.notes)
  RETURNING id INTO v_exp;

  UPDATE supplier_credit_notes
     SET status = 'confirmed', expense_id = v_exp, confirmed_at = now()
   WHERE id = p_id;
  RETURN v_exp;
END $function$;

REVOKE ALL ON FUNCTION confirm_supplier_credit_note(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION confirm_supplier_credit_note(UUID) TO authenticated;
