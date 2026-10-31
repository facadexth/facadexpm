-- ================================================================
-- Tests for 2026-10-15-01-demo-tenant-seed.sql.
-- Dry-run only (see docs/superpowers/plans/2026-10-14-demo-tenant-seed.md "Dry-run harness").
-- Success = ERROR text contains 'RESULT: demo_tenant_seed_test ALL PASSED'.
-- ================================================================
BEGIN;
DO $$
DECLARE
  t_owner UUID; t_tenant UUID; t_other UUID; v_n INT; v_n2 INT; v_msg TEXT;
  admin_email TEXT := '__demo_test_admin__@example.com';
  owner_email TEXT := '__demo_test_owner__@example.com';
  worker_email TEXT := '__demo_test_worker__@example.com';
  s1 JSONB; s2 JSONB; d1 JSONB; v_q1 TEXT; v_q2 TEXT; cs RECORD; v_loc UUID;
BEGIN
  SELECT id INTO t_owner FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO platform_admins (user_email) VALUES (admin_email);
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at, plan_expires_at, package_id)
    VALUES ('__DEMO TEST__', t_owner, 'active', now() - interval '1 day', '2099-12-31', (SELECT id FROM packages WHERE name = 'Enterprise'))
    RETURNING id INTO t_tenant;
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES (owner_email, 'OWNER', 'approved', t_tenant);
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES (worker_email, 'WORKER', 'approved', t_tenant);
  INSERT INTO tenant_modules (tenant_id, module_key) SELECT t_tenant, k FROM unnest(ARRAY['quotations','invoices','cheque_tracking','client_deposits','purchase_orders','payroll','labor_subcontractors','line_bot']) k;
  INSERT INTO sites (tenant_id, site_number, name, is_default) VALUES (t_tenant, 'SD-0000-000', 'ส่วนกลาง', true);
  INSERT INTO app_settings (tenant_id, key, value) VALUES (t_tenant, 'travel_rate_per_km', '20'), (t_tenant, 'holiday_pay_multiplier', '1.5');
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at) VALUES ('__DEMO OTHER__', t_owner, 'trial', now() + interval '14 days') RETURNING id INTO t_other;
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES ('__demo_other_owner__@example.com', 'OWNER', 'approved', t_other);

  -- act as the platform admin for every call below
  PERFORM set_config('request.jwt.claims', json_build_object('email', admin_email, 'role', 'authenticated')::text, true);

  -- ── T1 ── (tasks append blocks here)
  -- ── T1 ── guard: no marker → raises, nothing deleted
  BEGIN
    PERFORM reset_demo_tenant(t_tenant);
    RAISE EXCEPTION 'T1 FAIL: reset without marker did not raise';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'demo_marker_missing%' THEN RAISE EXCEPTION 'T1 FAIL: expected demo_marker_missing, got %', v_msg; END IF;
  END;
  SELECT count(*) INTO v_n FROM sites WHERE tenant_id = t_tenant;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T1 FAIL: default site was deleted by a refused reset'; END IF;

  -- guard: marker present but caller not platform admin → raises
  INSERT INTO app_settings (tenant_id, key, value) VALUES (t_tenant, 'is_demo_tenant', 'true');
  PERFORM set_config('request.jwt.claims', json_build_object('email', owner_email, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM reset_demo_tenant(t_tenant);
    RAISE EXCEPTION 'T1 FAIL: non-admin reset did not raise';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'demo_not_platform_admin%' THEN RAISE EXCEPTION 'T1 FAIL: expected demo_not_platform_admin, got %', v_msg; END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('email', admin_email, 'role', 'authenticated')::text, true);

  -- platform_list_tenants exposes is_demo
  SELECT count(*) INTO v_n FROM platform_list_tenants() WHERE id = t_tenant AND is_demo;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T1 FAIL: is_demo not true for demo tenant'; END IF;
  SELECT count(*) INTO v_n FROM platform_list_tenants() WHERE id = t_other AND is_demo;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T1 FAIL: is_demo true for non-demo tenant'; END IF;

  -- reset on an (almost) empty demo tenant: keeps the kept tables, returns jsonb
  d1 := reset_demo_tenant(t_tenant);
  IF d1 IS NULL OR NOT (d1 ? 'deleted') THEN RAISE EXCEPTION 'T1 FAIL: reset summary missing deleted'; END IF;
  SELECT count(*) INTO v_n FROM user_roles WHERE tenant_id = t_tenant;
  IF v_n <> 2 THEN RAISE EXCEPTION 'T1 FAIL: user_roles touched by reset'; END IF;
  SELECT count(*) INTO v_n FROM tenant_modules WHERE tenant_id = t_tenant;
  IF v_n <> 8 THEN RAISE EXCEPTION 'T1 FAIL: tenant_modules touched by reset'; END IF;
  SELECT count(*) INTO v_n FROM app_settings WHERE tenant_id = t_tenant AND key = 'is_demo_tenant';
  IF v_n <> 1 THEN RAISE EXCEPTION 'T1 FAIL: marker not re-inserted after reset'; END IF;

  -- the marker cannot be written by a tenant (RLS lets owners write any key; the trigger blocks this one)
  PERFORM set_config('request.jwt.claims', json_build_object('email', owner_email, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO app_settings (tenant_id, key, value) VALUES (t_other, 'is_demo_tenant', 'true');
    RESET ROLE;
    RAISE EXCEPTION 'T1 FAIL: tenant could insert the demo marker';
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'demo_marker_protected%' THEN RAISE EXCEPTION 'T1 FAIL: expected demo_marker_protected, got %', v_msg; END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('email', admin_email, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_n FROM app_settings WHERE tenant_id = t_other AND key = 'is_demo_tenant';
  IF v_n <> 0 THEN RAISE EXCEPTION 'T1 FAIL: marker leaked onto the other tenant'; END IF;

  -- ── T2 ── core data
  -- reset_demo_tenant already seeds once (T1 above); a second seed_demo_tenant would double rows.
  -- Reset again so the tenant is clean and the single seed summary comes from the reset.
  s1 := reset_demo_tenant(t_tenant) -> 'seeded';
  IF COALESCE((s1->>'clients')::int, -1) <> 8 THEN RAISE EXCEPTION 'T2 FAIL: clients=%', s1->>'clients'; END IF;
  IF COALESCE((s1->>'suppliers')::int, -1) <> 8 THEN RAISE EXCEPTION 'T2 FAIL: suppliers=%', s1->>'suppliers'; END IF;
  IF COALESCE((s1->>'catalog_items')::int, -1) <> 15 THEN RAISE EXCEPTION 'T2 FAIL: catalog=%', s1->>'catalog_items'; END IF;
  SELECT count(*) INTO v_n FROM sites WHERE tenant_id = t_tenant AND NOT is_default;
  IF v_n <> 10 THEN RAISE EXCEPTION 'T2 FAIL: sites=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM sites WHERE tenant_id = t_tenant AND status = 'Ongoing' AND NOT is_default;
  IF v_n <> 5 THEN RAISE EXCEPTION 'T2 FAIL: ongoing=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM sites WHERE tenant_id = t_tenant AND status = 'Completed' AND NOT retention_released;
  IF v_n <> 2 THEN RAISE EXCEPTION 'T2 FAIL: completed retention pending=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM sites WHERE tenant_id = t_tenant AND lat IS NULL AND NOT is_default;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T2 FAIL: site without lat/lng'; END IF;
  SELECT count(DISTINCT site_number), count(*) INTO v_n, v_n2 FROM sites WHERE tenant_id = t_tenant;
  IF v_n <> v_n2 THEN RAISE EXCEPTION 'T2 FAIL: duplicate site numbers'; END IF;
  SELECT count(*) INTO v_n FROM site_phases WHERE tenant_id = t_tenant;
  IF v_n <> 40 THEN RAISE EXCEPTION 'T2 FAIL: phases=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM phase_tasks WHERE tenant_id = t_tenant;
  IF v_n < 80 THEN RAISE EXCEPTION 'T2 FAIL: tasks=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM expense_categories WHERE tenant_id = t_tenant;
  IF v_n <> 8 THEN RAISE EXCEPTION 'T2 FAIL: categories=% (defaults not replaced)', v_n; END IF;
  SELECT count(*) INTO v_n FROM expense_categories WHERE tenant_id = t_tenant AND use_for_cost_deduction AND code_prefix IS NOT NULL;
  IF v_n <> 4 THEN RAISE EXCEPTION 'T2 FAIL: deduction categories=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM bank_accounts WHERE tenant_id = t_tenant AND is_default;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T2 FAIL: bank account'; END IF;
  SELECT count(*) INTO v_n FROM tenants WHERE id = t_tenant AND trial_ends_at < now();
  IF v_n <> 1 THEN RAISE EXCEPTION 'T2 FAIL: trial_ends_at still in the future (trial banner would show)'; END IF;
  SELECT count(*) INTO v_n FROM tenants WHERE id = t_tenant AND tax_id = '0125599000001' AND address IS NOT NULL AND document_template_key = 'classic';
  IF v_n <> 1 THEN RAISE EXCEPTION 'T2 FAIL: tenant profile not filled'; END IF;

  SELECT count(*) INTO v_n FROM clients WHERE tenant_id = t_tenant AND client_number ~ '^CL-[0-9]{4}-[0-9]{3}$';
  SELECT count(DISTINCT client_number) INTO v_n2 FROM clients WHERE tenant_id = t_tenant;
  IF v_n <> 8 OR v_n2 <> 8 THEN RAISE EXCEPTION 'T2 FAIL: client numbers malformed or not distinct (% / %)', v_n, v_n2; END IF;
  SELECT count(*) INTO v_n FROM suppliers WHERE tenant_id = t_tenant AND supplier_number ~ '^SP-[0-9]{4}-[0-9]{3}$';
  SELECT count(DISTINCT supplier_number) INTO v_n2 FROM suppliers WHERE tenant_id = t_tenant;
  IF v_n <> 8 OR v_n2 <> 8 THEN RAISE EXCEPTION 'T2 FAIL: supplier numbers malformed or not distinct (% / %)', v_n, v_n2; END IF;

  -- ── T3 ── sales chain
  IF COALESCE((s1->>'quotations')::int, -1) <> 18 THEN RAISE EXCEPTION 'T3 FAIL: quotations=%', s1->>'quotations'; END IF;
  SELECT count(*) INTO v_n FROM quotations WHERE tenant_id = t_tenant AND status = 'accepted' AND site_id IS NOT NULL;
  IF v_n <> 9 THEN RAISE EXCEPTION 'T3 FAIL: accepted with site=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM quotations WHERE tenant_id = t_tenant AND status = 'sent';
  IF v_n <> 4 THEN RAISE EXCEPTION 'T3 FAIL: sent=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM quotations WHERE tenant_id = t_tenant AND on_hold;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T3 FAIL: on_hold=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM quotation_items WHERE tenant_id = t_tenant AND item_type IN ('item_description','note');
  IF v_n < 10 THEN RAISE EXCEPTION 'T3 FAIL: too few description/note lines=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM quotation_revisions WHERE tenant_id = t_tenant;
  IF v_n <> 2 THEN RAISE EXCEPTION 'T3 FAIL: revisions=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM quotation_revisions WHERE tenant_id = t_tenant AND NOT (snapshot->'items'->0 ? 'item_type');
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: revision snapshot without item_type'; END IF;
  -- numbers: unique per tenant, month prefix matches the date
  SELECT count(*) INTO v_n FROM quotations WHERE tenant_id = t_tenant AND quotation_number !~ ('^QT' || to_char(date, 'YYMM') || '-[0-9]{3}$');
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: quotation number/date mismatch'; END IF;
  SELECT count(*) - count(DISTINCT quotation_number) INTO v_n FROM quotations WHERE tenant_id = t_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: duplicate quotation numbers'; END IF;
  SELECT count(*) - count(DISTINCT invoice_number) INTO v_n FROM invoices WHERE tenant_id = t_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: duplicate invoice numbers'; END IF;
  -- invoices
  SELECT count(*) INTO v_n FROM invoices WHERE tenant_id = t_tenant;
  IF v_n < 24 THEN RAISE EXCEPTION 'T3 FAIL: invoices=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM invoices WHERE tenant_id = t_tenant AND status = 'unpaid';
  IF v_n <> 4 THEN RAISE EXCEPTION 'T3 FAIL: unpaid=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM invoices WHERE tenant_id = t_tenant AND status = 'void';
  IF v_n <> 1 THEN RAISE EXCEPTION 'T3 FAIL: void=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM invoices WHERE tenant_id = t_tenant AND is_deposit;
  IF v_n <> 3 THEN RAISE EXCEPTION 'T3 FAIL: deposit invoices=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM invoices i WHERE i.tenant_id = t_tenant
    AND abs(i.subtotal - (SELECT COALESCE(sum(line_total), 0) FROM invoice_items x WHERE x.invoice_id = i.id)) > 0.01;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: % invoices whose subtotal != items', v_n; END IF;
  SELECT count(*) INTO v_n FROM invoices i WHERE i.tenant_id = t_tenant AND abs(i.total - (i.subtotal + i.vat)) > 0.01;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: total != subtotal+vat'; END IF;
  -- paid chain
  SELECT count(*) INTO v_n FROM invoices WHERE tenant_id = t_tenant AND status = 'paid';
  SELECT count(*) INTO v_n2 FROM incomes WHERE tenant_id = t_tenant AND source_invoice_id IS NOT NULL;
  IF v_n <> v_n2 OR v_n < 18 THEN RAISE EXCEPTION 'T3 FAIL: paid=% incomes=%', v_n, v_n2; END IF;
  SELECT count(*) INTO v_n2 FROM receipts r JOIN invoices i ON i.id = r.invoice_id WHERE i.tenant_id = t_tenant;
  IF v_n <> v_n2 THEN RAISE EXCEPTION 'T3 FAIL: receipts=% paid=%', v_n2, v_n; END IF;
  SELECT count(*) INTO v_n FROM incomes n JOIN invoices i ON i.id = n.source_invoice_id WHERE n.tenant_id = t_tenant
    AND abs(n.received_amount - (i.subtotal + i.vat - n.tax_withheld - n.retention - COALESCE(n.deposit_deduction, 0))) > 0.01;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: % incomes break the received_amount formula', v_n; END IF;
  SELECT count(*) INTO v_n FROM incomes WHERE tenant_id = t_tenant AND income_type = 'มัดจำ';
  IF v_n <> 3 THEN RAISE EXCEPTION 'T3 FAIL: deposit incomes=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM invoices i WHERE i.tenant_id = t_tenant AND i.status = 'paid' AND (i.income_id IS NULL OR i.paid_date IS NULL);
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: paid invoice without income_id/paid_date'; END IF;
  -- draws: cumulative pct never exceeds 100 and matches the last draw
  SELECT count(*) INTO v_n FROM quotation_item_units WHERE tenant_id = t_tenant AND cumulative_pct > 100;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: cumulative_pct > 100'; END IF;
  -- site contract value equals accepted quotation total (incl. VAT)
  SELECT count(*) INTO v_n FROM quotations q JOIN sites s ON s.id = q.site_id
    WHERE q.tenant_id = t_tenant AND q.status = 'accepted'
    AND abs(s.contract_value - (SELECT sum(line_total) * 1.07 FROM quotation_items x WHERE x.quotation_id = q.id AND x.item_type = 'item')) > 1;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: % sites whose contract_value != accepted quotation', v_n; END IF;

  SELECT count(*) INTO v_n FROM invoices WHERE tenant_id = t_tenant AND (date > current_date OR paid_date > current_date);
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: % invoices dated in the future', v_n; END IF;
  SELECT count(*) INTO v_n FROM receipts r JOIN invoices i ON i.id = r.invoice_id WHERE i.tenant_id = t_tenant AND r.date > current_date;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: receipt in the future'; END IF;
  SELECT count(*) INTO v_n FROM incomes WHERE tenant_id = t_tenant AND (date > current_date OR received_amount <= 0);
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: income in the future or non-positive'; END IF;
  SELECT count(*) INTO v_n FROM incomes WHERE tenant_id = t_tenant AND deposit_deduction > 0;
  IF v_n < 3 THEN RAISE EXCEPTION 'T3 FAIL: expected >=3 incomes with a deposit deduction, got %', v_n; END IF;
  SELECT count(*) INTO v_n FROM invoices WHERE tenant_id = t_tenant AND deposit_deduction_amount > 0;
  IF v_n < 1 THEN RAISE EXCEPTION 'T3 FAIL: no invoice with a deposit deduction to check VAT on'; END IF;
  SELECT count(*) INTO v_n FROM invoices WHERE tenant_id = t_tenant AND deposit_deduction_amount > 0
    AND abs(vat - round((subtotal - deposit_deduction_amount) * 0.07, 2)) > 0.01;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: % invoices whose VAT is not on (subtotal - deposit deduction)', v_n; END IF;
  SELECT count(*) INTO v_n FROM invoices WHERE tenant_id = t_tenant AND deposit_deduction_amount > subtotal;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: deposit deduction exceeds subtotal'; END IF;
  -- draws of one quotation are in date order: a later prior_pct never has an earlier invoice date
  SELECT count(*) INTO v_n FROM invoice_item_draws d1 JOIN invoice_items x1 ON x1.id = d1.invoice_item_id JOIN invoices i1 ON i1.id = x1.invoice_id
    JOIN invoice_item_draws d2 ON d2.quotation_item_unit_id = d1.quotation_item_unit_id JOIN invoice_items x2 ON x2.id = d2.invoice_item_id JOIN invoices i2 ON i2.id = x2.invoice_id
    WHERE i1.tenant_id = t_tenant AND d2.prior_pct > d1.prior_pct AND i2.date < i1.date;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: % draw pairs out of date order', v_n; END IF;

  -- ── T4 ── purchasing, expenses, cheques, stock
  IF COALESCE((s1->>'purchase_orders')::int, -1) <> 12 THEN RAISE EXCEPTION 'T4 FAIL: pos=%', s1->>'purchase_orders'; END IF;
  SELECT count(*) INTO v_n FROM purchase_orders WHERE tenant_id = t_tenant AND status = 'draft';
  IF v_n <> 1 THEN RAISE EXCEPTION 'T4 FAIL: draft pos=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM purchase_orders WHERE tenant_id = t_tenant AND status = 'received' AND (expense_id IS NULL OR received_date IS NULL);
  IF v_n <> 0 THEN RAISE EXCEPTION 'T4 FAIL: received PO without expense/received_date'; END IF;
  SELECT count(*) INTO v_n FROM purchase_orders WHERE tenant_id = t_tenant AND po_number !~ ('^PO' || to_char(date, 'YYMM') || '-[0-9]{3}$');
  IF v_n <> 0 THEN RAISE EXCEPTION 'T4 FAIL: po number/date mismatch'; END IF;
  SELECT count(*) INTO v_n FROM expenses WHERE tenant_id = t_tenant;
  IF v_n < 150 THEN RAISE EXCEPTION 'T4 FAIL: expenses=%', v_n; END IF;
  -- Completed sites made a profit (billed = received + deposit deducted, >= 10% above cost) and spent nothing after their end_date
  FOR cs IN SELECT s.name, s.end_date,
             COALESCE((SELECT sum(n.received_amount + COALESCE(n.deposit_deduction, 0)) FROM incomes n WHERE n.site_id = s.id), 0) AS billed,
             COALESCE((SELECT sum(e.amount_no_vat) FROM expenses e WHERE e.site_id = s.id), 0) AS cost,
             (SELECT count(*) FROM expenses e WHERE e.site_id = s.id AND e.date > s.end_date) AS late
           FROM sites s WHERE s.tenant_id = t_tenant AND s.status = 'Completed' LOOP
    RAISE NOTICE 'T4 completed site %: billed % cost % margin %%%', cs.name, cs.billed, cs.cost, round((cs.billed - cs.cost) / NULLIF(cs.billed, 0) * 100, 1);
    IF cs.billed < cs.cost * 1.10 THEN RAISE EXCEPTION 'T4 FAIL: completed site % billed % vs cost % (< 10%% profit)', cs.name, cs.billed, cs.cost; END IF;
    IF cs.late <> 0 THEN RAISE EXCEPTION 'T4 FAIL: completed site % has % expenses after its end_date', cs.name, cs.late; END IF;
  END LOOP;
  -- Ongoing sites: spend stays below 80% of the contract and near what has been billed or is being billed
  FOR cs IN SELECT s.name, s.contract_value_no_vat AS cv,
             COALESCE((SELECT sum(e.amount_no_vat) FROM expenses e WHERE e.site_id = s.id), 0) AS cost,
             COALESCE((SELECT sum(n.amount_no_vat) FROM incomes n WHERE n.site_id = s.id), 0)
               + COALESCE((SELECT sum(i.subtotal) FROM invoices i WHERE i.site_id = s.id AND i.status = 'unpaid'), 0) AS billed
           FROM sites s WHERE s.tenant_id = t_tenant AND s.status = 'Ongoing' AND NOT s.is_default LOOP
    RAISE NOTICE 'T4 ongoing site %: cost % billed % contract %', cs.name, cs.cost, cs.billed, cs.cv;
    IF cs.cost > 0.80 * cs.cv THEN RAISE EXCEPTION 'T4 FAIL: ongoing site % spent % > 80%% of contract %', cs.name, cs.cost, cs.cv; END IF;
    IF cs.cost > 1.15 * cs.billed + 0.05 * cs.cv THEN RAISE EXCEPTION 'T4 FAIL: ongoing site % spent % vs billed % (contract %)', cs.name, cs.cost, cs.billed, cs.cv; END IF;
  END LOOP;
  SELECT count(DISTINCT to_char(date, 'YYYY-MM')) INTO v_n FROM expenses WHERE tenant_id = t_tenant;
  IF v_n < 8 THEN RAISE EXCEPTION 'T4 FAIL: expenses cover only % months', v_n; END IF;
  SELECT count(*) INTO v_n FROM expenses WHERE tenant_id = t_tenant AND status = 'pending' AND due_date BETWEEN current_date AND current_date + 30;
  IF v_n < 5 THEN RAISE EXCEPTION 'T4 FAIL: too few pending expenses for the forecast (%)', v_n; END IF;
  SELECT count(*) INTO v_n FROM expenses WHERE tenant_id = t_tenant AND category_id IS NULL;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T4 FAIL: expense without category'; END IF;
  SELECT count(*) INTO v_n FROM cheques WHERE tenant_id = t_tenant;
  IF v_n <> 6 THEN RAISE EXCEPTION 'T4 FAIL: cheques=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM cheques WHERE tenant_id = t_tenant AND status = 'issued' AND check_date BETWEEN current_date AND current_date + 3;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T4 FAIL: cheque due within 3 days=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM expenses e JOIN cheques c ON c.id = e.cheque_id WHERE e.tenant_id = t_tenant
    AND e.status <> CASE c.status WHEN 'cashed' THEN 'check_cleared' ELSE 'check_issued' END;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T4 FAIL: % cheque-linked expenses out of sync with cheque status', v_n; END IF;
  SELECT count(*) INTO v_n FROM inventory_items WHERE tenant_id = t_tenant;
  IF v_n <> 12 THEN RAISE EXCEPTION 'T4 FAIL: inventory items=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM inventory_items WHERE tenant_id = t_tenant AND code !~ '^[A-Z]{3}-[0-9]{4}$';
  IF v_n <> 0 THEN RAISE EXCEPTION 'T4 FAIL: inventory code format'; END IF;
  -- ledger == balances, nothing negative
  SELECT count(*) INTO v_n FROM (
    SELECT inventory_item_id, site_id, sum(CASE movement_type WHEN 'transfer_out' THEN -quantity WHEN 'sale_out' THEN -quantity ELSE quantity END) AS q FROM stock_movements WHERE tenant_id = t_tenant GROUP BY 1, 2) l
    FULL JOIN (SELECT * FROM inventory_stock_balances WHERE tenant_id = t_tenant) b ON b.inventory_item_id = l.inventory_item_id AND b.site_id = l.site_id  -- tenant filter inside the subquery: in the ON clause it counted other tenants' balances as orphans
    WHERE b.id IS NULL OR l.inventory_item_id IS NULL OR abs(b.quantity_on_hand - l.q) > 0.0001;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T4 FAIL: % (item,site) pairs where balance != ledger', v_n; END IF;
  SELECT count(*) INTO v_n FROM inventory_stock_balances WHERE tenant_id = t_tenant AND (quantity_on_hand < 0 OR weighted_average_cost < 0);
  IF v_n <> 0 THEN RAISE EXCEPTION 'T4 FAIL: negative balance or cost'; END IF;
  SELECT count(*) INTO v_n FROM stock_movements WHERE tenant_id = t_tenant AND movement_type = 'purchase_in' AND reference_type = 'purchase_order';
  IF v_n < 7 THEN RAISE EXCEPTION 'T4 FAIL: purchase_in movements=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM stock_movements WHERE tenant_id = t_tenant AND movement_type IN ('transfer_out','transfer_in');
  IF v_n < 4 THEN RAISE EXCEPTION 'T4 FAIL: transfers=%', v_n; END IF;
  -- bell: draft PO and cheque due (counted directly: pending_counts() is SECURITY INVOKER and counts across tenants when run as postgres)
  SELECT count(*) INTO v_n FROM purchase_orders WHERE tenant_id = t_tenant AND status = 'draft';
  IF v_n <> 1 THEN RAISE EXCEPTION 'T4 FAIL: draft POs for the bell=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM cheques WHERE tenant_id = t_tenant AND status <> 'cashed' AND check_date <= current_date + 3;
  IF v_n < 1 THEN RAISE EXCEPTION 'T4 FAIL: no cheque due for the bell'; END IF;

  -- ── T5 ── people
  IF COALESCE((s1->>'workers')::int, -1) <> 12 THEN RAISE EXCEPTION 'T5 FAIL: workers=%', s1->>'workers'; END IF;
  SELECT count(*) INTO v_n FROM workers WHERE tenant_id = t_tenant AND email = worker_email;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T5 FAIL: worker login not linked'; END IF;
  SELECT count(*) INTO v_n FROM worker_teams WHERE tenant_id = t_tenant;
  IF v_n <> 2 THEN RAISE EXCEPTION 'T5 FAIL: teams=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM worker_team_members WHERE tenant_id = t_tenant;
  IF v_n <> 12 THEN RAISE EXCEPTION 'T5 FAIL: team members=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM worker_assignments WHERE tenant_id = t_tenant;
  IF v_n < 1000 THEN RAISE EXCEPTION 'T5 FAIL: assignments=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM worker_assignments WHERE tenant_id = t_tenant AND type = 'site' AND site_id IS NULL;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T5 FAIL: site assignment without site'; END IF;
  SELECT count(*) INTO v_n FROM worker_assignments WHERE tenant_id = t_tenant AND date > current_date;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T5 FAIL: assignment in the future'; END IF;
  SELECT count(*) INTO v_n FROM worker_checkins WHERE tenant_id = t_tenant;
  IF v_n < 100 THEN RAISE EXCEPTION 'T5 FAIL: checkins=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM worker_checkins WHERE tenant_id = t_tenant AND checkin_distance_m > 200;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T5 FAIL: checkin outside radius'; END IF;
  SELECT count(*) INTO v_n FROM worker_ot WHERE tenant_id = t_tenant;
  IF v_n < 12 THEN RAISE EXCEPTION 'T5 FAIL: ot=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM leave_requests WHERE tenant_id = t_tenant AND status = 'pending';
  IF v_n <> 2 THEN RAISE EXCEPTION 'T5 FAIL: pending leave=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM leave_requests WHERE tenant_id = t_tenant;
  IF v_n <> 6 THEN RAISE EXCEPTION 'T5 FAIL: leave=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM company_holidays WHERE tenant_id = t_tenant AND date >= current_date;
  IF v_n < 2 THEN RAISE EXCEPTION 'T5 FAIL: upcoming holidays=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM salary_records WHERE tenant_id = t_tenant;
  IF v_n <> 24 THEN RAISE EXCEPTION 'T5 FAIL: salary records=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM salary_records WHERE tenant_id = t_tenant AND abs(net_pay - (base_salary - social_security_ded - leave_deduction + ot_amount)) > 0.01;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T5 FAIL: % salary records break the net formula', v_n; END IF;
  SELECT count(*) INTO v_n FROM labor_subcontractors WHERE tenant_id = t_tenant;
  IF v_n <> 3 THEN RAISE EXCEPTION 'T5 FAIL: subcontractors=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM labor_subcontractors WHERE tenant_id = t_tenant AND subcontractor_number ~ '^LC-[0-9]{4}-[0-9]{3}$';
  SELECT count(DISTINCT subcontractor_number) INTO v_n2 FROM labor_subcontractors WHERE tenant_id = t_tenant;
  IF v_n <> 3 OR v_n2 <> 3 THEN RAISE EXCEPTION 'T5 FAIL: subcontractor numbers malformed or not distinct (% / %)', v_n, v_n2; END IF;
  SELECT count(*) INTO v_n FROM labor_contracts WHERE tenant_id = t_tenant;
  IF v_n <> 4 THEN RAISE EXCEPTION 'T5 FAIL: contracts=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM labor_payments WHERE tenant_id = t_tenant;
  IF v_n <> 6 THEN RAISE EXCEPTION 'T5 FAIL: payments=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM labor_payments WHERE tenant_id = t_tenant AND status = 'paid';
  SELECT count(*) INTO v_n2 FROM expenses WHERE tenant_id = t_tenant AND is_subcontract;
  IF v_n <> 5 OR v_n2 <> 5 THEN RAISE EXCEPTION 'T5 FAIL: paid payments=% subcontract expenses=%', v_n, v_n2; END IF;
  SELECT count(*) INTO v_n FROM labor_payments WHERE tenant_id = t_tenant AND abs(net_amount - (gross_amount - withholding_tax - retention_amount)) > 0.01;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T5 FAIL: labor payment net formula'; END IF;
  SELECT count(*) INTO v_n FROM labor_payments WHERE tenant_id = t_tenant AND is_retention_release;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T5 FAIL: retention release=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM line_groups WHERE tenant_id = t_tenant;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T5 FAIL: line groups=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM line_issue_reports WHERE tenant_id = t_tenant AND status = 'open';
  IF v_n <> 2 THEN RAISE EXCEPTION 'T5 FAIL: open issues=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM app_settings WHERE tenant_id = t_tenant AND key IN ('sign_physical_enabled','checkin_radius_m','cheque_reminder_days','require_checkin_confirmation','regular_shift_end_time');
  IF v_n <> 5 THEN RAISE EXCEPTION 'T5 FAIL: app settings=%', v_n; END IF;
  -- team pattern: on the latest Monday, all six members of team A are on one site and the foreman is the leader
  SELECT count(DISTINCT site_id) INTO v_n FROM worker_assignments a JOIN worker_team_members m ON m.worker_id = a.worker_id
    WHERE a.tenant_id = t_tenant AND a.type = 'site' AND a.shift = 'morning' AND a.date = current_date - ((extract(isodow FROM current_date)::int + 6) % 7)
      AND m.team_id = (SELECT id FROM worker_teams WHERE tenant_id = t_tenant ORDER BY name LIMIT 1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'T5 FAIL: team A not on a single site on the latest Monday (distinct sites=%)', v_n; END IF;
  SELECT count(*) INTO v_n FROM worker_assignments WHERE tenant_id = t_tenant AND is_team_leader AND type = 'site';
  IF v_n < 20 THEN RAISE EXCEPTION 'T5 FAIL: too few team-leader site shifts (%)', v_n; END IF;
  -- individual pattern: at least one worker was assigned alone (no teammate on the same site that day)
  SELECT count(*) INTO v_n FROM worker_assignments a
    WHERE a.tenant_id = t_tenant AND a.type = 'site' AND a.shift = 'morning' AND extract(isodow FROM a.date) IN (2, 4)
      AND NOT EXISTS (SELECT 1 FROM worker_assignments b JOIN worker_team_members mb ON mb.worker_id = b.worker_id
                      JOIN worker_team_members ma ON ma.worker_id = a.worker_id AND ma.team_id = mb.team_id
                      WHERE b.tenant_id = t_tenant AND b.date = a.date AND b.shift = a.shift AND b.site_id = a.site_id AND b.worker_id <> a.worker_id);
  IF v_n < 10 THEN RAISE EXCEPTION 'T5 FAIL: too few individual (solo) site assignments (%)', v_n; END IF;
  SELECT count(*) INTO v_n FROM worker_checkins WHERE tenant_id = t_tenant AND checkin_at > now();
  IF v_n <> 0 THEN RAISE EXCEPTION 'T5 FAIL: checkin in the future'; END IF;

  SELECT count(*) INTO v_n FROM labor_payments WHERE tenant_id = t_tenant AND (payment_date > current_date OR paid_date > current_date);
  IF v_n <> 0 THEN RAISE EXCEPTION 'T5 FAIL: % labor payments dated in the future', v_n; END IF;
  SELECT count(*) INTO v_n FROM expenses WHERE tenant_id = t_tenant AND is_subcontract AND date > current_date;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T5 FAIL: subcontract expense in the future'; END IF;
  SELECT count(*) INTO v_n FROM worker_checkins WHERE tenant_id = t_tenant AND extract(hour FROM checkin_at AT TIME ZONE 'Asia/Bangkok') NOT BETWEEN 7 AND 8;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T5 FAIL: % check-ins outside 07:00-08:59 Bangkok', v_n; END IF;

  -- ── T5b ── Kanban photos
  IF COALESCE((s1->>'photos')::int, -1) < 20 THEN RAISE EXCEPTION 'T5b FAIL: photos=%', s1->>'photos'; END IF;
  SELECT count(*) INTO v_n FROM line_site_photos WHERE tenant_id = t_tenant AND task_id IS NOT NULL;
  IF v_n < 15 THEN RAISE EXCEPTION 'T5b FAIL: assigned photos=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM line_site_photos WHERE tenant_id = t_tenant AND task_id IS NULL;
  IF v_n <> 3 THEN RAISE EXCEPTION 'T5b FAIL: unassigned photos=%', v_n; END IF;
  -- every assigned photo sits on a task of the same site, and that task is done or in progress
  SELECT count(*) INTO v_n FROM line_site_photos p JOIN phase_tasks t ON t.id = p.task_id
    WHERE p.tenant_id = t_tenant AND (t.site_id <> p.site_id OR t.status = 'not_started');
  IF v_n <> 0 THEN RAISE EXCEPTION 'T5b FAIL: % photos on a wrong-site or not-started task', v_n; END IF;
  -- paths live under the tenant's own folder and use the fixed demo keys
  SELECT count(*) INTO v_n FROM line_site_photos WHERE tenant_id = t_tenant AND photo_path !~ ('^' || t_tenant::text || '/demo/[0-9]{2}-[a-z-]+\.jpg$');
  IF v_n <> 0 THEN RAISE EXCEPTION 'T5b FAIL: % photo paths outside <tenant>/demo/', v_n; END IF;
  SELECT count(DISTINCT photo_path) INTO v_n FROM line_site_photos WHERE tenant_id = t_tenant;
  IF v_n <> 12 THEN RAISE EXCEPTION 'T5b FAIL: expected all 12 demo files referenced, got %', v_n; END IF;
  SELECT count(*) INTO v_n FROM line_site_photos WHERE tenant_id = t_tenant AND (date > current_date OR created_at > now() OR worker_id IS NULL OR description IS NULL);
  IF v_n <> 0 THEN RAISE EXCEPTION 'T5b FAIL: photo with future date, no worker or no caption'; END IF;
  -- at least 3 Ongoing sites have photos (the Kanban demo opens any of them)
  SELECT count(DISTINCT site_id) INTO v_n FROM line_site_photos WHERE tenant_id = t_tenant;
  IF v_n < 3 THEN RAISE EXCEPTION 'T5b FAIL: photos on only % sites', v_n; END IF;

  -- ── T6 ── reset wipes everything (including a table that does not exist yet today), re-seed is identical
  -- cross-tenant sentinel: a site of the OTHER tenant must survive both resets
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t_other, 'ZZ-0000-001', '__other site__');
  CREATE TABLE zz_future_demo (id SERIAL PRIMARY KEY, tenant_id UUID NOT NULL, note TEXT);
  INSERT INTO zz_future_demo (tenant_id, note) VALUES (t_tenant, 'must be wiped'), (t_other, 'must stay');
  SELECT string_agg(quotation_number, ',' ORDER BY quotation_number) INTO v_q1 FROM quotations WHERE tenant_id = t_tenant;
  d1 := reset_demo_tenant(t_tenant);
  SELECT count(*) INTO v_n FROM zz_future_demo WHERE tenant_id = t_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T6 FAIL: future table not wiped'; END IF;
  SELECT count(*) INTO v_n FROM zz_future_demo WHERE tenant_id = t_other;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T6 FAIL: other tenant row deleted'; END IF;
  IF COALESCE((d1->'deleted'->>'quotations')::int, -1) <> 18 THEN RAISE EXCEPTION 'T6 FAIL: deleted.quotations=%', d1->'deleted'->>'quotations'; END IF;
  s2 := d1->'seeded';
  IF s1 IS NULL OR s2 IS DISTINCT FROM s1 THEN RAISE EXCEPTION 'T6 FAIL: second seed differs: % vs %', s1, s2; END IF;
  -- same document numbers both times
  SELECT string_agg(quotation_number, ',' ORDER BY quotation_number) INTO v_q2 FROM quotations WHERE tenant_id = t_tenant;
  IF v_q1 IS NULL OR v_q1 <> v_q2 THEN RAISE EXCEPTION 'T6 FAIL: quotation numbers differ after reset: % vs %', v_q1, v_q2; END IF;
  -- Kanban photos are re-seeded too
  SELECT count(*) INTO v_n FROM line_site_photos WHERE tenant_id = t_tenant;
  IF v_n < 20 THEN RAISE EXCEPTION 'T6 FAIL: photos not re-seeded'; END IF;
  -- the kept user_roles row points at a checkin location the reset deletes; a push subscription must survive
  SELECT id INTO v_loc FROM checkin_locations WHERE tenant_id = t_tenant LIMIT 1;
  IF v_loc IS NULL THEN RAISE EXCEPTION 'T6 FAIL: demo has no checkin location to point at'; END IF;
  UPDATE user_roles SET assigned_checkin_location_id = v_loc WHERE tenant_id = t_tenant AND user_email = owner_email;
  INSERT INTO push_subscriptions (tenant_id, user_email, endpoint, p256dh_key, auth_key) VALUES (t_tenant, owner_email, 'https://example.invalid/__demo_test__', 'k', 'a');
  -- second reset on the re-seeded tenant: spot-checks that the seeded quotations, sites and photos were deleted and that the other tenant's future-table row survived
  d1 := reset_demo_tenant(t_tenant);
  IF COALESCE((d1->'deleted'->>'sites')::int, -1) <> 11 THEN RAISE EXCEPTION 'T6 FAIL: expected 11 sites deleted (10 + ส่วนกลาง), got %', d1->'deleted'->>'sites'; END IF;
  IF COALESCE((d1->'deleted'->>'quotations')::int, -1) <> 18 THEN RAISE EXCEPTION 'T6 FAIL: second reset deleted.quotations=%', d1->'deleted'->>'quotations'; END IF;
  IF COALESCE((d1->'deleted'->>'line_site_photos')::int, -1) < 20 THEN RAISE EXCEPTION 'T6 FAIL: second reset deleted.line_site_photos=%', d1->'deleted'->>'line_site_photos'; END IF;
  SELECT count(*) INTO v_n FROM push_subscriptions WHERE tenant_id = t_tenant;
  IF v_n <> 1 OR d1->'deleted' ? 'push_subscriptions' THEN RAISE EXCEPTION 'T6 FAIL: push_subscriptions not kept by reset'; END IF;
  SELECT count(*) INTO v_n FROM user_roles WHERE tenant_id = t_tenant AND assigned_checkin_location_id IS NOT NULL;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T6 FAIL: user_roles still points at a deleted checkin location'; END IF;
  SELECT count(*) INTO v_n FROM zz_future_demo;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T6 FAIL: zz_future_demo has % rows after second reset (expected only the t_other sentinel)', v_n; END IF;
  -- other tenant untouched by the whole exercise: its sentinel site is still there and it has exactly one site
  SELECT count(*) INTO v_n FROM sites WHERE tenant_id = t_other AND site_number = 'ZZ-0000-001' AND name = '__other site__';
  IF v_n <> 1 THEN RAISE EXCEPTION 'T6 FAIL: other tenant sentinel site missing'; END IF;
  SELECT count(*) INTO v_n FROM sites WHERE tenant_id = t_other;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T6 FAIL: other tenant sites=% (expected only the sentinel)', v_n; END IF;
  DROP TABLE zz_future_demo;

  RAISE EXCEPTION 'RESULT: demo_tenant_seed_test ALL PASSED';
END $$;
ROLLBACK;
