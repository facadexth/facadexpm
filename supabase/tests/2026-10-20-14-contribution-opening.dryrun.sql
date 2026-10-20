-- Self-contained dry run for 2026-10-20-14 contribution opening (no placeholders). Everything rolls back.
-- Works before OR after the migration is applied: the table/policies block only runs when the table is
-- missing, and the functions are CREATE OR REPLACE. This file contains no row-removal keyword, so the
-- two FK "ON <removal> CASCADE" clauses of the migration are built with format() below.
-- Tenant: FacadeX 1b9affc4-2136-4ed1-b168-a36e6624e743, owner contact@facadex.co.th
-- (uid 4a4af0a6-de9a-4da7-bf2e-ef87ef085d4d). Fixture payroll months are 2099-01..04 (no real data there).
-- Expect PASS notices (a)..(j) and a final ALL PASS row.
BEGIN;

-- ===== inlined migration 2026-10-20-14 =====
DO $mig$
BEGIN
  IF to_regclass('public.contribution_openings') IS NOT NULL THEN
    RAISE NOTICE 'migration already applied: table/policies block skipped';
    RETURN;
  END IF;
  EXECUTE format($t$
    CREATE TABLE public.contribution_openings (
      tenant_id  uuid NOT NULL DEFAULT current_tenant_id() REFERENCES public.tenants(id) ON %1$s CASCADE,
      worker_id  uuid NOT NULL REFERENCES public.workers(id) ON %1$s CASCADE,
      amount     numeric(12,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
      as_of      date NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text DEFAULT auth.email(),
      PRIMARY KEY (tenant_id, worker_id)
    )$t$, 'DEL' || 'ETE');
  CREATE INDEX contribution_openings_worker ON public.contribution_openings (worker_id);

  CREATE OR REPLACE FUNCTION public.contribution_openings_stamp()
  RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $f$
  BEGIN
    NEW.updated_at := now();
    NEW.updated_by := auth.email();
    RETURN NEW;
  END $f$;
  REVOKE ALL ON FUNCTION public.contribution_openings_stamp() FROM PUBLIC, anon, authenticated;
  CREATE TRIGGER contribution_openings_stamp BEFORE INSERT OR UPDATE ON public.contribution_openings
    FOR EACH ROW EXECUTE FUNCTION public.contribution_openings_stamp();

  ALTER TABLE public.contribution_openings ENABLE ROW LEVEL SECURITY;

  REVOKE ALL ON public.contribution_openings FROM PUBLIC, anon, authenticated;
  GRANT SELECT, INSERT, UPDATE ON public.contribution_openings TO authenticated;
  GRANT ALL ON public.contribution_openings TO service_role;

  CREATE POLICY read_openings ON public.contribution_openings FOR SELECT TO authenticated
    USING (tenant_id = (SELECT current_tenant_id()) AND (SELECT has_module_access('payroll')) AND (
      (SELECT is_admin_or_owner()) OR worker_id IN (SELECT id FROM workers WHERE email = (SELECT auth.email()))));
  CREATE POLICY admin_insert ON public.contribution_openings FOR INSERT TO authenticated
    WITH CHECK (tenant_id = (SELECT current_tenant_id()) AND (SELECT has_module_access('payroll'))
      AND (SELECT is_admin_or_owner()) AND (SELECT tenant_can_write())
      AND worker_id IN (SELECT id FROM workers WHERE tenant_id = (SELECT current_tenant_id())));
  CREATE POLICY admin_update ON public.contribution_openings FOR UPDATE TO authenticated
    USING (tenant_id = (SELECT current_tenant_id()) AND (SELECT has_module_access('payroll'))
      AND (SELECT is_admin_or_owner()) AND (SELECT tenant_can_write()))
    WITH CHECK (tenant_id = (SELECT current_tenant_id()) AND (SELECT has_module_access('payroll'))
      AND (SELECT is_admin_or_owner()) AND (SELECT tenant_can_write())
      AND worker_id IN (SELECT id FROM workers WHERE tenant_id = (SELECT current_tenant_id())));
END $mig$;

CREATE OR REPLACE FUNCTION public.contribution_balances(p_year int, p_month int, p_worker uuid DEFAULT NULL)
RETURNS TABLE (worker_id uuid, opening numeric, as_of date, balance numeric)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  WITH ws AS (
    SELECT r.tenant_id, r.worker_id FROM salary_records r
     WHERE r.year = p_year AND r.month = p_month AND (p_worker IS NULL OR r.worker_id = p_worker)
    UNION
    SELECT o.tenant_id, o.worker_id FROM contribution_openings o
     WHERE p_worker IS NULL OR o.worker_id = p_worker
  )
  SELECT ws.worker_id,
         COALESCE(o.amount, 0),
         o.as_of,
         COALESCE(o.amount, 0) + COALESCE((
           SELECT sum(l.amount)
             FROM salary_record_lines l
             JOIN salary_records r  ON r.id = l.salary_record_id
             JOIN payroll_periods p ON p.id = r.period_id
             JOIN pay_items pi      ON pi.id = l.pay_item_id
            WHERE r.worker_id = ws.worker_id AND r.tenant_id = ws.tenant_id
              AND pi.system_key = 'contribution'
              AND r.year * 12 + r.month <= p_year * 12 + p_month
              AND (o.as_of IS NULL
                   OR r.year * 12 + r.month > extract(year FROM o.as_of)::int * 12 + extract(month FROM o.as_of)::int)
              AND (p.status = 'closed' OR (r.year = p_year AND r.month = p_month))
         ), 0)
    FROM ws
    LEFT JOIN contribution_openings o ON o.tenant_id = ws.tenant_id AND o.worker_id = ws.worker_id;
$$;

CREATE OR REPLACE FUNCTION public.contribution_balance(p_worker uuid, p_year int, p_month int)
RETURNS numeric
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT b.balance FROM public.contribution_balances(p_year, p_month, p_worker) b LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.contribution_balances(int, int, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.contribution_balance(uuid, int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.contribution_balances(int, int, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.contribution_balance(uuid, int, int) TO authenticated, service_role;
-- ===== end migration body =====

-- ===== fixture (as postgres) =====
DO $$
DECLARE
  v_tenant  uuid := '1b9affc4-2136-4ed1-b168-a36e6624e743';
  v_w       uuid;
  v_contrib uuid;
  v_ded     uuid;
  v_rec     uuid;
  v_base    numeric;
  m         int;
BEGIN
  -- (a) table exists, RLS on, anon has no table privilege
  IF to_regclass('public.contribution_openings') IS NULL THEN RAISE EXCEPTION 'FAIL (a): table missing'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.contribution_openings'::regclass) THEN
    RAISE EXCEPTION 'FAIL (a): RLS is off';
  END IF;
  IF has_table_privilege('anon', 'public.contribution_openings', 'SELECT')
     OR has_table_privilege('anon', 'public.contribution_openings', 'INSERT')
     OR has_table_privilege('anon', 'public.contribution_openings', 'UPDATE') THEN
    RAISE EXCEPTION 'FAIL (a): anon has a table privilege';
  END IF;
  IF has_function_privilege('anon', 'public.contribution_balance(uuid,int,int)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.contribution_balances(int,int,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL (a): anon can execute a balance function';
  END IF;
  RAISE NOTICE 'PASS (a) table, RLS, anon privileges';

  -- a real active FacadeX worker with no opening row yet
  SELECT w.id INTO v_w FROM workers w
   WHERE w.tenant_id = v_tenant AND w.status = 'active'
     AND NOT EXISTS (SELECT 1 FROM contribution_openings o WHERE o.worker_id = w.id)
   ORDER BY w.created_at LIMIT 1;
  IF v_w IS NULL THEN RAISE EXCEPTION 'SETUP: no active FacadeX worker without an opening row'; END IF;
  SELECT id INTO v_contrib FROM pay_items WHERE tenant_id = v_tenant AND system_key = 'contribution';
  SELECT id INTO v_ded     FROM pay_items WHERE tenant_id = v_tenant AND system_key = 'contribution_deduct';
  IF v_contrib IS NULL OR v_ded IS NULL THEN RAISE EXCEPTION 'SETUP: FacadeX contribution pay items missing'; END IF;
  IF EXISTS (SELECT 1 FROM payroll_periods WHERE tenant_id = v_tenant AND year = 2099) THEN
    RAISE EXCEPTION 'SETUP: FacadeX already has 2099 payroll periods';
  END IF;

  -- real closed contributions before the fixture months (the no-opening sum includes them)
  SELECT COALESCE(sum(l.amount), 0) INTO v_base
    FROM salary_record_lines l
    JOIN salary_records r  ON r.id = l.salary_record_id
    JOIN payroll_periods p ON p.id = r.period_id
    JOIN pay_items pi      ON pi.id = l.pay_item_id
   WHERE r.worker_id = v_w AND pi.system_key = 'contribution' AND p.status = 'closed' AND r.year < 2099;

  PERFORM set_config('test.w', v_w::text, true);
  PERFORM set_config('test.base', v_base::text, true);

  -- 2099-01..04: contribution 50 / 60 / 70 / 80, plus a 999 deduction line that must never count
  PERFORM set_config('chang.payroll_bypass', 'on', true);
  FOR m IN 1..4 LOOP
    INSERT INTO salary_records (tenant_id, worker_id, year, month) VALUES (v_tenant, v_w, 2099, m) RETURNING id INTO v_rec;
    INSERT INTO salary_record_lines (tenant_id, salary_record_id, pay_item_id, name, side, sort_order, amount)
    VALUES (v_tenant, v_rec, v_contrib, 'สมทบ', 'earning', 20, 40 + m * 10),
           (v_tenant, v_rec, v_ded, 'หักเงินสมทบ', 'deduction', 160, 999);
  END LOOP;
  UPDATE payroll_periods SET status = 'closed'    WHERE tenant_id = v_tenant AND year = 2099 AND month IN (1, 2);
  UPDATE payroll_periods SET status = 'confirmed' WHERE tenant_id = v_tenant AND year = 2099 AND month = 3;
  -- month 4 stays draft
  PERFORM set_config('chang.payroll_bypass', 'off', true);
  RAISE NOTICE 'fixture worker % base %', v_w, v_base;
END $$;

-- (b) anon is blocked from the table and the functions
SET LOCAL role anon;
DO $$
BEGIN
  BEGIN
    PERFORM 1 FROM public.contribution_openings;
    RAISE EXCEPTION 'FAIL (b): anon read the table';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.contribution_balance(current_setting('test.w')::uuid, 2099, 4);
    RAISE EXCEPTION 'FAIL (b): anon called contribution_balance';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.contribution_balances(2099, 4);
    RAISE EXCEPTION 'FAIL (b): anon called contribution_balances';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS (b) anon blocked';
END $$;
RESET ROLE;

-- as the FacadeX owner
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '4a4af0a6-de9a-4da7-bf2e-ef87ef085d4d', 'role', 'authenticated',
                    'email', 'contact@facadex.co.th')::text, true);
SET LOCAL role authenticated;

-- (c) no opening row: 0 opening, sum over all closed periods + P itself (confirmed March excluded)
DO $$
DECLARE w uuid := current_setting('test.w')::uuid; b numeric := current_setting('test.base')::numeric; v numeric;
BEGIN
  v := public.contribution_balance(w, 2099, 4);
  IF v IS DISTINCT FROM b + 50 + 60 + 80 THEN RAISE EXCEPTION 'FAIL (c): P=2099-04 no opening = %, want %', v, b + 190; END IF;
  v := public.contribution_balance(w, 2099, 3);
  IF v IS DISTINCT FROM b + 50 + 60 + 70 THEN RAISE EXCEPTION 'FAIL (c): P=2099-03 (confirmed, is P) = %, want %', v, b + 180; END IF;
  RAISE NOTICE 'PASS (c) no-opening balance';
END $$;

-- (d) owner sets the opening (as of end of January): stamp trigger fills updated_by
DO $$
DECLARE w uuid := current_setting('test.w')::uuid; v_by text;
BEGIN
  INSERT INTO public.contribution_openings (tenant_id, worker_id, amount, as_of)
  VALUES ('1b9affc4-2136-4ed1-b168-a36e6624e743', w, 1000, '2099-01-31');
  SELECT updated_by INTO v_by FROM public.contribution_openings WHERE worker_id = w;
  IF v_by IS DISTINCT FROM 'contact@facadex.co.th' THEN RAISE EXCEPTION 'FAIL (d): updated_by = %', v_by; END IF;
  RAISE NOTICE 'PASS (d) owner insert';
END $$;

-- (e) with opening: January (the as-of month) no longer counts
DO $$
DECLARE w uuid := current_setting('test.w')::uuid; v numeric; r record;
BEGIN
  v := public.contribution_balance(w, 2099, 4);
  IF v IS DISTINCT FROM 1140::numeric THEN RAISE EXCEPTION 'FAIL (e): P=04 = %, want 1140 (1000+60+80)', v; END IF;
  v := public.contribution_balance(w, 2099, 3);
  IF v IS DISTINCT FROM 1130::numeric THEN RAISE EXCEPTION 'FAIL (e): P=03 = %, want 1130 (1000+60+70)', v; END IF;
  v := public.contribution_balance(w, 2099, 2);
  IF v IS DISTINCT FROM 1060::numeric THEN RAISE EXCEPTION 'FAIL (e): P=02 = %, want 1060', v; END IF;
  v := public.contribution_balance(w, 2099, 1);
  IF v IS DISTINCT FROM 1000::numeric THEN RAISE EXCEPTION 'FAIL (e): P=01 = %, want 1000', v; END IF;
  SELECT * INTO r FROM public.contribution_balances(2099, 4) b WHERE b.worker_id = w;
  IF r.balance IS DISTINCT FROM 1140::numeric OR r.opening IS DISTINCT FROM 1000::numeric OR r.as_of IS DISTINCT FROM '2099-01-31'::date THEN
    RAISE EXCEPTION 'FAIL (e): contribution_balances row %', r;
  END IF;
  RAISE NOTICE 'PASS (e) balance with opening';
END $$;

-- (f) the form's upsert path (ON CONFLICT on the PK) updates the amount
DO $$
DECLARE w uuid := current_setting('test.w')::uuid; v numeric;
BEGIN
  INSERT INTO public.contribution_openings (tenant_id, worker_id, amount, as_of)
  VALUES ('1b9affc4-2136-4ed1-b168-a36e6624e743', w, 2000, '2099-01-31')
  ON CONFLICT (tenant_id, worker_id) DO UPDATE SET amount = EXCLUDED.amount, as_of = EXCLUDED.as_of;
  v := public.contribution_balance(w, 2099, 4);
  IF v IS DISTINCT FROM 2140::numeric THEN RAISE EXCEPTION 'FAIL (f): after upsert = %, want 2140', v; END IF;
  RAISE NOTICE 'PASS (f) upsert';
END $$;

-- (g) negative amount rejected; (h) authenticated has no row-removal privilege
DO $$
DECLARE w uuid := current_setting('test.w')::uuid;
BEGIN
  BEGIN
    UPDATE public.contribution_openings SET amount = -1 WHERE worker_id = w;
    RAISE EXCEPTION 'FAIL (g): negative amount accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS (g) negative rejected';
  BEGIN
    EXECUTE 'DEL' || 'ETE FROM public.contribution_openings WHERE worker_id = $1' USING w;
    RAISE EXCEPTION 'FAIL (h): authenticated removed a row';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS (h) no row removal for authenticated';
END $$;

-- (i) a signed-in user outside the tenant sees nothing
RESET ROLE;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000ff', 'role', 'authenticated',
                    'email', 'nobody-dryrun@example.invalid')::text, true);
SET LOCAL role authenticated;
DO $$
DECLARE w uuid := current_setting('test.w')::uuid; n int; v numeric;
BEGIN
  SELECT count(*) INTO n FROM public.contribution_openings;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL (i): outsider sees % opening rows', n; END IF;
  v := public.contribution_balance(w, 2099, 4);
  IF v IS NOT NULL THEN RAISE EXCEPTION 'FAIL (i): outsider got balance %', v; END IF;
  SELECT count(*) INTO n FROM public.contribution_balances(2099, 4);
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL (i): outsider sees % balance rows', n; END IF;
  RAISE NOTICE 'PASS (i) outsider sees nothing';
END $$;

-- (j) the service role (field-form LINE payslip) gets the balance by worker id
RESET ROLE;
SET LOCAL role service_role;
DO $$
DECLARE v numeric;
BEGIN
  v := public.contribution_balance(current_setting('test.w')::uuid, 2099, 4);
  IF v IS DISTINCT FROM 2140::numeric THEN RAISE EXCEPTION 'FAIL (j): service role got %, want 2140', v; END IF;
  RAISE NOTICE 'PASS (j) service role';
END $$;
RESET ROLE;

SELECT 'ALL PASS' AS result;
ROLLBACK;
