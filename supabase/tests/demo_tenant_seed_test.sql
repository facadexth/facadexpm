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

  RAISE EXCEPTION 'RESULT: demo_tenant_seed_test ALL PASSED';
END $$;
ROLLBACK;
