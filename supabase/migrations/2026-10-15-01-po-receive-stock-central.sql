-- ================================================================
-- 2026-10-15-01: stock received from a PO goes to the central site "ส่วนกลาง"
-- Owner rule (2026-10-15): stock is kept centrally; expenses stay on the PO's job site.
-- - central_stock_site_id(tenant): the tenant's site named ส่วนกลาง (trimmed), or NULL
-- - receive_po_lines: purchase_in movements use that site instead of po.site_id; raises
--   central_site_missing (before any write) when the receipt posts stock and the site does not exist
-- Existing balances on job sites are left as they are (owner: "ไม่ย้าย").
-- The whole-PO receive path (client: record_stock_movement) is changed in the app in the same release.
-- Body of receive_po_lines = 2026-10-09-02 verbatim except the three marked lines.
-- ================================================================

CREATE OR REPLACE FUNCTION central_stock_site_id(p_tenant UUID)
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM sites WHERE tenant_id = p_tenant AND btrim(name) = 'ส่วนกลาง' ORDER BY created_at NULLS LAST, id LIMIT 1
$$;
REVOKE ALL ON FUNCTION central_stock_site_id(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION central_stock_site_id(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION receive_po_lines(p_po_id UUID, p_line_ids UUID[], p_received_date DATE, p_deduction JSONB,
  p_expected_subtotal NUMERIC, p_expected_vat NUMERIC, p_stock JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  v_today DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  po purchase_orders%ROWTYPE; rv RECORD; d RECORD; li RECORD; sup RECORD;
  v_ids UUID[]; v_n INT; v_seq INT; v_no TEXT; v_rcpt UUID; v_exp UUID := NULL; v_status TEXT; v_at TIMESTAMPTZ; v_mid UUID;
  v_rgross NUMERIC; a JSONB; v_dep UUID; v_mode TEXT; v_val NUMERIC; v_gross NUMERIC; v_rem_gross NUMERIC;
  v_used_net NUMERIC; v_used_vat NUMERIC; v_rem_net NUMERIC; v_rem_vat NUMERIC; v_amt NUMERIC; v_dvat NUMERIC;
  v_sum_net NUMERIC := 0; v_sum_vat NUMERIC := 0; v_net NUMERIC; v_vat_pay NUMERIC;
  v_apps JSONB := '[]'::jsonb; v_seen UUID[] := '{}'; v_cov NUMERIC := 0; v_parsed JSONB := '[]'::jsonb; v_last JSONB;
  v_has_ded BOOLEAN; v_tol NUMERIC; v_tolerated BOOLEAN;
  s JSONB; v_stock JSONB := '{}'::jsonb; v_item UUID; v_bq NUMERIC; v_uc NUMERIC; v_line_net NUMERIC; v_stock_site UUID;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders') AND tenant_can_write()) THEN RAISE EXCEPTION 'insufficient_privilege'; END IF;
  SELECT * INTO po FROM purchase_orders WHERE id = p_po_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'po_not_found'; END IF;
  IF po.status NOT IN ('ordered', 'partially_received') THEN RAISE EXCEPTION 'po_not_receivable'; END IF;
  -- R7: tax-invoice linking needs status 'received', so this is normally unreachable; checked explicitly so a
  -- hand-linked PO fails with the clean code before any write (the PO/stock triggers would raise the same code later)
  IF _po_tax_invoiced(po.id) THEN RAISE EXCEPTION 'po_tax_invoiced'; END IF;
  -- applications without a receipt = the PO was received the old way and later un-received by hand: never receive it again here
  IF EXISTS (SELECT 1 FROM po_deposit_applications WHERE po_id = po.id AND receipt_id IS NULL) THEN RAISE EXCEPTION 'po_has_deposit_applications'; END IF;
  IF p_received_date IS NULL THEN RAISE EXCEPTION 'bad_received_date'; END IF;
  IF p_received_date > v_today THEN RAISE EXCEPTION 'received_date_in_future'; END IF;

  SELECT array_agg(DISTINCT u ORDER BY u) INTO v_ids FROM unnest(COALESCE(p_line_ids, '{}'::uuid[])) AS u WHERE u IS NOT NULL;
  IF v_ids IS NULL OR cardinality(v_ids) <> cardinality(COALESCE(p_line_ids, '{}'::uuid[])) THEN RAISE EXCEPTION 'bad_lines'; END IF;
  SELECT count(*) INTO v_n FROM purchase_order_items WHERE po_id = po.id AND tenant_id = v_tenant AND id = ANY (v_ids);
  IF v_n <> cardinality(v_ids) THEN RAISE EXCEPTION 'bad_lines'; END IF;
  IF EXISTS (SELECT 1 FROM po_receipt_items WHERE po_item_id = ANY (v_ids)) THEN RAISE EXCEPTION 'line_already_received'; END IF;
  -- v1 limit: negative (discount) lines are not receivable line by line (the final-receipt rule would turn them into
  -- a negative receipt that the bill clamps to 0, i.e. the supplier would be overpaid)
  IF EXISTS (SELECT 1 FROM purchase_order_items WHERE id = ANY (v_ids) AND tenant_id = v_tenant AND line_total < 0) THEN
    RAISE EXCEPTION 'bad_lines';
  END IF;

  SELECT * INTO rv FROM _po_receipt_value(po.id, v_tenant, v_ids);
  IF rv.subtotal IS NULL OR rv.vat IS NULL THEN RAISE EXCEPTION 'bad_lines'; END IF;
  -- A receipt value may not be negative, except the FINAL receipt WITHOUT deductions, whose remainder (PO minus the
  -- earlier, satang-rounded receipts) may sit up to 0.01 per earlier receipt below 0. It is stored as computed (the
  -- receipts still add up to the PO exactly); no bill when it is worth <= 0 (see below). Mirror: computeReceiveDeductions.
  v_has_ded := jsonb_typeof(COALESCE(p_deduction, '[]'::jsonb)) = 'array' AND jsonb_array_length(COALESCE(p_deduction, '[]'::jsonb)) > 0;
  v_tol := CASE WHEN rv.is_final AND NOT v_has_ded THEN 0.01 * rv.n_prior ELSE 0 END;
  IF rv.subtotal < -(v_tol + 0.005) OR rv.vat < -(v_tol + 0.005) THEN RAISE EXCEPTION 'bad_lines'; END IF;
  v_tolerated := rv.is_final AND NOT v_has_ded AND (rv.subtotal < 0 OR rv.vat < 0);
  IF abs(rv.subtotal - COALESCE(p_expected_subtotal, -1)) > 0.01 OR abs(rv.vat - COALESCE(p_expected_vat, -1)) > 0.01 THEN
    RAISE EXCEPTION 'totals_mismatch';
  END IF;
  v_rgross := round(rv.subtotal + rv.vat, 2);

  -- deductions: VAT-inclusive input -> net by the deposit's own ratio -> VAT by the R5 rule (= deductionFromInput)
  IF jsonb_typeof(COALESCE(p_deduction, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'bad_deduction'; END IF;
  -- pass 1: parse and validate every element (no locks yet); the deposit id is kept as a cast uuid
  FOR a IN SELECT value FROM jsonb_array_elements(COALESCE(p_deduction, '[]'::jsonb)) LOOP
    BEGIN
      v_dep := (a->>'deposit_id')::uuid; v_mode := a->>'mode'; v_val := (a->>'value')::numeric;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'bad_deduction';
    END;
    IF v_dep IS NULL OR v_mode IS NULL OR v_mode NOT IN ('percent', 'value') OR NOT _sti_finite(v_val) OR v_val <= 0
       OR (v_mode = 'percent' AND v_val > 100) OR v_dep = ANY (v_seen) THEN RAISE EXCEPTION 'bad_deduction'; END IF;
    v_seen := v_seen || v_dep;
    v_parsed := v_parsed || jsonb_build_object('deposit_id', v_dep, 'mode', v_mode, 'value', v_val);
  END LOOP;
  -- pass 2: lock and apply in uuid order (fixed lock order whatever the case/format of the ids sent; uuid order =
  -- byte order of the canonical lower-case text, the order the client's computeReceivePlan uses for the fold)
  FOR a IN SELECT value FROM jsonb_array_elements(v_parsed) ORDER BY (value->>'deposit_id')::uuid LOOP
    v_dep := (a->>'deposit_id')::uuid; v_mode := a->>'mode'; v_val := (a->>'value')::numeric;
    v_gross := CASE WHEN v_mode = 'percent' THEN round(v_val / 100 * v_rgross, 2) ELSE round(v_val, 2) END;
    IF v_gross <= 0 THEN RAISE EXCEPTION 'bad_deduction'; END IF;
    SELECT sd.id, sd.po_id, e.tenant_id AS e_tenant, e.supplier_id, e.amount, e.amount_no_vat, e.vat INTO d
      FROM supplier_deposits sd JOIN expenses e ON e.id = sd.expense_id
     WHERE sd.id = v_dep AND sd.tenant_id = v_tenant FOR UPDATE OF sd, e;
    IF NOT FOUND OR d.e_tenant IS DISTINCT FROM v_tenant THEN RAISE EXCEPTION 'deposit_not_found'; END IF;
    IF d.supplier_id IS DISTINCT FROM po.supplier_id THEN RAISE EXCEPTION 'deposit_wrong_supplier'; END IF;
    -- a deposit created for a PO is deducted on that PO only
    IF d.po_id IS NOT NULL AND d.po_id <> po.id THEN RAISE EXCEPTION 'deposit_other_po'; END IF;
    IF d.amount_no_vat IS NULL OR d.vat IS NULL OR d.amount_no_vat <= 0 OR round(d.amount_no_vat + d.vat - d.amount, 2) <> 0 THEN
      RAISE EXCEPTION 'deposit_expense_needs_vat_split';
    END IF;
    SELECT COALESCE(SUM(amount_no_vat), 0), COALESCE(SUM(vat), 0) INTO v_used_net, v_used_vat FROM po_deposit_applications WHERE deposit_id = d.id;
    v_rem_net := round(d.amount_no_vat - v_used_net, 2); v_rem_vat := round(d.vat - v_used_vat, 2);
    v_rem_gross := round(v_rem_net + v_rem_vat, 2);
    -- re-checked under the lock: applications beyond the deposit's own amounts (expense edited past the trigger) = nothing left
    IF v_rem_net < 0 OR v_rem_vat < 0 THEN RAISE EXCEPTION 'deposit_exceeds_remaining'; END IF;
    IF v_gross > v_rem_gross + 0.005 THEN RAISE EXCEPTION 'deposit_exceeds_remaining'; END IF;
    -- = computeReceiveDeductions: the deductions' gross together may not exceed this receipt's gross
    IF v_gross > round(v_rgross - v_cov, 2) + 0.005 THEN RAISE EXCEPTION 'deposit_exceeds_receipt'; END IF;
    v_cov := round(v_cov + v_gross, 2);
    IF abs(v_gross - v_rem_gross) < 0.005 THEN
      v_amt := v_rem_net; v_dvat := v_rem_vat;
    ELSE
      v_amt := LEAST(round(v_gross * d.amount_no_vat / (d.amount_no_vat + d.vat), 2), v_rem_net);
      IF abs(v_amt - v_rem_net) < 0.005 THEN v_dvat := v_rem_vat;
      ELSE v_dvat := LEAST(round(v_amt * d.vat / d.amount_no_vat, 2), v_rem_vat); END IF;
    END IF;
    IF v_amt <= 0 OR v_dvat < 0 THEN RAISE EXCEPTION 'bad_deduction'; END IF;
    v_sum_net := v_sum_net + v_amt; v_sum_vat := v_sum_vat + v_dvat;
    v_apps := v_apps || jsonb_build_object('deposit_id', d.id, 'net', v_amt, 'vat', v_dvat, 'rem_vat', v_rem_vat);
  END LOOP;

  IF jsonb_array_length(v_apps) > 0 AND v_sum_net > rv.subtotal + 0.005 THEN RAISE EXCEPTION 'deposit_exceeds_receipt'; END IF;
  v_net := round(rv.subtotal - v_sum_net, 2); v_vat_pay := round(rv.vat - v_sum_vat, 2);
  -- same fold as receive_po_with_deposits: deductions cover the whole net -> a VAT gap of up to 0.01 per application is rounding.
  -- The last application (uuid order) takes it only while its VAT stays within [0, that deposit's remaining VAT];
  -- otherwise the satang stays on the bill (= computeReceivePlan with remVat).
  v_last := v_apps->(jsonb_array_length(v_apps) - 1);
  IF jsonb_array_length(v_apps) > 0 AND abs(v_net) <= 0.005 AND abs(v_vat_pay) > 0.005
     AND abs(v_vat_pay) <= 0.01 * jsonb_array_length(v_apps) + 0.0001
     AND round((v_last->>'vat')::numeric + v_vat_pay, 2) >= 0
     AND round((v_last->>'vat')::numeric + v_vat_pay, 2) <= (v_last->>'rem_vat')::numeric THEN
    v_apps := jsonb_set(v_apps, ARRAY[(jsonb_array_length(v_apps) - 1)::text, 'vat'],
      to_jsonb(round((v_last->>'vat')::numeric + v_vat_pay, 2)));
    v_sum_vat := v_sum_vat + v_vat_pay; v_vat_pay := 0;
  END IF;
  IF v_tolerated THEN
    -- tolerated final remainder (no deductions): bill the payable total exactly, never a negative field; none when <= 0
    IF round(v_net + v_vat_pay, 2) <= 0 THEN v_net := 0; v_vat_pay := 0;
    ELSIF v_vat_pay < 0 THEN v_net := round(v_net + v_vat_pay, 2); v_vat_pay := 0;
    ELSIF v_net < 0 THEN v_vat_pay := round(v_vat_pay + v_net, 2); v_net := 0;
    END IF;
  ELSE
    IF v_vat_pay < -0.005 THEN RAISE EXCEPTION 'deposit_vat_exceeds_receipt'; END IF;
    v_net := GREATEST(v_net, 0); v_vat_pay := GREATEST(v_vat_pay, 0);
  END IF;

  -- stock plan: the base-quantity conversion lives in the client (computePoItemBaseQty); validate it here
  IF jsonb_typeof(COALESCE(p_stock, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'bad_stock_plan'; END IF;
  FOR s IN SELECT value FROM jsonb_array_elements(COALESCE(p_stock, '[]'::jsonb)) LOOP
    BEGIN
      v_item := (s->>'po_item_id')::uuid; v_bq := (s->>'base_qty')::numeric; v_uc := (s->>'unit_cost')::numeric;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'bad_stock_plan';
    END;
    IF v_item IS NULL OR NOT (v_item = ANY (v_ids)) OR v_stock ? v_item::text
       OR NOT _sti_finite(v_bq) OR NOT _sti_finite(v_uc) OR v_bq <= 0 OR v_uc < 0 THEN RAISE EXCEPTION 'bad_stock_plan'; END IF;
    v_stock := v_stock || jsonb_build_object(v_item::text, jsonb_build_object('base_qty', v_bq, 'unit_cost', v_uc));
  END LOOP;
  FOR li IN SELECT id, inventory_item_id, line_total FROM purchase_order_items WHERE id = ANY (v_ids) AND tenant_id = v_tenant LOOP
    IF po.stock_from_invoice OR li.inventory_item_id IS NULL THEN
      IF v_stock ? li.id::text THEN RAISE EXCEPTION 'bad_stock_plan'; END IF;
    ELSE
      IF NOT (v_stock ? li.id::text) THEN RAISE EXCEPTION 'bad_stock_plan'; END IF;
      v_line_net := CASE WHEN po.has_vat AND po.price_includes_vat THEN li.line_total / 1.07 ELSE li.line_total END;
      IF abs((v_stock->li.id::text->>'base_qty')::numeric * (v_stock->li.id::text->>'unit_cost')::numeric - v_line_net)
         > GREATEST(0.01, abs(v_line_net) * 0.000001) THEN RAISE EXCEPTION 'stock_cost_mismatch'; END IF;
    END IF;
  END LOOP;

  -- Stock is kept centrally (owner rule 2026-10-15): every purchase_in goes to the tenant's "ส่วนกลาง" site,
  -- whatever job site the PO (and its bill) belongs to. Resolved only when this receipt posts stock.
  IF v_stock <> '{}'::jsonb THEN
    v_stock_site := central_stock_site_id(v_tenant);
    IF v_stock_site IS NULL THEN RAISE EXCEPTION 'central_site_missing'; END IF;
  END IF;

  SELECT COALESCE(MAX(seq), 0) + 1 INTO v_seq FROM po_receipts WHERE po_id = po.id;
  v_no := po.po_number || '-R' || v_seq;
  v_status := CASE WHEN rv.is_final THEN 'received' ELSE 'partially_received' END;
  v_at := (p_received_date + time '12:00') AT TIME ZONE 'Asia/Bangkok';

  IF v_net > 0.005 OR v_vat_pay > 0.005 THEN
    SELECT credit_days, name INTO sup FROM suppliers WHERE id = po.supplier_id AND tenant_id = v_tenant;
    INSERT INTO expenses (tenant_id, date, description, site_id, category_id, supplier_id, supplier, amount_no_vat, vat, amount,
                          payment_method, status, notes, po_id)
    VALUES (v_tenant, po.date,                                   -- R2: the bill keeps the PO date; the received date dates the stock
            'จากใบสั่งซื้อ ' || po.po_number || CASE WHEN v_seq > 1 OR NOT rv.is_final THEN ' (รับครั้งที่ ' || v_seq || ')' ELSE '' END,
            po.site_id, po.category_id, po.supplier_id, sup.name, v_net, v_vat_pay, round(v_net + v_vat_pay, 2),
            CASE WHEN sup.credit_days IS NOT NULL THEN 'check' ELSE 'transfer' END,
            CASE WHEN sup.credit_days IS NOT NULL THEN 'awaiting_billing' ELSE 'pending' END,
            'จาก ใบสั่งซื้อ ' || po.po_number || ' รับของ ' || to_char(p_received_date, 'DD/MM/YYYY') || ' (' || v_no || ')'
              || CASE WHEN v_sum_net > 0 THEN ' (หักมัดจำ)' ELSE '' END,
            po.id)
    RETURNING id INTO v_exp;
  END IF;

  INSERT INTO po_receipts (tenant_id, po_id, seq, received_date, received_by, goods_subtotal, goods_vat, expense_id)
  VALUES (v_tenant, po.id, v_seq, p_received_date, auth.email(), rv.subtotal, rv.vat, v_exp)
  RETURNING id INTO v_rcpt;

  INSERT INTO po_deposit_applications (tenant_id, deposit_id, po_id, amount_no_vat, vat, created_by, receipt_id)
  SELECT v_tenant, (x->>'deposit_id')::uuid, po.id, (x->>'net')::numeric, (x->>'vat')::numeric, auth.email(), v_rcpt
    FROM jsonb_array_elements(v_apps) x;

  -- lines + stock, in item order (balance locks taken in a fixed order)
  FOR li IN SELECT id, quantity, line_total, inventory_item_id FROM purchase_order_items
             WHERE id = ANY (v_ids) AND tenant_id = v_tenant ORDER BY inventory_item_id NULLS LAST, id LOOP
    v_bq := NULL; v_uc := NULL; v_mid := NULL;
    IF v_stock ? li.id::text THEN
      v_bq := (v_stock->li.id::text->>'base_qty')::numeric; v_uc := (v_stock->li.id::text->>'unit_cost')::numeric;
      SELECT movement_id INTO v_mid FROM record_stock_movement(li.inventory_item_id, v_stock_site, 'purchase_in', v_bq, v_uc,
                                                               'purchase_order', po.id, v_no);
      UPDATE stock_movements SET created_at = v_at WHERE id = v_mid AND tenant_id = v_tenant;
    END IF;
    INSERT INTO po_receipt_items (tenant_id, receipt_id, po_item_id, quantity, line_total, base_qty, unit_cost, stock_movement_id)
    VALUES (v_tenant, v_rcpt, li.id, li.quantity, li.line_total, v_bq, v_uc, v_mid);
  END LOOP;

  PERFORM set_config('app.po_receipt_rpc', 'on', true);
  UPDATE purchase_orders
     SET status = v_status,
         received_date = GREATEST(COALESCE(received_date, p_received_date), p_received_date),
         expense_id = COALESCE(expense_id, v_exp)
   WHERE id = po.id;
  PERFORM set_config('app.po_receipt_rpc', 'off', true);

  RETURN jsonb_build_object('receipt_id', v_rcpt, 'seq', v_seq, 'receipt_no', v_no, 'expense_id', v_exp, 'status', v_status,
                            'subtotal', rv.subtotal, 'vat', rv.vat);
END $$;

REVOKE ALL ON FUNCTION receive_po_lines(UUID, UUID[], DATE, JSONB, NUMERIC, NUMERIC, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION receive_po_lines(UUID, UUID[], DATE, JSONB, NUMERIC, NUMERIC, JSONB) TO authenticated;
