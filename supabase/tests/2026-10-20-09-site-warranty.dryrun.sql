-- Self-contained dry run for 2026-10-20-09 site warranty (no placeholders). Paste into the Supabase SQL Editor; everything rolls back.
BEGIN;

-- ===== inlined migration 2026-10-20-09 =====
-- 2026-10-20-09: site warranty. Adds warranty_months / handover_date / warranty_followup_at to sites,
-- backfills handover_date for Completed sites, makes the retention due date = warranty end date, and adds the
-- 'warranty_followup' key to pending_counts(). The view and pending_counts() are copied from the LIVE
-- definitions (2026-10-19); only due_date and the one new key changed.

ALTER TABLE public.sites
  ADD COLUMN warranty_months integer NOT NULL DEFAULT 12 CHECK (warranty_months BETWEEN 0 AND 120),
  ADD COLUMN handover_date date,
  ADD COLUMN warranty_followup_at timestamptz;

UPDATE public.sites SET handover_date = end_date
 WHERE status = 'Completed' AND handover_date IS NULL AND end_date IS NOT NULL;

UPDATE public.sites SET handover_date = DATE '2025-10-14'
 WHERE status = 'Completed' AND handover_date IS NULL;

CREATE OR REPLACE FUNCTION public.sites_warranty_followup_reset_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.handover_date IS DISTINCT FROM OLD.handover_date
     OR NEW.warranty_months IS DISTINCT FROM OLD.warranty_months THEN
    NEW.warranty_followup_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sites_warranty_followup_reset
  BEFORE UPDATE ON public.sites
  FOR EACH ROW EXECUTE FUNCTION public.sites_warranty_followup_reset_fn();

CREATE OR REPLACE VIEW public.site_retention_summary WITH (security_invoker = true) AS
 SELECT s.id AS site_id,
    s.site_number,
    s.name,
    s.end_date,
    s.default_retention_period_days,
    s.retention_released,
    s.retention_released_date,
    COALESCE(sum(i.retention), 0::numeric) AS total_retention,
        CASE
            WHEN s.handover_date IS NOT NULL AND s.warranty_months > 0 THEN (s.handover_date + make_interval(months => s.warranty_months))::date
            ELSE NULL::date
        END AS due_date
   FROM sites s
     LEFT JOIN incomes i ON i.site_id = s.id
  GROUP BY s.id, s.site_number, s.name, s.end_date, s.default_retention_period_days, s.retention_released, s.retention_released_date;

CREATE OR REPLACE FUNCTION public.pending_counts()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH today AS (
    SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date AS d
  ),
  cheque_window AS (
    SELECT COALESCE(
      (SELECT CASE WHEN value ~ '^[0-9]+$' THEN value::int END
         FROM app_settings WHERE key = 'cheque_reminder_days' LIMIT 1),
      3) AS n
  )
  SELECT jsonb_build_object(
    'leave_pending',
      (SELECT count(*) FROM leave_requests WHERE status = 'pending'),
    'po_draft',
      (SELECT count(*) FROM purchase_orders WHERE status = 'draft'),
    'issues_open',
      (SELECT count(*) FROM line_issue_reports WHERE status = 'open'),
    'cheques_due',
      (SELECT count(*) FROM cheques c, today, cheque_window w
        WHERE c.status <> 'cashed' AND c.check_date <= today.d + w.n),
    'quotations_followup',
      (SELECT count(*) FROM quotations q, today
        WHERE q.status = 'sent' AND NOT q.on_hold
          AND q.valid_until IS NOT NULL
          AND q.valid_until <= today.d + 7),
    'offboarded_in_group',
      (SELECT count(*) FROM workers w
        WHERE w.status = 'inactive' AND w.line_offboarding_alerted_at IS NOT NULL
          AND (w.line_group_removed_at IS NULL OR w.line_group_removed_at < w.line_offboarding_alerted_at)),
    'advances_pending',
      CASE WHEN is_admin_or_owner()
           THEN (SELECT count(*) FROM salary_advances
                  WHERE tenant_id = current_tenant_id() AND status = 'pending')
           ELSE 0 END,
    'customer_requests_open',
      CASE WHEN is_owner()
           THEN (SELECT count(*) FROM customer_line_requests
                  WHERE tenant_id = current_tenant_id() AND handled_at IS NULL)
           ELSE 0 END,
    'warranty_followup',
      CASE WHEN is_admin_or_owner()
           THEN (SELECT count(*) FROM sites s, today
                  WHERE s.tenant_id = current_tenant_id()
                    AND s.status = 'Completed'
                    AND s.handover_date IS NOT NULL
                    AND s.warranty_months > 0
                    AND s.warranty_followup_at IS NULL
                    AND (s.handover_date + make_interval(months => s.warranty_months))::date
                        BETWEEN today.d AND today.d + 30)
           ELSE 0 END
  );
$function$;

-- ===== end migration body =====

DO $t$
DECLARE
  v_tenant uuid := '8b61c890-0a90-4223-91d3-b5f8f4e89908';
  v_site uuid; v_site2 uuid; n int; n0 int; d date; f timestamptz; cnt jsonb; k text; opts text[];
  v_today date := (now() AT TIME ZONE 'Asia/Bangkok')::date;
BEGIN
  SELECT count(*) INTO n FROM sites WHERE status = 'Completed' AND handover_date IS NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL (a): % completed sites without handover_date', n; END IF;
  RAISE NOTICE 'PASS (a)';

  SELECT reloptions INTO opts FROM pg_class WHERE oid = 'public.site_retention_summary'::regclass;
  IF opts IS NULL OR NOT ('security_invoker=true' = ANY (opts)) THEN RAISE EXCEPTION 'FAIL (R1): security_invoker lost, reloptions=%', opts; END IF;
  RAISE NOTICE 'PASS (R1)';

  INSERT INTO sites (tenant_id, site_number, name, handover_date, warranty_months)
    VALUES (v_tenant, 'ZZW-A', 'ZZ warranty A', DATE '2026-01-31', 1) RETURNING id INTO v_site;
  SELECT due_date INTO d FROM site_retention_summary WHERE site_id = v_site;
  IF d IS DISTINCT FROM DATE '2026-02-28' THEN RAISE EXCEPTION 'FAIL (b): due_date %', d; END IF;
  RAISE NOTICE 'PASS (b)';

  UPDATE sites SET warranty_followup_at = now() WHERE id = v_site;
  SELECT warranty_followup_at INTO f FROM sites WHERE id = v_site;
  IF f IS NULL THEN RAISE EXCEPTION 'FAIL (c): followup was reset by an unrelated update'; END IF;
  UPDATE sites SET warranty_months = 2 WHERE id = v_site;
  SELECT warranty_followup_at INTO f FROM sites WHERE id = v_site;
  IF f IS NOT NULL THEN RAISE EXCEPTION 'FAIL (c): followup not reset'; END IF;
  RAISE NOTICE 'PASS (c)';

  PERFORM set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-000000000001','role','authenticated','email','demo-owner@facadex.co.th')::text, true);
  EXECUTE 'SET LOCAL role authenticated';
  SELECT (pending_counts()->>'warranty_followup')::int INTO n0;
  EXECUTE 'RESET ROLE';

  INSERT INTO sites (tenant_id, site_number, name, status, end_date, handover_date, warranty_months)
    VALUES (v_tenant, 'ZZW-B', 'ZZ warranty B', 'Completed', v_today + 10, (v_today + 10 - interval '1 month')::date, 1) RETURNING id INTO v_site2;

  EXECUTE 'SET LOCAL role authenticated';
  SELECT (pending_counts()->>'warranty_followup')::int INTO n;
  EXECUTE 'RESET ROLE';
  IF n <> n0 + 1 THEN RAISE EXCEPTION 'FAIL (d): expected % got %', n0 + 1, n; END IF;

  UPDATE sites SET warranty_months = 0 WHERE id = v_site2;
  EXECUTE 'SET LOCAL role authenticated';
  SELECT (pending_counts()->>'warranty_followup')::int INTO n;
  EXECUTE 'RESET ROLE';
  IF n <> n0 THEN RAISE EXCEPTION 'FAIL (d): zero-month site counted, got % expected %', n, n0; END IF;
  RAISE NOTICE 'PASS (d)';

  EXECUTE 'SET LOCAL role authenticated';
  cnt := pending_counts();
  EXECUTE 'RESET ROLE';
  FOREACH k IN ARRAY ARRAY['leave_pending','po_draft','issues_open','cheques_due','quotations_followup','offboarded_in_group','advances_pending','customer_requests_open','warranty_followup'] LOOP
    IF NOT (cnt ? k) THEN RAISE EXCEPTION 'FAIL (e): missing key %', k; END IF;
  END LOOP;
  RAISE NOTICE 'PASS (e)';
END
$t$;

SELECT 'ALL PASS' AS result;
ROLLBACK;
