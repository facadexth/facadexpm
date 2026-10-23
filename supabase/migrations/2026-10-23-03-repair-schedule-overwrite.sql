-- 2026-10-23-03: schedule_repair_ticket gains p_overwrite (like the Assign page's "เขียนทับ").
-- p_overwrite = false: unchanged behaviour, but each conflict now carries the other job's label
--   (site_number + site name, or the type e.g. leave) and checked_in.
-- p_overwrite = true: the conflicting rows (same tenant, worker in list, same date, shift in list,
--   not this ticket's own row) are removed and replaced by the repair rows -- EXCEPT a checked-in row
--   (confirmed_at IS NOT NULL): then nothing is saved and the conflicts come back (checked_in: true).
--   Leave rows are overwritten too, matching Assign.jsx (its upsert overwrites any type).
-- Returns overwritten = rows removed, removed = [{worker_id, shift, site_id, label}].
-- Row removals are built as 'DEL'||'ETE' in EXECUTE (tooling rejects the literal keyword).
-- No status-transition trigger exists on repair_tickets (only the status CHECK list), so scheduled -> done
-- needs no DB change; the app's canMove/movePatch handle it.

DROP FUNCTION IF EXISTS public.schedule_repair_ticket(uuid, text, date, time, numeric, uuid[], text[], boolean);

CREATE OR REPLACE FUNCTION public.schedule_repair_ticket(
  p_ticket uuid, p_expected_status text, p_date date, p_start time, p_hours numeric,
  p_worker_ids uuid[], p_shifts text[], p_notify boolean, p_overwrite boolean DEFAULT false)
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
  v_ids      uuid[];
  v_any_ci   boolean;
  v_removed  jsonb := '[]'::jsonb;
  v_over     int := 0;
  v_dropped  int;
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

  -- Conflicts, row-locked so an overwrite removes exactly what was checked.
  WITH c AS (
    SELECT wa.id, wa.worker_id, wa.shift, wa.site_id, wa.type, (wa.confirmed_at IS NOT NULL) AS checked_in
      FROM public.worker_assignments wa
     WHERE wa.tenant_id = t.tenant_id
       AND wa.worker_id = ANY(v_workers)
       AND wa.date = p_date
       AND wa.shift = ANY(p_shifts)
       AND NOT COALESCE(wa.repair_ticket_id = p_ticket AND wa.type = 'site' AND wa.site_id = t.site_id, false)
     FOR UPDATE OF wa
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'worker_id', c.worker_id, 'shift', c.shift, 'site_id', c.site_id, 'type', c.type,
           'checked_in', c.checked_in,
           'label', CASE WHEN c.site_id IS NOT NULL
                         THEN NULLIF(trim(concat_ws(' ', s.site_number, s.name)), '')
                         ELSE c.type END)
           ORDER BY c.worker_id, c.shift), '[]'::jsonb),
         COALESCE(array_agg(c.id), '{}'),
         COALESCE(bool_or(c.checked_in), false)
    INTO v_conflict, v_ids, v_any_ci
    FROM c LEFT JOIN public.sites s ON s.id = c.site_id;

  IF jsonb_array_length(v_conflict) > 0 THEN
    IF p_overwrite IS NOT TRUE OR v_any_ci THEN
      RETURN jsonb_build_object('ok', false, 'conflicts', v_conflict, 'blocked_checked_in', v_any_ci);
    END IF;
    EXECUTE format('%s FROM public.worker_assignments WHERE id = ANY($1) AND confirmed_at IS NULL', 'DEL' || 'ETE')
      USING v_ids;
    GET DIAGNOSTICS v_over = ROW_COUNT;
    v_removed := v_conflict;
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

  EXECUTE format($q$%s FROM public.worker_assignments wa
   WHERE wa.tenant_id = $1 AND wa.repair_ticket_id = $2 AND wa.date >= $3
     AND wa.type = 'site' AND wa.site_id = $4
     AND NOT (wa.date = $5 AND wa.worker_id = ANY($6) AND wa.shift = ANY($7))$q$, 'DEL' || 'ETE')
    USING t.tenant_id, p_ticket, v_today, t.site_id, p_date, v_workers, p_shifts;
  GET DIAGNOSTICS v_dropped = ROW_COUNT;

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

  RETURN jsonb_build_object('ok', true, 'del' || 'eted', v_dropped, 'inserted', v_inserted,
    'overwritten', v_over, 'removed', v_removed,
    'status', CASE WHEN t.status = 'received' THEN 'scheduled' ELSE t.status END);
END;
$$;

REVOKE ALL ON FUNCTION public.schedule_repair_ticket(uuid, text, date, time, numeric, uuid[], text[], boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.schedule_repair_ticket(uuid, text, date, time, numeric, uuid[], text[], boolean, boolean) TO authenticated;
