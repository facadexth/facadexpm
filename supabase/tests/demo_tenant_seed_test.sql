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
  s1 JSONB; s2 JSONB; d1 JSONB; v_q1 TEXT; v_q2 TEXT;
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
  SELECT count(*) INTO v_n FROM tenants WHERE id = t_tenant AND tax_id = '0125599000001' AND address IS NOT NULL AND document_template_key = 'classic';
  IF v_n <> 1 THEN RAISE EXCEPTION 'T2 FAIL: tenant profile not filled'; END IF;

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
  SELECT count(*) INTO v_n FROM invoices WHERE tenant_id = t_tenant AND deposit_deduction_amount > subtotal;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: deposit deduction exceeds subtotal'; END IF;
  -- draws of one quotation are in date order: a later prior_pct never has an earlier invoice date
  SELECT count(*) INTO v_n FROM invoice_item_draws d1 JOIN invoice_items x1 ON x1.id = d1.invoice_item_id JOIN invoices i1 ON i1.id = x1.invoice_id
    JOIN invoice_item_draws d2 ON d2.quotation_item_unit_id = d1.quotation_item_unit_id JOIN invoice_items x2 ON x2.id = d2.invoice_item_id JOIN invoices i2 ON i2.id = x2.invoice_id
    WHERE i1.tenant_id = t_tenant AND d2.prior_pct > d1.prior_pct AND i2.date < i1.date;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: % draw pairs out of date order', v_n; END IF;

  RAISE EXCEPTION 'RESULT: demo_tenant_seed_test ALL PASSED';
END $$;
ROLLBACK;
