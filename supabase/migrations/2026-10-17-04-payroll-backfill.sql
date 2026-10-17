-- supabase/migrations/2026-10-17-04-payroll-backfill.sql
-- Converts pre-rework salary_records (fixed money columns) into
-- salary_record_lines so old months open in the new grid and payslip.
-- Paid months (every record has paid_date) become 'closed'.
-- p_apply=false is a dry run (counts + mismatches, then RAISE to roll back).

CREATE OR REPLACE FUNCTION payroll_backfill_lines(p_tenant UUID, p_apply BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r RECORD; v_items JSONB; v_lines INT := 0; v_recs INT := 0; v_mis JSONB := '[]'::jsonb;
  v_sum NUMERIC; v_out JSONB;
BEGIN
  PERFORM set_config('chang.payroll_bypass', 'on', true);
  PERFORM seed_default_pay_items(p_tenant);
  SELECT jsonb_object_agg(system_key, jsonb_build_object('id', id, 'name', name, 'side', side, 'sort', sort_order))
    INTO v_items FROM pay_items WHERE tenant_id = p_tenant AND system_key IS NOT NULL;

  FOR r IN
    SELECT s.*, w.name AS worker_name FROM salary_records s JOIN workers w ON w.id = s.worker_id
    WHERE s.tenant_id = p_tenant
      AND NOT EXISTS (SELECT 1 FROM salary_record_lines l WHERE l.salary_record_id = s.id)
  LOOP
    v_recs := v_recs + 1;
    INSERT INTO salary_record_lines (tenant_id, salary_record_id, pay_item_id, name, side, sort_order, amount)
    SELECT p_tenant, r.id, (v_items->k->>'id')::uuid, v_items->k->>'name', v_items->k->>'side', (v_items->k->>'sort')::int, amt
    FROM (VALUES
      ('salary', r.base_salary), ('contribution', r.contribution), ('phone', r.phone_allowance),
      ('ot', r.ot_amount), ('parking', r.special_allowance), ('sso', r.social_security_ded),
      ('house', 0::numeric), ('advances', r.advance_deduction), ('student_loan', r.loan_deduction),
      ('unpaid_leave', r.leave_deduction), ('contribution_deduct', r.contribution)
    ) AS m(k, amt)
    WHERE COALESCE(amt, 0) <> 0;
    GET DIAGNOSTICS v_sum = ROW_COUNT; v_lines := v_lines + v_sum;

    SELECT COALESCE(sum(CASE WHEN side = 'earning' THEN amount ELSE -amount END), 0) INTO v_sum
      FROM salary_record_lines WHERE salary_record_id = r.id;
    IF round(v_sum, 2) <> round(COALESCE(r.net_pay, 0), 2) THEN
      v_mis := v_mis || jsonb_build_object('record_id', r.id, 'worker', r.worker_name, 'year', r.year, 'month', r.month,
                                           'old_net', r.net_pay, 'lines_net', round(v_sum, 2));
      INSERT INTO salary_record_lines (tenant_id, salary_record_id, name, side, sort_order, amount, note)
      VALUES (p_tenant, r.id, 'ปรับยอดจากระบบเดิม',
              CASE WHEN COALESCE(r.net_pay, 0) > v_sum THEN 'earning' ELSE 'deduction' END, 999,
              abs(round(COALESCE(r.net_pay, 0) - v_sum, 2)), 'ยอดสุทธิเดิมที่จ่ายจริง');
      v_lines := v_lines + 1;
    END IF;
  END LOOP;

  UPDATE payroll_periods p SET status = 'closed', paid_date = (SELECT max(paid_date) FROM salary_records s WHERE s.period_id = p.id)
   WHERE p.tenant_id = p_tenant AND p.status = 'draft'
     AND EXISTS (SELECT 1 FROM salary_records s WHERE s.period_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM salary_records s WHERE s.period_id = p.id AND s.paid_date IS NULL);

  PERFORM set_config('chang.payroll_bypass', '', true);
  v_out := jsonb_build_object('records', v_recs, 'lines', v_lines, 'mismatches', v_mis);
  IF NOT p_apply THEN RAISE EXCEPTION 'DRY RUN %', v_out; END IF;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION payroll_backfill_lines(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;

-- ── demo hooks: live bodies (pulled 2026-10-17) plus the payroll lines ──
CREATE OR REPLACE FUNCTION public.reset_demo_tenant(p_tenant_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_claims TEXT := current_setting('request.jwt.claims', true);
  v_keep TEXT[] := ARRAY['tenants','user_roles','tenant_modules','tenant_status_log','payment_intents','subscription_receipts','push_subscriptions'];
  v_tables TEXT[]; v_remaining TEXT[]; v_t TEXT; v_deleted JSONB := '{}'::jsonb;
  v_pass INT := 0; v_progress BOOLEAN; v_n BIGINT; v_err TEXT; v_errs JSONB := '{}'::jsonb; v_seed JSONB;
BEGIN
  PERFORM demo_tenant_guard(p_tenant_id);
  PERFORM set_config('chang.payroll_bypass', 'on', true);
  -- user_roles is kept but points at checkin_locations, which is deleted below
  UPDATE user_roles SET assigned_checkin_location_id = NULL WHERE tenant_id = p_tenant_id;
  SELECT array_agg(c.table_name::text ORDER BY c.table_name) INTO v_tables
  FROM information_schema.columns c
  JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
  WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
    AND NOT (c.table_name = ANY (v_keep)) AND c.table_name NOT LIKE 'contractor_type%'
    AND c.table_name NOT LIKE 'platform_%' AND c.table_name NOT LIKE 'package%';
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
END $function$;
REVOKE ALL ON FUNCTION public.reset_demo_tenant(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reset_demo_tenant(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.seed_demo_tenant(p_tenant_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_claims TEXT := current_setting('request.jwt.claims', true); v_out JSONB := '{}'::jsonb;
BEGIN
  PERFORM demo_tenant_guard(p_tenant_id);
  PERFORM setseed(0.42);
  PERFORM demo_impersonate(p_tenant_id);
  v_out := v_out || demo_seed_core(p_tenant_id);
  v_out := v_out || demo_seed_sales(p_tenant_id);
  v_out := v_out || demo_seed_purchasing(p_tenant_id);
  PERFORM seed_default_pay_items(p_tenant_id);
  v_out := v_out || demo_seed_people(p_tenant_id);
  v_out := v_out || jsonb_build_object('payroll_backfill', payroll_backfill_lines(p_tenant_id, true));
  v_out := v_out || demo_seed_photos(p_tenant_id);
  -- sections: ... (Tasks 3-5)
  PERFORM set_config('request.jwt.claims', COALESCE(v_claims, ''), true);
  RETURN v_out;
END $function$;
REVOKE ALL ON FUNCTION public.seed_demo_tenant(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.seed_demo_tenant(uuid) TO authenticated;
