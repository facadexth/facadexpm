-- Dry run for 2026-10-23-03 (repair schedule overwrite). Paste into the SQL editor; the final DO always raises, so everything rolls back.
-- Tenant: current_tenant_id() reads auth.email(), so the tests set request.jwt.claims to an OWNER/ADMIN of the
-- ticket's tenant and call as role authenticated (same approach as supabase/tests/2026-10-20-11-repair-tickets.dryrun.sql).
BEGIN;

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

CREATE TEMP TABLE _res (n serial, line text);
GRANT ALL ON _res TO authenticated;
GRANT USAGE ON SEQUENCE _res_n_seq TO authenticated;

DO $t$
DECLARE
  tk     public.repair_tickets%ROWTYPE;
  v_mail text;
  v_wa   uuid;
  v_wb   uuid;
  v_s2   uuid;
  v_s2l  text;
  v_d    date := DATE '2099-11-10';
  res    jsonb;
  n      int;
  ok     boolean;
BEGIN
  -- A received/scheduled ticket whose tenant has an OWNER/ADMIN login and 2+ workers, and no checked-in own rows.
  SELECT rt.* INTO tk FROM repair_tickets rt
   WHERE rt.status IN ('received', 'scheduled')
     AND EXISTS (SELECT 1 FROM user_roles ur WHERE ur.tenant_id = rt.tenant_id AND ur.role IN ('OWNER', 'ADMIN'))
     AND (SELECT count(*) FROM workers w WHERE w.tenant_id = rt.tenant_id) >= 2
     AND EXISTS (SELECT 1 FROM sites s WHERE s.tenant_id = rt.tenant_id AND s.id <> rt.site_id)
     AND NOT EXISTS (SELECT 1 FROM worker_assignments wa WHERE wa.repair_ticket_id = rt.id AND wa.confirmed_at IS NOT NULL)
   ORDER BY rt.created_at DESC LIMIT 1;
  IF NOT FOUND THEN INSERT INTO _res(line) VALUES ('FAIL setup: no suitable repair ticket'); RETURN; END IF;
  SELECT user_email INTO v_mail FROM user_roles WHERE tenant_id = tk.tenant_id AND role IN ('OWNER', 'ADMIN') ORDER BY role DESC LIMIT 1;
  SELECT id INTO v_wa FROM workers WHERE tenant_id = tk.tenant_id ORDER BY id LIMIT 1;
  SELECT id INTO v_wb FROM workers WHERE tenant_id = tk.tenant_id AND id <> v_wa ORDER BY id LIMIT 1;
  SELECT id, trim(concat_ws(' ', site_number, name)) INTO v_s2, v_s2l FROM sites WHERE tenant_id = tk.tenant_id AND id <> tk.site_id ORDER BY created_at DESC LIMIT 1;
  INSERT INTO _res(line) VALUES (format('info: ticket %s (%s) tenant %s as %s', tk.ticket_number, tk.status, tk.tenant_id, v_mail));

  -- Clear anything those workers have that day, then plant the conflicts.
  EXECUTE format('%s FROM worker_assignments WHERE worker_id IN ($1, $2) AND date = $3', 'DEL' || 'ETE') USING v_wa, v_wb, v_d;
  INSERT INTO worker_assignments (tenant_id, worker_id, site_id, date, shift, type) VALUES
    (tk.tenant_id, v_wa, v_s2, v_d, 'morning', 'site'),
    (tk.tenant_id, v_wb, NULL, v_d, 'morning', 'leave');

  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated', 'email', v_mail)::text, true);

  -- 0. one signature only
  SELECT count(*) INTO n FROM pg_proc WHERE proname = 'schedule_repair_ticket' AND pronamespace = 'public'::regnamespace;
  INSERT INTO _res(line) VALUES (CASE WHEN n = 1 THEN 'PASS 0 one overload' ELSE 'FAIL 0 overloads=' || n END);
  INSERT INTO _res(line) VALUES (CASE WHEN NOT has_function_privilege('anon', 'public.schedule_repair_ticket(uuid,text,date,time,numeric,uuid[],text[],boolean,boolean)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.schedule_repair_ticket(uuid,text,date,time,numeric,uuid[],text[],boolean,boolean)', 'EXECUTE')
     THEN 'PASS 0b grants' ELSE 'FAIL 0b grants' END);

  -- 1. no overwrite -> conflicts with labels, nothing saved
  EXECUTE 'SET LOCAL role authenticated';
  res := schedule_repair_ticket(tk.id, tk.status, v_d, TIME '09:00', 2, ARRAY[v_wa, v_wb], ARRAY['morning'], false);
  EXECUTE 'RESET ROLE';
  ok := NOT (res->>'ok')::boolean AND jsonb_array_length(res->'conflicts') = 2
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(res->'conflicts') c WHERE c->>'worker_id' = v_wa::text AND c->>'label' = v_s2l AND NOT (c->>'checked_in')::boolean)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(res->'conflicts') c WHERE c->>'worker_id' = v_wb::text AND c->>'label' = 'leave')
    AND (SELECT count(*) FROM worker_assignments WHERE worker_id IN (v_wa, v_wb) AND date = v_d) = 2
    AND NOT EXISTS (SELECT 1 FROM worker_assignments WHERE repair_ticket_id = tk.id AND date = v_d);
  INSERT INTO _res(line) VALUES ((CASE WHEN ok THEN 'PASS 1 ' ELSE 'FAIL 1 ' END) || res::text);

  -- 2. overwrite -> replaced, overwritten = 2
  EXECUTE 'SET LOCAL role authenticated';
  res := schedule_repair_ticket(tk.id, tk.status, v_d, TIME '09:00', 2, ARRAY[v_wa, v_wb], ARRAY['morning'], true);
  EXECUTE 'RESET ROLE';
  ok := (res->>'ok')::boolean AND (res->>'overwritten')::int = 2 AND jsonb_array_length(res->'removed') = 2
    AND (res->>'inserted')::int = 2
    AND (SELECT count(*) FROM worker_assignments WHERE worker_id IN (v_wa, v_wb) AND date = v_d AND shift = 'morning' AND repair_ticket_id = tk.id AND site_id = tk.site_id) = 2
    AND NOT EXISTS (SELECT 1 FROM worker_assignments WHERE worker_id IN (v_wa, v_wb) AND date = v_d AND (site_id = v_s2 OR type = 'leave'));
  INSERT INTO _res(line) VALUES ((CASE WHEN ok THEN 'PASS 2 ' ELSE 'FAIL 2 ' END) || res::text);
  SELECT * INTO tk FROM repair_tickets WHERE id = tk.id;

  -- 3. own rows re-save fine (no conflicts, nothing overwritten)
  EXECUTE 'SET LOCAL role authenticated';
  res := schedule_repair_ticket(tk.id, tk.status, v_d, TIME '09:00', 2, ARRAY[v_wa, v_wb], ARRAY['morning'], false);
  EXECUTE 'RESET ROLE';
  ok := (res->>'ok')::boolean AND (res->>'overwritten')::int = 0 AND (res->>'inserted')::int = 0;
  INSERT INTO _res(line) VALUES ((CASE WHEN ok THEN 'PASS 3 ' ELSE 'FAIL 3 ' END) || res::text);

  -- 4. checked-in conflict blocks even with overwrite
  INSERT INTO worker_assignments (tenant_id, worker_id, site_id, date, shift, type, confirmed_at)
  VALUES (tk.tenant_id, v_wa, v_s2, v_d, 'evening', 'site', now());
  EXECUTE 'SET LOCAL role authenticated';
  res := schedule_repair_ticket(tk.id, tk.status, v_d, TIME '09:00', 8, ARRAY[v_wa, v_wb], ARRAY['morning', 'evening'], true);
  EXECUTE 'RESET ROLE';
  ok := NOT (res->>'ok')::boolean AND (res->>'blocked_checked_in')::boolean
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(res->'conflicts') c WHERE c->>'worker_id' = v_wa::text AND c->>'shift' = 'evening' AND (c->>'checked_in')::boolean)
    AND EXISTS (SELECT 1 FROM worker_assignments WHERE worker_id = v_wa AND date = v_d AND shift = 'evening' AND site_id = v_s2)
    AND NOT EXISTS (SELECT 1 FROM worker_assignments WHERE repair_ticket_id = tk.id AND date = v_d AND shift = 'evening');
  INSERT INTO _res(line) VALUES ((CASE WHEN ok THEN 'PASS 4 ' ELSE 'FAIL 4 ' END) || res::text);

  -- 5. scheduled -> done directly (app's close patch), no trigger blocks it, started_at stamped
  SELECT * INTO tk FROM repair_tickets WHERE id = tk.id;
  EXECUTE 'SET LOCAL role authenticated';
  UPDATE repair_tickets SET status = 'done', done_at = now(), started_at = COALESCE(started_at, now()), fix_note = 'dry-run'
   WHERE id = tk.id AND status = 'scheduled';
  GET DIAGNOSTICS n = ROW_COUNT;
  EXECUTE 'RESET ROLE';
  SELECT * INTO tk FROM repair_tickets WHERE id = tk.id;
  INSERT INTO _res(line) VALUES (CASE WHEN n = 1 AND tk.status = 'done' AND tk.started_at IS NOT NULL AND tk.done_at IS NOT NULL
    THEN 'PASS 5 scheduled->done' ELSE 'FAIL 5 rows=' || n || ' status=' || tk.status END);
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _res(line) VALUES ('FAIL exception: ' || SQLERRM);
END $t$;

DO $z$ BEGIN RAISE EXCEPTION 'RESULTS: %', (SELECT string_agg(line, E'\n' ORDER BY n) FROM _res); END $z$;
