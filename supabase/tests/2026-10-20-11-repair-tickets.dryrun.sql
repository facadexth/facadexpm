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
  site_id             uuid NOT NULL REFERENCES public.sites(id) ON DELETE RESTRICT,
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
CREATE UNIQUE INDEX repair_ticket_media_path ON public.repair_ticket_media (tenant_id, storage_path);

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

-- Assign.jsx and HR.jsx upsert worker_assignments ON CONFLICT (worker_id, date, shift) without sending
-- repair_ticket_id, so a repair crew row they turn into leave or another site would keep its repair link,
-- and a later reschedule/decline of the repair would then delete that leave/other-site row. Clear the link
-- whenever the row's site or type changes, unless the same UPDATE set repair_ticket_id itself.
CREATE OR REPLACE FUNCTION public.worker_assignments_clear_stale_repair_link()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.repair_ticket_id IS NOT NULL
     AND (NEW.site_id IS DISTINCT FROM OLD.site_id OR NEW.type IS DISTINCT FROM OLD.type)
     AND NEW.repair_ticket_id IS NOT DISTINCT FROM OLD.repair_ticket_id THEN
    NEW.repair_ticket_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER worker_assignments_clear_stale_repair_link
  BEFORE UPDATE ON public.worker_assignments
  FOR EACH ROW EXECUTE FUNCTION public.worker_assignments_clear_stale_repair_link();

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

-- Ruling R28: the staff "บันทึกนัด" save is one atomic call. SECURITY INVOKER, so the caller's own RLS on
-- repair_tickets (admin/owner, tenant, tenant_can_write) and worker_assignments (payroll module) applies.
-- Locks the ticket, checks crew conflicts (any other assignment of those workers in those shifts that day),
-- then diffs this ticket's own future rows: keeps the wanted (worker, shift) pairs, deletes the rest (never a
-- checked-in row), inserts the missing pairs, and updates the ticket. Conflicts return {ok:false} unwritten.
CREATE OR REPLACE FUNCTION public.schedule_repair_ticket(
  p_ticket uuid, p_expected_status text, p_date date, p_start time, p_hours numeric,
  p_worker_ids uuid[], p_shifts text[], p_notify boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  t          public.repair_tickets%ROWTYPE;
  v_today    date := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  v_workers  uuid[];
  v_conflict jsonb;
  v_deleted  int;
  v_inserted int;
BEGIN
  SELECT * INTO t FROM public.repair_tickets
   WHERE id = p_ticket AND tenant_id = current_tenant_id()
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบงานซ่อมนี้'; END IF;
  IF t.status IS DISTINCT FROM p_expected_status THEN
    RAISE EXCEPTION 'งานซ่อมนี้ถูกเปลี่ยนสถานะไปแล้ว ปิดแล้วเปิดใหม่อีกครั้ง';
  END IF;
  IF t.status NOT IN ('received', 'scheduled', 'in_progress') THEN
    RAISE EXCEPTION 'สถานะนี้นัดวันไม่ได้';
  END IF;

  IF p_shifts IS NULL OR cardinality(p_shifts) = 0 OR NOT (p_shifts <@ ARRAY['morning', 'evening']) THEN
    RAISE EXCEPTION 'กะไม่ถูกต้อง';
  END IF;
  IF p_date IS NULL OR p_date < v_today THEN RAISE EXCEPTION 'วันที่เข้าต้องไม่ก่อนวันนี้'; END IF;
  IF p_start IS NULL THEN RAISE EXCEPTION 'กรุณาระบุเวลาเริ่ม'; END IF;
  IF p_hours IS NULL OR p_hours <= 0 THEN RAISE EXCEPTION 'ระยะเวลาต้องมากกว่า 0 ชม.'; END IF;

  SELECT COALESCE(array_agg(DISTINCT w), '{}') INTO v_workers FROM unnest(COALESCE(p_worker_ids, '{}'::uuid[])) w;
  IF (SELECT count(*) FROM public.workers WHERE id = ANY(v_workers) AND tenant_id = t.tenant_id) <> cardinality(v_workers) THEN
    RAISE EXCEPTION 'ไม่พบช่างบางคนในบริษัทนี้';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('worker_id', wa.worker_id, 'shift', wa.shift) ORDER BY wa.worker_id, wa.shift), '[]'::jsonb)
    INTO v_conflict
    FROM public.worker_assignments wa
   WHERE wa.tenant_id = t.tenant_id
     AND wa.worker_id = ANY(v_workers)
     AND wa.date = p_date
     AND wa.shift = ANY(p_shifts)
     AND NOT COALESCE(wa.repair_ticket_id = p_ticket AND wa.type = 'site' AND wa.site_id = t.site_id, false);
  IF jsonb_array_length(v_conflict) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'conflicts', v_conflict);
  END IF;

  -- Own future rows outside the wanted set are dropped; a checked-in one blocks the whole save.
  -- "Own" = linked to this ticket AND still a site row at the ticket's site (never a leave/other-site row).
  IF EXISTS (
    SELECT 1 FROM public.worker_assignments wa
     WHERE wa.tenant_id = t.tenant_id AND wa.repair_ticket_id = p_ticket AND wa.date >= v_today
       AND wa.type = 'site' AND wa.site_id = t.site_id
       AND wa.confirmed_at IS NOT NULL
       AND NOT (wa.date = p_date AND wa.worker_id = ANY(v_workers) AND wa.shift = ANY(p_shifts))
  ) THEN
    RAISE EXCEPTION 'มีช่างเช็คอินแล้ว ลบไม่ได้';
  END IF;

  DELETE FROM public.worker_assignments wa
   WHERE wa.tenant_id = t.tenant_id AND wa.repair_ticket_id = p_ticket AND wa.date >= v_today
     AND wa.type = 'site' AND wa.site_id = t.site_id
     AND NOT (wa.date = p_date AND wa.worker_id = ANY(v_workers) AND wa.shift = ANY(p_shifts));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  INSERT INTO public.worker_assignments (tenant_id, worker_id, site_id, date, shift, type, notes, repair_ticket_id)
  SELECT t.tenant_id, w.id, t.site_id, p_date, s.shift, 'site', 'งานซ่อม ' || t.ticket_number, p_ticket
    FROM unnest(v_workers) AS w(id)
   CROSS JOIN (SELECT DISTINCT unnest(p_shifts) AS shift) s
   WHERE NOT EXISTS (
     SELECT 1 FROM public.worker_assignments wa
      WHERE wa.worker_id = w.id AND wa.date = p_date AND wa.shift = s.shift);
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  UPDATE public.repair_tickets SET
    scheduled_date = p_date,
    scheduled_start = p_start,
    duration_hours = p_hours,
    -- now() = reminder "suppressed": the 13:00 cron only reminds rows with reminded_at IS NULL.
    reminded_at = CASE WHEN p_notify IS NOT TRUE THEN now()
                       WHEN p_date IS DISTINCT FROM t.scheduled_date THEN NULL
                       ELSE reminded_at END,
    status = CASE WHEN t.status = 'received' THEN 'scheduled' ELSE status END,
    scheduled_at = CASE WHEN t.status = 'received' THEN now() ELSE scheduled_at END,
    received_at = CASE WHEN t.status = 'received' THEN COALESCE(received_at, now()) ELSE received_at END
   WHERE id = p_ticket;
  IF NOT FOUND THEN RAISE EXCEPTION 'บันทึกไม่ได้ (สิทธิ์หรือแพ็กเกจหมดอายุ)'; END IF;

  RETURN jsonb_build_object('ok', true, 'deleted', v_deleted, 'inserted', v_inserted,
    'status', CASE WHEN t.status = 'received' THEN 'scheduled' ELSE t.status END);
END;
$$;

REVOKE ALL ON FUNCTION public.schedule_repair_ticket(uuid, text, date, time, numeric, uuid[], text[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.schedule_repair_ticket(uuid, text, date, time, numeric, uuid[], text[], boolean) TO authenticated;

-- ===== assertions =====
DO $$
DECLARE
  v_tenant uuid := '8b61c890-0a90-4223-91d3-b5f8f4e89908';
  v_other uuid;
  v_other_email text;
  v_site uuid; v_site2 uuid; v_t1 uuid; v_t2 uuid; v_t3 uuid; v_t4 uuid; v_worker uuid; v_wa uuid;
  n1 text; n2 text; n3 text; k text; i int; r boolean; cnt jsonb; n int; ra uuid;
  v_w2 uuid; res jsonb; v_conf uuid; tk repair_tickets%ROWTYPE;
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

  SELECT id INTO v_worker FROM workers WHERE tenant_id = v_tenant LIMIT 1;
  IF v_worker IS NULL THEN
    INSERT INTO workers (tenant_id, name, monthly_salary) VALUES (v_tenant, 'ZZ Repair Worker', 0) RETURNING id INTO v_worker;
  END IF;
  INSERT INTO worker_assignments (tenant_id, worker_id, site_id, date, repair_ticket_id)
    VALUES (v_tenant, v_worker, v_site, DATE '2099-12-01', v_t1) RETURNING id INTO v_wa;
  DELETE FROM repair_tickets WHERE id = v_t1;
  SELECT repair_ticket_id INTO ra FROM worker_assignments WHERE id = v_wa;
  IF ra IS NOT NULL THEN RAISE EXCEPTION 'FAIL (f): repair_ticket_id not nulled'; END IF;
  IF NOT EXISTS (SELECT 1 FROM worker_assignments WHERE id = v_wa) THEN RAISE EXCEPTION 'FAIL (f): assignment deleted'; END IF;
  RAISE NOTICE 'PASS (f)';

  -- (i1) stale-link trigger: an Assign/HR-style upsert that turns a repair crew row into leave
  -- (site/type changed, repair_ticket_id not in the SET list) clears the repair link.
  INSERT INTO worker_assignments (tenant_id, worker_id, site_id, date, shift, type, repair_ticket_id)
    VALUES (v_tenant, v_worker, v_site, DATE '2099-11-10', 'morning', 'site', v_t2) RETURNING id INTO v_wa;
  UPDATE worker_assignments SET notes = 'touched' WHERE id = v_wa;
  IF (SELECT repair_ticket_id FROM worker_assignments WHERE id = v_wa) IS DISTINCT FROM v_t2 THEN
    RAISE EXCEPTION 'FAIL (i1): link cleared on an update that kept site and type';
  END IF;
  INSERT INTO worker_assignments (tenant_id, worker_id, site_id, date, shift, type)
    VALUES (v_tenant, v_worker, NULL, DATE '2099-11-10', 'morning', 'leave_sick')
    ON CONFLICT (worker_id, date, shift) DO UPDATE SET site_id = EXCLUDED.site_id, type = EXCLUDED.type;
  SELECT repair_ticket_id INTO ra FROM worker_assignments WHERE id = v_wa;
  IF ra IS NOT NULL THEN RAISE EXCEPTION 'FAIL (i1): leave row kept repair link %', ra; END IF;
  RAISE NOTICE 'PASS (i1)';

  -- (i2) an UPDATE that sets repair_ticket_id itself keeps it, even while changing site/type.
  UPDATE worker_assignments SET site_id = v_site, type = 'site', repair_ticket_id = v_t2 WHERE id = v_wa;
  SELECT repair_ticket_id INTO ra FROM worker_assignments WHERE id = v_wa;
  IF ra IS DISTINCT FROM v_t2 THEN RAISE EXCEPTION 'FAIL (i2): explicit link dropped (%)', ra; END IF;
  RAISE NOTICE 'PASS (i2)';

  -- (h) schedule_repair_ticket (R28), as the demo owner (claims from (c)). v_worker has a free
  -- morning row on 2099-12-01 from (f); v_t3 is 'received'.
  INSERT INTO workers (tenant_id, name, monthly_salary) VALUES (v_tenant, 'ZZ Repair Worker 2', 0) RETURNING id INTO v_w2;

  EXECUTE 'SET LOCAL role authenticated';
  res := schedule_repair_ticket(v_t3, 'received', DATE '2099-12-01', TIME '09:00', 2, ARRAY[v_worker], ARRAY['morning'], true);
  EXECUTE 'RESET ROLE';
  IF (res->>'ok')::boolean OR jsonb_array_length(res->'conflicts') <> 1
     OR res->'conflicts'->0->>'worker_id' <> v_worker::text OR res->'conflicts'->0->>'shift' <> 'morning' THEN
    RAISE EXCEPTION 'FAIL (h1): conflict result %', res;
  END IF;
  SELECT * INTO tk FROM repair_tickets WHERE id = v_t3;
  IF tk.status <> 'received' OR tk.scheduled_date IS NOT NULL THEN RAISE EXCEPTION 'FAIL (h1): ticket written on conflict'; END IF;
  IF EXISTS (SELECT 1 FROM worker_assignments WHERE repair_ticket_id = v_t3) THEN RAISE EXCEPTION 'FAIL (h1): rows written on conflict'; END IF;
  RAISE NOTICE 'PASS (h1)';

  EXECUTE 'SET LOCAL role authenticated';
  res := schedule_repair_ticket(v_t3, 'received', DATE '2099-12-02', TIME '10:00', 3, ARRAY[v_worker, v_w2, v_w2], ARRAY['morning','evening'], true);
  EXECUTE 'RESET ROLE';
  IF NOT (res->>'ok')::boolean OR (res->>'inserted')::int <> 4 OR res->>'status' <> 'scheduled' THEN RAISE EXCEPTION 'FAIL (h2): %', res; END IF;
  SELECT * INTO tk FROM repair_tickets WHERE id = v_t3;
  IF tk.status <> 'scheduled' OR tk.scheduled_at IS NULL OR tk.received_at IS NULL OR tk.reminded_at IS NOT NULL
     OR tk.scheduled_date <> DATE '2099-12-02' OR tk.scheduled_start <> TIME '10:00' OR tk.duration_hours <> 3 THEN
    RAISE EXCEPTION 'FAIL (h2): ticket %', row_to_json(tk);
  END IF;
  SELECT count(*) INTO n FROM worker_assignments
   WHERE repair_ticket_id = v_t3 AND tenant_id = v_tenant AND site_id = v_site AND type = 'site'
     AND date = DATE '2099-12-02' AND notes = 'งานซ่อม ' || tk.ticket_number;
  IF n <> 4 THEN RAISE EXCEPTION 'FAIL (h2): % rows', n; END IF;
  RAISE NOTICE 'PASS (h2)';

  EXECUTE 'SET LOCAL role authenticated';
  BEGIN
    res := schedule_repair_ticket(v_t3, 'received', DATE '2099-12-02', TIME '10:00', 3, ARRAY[v_worker], ARRAY['morning'], true);
    EXECUTE 'RESET ROLE';
    RAISE EXCEPTION 'FAIL (h3): stale expected status accepted';
  EXCEPTION WHEN raise_exception THEN
    EXECUTE 'RESET ROLE';
    IF SQLERRM LIKE 'FAIL%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'PASS (h3)';

  -- (h4) diff keeps the wanted checked-in row, drops the rest; notify off suppresses the reminder.
  UPDATE worker_assignments SET confirmed_at = now()
   WHERE repair_ticket_id = v_t3 AND worker_id = v_worker AND shift = 'morning' RETURNING id INTO v_conf;
  EXECUTE 'SET LOCAL role authenticated';
  res := schedule_repair_ticket(v_t3, 'scheduled', DATE '2099-12-02', TIME '09:00', 2, ARRAY[v_worker], ARRAY['morning'], false);
  EXECUTE 'RESET ROLE';
  IF NOT (res->>'ok')::boolean OR (res->>'deleted')::int <> 3 OR (res->>'inserted')::int <> 0 THEN RAISE EXCEPTION 'FAIL (h4): %', res; END IF;
  IF NOT EXISTS (SELECT 1 FROM worker_assignments WHERE id = v_conf AND confirmed_at IS NOT NULL) THEN RAISE EXCEPTION 'FAIL (h4): kept row replaced'; END IF;
  SELECT count(*) INTO n FROM worker_assignments WHERE repair_ticket_id = v_t3;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL (h4): % rows left', n; END IF;
  SELECT * INTO tk FROM repair_tickets WHERE id = v_t3;
  IF tk.reminded_at IS NULL OR tk.status <> 'scheduled' THEN RAISE EXCEPTION 'FAIL (h4): reminder not suppressed / status %', tk.status; END IF;
  RAISE NOTICE 'PASS (h4)';

  -- (h5) moving away from a checked-in row is refused and nothing changes.
  EXECUTE 'SET LOCAL role authenticated';
  BEGIN
    res := schedule_repair_ticket(v_t3, 'scheduled', DATE '2099-12-03', TIME '09:00', 2, ARRAY[v_worker], ARRAY['morning'], true);
    EXECUTE 'RESET ROLE';
    RAISE EXCEPTION 'FAIL (h5): checked-in row dropped';
  EXCEPTION WHEN raise_exception THEN
    EXECUTE 'RESET ROLE';
    IF SQLERRM NOT LIKE 'มีช่างเช็คอินแล้ว%' THEN RAISE; END IF;
  END;
  IF NOT EXISTS (SELECT 1 FROM worker_assignments WHERE id = v_conf) THEN RAISE EXCEPTION 'FAIL (h5): row gone'; END IF;
  IF (SELECT scheduled_date FROM repair_tickets WHERE id = v_t3) <> DATE '2099-12-02' THEN RAISE EXCEPTION 'FAIL (h5): ticket moved'; END IF;
  RAISE NOTICE 'PASS (h5)';

  -- (h6) bad shifts and a past date are refused.
  EXECUTE 'SET LOCAL role authenticated';
  BEGIN
    res := schedule_repair_ticket(v_t3, 'scheduled', DATE '2099-12-02', TIME '09:00', 2, ARRAY[v_worker], ARRAY['night'], true);
    EXECUTE 'RESET ROLE';
    RAISE EXCEPTION 'FAIL (h6): bad shift accepted';
  EXCEPTION WHEN raise_exception THEN
    EXECUTE 'RESET ROLE';
    IF SQLERRM LIKE 'FAIL%' THEN RAISE; END IF;
  END;
  EXECUTE 'SET LOCAL role authenticated';
  BEGIN
    res := schedule_repair_ticket(v_t3, 'scheduled', DATE '2000-01-01', TIME '09:00', 2, '{}'::uuid[], ARRAY['morning'], true);
    EXECUTE 'RESET ROLE';
    RAISE EXCEPTION 'FAIL (h6): past date accepted';
  EXCEPTION WHEN raise_exception THEN
    EXECUTE 'RESET ROLE';
    IF SQLERRM LIKE 'FAIL%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'PASS (h6)';

  -- (h7) a new date with notify on clears reminded_at; an empty crew is allowed (removes unconfirmed own rows).
  UPDATE worker_assignments SET confirmed_at = NULL WHERE id = v_conf;
  EXECUTE 'SET LOCAL role authenticated';
  res := schedule_repair_ticket(v_t3, 'scheduled', DATE '2099-12-04', TIME '13:00', 1, '{}'::uuid[], ARRAY['evening'], true);
  EXECUTE 'RESET ROLE';
  IF NOT (res->>'ok')::boolean OR (res->>'deleted')::int <> 1 THEN RAISE EXCEPTION 'FAIL (h7): %', res; END IF;
  SELECT * INTO tk FROM repair_tickets WHERE id = v_t3;
  IF tk.reminded_at IS NOT NULL OR tk.scheduled_date <> DATE '2099-12-04' THEN RAISE EXCEPTION 'FAIL (h7): ticket %', row_to_json(tk); END IF;
  IF EXISTS (SELECT 1 FROM worker_assignments WHERE repair_ticket_id = v_t3) THEN RAISE EXCEPTION 'FAIL (h7): rows left'; END IF;
  RAISE NOTICE 'PASS (h7)';

  -- (i3) RPC belt and braces: a leave row still carrying this ticket's link (INSERT skips the update
  -- trigger) is not "own": it counts as a conflict and is never deleted.
  INSERT INTO worker_assignments (tenant_id, worker_id, site_id, date, shift, type, repair_ticket_id)
    VALUES (v_tenant, v_w2, NULL, DATE '2099-12-04', 'morning', 'leave_sick', v_t3) RETURNING id INTO v_wa;
  EXECUTE 'SET LOCAL role authenticated';
  res := schedule_repair_ticket(v_t3, 'scheduled', DATE '2099-12-04', TIME '13:00', 1, ARRAY[v_w2], ARRAY['morning'], true);
  EXECUTE 'RESET ROLE';
  IF (res->>'ok')::boolean OR jsonb_array_length(res->'conflicts') <> 1 THEN RAISE EXCEPTION 'FAIL (i3): stale leave row not a conflict: %', res; END IF;
  EXECUTE 'SET LOCAL role authenticated';
  res := schedule_repair_ticket(v_t3, 'scheduled', DATE '2099-12-05', TIME '13:00', 1, '{}'::uuid[], ARRAY['evening'], true);
  EXECUTE 'RESET ROLE';
  IF NOT (res->>'ok')::boolean OR (res->>'deleted')::int <> 0 THEN RAISE EXCEPTION 'FAIL (i3): %', res; END IF;
  IF NOT EXISTS (SELECT 1 FROM worker_assignments WHERE id = v_wa AND type = 'leave_sick') THEN
    RAISE EXCEPTION 'FAIL (i3): leave row deleted by reschedule';
  END IF;
  RAISE NOTICE 'PASS (i3)';

  -- (h8) anon may not execute it.
  EXECUTE 'SET LOCAL role anon';
  BEGIN
    res := schedule_repair_ticket(v_t3, 'scheduled', DATE '2099-12-04', TIME '13:00', 1, '{}'::uuid[], ARRAY['evening'], true);
    EXECUTE 'RESET ROLE';
    RAISE EXCEPTION 'FAIL (h8): anon may execute schedule_repair_ticket';
  EXCEPTION WHEN insufficient_privilege THEN
    EXECUTE 'RESET ROLE';
  END;
  RAISE NOTICE 'PASS (h8)';

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
