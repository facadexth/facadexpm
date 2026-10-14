-- ================================================================
-- Demo tenant: marker-guarded seed + reset for customer demos.
-- Design: docs/superpowers/specs/2026-10-14-demo-tenant-seed-design.md
-- Plan:   docs/superpowers/plans/2026-10-14-demo-tenant-seed.md
-- Both public entry points refuse to run unless (a) the caller is a
-- platform admin and (b) the tenant carries app_settings
-- is_demo_tenant='true'. (b) is the only thing between "reset the demo"
-- and "wipe a paying customer", so it is checked inside the functions.
-- ================================================================

-- ── guard + helpers ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION demo_tenant_guard(p_tenant UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()) THEN
    RAISE EXCEPTION 'demo_not_platform_admin' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_settings WHERE tenant_id = p_tenant AND key = 'is_demo_tenant' AND value = 'true') THEN
    RAISE EXCEPTION 'demo_marker_missing: tenant % is not flagged is_demo_tenant', p_tenant USING ERRCODE = '42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION demo_tenant_guard(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION demo_owner_email(p_tenant UUID)
RETURNS TEXT LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT user_email FROM user_roles WHERE tenant_id = p_tenant AND role = 'OWNER' ORDER BY created_at LIMIT 1;
$$;
CREATE OR REPLACE FUNCTION demo_worker_email(p_tenant UUID)
RETURNS TEXT LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT user_email FROM user_roles WHERE tenant_id = p_tenant AND role = 'WORKER' ORDER BY created_at LIMIT 1;
$$;
REVOKE ALL ON FUNCTION demo_owner_email(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION demo_worker_email(UUID) FROM PUBLIC, anon, authenticated;

-- Triggers (numbering, seat limits, created_by defaults) read auth.email()
-- and current_tenant_id(); impersonating the demo owner for the rest of
-- the transaction makes them behave as if the owner typed the data in.
-- Same pattern as supabase/tests/*.sql. The caller's claims are restored
-- by the public entry points before they return.
CREATE OR REPLACE FUNCTION demo_impersonate(p_tenant UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_email TEXT := demo_owner_email(p_tenant); v_uid UUID;
BEGIN
  IF v_email IS NULL THEN RAISE EXCEPTION 'demo_no_owner: tenant % has no OWNER role', p_tenant; END IF;
  SELECT id INTO v_uid FROM auth.users WHERE email = v_email;
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_email, 'role', 'authenticated', 'sub', COALESCE(v_uid::text, ''))::text, true);
END $$;
REVOKE ALL ON FUNCTION demo_impersonate(UUID) FROM PUBLIC, anon, authenticated;

-- ── seed entry point (sections are added by later tasks) ───────
CREATE OR REPLACE FUNCTION seed_demo_tenant(p_tenant_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_claims TEXT := current_setting('request.jwt.claims', true); v_out JSONB := '{}'::jsonb;
BEGIN
  PERFORM demo_tenant_guard(p_tenant_id);
  PERFORM setseed(0.42);
  PERFORM demo_impersonate(p_tenant_id);
  -- sections: v_out := v_out || demo_seed_core(p_tenant_id); ... (Tasks 2-5)
  PERFORM set_config('request.jwt.claims', COALESCE(v_claims, ''), true);
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION seed_demo_tenant(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION seed_demo_tenant(UUID) TO authenticated;

-- ── reset ───────────────────────────────────────────────────────
-- Deletes every row of the tenant in every public table that has a
-- tenant_id column, except the kept list. Order is discovered at run
-- time by retrying: a DELETE that hits a foreign key (or a "has children"
-- trigger such as expenses_block_receipt_bill_delete) is caught in a
-- sub-transaction and retried on the next pass once its children are
-- gone. A pass that deletes nothing while rows remain means a real
-- cycle or an unknown blocker: the function raises with the table list
-- and the whole transaction rolls back, so the demo is never half-empty.
CREATE OR REPLACE FUNCTION reset_demo_tenant(p_tenant_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_claims TEXT := current_setting('request.jwt.claims', true);
  v_keep TEXT[] := ARRAY['tenants','user_roles','tenant_modules','tenant_status_log','platform_admins','packages','package_modules'];
  v_tables TEXT[]; v_remaining TEXT[]; v_t TEXT; v_deleted JSONB := '{}'::jsonb;
  v_pass INT := 0; v_progress BOOLEAN; v_n BIGINT; v_err TEXT; v_errs JSONB := '{}'::jsonb; v_seed JSONB;
BEGIN
  PERFORM demo_tenant_guard(p_tenant_id);
  SELECT array_agg(c.table_name::text ORDER BY c.table_name) INTO v_tables
  FROM information_schema.columns c
  JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
  WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
    AND NOT (c.table_name = ANY (v_keep)) AND c.table_name NOT LIKE 'contractor_type%';
  v_remaining := v_tables;
  LOOP
    v_pass := v_pass + 1; v_progress := false;
    IF v_pass > 25 THEN EXIT; END IF;
    FOREACH v_t IN ARRAY v_remaining LOOP
      BEGIN
        EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', v_t) USING p_tenant_id;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_deleted := v_deleted || jsonb_build_object(v_t, COALESCE((v_deleted->>v_t)::bigint, 0) + v_n);
        v_remaining := array_remove(v_remaining, v_t);
        v_progress := true;
      EXCEPTION WHEN foreign_key_violation OR raise_exception OR check_violation THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
        v_errs := v_errs || jsonb_build_object(v_t, v_err);
      END;
    END LOOP;
    EXIT WHEN cardinality(v_remaining) = 0 OR NOT v_progress;
  END LOOP;
  IF cardinality(v_remaining) > 0 THEN
    RAISE EXCEPTION 'demo_reset_stuck: could not delete from % (last errors %)', v_remaining, v_errs;
  END IF;
  -- keep the marker and the two settings the signup trigger always creates
  INSERT INTO app_settings (tenant_id, key, value) VALUES
    (p_tenant_id, 'is_demo_tenant', 'true'),
    (p_tenant_id, 'travel_rate_per_km', '20'),
    (p_tenant_id, 'holiday_pay_multiplier', '1.5');
  v_seed := seed_demo_tenant(p_tenant_id);
  PERFORM set_config('request.jwt.claims', COALESCE(v_claims, ''), true);
  RETURN jsonb_build_object('deleted', v_deleted, 'passes', v_pass, 'seeded', v_seed);
END $$;
REVOKE ALL ON FUNCTION reset_demo_tenant(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reset_demo_tenant(UUID) TO authenticated;

-- ── platform_list_tenants gains is_demo ─────────────────────────
DROP FUNCTION IF EXISTS platform_list_tenants();
CREATE FUNCTION platform_list_tenants()
RETURNS TABLE (
  id UUID, company_name TEXT, plan TEXT, trial_ends_at TIMESTAMPTZ, plan_expires_at TIMESTAMPTZ,
  package_id UUID, package_name TEXT, price_monthly NUMERIC, price_yearly NUMERIC, created_at TIMESTAMPTZ,
  is_demo BOOLEAN
)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT t.id, t.company_name, t.plan, t.trial_ends_at, t.plan_expires_at, t.package_id, p.name,
         p.price_monthly, p.price_yearly, t.created_at,
         EXISTS (SELECT 1 FROM app_settings a WHERE a.tenant_id = t.id AND a.key = 'is_demo_tenant' AND a.value = 'true') AS is_demo
  FROM tenants t
  LEFT JOIN packages p ON p.id = t.package_id
  WHERE EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email())
  ORDER BY t.company_name;
$$;
REVOKE EXECUTE ON FUNCTION platform_list_tenants() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION platform_list_tenants() TO authenticated;
