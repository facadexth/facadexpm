-- PO deposit deduction (หักมัดจำ): atomic receive RPC. Requires 2026-10-07-01-supplier-deposits.sql.
-- Math mirrors src/lib/depositMath.js (splitDeduction / computeReceivePlan); this function is the authority.
-- Definer rights: po_deposit_applications is not client-writable. Re-checks role + tenant itself.
-- Note: the client preview (depositMath.js) and this server value can differ by one satang on exact
-- .5 rounding ties; the server value is the one stored.
-- Errors: insufficient_privilege, po_not_found, not_ordered, totals_mismatch, deposit_not_found,
--         deposit_wrong_supplier, deposit_exceeds_remaining, deposit_exceeds_po, deposit_vat_exceeds_po, deposit_expense_needs_vat_split, bad_application.

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

  FOR a IN SELECT value FROM jsonb_array_elements(COALESCE(p_applications, '[]'::jsonb)) ORDER BY value->>'deposit_id' LOOP   -- fixed lock order: no deadlock between concurrent receives
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
    SELECT sd.id, e.tenant_id AS e_tenant, e.supplier_id, e.amount, e.amount_no_vat, e.vat INTO d
      FROM supplier_deposits sd JOIN expenses e ON e.id = sd.expense_id
     WHERE sd.id = v_dep AND sd.tenant_id = v_tenant FOR UPDATE OF sd, e;
    IF NOT FOUND THEN RAISE EXCEPTION 'deposit_not_found'; END IF;
    IF d.e_tenant IS DISTINCT FROM v_tenant THEN RAISE EXCEPTION 'deposit_not_found'; END IF;
    IF d.supplier_id IS DISTINCT FROM po.supplier_id THEN RAISE EXCEPTION 'deposit_wrong_supplier'; END IF;
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
