-- Self-contained dry run for 2026-10-20-11 repair tickets (no placeholders). Paste into the Supabase SQL Editor; everything rolls back.
BEGIN;

-- ===== inlined migration 2026-10-20-11 =====
-- 2026-10-20-11: repair tickets (งานซ่อม). Tables repair_tickets / repair_ticket_media (admin/owner RLS),
-- customer_line_repair_sessions and customer_push_log (service role only), the private bucket repair-media,
-- worker_assignments.repair_ticket_id, the per-tenant daily customer push budget, and the 'repair_pending'
-- key on pending_counts() (copied from the LIVE definition 2026-10-20, one new key only).

CREATE TABLE public.repair_tickets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  ticket_number       text NOT NULL,
  site_id             uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  client_id           uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  source              text NOT NULL DEFAULT 'staff' CHECK (source IN ('line','staff')),
  line_user_id        text,
  status              text NOT NULL DEFAULT 'pending_review'
                      CHECK (status IN ('pending_review','received','scheduled','in_progress','done','declined')),
  description         text,
  scheduled_date      date,
  scheduled_start     time,
  duration_hours      numeric,
  fix_note            text,
  received_at         timestamptz,
  scheduled_at        timestamptz,
  started_at          timestamptz,
  done_at             timestamptz,
  declined_at         timestamptz,
  notified_schedule_at timestamptz,
  reminded_at         timestamptz,
  reported_at         timestamptz,
  created_by          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, ticket_number)
);

CREATE INDEX repair_tickets_tenant_status ON public.repair_tickets (tenant_id, status);
CREATE INDEX repair_tickets_tenant_site ON public.repair_tickets (tenant_id, site_id);

CREATE OR REPLACE FUNCTION public.generate_repair_ticket_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  year_month text := TO_CHAR((now() AT TIME ZONE 'Asia/Bangkok'), 'YYMM');
  seq_num    int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('repair_ticket_number:' || NEW.tenant_id::text));
  SELECT COALESCE(MAX(SUBSTRING(ticket_number FROM 'RP\d{4}-(\d+)$')::int), 0) + 1
    INTO seq_num
    FROM public.repair_tickets
   WHERE tenant_id = NEW.tenant_id
     AND ticket_number LIKE 'RP' || year_month || '-%';
  NEW.ticket_number := 'RP' || year_month || '-' || LPAD(seq_num::text, 3, '0');
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.generate_repair_ticket_number() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER repair_tickets_set_number
  BEFORE INSERT ON public.repair_tickets
  FOR EACH ROW EXECUTE FUNCTION public.generate_repair_ticket_number();

CREATE OR REPLACE FUNCTION public.repair_tickets_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.repair_tickets_touch_updated_at() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER repair_tickets_updated_at
  BEFORE UPDATE ON public.repair_tickets
  FOR EACH ROW EXECUTE FUNCTION public.repair_tickets_touch_updated_at();

CREATE TABLE public.repair_ticket_media (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  ticket_id    uuid NOT NULL REFERENCES public.repair_tickets(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('customer','before','after')),
  media_type   text NOT NULL CHECK (media_type IN ('image','video','file')),
  storage_path text NOT NULL,
  file_name    text,
  mime         text,
  size_bytes   bigint,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX repair_ticket_media_ticket ON public.repair_ticket_media (tenant_id, ticket_id);

ALTER TABLE public.repair_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.repair_ticket_media ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.repair_tickets FROM anon, authenticated;
REVOKE ALL ON public.repair_ticket_media FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.repair_tickets TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.repair_ticket_media TO authenticated;

CREATE POLICY admin_select ON public.repair_tickets FOR SELECT TO authenticated
  USING ((SELECT is_admin_or_owner()) AND tenant_id = (SELECT current_tenant_id()));

CREATE POLICY admin_insert ON public.repair_tickets FOR INSERT TO authenticated
  WITH CHECK ((SELECT is_admin_or_owner()) AND tenant_id = (SELECT current_tenant_id()) AND (SELECT tenant_can_write()));

CREATE POLICY admin_update ON public.repair_tickets FOR UPDATE TO authenticated
  USING ((SELECT is_admin_or_owner()) AND tenant_id = (SELECT current_tenant_id()) AND (SELECT tenant_can_write()))
  WITH CHECK ((SELECT is_admin_or_owner()) AND tenant_id = (SELECT current_tenant_id()) AND (SELECT tenant_can_write()));

CREATE POLICY admin_delete ON public.repair_tickets FOR DELETE TO authenticated
  USING ((SELECT is_admin_or_owner()) AND tenant_id = (SELECT current_tenant_id()) AND (SELECT tenant_can_write()));

CREATE POLICY admin_select ON public.repair_ticket_media FOR SELECT TO authenticated
  USING ((SELECT is_admin_or_owner()) AND tenant_id = (SELECT current_tenant_id()));

CREATE POLICY admin_insert ON public.repair_ticket_media FOR INSERT TO authenticated
  WITH CHECK ((SELECT is_admin_or_owner()) AND tenant_id = (SELECT current_tenant_id()) AND (SELECT tenant_can_write()));

CREATE POLICY admin_update ON public.repair_ticket_media FOR UPDATE TO authenticated
  USING ((SELECT is_admin_or_owner()) AND tenant_id = (SELECT current_tenant_id()) AND (SELECT tenant_can_write()))
  WITH CHECK ((SELECT is_admin_or_owner()) AND tenant_id = (SELECT current_tenant_id()) AND (SELECT tenant_can_write()));

CREATE POLICY admin_delete ON public.repair_ticket_media FOR DELETE TO authenticated
  USING ((SELECT is_admin_or_owner()) AND tenant_id = (SELECT current_tenant_id()) AND (SELECT tenant_can_write()));

CREATE TABLE public.customer_line_repair_sessions (
  tenant_id    uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  line_user_id text NOT NULL,
  ticket_id    uuid NOT NULL REFERENCES public.repair_tickets(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, line_user_id)
);

ALTER TABLE public.customer_line_repair_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_line_repair_sessions FROM anon, authenticated;

ALTER TABLE public.worker_assignments
  ADD COLUMN repair_ticket_id uuid REFERENCES public.repair_tickets(id) ON DELETE SET NULL;

CREATE INDEX worker_assignments_repair_ticket ON public.worker_assignments (repair_ticket_id)
  WHERE repair_ticket_id IS NOT NULL;

INSERT INTO storage.buckets (id, name, public) VALUES ('repair-media', 'repair-media', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY repair_media_tenant_access ON storage.objects FOR ALL TO authenticated
  USING ((bucket_id = 'repair-media'::text) AND is_admin_or_owner() AND ((storage.foldername(name))[1] = (current_tenant_id())::text))
  WITH CHECK ((bucket_id = 'repair-media'::text) AND is_admin_or_owner() AND tenant_can_write() AND ((storage.foldername(name))[1] = (current_tenant_id())::text));

CREATE TABLE public.customer_push_log (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  day       date NOT NULL,
  n         int NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);

ALTER TABLE public.customer_push_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_push_log FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.consume_customer_push(p_tenant uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH claimed AS (
    INSERT INTO public.customer_push_log AS l (tenant_id, day, n)
    VALUES (p_tenant, (now() AT TIME ZONE 'Asia/Bangkok')::date, 1)
    ON CONFLICT (tenant_id, day) DO UPDATE SET n = l.n + 1
      WHERE l.n < 100
    RETURNING true AS ok
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$;

REVOKE ALL ON FUNCTION public.consume_customer_push(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_customer_push(uuid) TO service_role;

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
           ELSE 0 END,
    'repair_pending',
      CASE WHEN is_admin_or_owner()
           THEN (SELECT count(*) FROM repair_tickets
                  WHERE tenant_id = current_tenant_id() AND status = 'pending_review')
           ELSE 0 END
  );
$function$;

-- ===== assertions =====
DO $$
DECLARE
  v_tenant uuid := '8b61c890-0a90-4223-91d3-b5f8f4e89908';
  v_other uuid;
  v_other_email text;
  v_site uuid; v_site2 uuid; v_t1 uuid; v_t2 uuid; v_t3 uuid; v_t4 uuid; v_worker uuid; v_wa uuid;
  n1 text; n2 text; n3 text; k text; i int; r boolean; cnt jsonb; n int; ra uuid;
BEGIN
  SELECT t.id, ur.user_email INTO v_other, v_other_email
    FROM tenants t JOIN user_roles ur ON ur.tenant_id = t.id AND ur.role = 'OWNER'
   WHERE t.id <> v_tenant LIMIT 1;
  IF v_other IS NULL THEN RAISE EXCEPTION 'SETUP: no second tenant with an owner'; END IF;

  INSERT INTO sites (tenant_id, site_number, name) VALUES (v_tenant, 'ZZR-A', 'ZZ repair A') RETURNING id INTO v_site;
  INSERT INTO sites (tenant_id, site_number, name) VALUES (v_other, 'ZZR-B', 'ZZ repair B') RETURNING id INTO v_site2;

  INSERT INTO repair_tickets (tenant_id, site_id, description) VALUES (v_tenant, v_site, 'one') RETURNING id, ticket_number INTO v_t1, n1;
  INSERT INTO repair_tickets (tenant_id, site_id, description) VALUES (v_tenant, v_site, 'two') RETURNING id, ticket_number INTO v_t2, n2;
  INSERT INTO repair_tickets (tenant_id, site_id, description) VALUES (v_other, v_site2, 'other') RETURNING id, ticket_number INTO v_t4, n3;
  IF n1 !~ '^RP[0-9]{4}-001$' OR n2 <> regexp_replace(n1, '001$', '002') THEN RAISE EXCEPTION 'FAIL (a): % then %', n1, n2; END IF;
  IF n3 <> regexp_replace(n1, '001$', '001') OR n3 !~ '-001$' THEN RAISE EXCEPTION 'FAIL (a): other tenant got %', n3; END IF;
  IF n1 <> 'RP' || TO_CHAR((now() AT TIME ZONE 'Asia/Bangkok'), 'YYMM') || '-001' THEN RAISE EXCEPTION 'FAIL (a): month part of %', n1; END IF;
  RAISE NOTICE 'PASS (a)';

  BEGIN
    INSERT INTO repair_tickets (tenant_id, site_id, status) VALUES (v_tenant, v_site, 'bogus');
    RAISE EXCEPTION 'FAIL (b): bad status accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  RAISE NOTICE 'PASS (b)';

  INSERT INTO repair_tickets (tenant_id, site_id, status) VALUES (v_tenant, v_site, 'received') RETURNING id INTO v_t3;
  PERFORM set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-000000000001','role','authenticated','email','demo-owner@facadex.co.th')::text, true);
  EXECUTE 'SET LOCAL role authenticated';
  cnt := pending_counts();
  EXECUTE 'RESET ROLE';
  IF (cnt->>'repair_pending')::int <> 2 THEN RAISE EXCEPTION 'FAIL (c): repair_pending % expected 2', cnt->>'repair_pending'; END IF;
  FOREACH k IN ARRAY ARRAY['leave_pending','po_draft','issues_open','cheques_due','quotations_followup','offboarded_in_group','advances_pending','customer_requests_open','warranty_followup','repair_pending'] LOOP
    IF NOT (cnt ? k) THEN RAISE EXCEPTION 'FAIL (c): missing key %', k; END IF;
  END LOOP;
  RAISE NOTICE 'PASS (c)';

  FOR i IN 1..100 LOOP
    r := consume_customer_push(v_tenant);
    IF NOT r THEN RAISE EXCEPTION 'FAIL (d): call % returned false', i; END IF;
  END LOOP;
  IF consume_customer_push(v_tenant) THEN RAISE EXCEPTION 'FAIL (d): call 101 returned true'; END IF;
  IF NOT consume_customer_push(v_other) THEN RAISE EXCEPTION 'FAIL (d): other tenant budget shared'; END IF;
  SELECT l.n INTO n FROM customer_push_log l WHERE l.tenant_id = v_tenant;
  IF n <> 100 THEN RAISE EXCEPTION 'FAIL (d): counter % expected 100', n; END IF;
  EXECUTE 'SET LOCAL role authenticated';
  BEGIN
    PERFORM consume_customer_push(v_tenant);
    EXECUTE 'RESET ROLE';
    RAISE EXCEPTION 'FAIL (d): authenticated may execute consume_customer_push';
  EXCEPTION WHEN insufficient_privilege THEN
    EXECUTE 'RESET ROLE';
  END;
  RAISE NOTICE 'PASS (d)';

  EXECUTE 'SET LOCAL role authenticated';
  BEGIN
    PERFORM 1 FROM customer_line_repair_sessions;
    EXECUTE 'RESET ROLE';
    RAISE EXCEPTION 'FAIL (e): sessions readable';
  EXCEPTION WHEN insufficient_privilege THEN
    EXECUTE 'RESET ROLE';
  END;
  EXECUTE 'SET LOCAL role authenticated';
  BEGIN
    PERFORM 1 FROM customer_push_log;
    EXECUTE 'RESET ROLE';
    RAISE EXCEPTION 'FAIL (e): push log readable';
  EXCEPTION WHEN insufficient_privilege THEN
    EXECUTE 'RESET ROLE';
  END;
  RAISE NOTICE 'PASS (e)';

  INSERT INTO workers (tenant_id, name, monthly_salary) VALUES (v_tenant, 'ZZ Repair Worker', 0) RETURNING id INTO v_worker;
  INSERT INTO worker_assignments (tenant_id, worker_id, site_id, date, repair_ticket_id)
    VALUES (v_tenant, v_worker, v_site, DATE '2026-12-01', v_t1) RETURNING id INTO v_wa;
  DELETE FROM repair_tickets WHERE id = v_t1;
  SELECT repair_ticket_id INTO ra FROM worker_assignments WHERE id = v_wa;
  IF ra IS NOT NULL THEN RAISE EXCEPTION 'FAIL (f): repair_ticket_id not nulled'; END IF;
  IF NOT EXISTS (SELECT 1 FROM worker_assignments WHERE id = v_wa) THEN RAISE EXCEPTION 'FAIL (f): assignment deleted'; END IF;
  RAISE NOTICE 'PASS (f)';

  PERFORM set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-000000000002','role','authenticated','email',v_other_email)::text, true);
  EXECUTE 'SET LOCAL role authenticated';
  SELECT count(*) INTO n FROM repair_tickets WHERE id IN (v_t2, v_t3);
  EXECUTE 'RESET ROLE';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL (g): other tenant sees % demo tickets', n; END IF;
  EXECUTE 'SET LOCAL role authenticated';
  SELECT count(*) INTO n FROM repair_tickets WHERE id = v_t4;
  EXECUTE 'RESET ROLE';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL (g): other owner cannot see own ticket'; END IF;
  RAISE NOTICE 'PASS (g)';
END $$;

SELECT 'ALL PASS' AS result;
ROLLBACK;
