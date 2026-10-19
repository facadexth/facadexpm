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
     AND wa.repair_ticket_id IS DISTINCT FROM p_ticket;
  IF jsonb_array_length(v_conflict) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'conflicts', v_conflict);
  END IF;

  -- Own future rows outside the wanted set are dropped; a checked-in one blocks the whole save.
  IF EXISTS (
    SELECT 1 FROM public.worker_assignments wa
     WHERE wa.tenant_id = t.tenant_id AND wa.repair_ticket_id = p_ticket AND wa.date >= v_today
       AND wa.confirmed_at IS NOT NULL
       AND NOT (wa.date = p_date AND wa.worker_id = ANY(v_workers) AND wa.shift = ANY(p_shifts))
  ) THEN
    RAISE EXCEPTION 'มีช่างเช็คอินแล้ว ลบไม่ได้';
  END IF;

  DELETE FROM public.worker_assignments wa
   WHERE wa.tenant_id = t.tenant_id AND wa.repair_ticket_id = p_ticket AND wa.date >= v_today
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
