-- ============================================================
-- PO deposits / partial receipts / split payments: RPCs. Requires 2026-10-09-01.
-- Definer rights: the receipt tables and po_deposit_applications are not client-writable. Each public RPC re-checks
-- role, module, tenant_can_write() and takes the tenant from current_tenant_id(). Each call is one transaction.
-- Maths mirrored by src/lib/poReceiptMath.js and src/lib/poPaymentMath.js; this file is the authority.
-- Lock order: PO row (FOR UPDATE) -> deposits by id (FOR UPDATE OF deposit, expense) -> stock balances by item
-- (inside record_stock_movement), same direction as post/void_supplier_tax_invoice.
-- split_payment: PO row (FOR SHARE) -> the bill (FOR UPDATE).
-- Also: receive_po_with_deposits (2026-10-07-02) re-created with one rule added (deposit_other_po);
-- sd_lock_when_applied (2026-10-07-01) redefined: a deposit linked to a PO keeps its expense and number;
-- new delete guard on supplier_deposits: a deposit linked to a PO cannot be unregistered (deposit_linked_to_po).
-- ============================================================

SET LOCAL lock_timeout = '5s';

-- = calcPoTotals() in src/lib/poTotals.js (subtotal unrounded for VAT-exclusive, as the client).
CREATE OR REPLACE FUNCTION _po_totals(p_po_id UUID, p_tenant UUID, OUT subtotal NUMERIC, OUT vat NUMERIC, OUT total NUMERIC)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_has BOOLEAN; v_incl BOOLEAN; v_raw NUMERIC;
BEGIN
  SELECT has_vat, price_includes_vat INTO v_has, v_incl FROM purchase_orders WHERE id = p_po_id AND tenant_id = p_tenant;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT COALESCE(SUM(line_total), 0) INTO v_raw FROM purchase_order_items WHERE po_id = p_po_id AND tenant_id = p_tenant;
  IF NOT v_has THEN subtotal := v_raw; vat := 0;
  ELSIF v_incl THEN subtotal := round(round(v_raw, 2) / 1.07, 2); vat := round(round(v_raw, 2) - subtotal, 2);
  ELSE subtotal := v_raw; vat := round(v_raw * 0.07, 2);
  END IF;
  total := round(subtotal + vat, 2);
END $$;

-- = receiptValue() in src/lib/poReceiptMath.js. Final receipt (nothing outstanding after it) = PO minus earlier receipts.
-- n_prior = number of earlier receipts: each rounded to satang, so a final remainder may sit up to 0.01 x n_prior below 0
-- (e.g. a last delivery of free lines after two deliveries whose VAT rounded up); receive_po_lines tolerates that.
CREATE OR REPLACE FUNCTION _po_receipt_value(p_po_id UUID, p_tenant UUID, p_line_ids UUID[],
  OUT subtotal NUMERIC, OUT vat NUMERIC, OUT is_final BOOLEAN, OUT n_prior INT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_has BOOLEAN; v_incl BOOLEAN; v_raw NUMERIC; v_left INT; v_psub NUMERIC; v_pvat NUMERIC; t RECORD;
BEGIN
  SELECT has_vat, price_includes_vat INTO v_has, v_incl FROM purchase_orders WHERE id = p_po_id AND tenant_id = p_tenant;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT count(*) INTO v_left FROM purchase_order_items i
   WHERE i.po_id = p_po_id AND i.tenant_id = p_tenant AND NOT (i.id = ANY (COALESCE(p_line_ids, '{}'::uuid[])))
     AND NOT EXISTS (SELECT 1 FROM po_receipt_items r WHERE r.po_item_id = i.id);
  is_final := v_left = 0 AND cardinality(COALESCE(p_line_ids, '{}'::uuid[])) > 0;
  SELECT count(*) INTO n_prior FROM po_receipts WHERE po_id = p_po_id AND tenant_id = p_tenant;
  IF is_final THEN
    SELECT * INTO t FROM _po_totals(p_po_id, p_tenant);
    SELECT COALESCE(SUM(goods_subtotal), 0), COALESCE(SUM(goods_vat), 0) INTO v_psub, v_pvat
      FROM po_receipts WHERE po_id = p_po_id AND tenant_id = p_tenant;
    subtotal := round(round(t.subtotal, 2) - v_psub, 2);
    vat := round(t.vat - v_pvat, 2);
  ELSE
    SELECT COALESCE(SUM(line_total), 0) INTO v_raw FROM purchase_order_items
     WHERE po_id = p_po_id AND tenant_id = p_tenant AND id = ANY (COALESCE(p_line_ids, '{}'::uuid[]));
    IF NOT v_has THEN subtotal := round(v_raw, 2); vat := 0;
    ELSIF v_incl THEN subtotal := round(round(v_raw, 2) / 1.07, 2); vat := round(round(v_raw, 2) - subtotal, 2);
    ELSE subtotal := round(v_raw, 2); vat := round(v_raw * 0.07, 2);
    END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION create_po_deposit(p_po_id UUID, p_mode TEXT, p_value NUMERIC, p_invoice_no TEXT, p_date DATE,
  p_payment_method TEXT, p_status TEXT DEFAULT 'paid')
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  v_today DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  po purchase_orders%ROWTYPE; t RECORD; v_sup_name TEXT;
  v_no TEXT := btrim(COALESCE(p_invoice_no, ''));
  v_gross NUMERIC; v_net NUMERIC; v_vat NUMERIC; v_pct NUMERIC; v_exp UUID; v_dep UUID; v_con TEXT;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders') AND tenant_can_write()) THEN RAISE EXCEPTION 'insufficient_privilege'; END IF;
  SELECT * INTO po FROM purchase_orders WHERE id = p_po_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'po_not_found'; END IF;
  IF po.status <> 'ordered' THEN RAISE EXCEPTION 'po_not_ordered'; END IF;
  IF po.supplier_id IS NULL THEN RAISE EXCEPTION 'po_no_supplier'; END IF;
  IF EXISTS (SELECT 1 FROM supplier_deposits WHERE po_id = po.id) THEN RAISE EXCEPTION 'po_has_deposit'; END IF;
  IF v_no = '' THEN RAISE EXCEPTION 'deposit_invoice_no_required'; END IF;
  IF p_date IS NULL OR p_date > v_today THEN RAISE EXCEPTION 'bad_deposit_date'; END IF;
  IF p_payment_method IS NULL OR p_payment_method NOT IN ('transfer', 'check', 'cash') THEN RAISE EXCEPTION 'bad_payment_method'; END IF;
  IF p_status IS NULL OR p_status NOT IN ('paid', 'pending') THEN RAISE EXCEPTION 'bad_deposit_status'; END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('percent', 'amount') OR NOT _sti_finite(p_value) OR p_value <= 0
     OR (p_mode = 'percent' AND p_value > 100) THEN RAISE EXCEPTION 'bad_deposit_value'; END IF;
  SELECT * INTO t FROM _po_totals(po.id, v_tenant);
  IF t.total IS NULL OR t.total <= 0 THEN RAISE EXCEPTION 'bad_deposit_value'; END IF;
  v_gross := CASE WHEN p_mode = 'percent' THEN round(p_value / 100 * t.total, 2) ELSE round(p_value, 2) END;
  IF v_gross <= 0 THEN RAISE EXCEPTION 'bad_deposit_value'; END IF;
  IF v_gross > t.total + 0.005 THEN RAISE EXCEPTION 'deposit_exceeds_po'; END IF;
  v_net := CASE WHEN po.has_vat THEN round(v_gross / 1.07, 2) ELSE v_gross END;
  v_vat := round(v_gross - v_net, 2);
  v_pct := GREATEST(round(v_gross / t.total * 100, 4), 0.0001);
  SELECT name INTO v_sup_name FROM suppliers WHERE id = po.supplier_id AND tenant_id = v_tenant;
  -- the deposit expense is NOT linked by expenses.po_id (sd_validate forbids it); supplier_deposits.po_id links it
  INSERT INTO expenses (tenant_id, date, description, site_id, category_id, supplier_id, supplier, amount_no_vat, vat, amount,
                        payment_method, status, invoice_no, notes)
  VALUES (v_tenant, p_date, 'มัดจำใบสั่งซื้อ ' || po.po_number, po.site_id, po.category_id, po.supplier_id, v_sup_name,
          v_net, v_vat, v_gross, p_payment_method, p_status, v_no,
          'มัดจำ ' || rtrim(rtrim(v_pct::text, '0'), '.') || '% ของใบสั่งซื้อ ' || po.po_number)
  RETURNING id INTO v_exp;
  BEGIN
    INSERT INTO supplier_deposits (tenant_id, expense_id, deposit_invoice_no, po_id, pct_of_po, created_by)
    VALUES (v_tenant, v_exp, v_no, po.id, v_pct, auth.email()) RETURNING id INTO v_dep;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME;
    RAISE EXCEPTION '%', CASE WHEN v_con = 'supplier_deposits_po_uq' THEN 'po_has_deposit' ELSE 'deposit_invoice_no_taken' END;
  END;
  RETURN jsonb_build_object('deposit_id', v_dep, 'expense_id', v_exp, 'amount', v_gross, 'amount_no_vat', v_net, 'vat', v_vat, 'pct_of_po', v_pct);
END $$;

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
  s JSONB; v_stock JSONB := '{}'::jsonb; v_item UUID; v_bq NUMERIC; v_uc NUMERIC; v_line_net NUMERIC;
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
      SELECT movement_id INTO v_mid FROM record_stock_movement(li.inventory_item_id, po.site_id, 'purchase_in', v_bq, v_uc,
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

CREATE OR REPLACE FUNCTION split_payment(p_expense_id UUID, p_amount NUMERIC, p_paid_date DATE, p_method TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  v_today DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  e expenses%ROWTYPE; v_paid NUMERIC; v_pvat NUMERIC; v_pnet NUMERIC; v_new UUID; v_split BOOLEAN; v_po UUID;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders') AND tenant_can_write()) THEN RAISE EXCEPTION 'insufficient_privilege'; END IF;
  -- lock order PO -> expense, as post/void_supplier_tax_invoice: read the PO link unlocked, lock the PO, then the bill
  SELECT po_id INTO v_po FROM expenses WHERE id = p_expense_id AND tenant_id = v_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'expense_not_found'; END IF;
  IF v_po IS NULL THEN RAISE EXCEPTION 'not_a_po_bill'; END IF;
  PERFORM 1 FROM purchase_orders WHERE id = v_po FOR SHARE;
  SELECT * INTO e FROM expenses WHERE id = p_expense_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'expense_not_found'; END IF;
  IF e.po_id IS NULL THEN RAISE EXCEPTION 'not_a_po_bill'; END IF;
  IF e.po_id IS DISTINCT FROM v_po THEN RAISE EXCEPTION 'bill_changed'; END IF;
  IF EXISTS (SELECT 1 FROM supplier_credit_notes WHERE expense_id = e.id) THEN RAISE EXCEPTION 'bill_is_credit_note'; END IF;
  IF EXISTS (SELECT 1 FROM supplier_deposits WHERE expense_id = e.id) THEN RAISE EXCEPTION 'bill_is_deposit'; END IF;
  IF e.cheque_id IS NOT NULL THEN RAISE EXCEPTION 'bill_is_cheque'; END IF;
  IF e.status <> 'pending' THEN RAISE EXCEPTION 'bill_not_pending'; END IF;
  IF p_paid_date IS NULL OR p_paid_date > v_today THEN RAISE EXCEPTION 'bad_paid_date'; END IF;
  IF p_method IS NULL OR p_method NOT IN ('transfer', 'check', 'cash') THEN RAISE EXCEPTION 'bad_payment_method'; END IF;
  IF NOT _sti_finite(p_amount) OR e.amount IS NULL OR e.amount <= 0 THEN RAISE EXCEPTION 'bad_split_amount'; END IF;
  v_paid := round(p_amount, 2);
  IF v_paid <= 0 OR v_paid >= round(e.amount, 2) - 0.005 THEN RAISE EXCEPTION 'bad_split_amount'; END IF;
  v_split := e.amount_no_vat IS NOT NULL AND e.vat IS NOT NULL;
  IF v_split AND round(e.amount_no_vat + e.vat - e.amount, 2) <> 0 THEN RAISE EXCEPTION 'bill_bad_split'; END IF;
  IF v_split THEN v_pvat := round(v_paid * e.vat / e.amount, 2); v_pnet := round(v_paid - v_pvat, 2); END IF;

  -- the remainder is a NEW pending row; the original row (id kept: PO / receipt / tax-invoice links stay valid) becomes the paid part
  INSERT INTO expenses (tenant_id, date, description, site_id, category_id, supplier, supplier_id, amount, amount_no_vat, vat,
                        payment_method, status, invoice_no, notes, is_subcontract, billing_date, due_date, check_date, payer, po_id)
  VALUES (v_tenant, e.date, e.description, e.site_id, e.category_id, e.supplier, e.supplier_id, round(e.amount - v_paid, 2),
          CASE WHEN v_split THEN round(e.amount_no_vat - v_pnet, 2) END, CASE WHEN v_split THEN round(e.vat - v_pvat, 2) END,
          e.payment_method, 'pending', e.invoice_no,
          concat_ws(' | ', NULLIF(btrim(e.notes), ''), 'ยอดคงเหลือหลังจ่ายบางส่วน ' || to_char(v_paid, 'FM999,999,999,990.00') || ' บาท (แยกบิล)'),
          e.is_subcontract, e.billing_date, e.due_date, e.check_date, e.payer, e.po_id)
  RETURNING id INTO v_new;
  UPDATE expenses
     SET amount = v_paid,
         amount_no_vat = CASE WHEN v_split THEN v_pnet END,
         vat = CASE WHEN v_split THEN v_pvat END,
         status = 'paid', payment_method = p_method,
         check_date = CASE WHEN p_method = 'check' THEN check_date END,
         notes = concat_ws(' | ', NULLIF(btrim(notes), ''),
                   'จ่ายบางส่วน ' || to_char(v_paid, 'FM999,999,999,990.00') || ' จาก ' || to_char(e.amount, 'FM999,999,999,990.00')
                   || ' บาท วันที่ ' || to_char(p_paid_date, 'DD/MM/YYYY') || ' (แยกบิล)')
   WHERE id = e.id;
  -- created_at = clock_timestamp(), not now(): a split that waited on the PO lock behind post_supplier_tax_invoice
  -- is then stamped after that invoice's posted_at (now() would be this transaction's start, possibly earlier)
  INSERT INTO expense_splits (tenant_id, source_expense_id, new_expense_id, paid_amount, paid_date, payment_method, created_by, created_at)
  VALUES (v_tenant, e.id, v_new, v_paid, p_paid_date, p_method, auth.email(), clock_timestamp());
  RETURN jsonb_build_object('paid_expense_id', e.id, 'remaining_expense_id', v_new, 'paid_amount', v_paid, 'remaining_amount', round(e.amount - v_paid, 2));
END $$;

-- ============================================================
-- receive_po_with_deposits (legacy client): body copied unchanged from 2026-10-07-02, plus ONE rule:
-- a deposit linked to a PO (supplier_deposits.po_id) is deducted on that PO only -> 'deposit_other_po'.
-- Grants re-issued exactly as the original.
-- ============================================================
CREATE OR REPLACE FUNCTION receive_po_with_deposits(
  p_po_id UUID, p_applications JSONB, p_expected_subtotal NUMERIC, p_expected_vat NUMERIC
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  v_today DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  po purchase_orders%ROWTYPE;
  v_raw NUMERIC; v_sub NUMERIC; v_vat NUMERIC;
  sup RECORD;
  a JSONB; d RECORD;
  v_used_net NUMERIC; v_used_vat NUMERIC; v_rem_net NUMERIC; v_rem_vat NUMERIC;
  v_amt NUMERIC; v_dvat NUMERIC;
  v_sum_net NUMERIC := 0; v_sum_vat NUMERIC := 0;
  v_net NUMERIC; v_vat_pay NUMERIC; v_exp UUID := NULL;
  v_apps JSONB := '[]'::jsonb;
  v_seen UUID[] := '{}';
  v_dep UUID;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders') AND tenant_can_write()) THEN RAISE EXCEPTION 'insufficient_privilege'; END IF;
  SELECT * INTO po FROM purchase_orders WHERE id = p_po_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'po_not_found'; END IF;
  IF po.status <> 'ordered' THEN RAISE EXCEPTION 'not_ordered'; END IF;
  -- a PO that already carries deposit applications (e.g. un-received by a superuser) must never be received again
  IF EXISTS (SELECT 1 FROM po_deposit_applications WHERE po_id = p_po_id) THEN RAISE EXCEPTION 'po_has_deposit_applications'; END IF;
  IF jsonb_typeof(COALESCE(p_applications, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'bad_application'; END IF;

  -- totals exactly as the client's calcPoTotals
  SELECT COALESCE(SUM(line_total), 0) INTO v_raw FROM purchase_order_items WHERE po_id = p_po_id AND tenant_id = v_tenant;
  IF NOT po.has_vat THEN v_sub := v_raw; v_vat := 0;
  ELSIF po.price_includes_vat THEN
    v_sub := round(round(v_raw, 2) / 1.07, 2); v_vat := round(round(v_raw, 2) - v_sub, 2);
  ELSE v_sub := v_raw; v_vat := round(v_sub * 0.07, 2);
  END IF;
  IF abs(v_sub - COALESCE(p_expected_subtotal, -1)) > 0.01 OR abs(v_vat - COALESCE(p_expected_vat, -1)) > 0.01 THEN
    RAISE EXCEPTION 'totals_mismatch';
  END IF;

  FOR a IN SELECT value FROM jsonb_array_elements(COALESCE(p_applications, '[]'::jsonb)) ORDER BY value->>'deposit_id' COLLATE "C" LOOP   -- fixed lock order: no deadlock between concurrent receives. COLLATE "C" = plain byte order, independent of the database collation; the client mirror (depositMath.js computeReceivePlan) sorts ids with plain JS string comparison, which is identical for lowercase hex UUIDs
    BEGIN
      v_amt := round((a->>'amount_no_vat')::numeric, 2);
      v_dep := (a->>'deposit_id')::uuid;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'bad_application';
    END;
    IF v_amt IS NULL OR v_amt <= 0 OR v_dep IS NULL THEN RAISE EXCEPTION 'bad_application'; END IF;
    -- one application per deposit per call (remaining is computed from committed rows only)
    IF v_dep = ANY (v_seen) THEN RAISE EXCEPTION 'bad_application'; END IF;
    v_seen := v_seen || v_dep;

    -- lock deposit AND its expense so concurrent receives serialize and cannot overspend
    SELECT sd.id, sd.po_id, e.tenant_id AS e_tenant, e.supplier_id, e.amount, e.amount_no_vat, e.vat INTO d
      FROM supplier_deposits sd JOIN expenses e ON e.id = sd.expense_id
     WHERE sd.id = v_dep AND sd.tenant_id = v_tenant FOR UPDATE OF sd, e;
    IF NOT FOUND THEN RAISE EXCEPTION 'deposit_not_found'; END IF;
    IF d.e_tenant IS DISTINCT FROM v_tenant THEN RAISE EXCEPTION 'deposit_not_found'; END IF;
    IF d.supplier_id IS DISTINCT FROM po.supplier_id THEN RAISE EXCEPTION 'deposit_wrong_supplier'; END IF;
    -- a deposit created for a PO is deducted on that PO only (added 2026-10-09-02)
    IF d.po_id IS NOT NULL AND d.po_id <> po.id THEN RAISE EXCEPTION 'deposit_other_po'; END IF;
    IF d.amount_no_vat IS NULL OR d.vat IS NULL OR d.amount_no_vat <= 0 OR round(d.amount_no_vat + d.vat - d.amount, 2) <> 0 THEN
      RAISE EXCEPTION 'deposit_expense_needs_vat_split';
    END IF;

    SELECT COALESCE(SUM(amount_no_vat), 0), COALESCE(SUM(vat), 0) INTO v_used_net, v_used_vat
      FROM po_deposit_applications WHERE deposit_id = d.id;
    v_rem_net := round(d.amount_no_vat - v_used_net, 2); v_rem_vat := round(d.vat - v_used_vat, 2);
    IF v_amt > v_rem_net + 0.005 THEN RAISE EXCEPTION 'deposit_exceeds_remaining'; END IF;
    IF abs(v_amt - v_rem_net) < 0.005 THEN v_dvat := v_rem_vat;
    ELSE v_dvat := LEAST(round(v_amt * d.vat / d.amount_no_vat, 2), v_rem_vat); END IF;
    v_sum_net := v_sum_net + v_amt; v_sum_vat := v_sum_vat + v_dvat;
    v_apps := v_apps || jsonb_build_object('deposit_id', d.id, 'net', v_amt, 'vat', v_dvat);
  END LOOP;

  IF v_sum_net > v_sub + 0.005 THEN RAISE EXCEPTION 'deposit_exceeds_po'; END IF;
  v_net := round(v_sub - v_sum_net, 2); v_vat_pay := round(v_vat - v_sum_vat, 2);
  -- Deductions cover the whole net: a VAT gap of up to 0.01 per application is per-line rounding.
  -- Fold it into the LAST application so deduction VAT == PO VAT exactly and no dust expense is made.
  IF jsonb_array_length(v_apps) > 0 AND abs(v_net) <= 0.005 AND abs(v_vat_pay) > 0.005
     AND abs(v_vat_pay) <= 0.01 * jsonb_array_length(v_apps) + 0.0001
     AND round((v_apps->(jsonb_array_length(v_apps) - 1)->>'vat')::numeric + v_vat_pay, 2) >= 0 THEN
    v_apps := jsonb_set(v_apps, ARRAY[(jsonb_array_length(v_apps) - 1)::text, 'vat'],
      to_jsonb(round((v_apps->(jsonb_array_length(v_apps) - 1)->>'vat')::numeric + v_vat_pay, 2)));
    v_sum_vat := v_sum_vat + v_vat_pay; v_vat_pay := 0;
  END IF;
  IF v_vat_pay < -0.005 THEN RAISE EXCEPTION 'deposit_vat_exceeds_po'; END IF;
  v_net := GREATEST(v_net, 0); v_vat_pay := GREATEST(v_vat_pay, 0);

  IF v_net > 0.005 OR v_vat_pay > 0.005 THEN
    SELECT credit_days, name INTO sup FROM suppliers WHERE id = po.supplier_id AND tenant_id = v_tenant;
    INSERT INTO expenses (tenant_id, date, description, site_id, category_id, supplier_id, supplier, amount_no_vat, vat, amount,
                          payment_method, status, notes, po_id)
    VALUES (v_tenant, v_today, 'จากใบสั่งซื้อ ' || po.po_number, po.site_id, po.category_id, po.supplier_id,
            sup.name, v_net, v_vat_pay, round(v_net + v_vat_pay, 2),
            CASE WHEN sup.credit_days IS NOT NULL THEN 'check' ELSE 'transfer' END,
            CASE WHEN sup.credit_days IS NOT NULL THEN 'awaiting_billing' ELSE 'pending' END,
            'จาก ใบสั่งซื้อ ' || po.po_number || CASE WHEN v_sum_net > 0 THEN ' (หักมัดจำ)' ELSE '' END, po.id)
    RETURNING id INTO v_exp;
  END IF;

  INSERT INTO po_deposit_applications (tenant_id, deposit_id, po_id, amount_no_vat, vat, created_by)
  SELECT v_tenant, (x->>'deposit_id')::uuid, po.id, (x->>'net')::numeric, (x->>'vat')::numeric, auth.email()
    FROM jsonb_array_elements(v_apps) x;

  UPDATE purchase_orders SET status = 'received', received_date = v_today, expense_id = v_exp WHERE id = po.id;
  RETURN v_exp;
END $$;

REVOKE ALL ON FUNCTION receive_po_with_deposits(UUID, JSONB, NUMERIC, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION receive_po_with_deposits(UUID, JSONB, NUMERIC, NUMERIC) TO authenticated;

-- A deposit that has applications keeps its expense, number, tenant and id (body of 2026-10-07-01, unchanged);
-- a deposit linked to a PO (create_po_deposit) also keeps its expense and number from the start, so the
-- client UPDATE grant on expense_id / deposit_invoice_no (registerSupplierDeposit) cannot re-point it.
CREATE OR REPLACE FUNCTION sd_lock_when_applied() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (NEW.expense_id IS DISTINCT FROM OLD.expense_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.deposit_invoice_no IS DISTINCT FROM OLD.deposit_invoice_no OR NEW.id IS DISTINCT FROM OLD.id)
     AND EXISTS (SELECT 1 FROM po_deposit_applications WHERE deposit_id = OLD.id) THEN
    RAISE EXCEPTION 'deposit_in_use';
  END IF;
  IF (NEW.expense_id IS DISTINCT FROM OLD.expense_id OR NEW.deposit_invoice_no IS DISTINCT FROM OLD.deposit_invoice_no)
     AND (OLD.po_id IS NOT NULL OR NEW.po_id IS NOT NULL) THEN
    RAISE EXCEPTION 'deposit_in_use';
  END IF;
  RETURN NEW;
END $$;

-- A deposit linked to a PO cannot be deleted (unregistered): it would silently unlink the PO and orphan the deposit
-- expense. Unlinked (legacy) deposits keep today's unregister path. A future definer RPC may set the flag.
CREATE OR REPLACE FUNCTION sd_block_delete_when_linked() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.po_id IS NOT NULL AND COALESCE(current_setting('app.po_receipt_rpc', true), '') <> 'on' THEN
    RAISE EXCEPTION 'deposit_linked_to_po';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER sd_block_delete_when_linked_trg BEFORE DELETE ON supplier_deposits FOR EACH ROW EXECUTE FUNCTION sd_block_delete_when_linked();

REVOKE ALL ON FUNCTION sd_lock_when_applied(), sd_block_delete_when_linked() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION _po_totals(UUID, UUID), _po_receipt_value(UUID, UUID, UUID[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION create_po_deposit(UUID, TEXT, NUMERIC, TEXT, DATE, TEXT, TEXT),
  receive_po_lines(UUID, UUID[], DATE, JSONB, NUMERIC, NUMERIC, JSONB), split_payment(UUID, NUMERIC, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_po_deposit(UUID, TEXT, NUMERIC, TEXT, DATE, TEXT, TEXT),
  receive_po_lines(UUID, UUID[], DATE, JSONB, NUMERIC, NUMERIC, JSONB), split_payment(UUID, NUMERIC, DATE, TEXT) TO authenticated;
