-- 2026-10-20-05: Bangkok date for the in-app check-in RPCs and the other live functions
-- that used CURRENT_DATE (DB timezone is UTC, so 00:00-07:00 Bangkok counted as yesterday).
-- Each function is copied VERBATIM from live (pg_get_functiondef, 2026-10-19); the ONLY
-- change is CURRENT_DATE -> (now() AT TIME ZONE 'Asia/Bangkok')::date. CREATE OR REPLACE
-- keeps the existing grants. Same fix as 2026-10-20-03 for the LINE check-in RPCs.

CREATE OR REPLACE FUNCTION public.get_my_team_today()
 RETURNS TABLE(id uuid, name text, nickname text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT DISTINCT w2.id, w2.name, w2.nickname
  FROM worker_assignments wa_me
  JOIN workers w_me ON w_me.id = wa_me.worker_id AND w_me.tenant_id = current_tenant_id()
  JOIN worker_assignments wa2 ON wa2.site_id = wa_me.site_id AND wa2.date = wa_me.date AND wa2.tenant_id = current_tenant_id()
  JOIN workers w2 ON w2.id = wa2.worker_id AND w2.tenant_id = current_tenant_id()
  WHERE w_me.email = auth.email()
    AND wa_me.date = (now() AT TIME ZONE 'Asia/Bangkok')::date
    AND wa_me.type = 'site'
    AND wa2.type = 'site';
$function$;

CREATE OR REPLACE FUNCTION public.perform_location_checkin(p_lat numeric, p_lng numeric)
 RETURNS TABLE(success boolean, distance_m numeric, radius_m numeric, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant_id uuid := current_tenant_id();
  v_worker_id uuid;
  v_role text;
  v_location_id uuid;
  v_loc_lat numeric;
  v_loc_lng numeric;
  v_radius numeric;
  v_distance numeric;
  v_today date := (now() AT TIME ZONE 'Asia/Bangkok')::date;
begin
  select role, assigned_checkin_location_id into v_role, v_location_id
  from user_roles where user_email = auth.email() and tenant_id = v_tenant_id;

  if v_role is null or v_role not in ('ADMIN', 'OWNER', 'PM') then
    return query select false, null::numeric, null::numeric, 'ฟีเจอร์นี้ใช้ได้เฉพาะแอดมิน/เจ้าของ'::text;
    return;
  end if;

  if v_location_id is null then
    select id into v_location_id from checkin_locations where tenant_id = v_tenant_id and role = 'office' limit 1;
  end if;

  if v_location_id is null then
    return query select false, null::numeric, null::numeric, 'ยังไม่ได้ตั้งค่าตำแหน่งเช็คอินสำหรับบัญชีนี้ — ติดต่อเจ้าของระบบ'::text;
    return;
  end if;

  select id into v_worker_id from workers where email = auth.email() and tenant_id = v_tenant_id;
  if v_worker_id is null then
    return query select false, null::numeric, null::numeric, 'บัญชีนี้ยังไม่ได้เชื่อมกับข้อมูลพนักงาน — ติดต่อผู้ดูแลระบบ'::text;
    return;
  end if;

  select lat, lng into v_loc_lat, v_loc_lng from checkin_locations where id = v_location_id and tenant_id = v_tenant_id;
  if v_loc_lat is null or v_loc_lng is null then
    return query select false, null::numeric, null::numeric, 'ไม่พบตำแหน่งที่กำหนด — ติดต่อเจ้าของระบบ'::text;
    return;
  end if;

  select coalesce((select value::numeric from app_settings where tenant_id = v_tenant_id and key = 'checkin_radius_m'), 200) into v_radius;
  v_distance := haversine_distance_m(p_lat, p_lng, v_loc_lat, v_loc_lng);

  if v_distance > v_radius then
    return query select false, v_distance, v_radius,
      format('คุณอยู่ห่างจากตำแหน่งที่กำหนด %s เมตร ต้องอยู่ในระยะ %s เมตรจึงจะเช็คอินได้', round(v_distance), round(v_radius))::text;
    return;
  end if;

  insert into worker_checkins (tenant_id, worker_id, checkin_location_id, date, checkin_at, checkin_lat, checkin_lng, checkin_distance_m)
  values (v_tenant_id, v_worker_id, v_location_id, v_today, now(), p_lat, p_lng, v_distance)
  on conflict (worker_id, checkin_location_id, date) where checkin_location_id is not null do update
    set checkin_at = now(), checkin_lat = p_lat, checkin_lng = p_lng, checkin_distance_m = v_distance;

  return query select true, v_distance, v_radius, 'เช็คอินสำเร็จ'::text;
end;
$function$;

CREATE OR REPLACE FUNCTION public.perform_location_checkout(p_lat numeric, p_lng numeric)
 RETURNS TABLE(success boolean, distance_m numeric, radius_m numeric, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant_id uuid := current_tenant_id();
  v_worker_id uuid;
  v_role text;
  v_location_id uuid;
  v_loc_lat numeric;
  v_loc_lng numeric;
  v_radius numeric;
  v_distance numeric;
  v_today date := (now() AT TIME ZONE 'Asia/Bangkok')::date;
begin
  select role, assigned_checkin_location_id into v_role, v_location_id
  from user_roles where user_email = auth.email() and tenant_id = v_tenant_id;

  if v_role is null or v_role not in ('ADMIN', 'OWNER', 'PM') then
    return query select false, null::numeric, null::numeric, 'ฟีเจอร์นี้ใช้ได้เฉพาะแอดมิน/เจ้าของ'::text;
    return;
  end if;

  if v_location_id is null then
    select id into v_location_id from checkin_locations where tenant_id = v_tenant_id and role = 'office' limit 1;
  end if;

  if v_location_id is null then
    return query select false, null::numeric, null::numeric, 'ยังไม่ได้ตั้งค่าตำแหน่งเช็คอินสำหรับบัญชีนี้ — ติดต่อเจ้าของระบบ'::text;
    return;
  end if;

  select id into v_worker_id from workers where email = auth.email() and tenant_id = v_tenant_id;
  if v_worker_id is null then
    return query select false, null::numeric, null::numeric, 'บัญชีนี้ยังไม่ได้เชื่อมกับข้อมูลพนักงาน — ติดต่อผู้ดูแลระบบ'::text;
    return;
  end if;

  if not exists (
    select 1 from worker_checkins
    where worker_id = v_worker_id and checkin_location_id = v_location_id and date = v_today and tenant_id = v_tenant_id
  ) then
    return query select false, null::numeric, null::numeric, 'ยังไม่ได้เช็คอินวันนี้ — เช็คอินก่อนจึงจะเช็คเอาท์ได้'::text;
    return;
  end if;

  select lat, lng into v_loc_lat, v_loc_lng from checkin_locations where id = v_location_id and tenant_id = v_tenant_id;
  select coalesce((select value::numeric from app_settings where tenant_id = v_tenant_id and key = 'checkin_radius_m'), 200) into v_radius;
  v_distance := haversine_distance_m(p_lat, p_lng, v_loc_lat, v_loc_lng);

  if v_distance > v_radius then
    return query select false, v_distance, v_radius,
      format('คุณอยู่ห่างจากตำแหน่งที่กำหนด %s เมตร ต้องอยู่ในระยะ %s เมตรจึงจะเช็คเอาท์ได้', round(v_distance), round(v_radius))::text;
    return;
  end if;

  update worker_checkins
  set checkout_at = now(), checkout_lat = p_lat, checkout_lng = p_lng, checkout_distance_m = v_distance
  where worker_id = v_worker_id and checkin_location_id = v_location_id and date = v_today and tenant_id = v_tenant_id;

  return query select true, v_distance, v_radius, 'เช็คเอาท์สำเร็จ'::text;
end;
$function$;

CREATE OR REPLACE FUNCTION public.perform_worker_checkin(p_site_id uuid, p_lat numeric, p_lng numeric)
 RETURNS TABLE(success boolean, distance_m numeric, radius_m numeric, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant_id UUID := current_tenant_id();
  v_worker_id UUID;
  v_site_lat NUMERIC;
  v_site_lng NUMERIC;
  v_radius NUMERIC;
  v_distance NUMERIC;
  v_today DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
BEGIN
  SELECT id INTO v_worker_id FROM workers WHERE email = auth.email() AND tenant_id = v_tenant_id;
  IF v_worker_id IS NULL THEN
    RETURN QUERY SELECT false, NULL::NUMERIC, NULL::NUMERIC, 'ไม่พบข้อมูลพนักงานที่ผูกกับบัญชีนี้'::TEXT;
    RETURN;
  END IF;

  SELECT lat, lng INTO v_site_lat, v_site_lng FROM sites WHERE id = p_site_id AND tenant_id = v_tenant_id;
  IF v_site_lat IS NULL OR v_site_lng IS NULL THEN
    RETURN QUERY SELECT false, NULL::NUMERIC, NULL::NUMERIC, 'ไซท์งานนี้ยังไม่ได้ตั้งพิกัด — ติดต่อสำนักงาน'::TEXT;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM worker_assignments
    WHERE worker_id = v_worker_id AND site_id = p_site_id AND date = v_today AND type = 'site' AND tenant_id = v_tenant_id
  ) THEN
    RETURN QUERY SELECT false, NULL::NUMERIC, NULL::NUMERIC, 'ไม่พบตารางงานของคุณที่ไซท์นี้วันนี้ — ติดต่อสำนักงาน'::TEXT;
    RETURN;
  END IF;

  SELECT COALESCE((SELECT value::numeric FROM app_settings WHERE tenant_id = v_tenant_id AND key = 'checkin_radius_m'), 200)
    INTO v_radius;
  v_distance := haversine_distance_m(p_lat, p_lng, v_site_lat, v_site_lng);

  IF v_distance > v_radius THEN
    RETURN QUERY SELECT false, v_distance, v_radius,
      format('คุณอยู่ห่างจากไซท์งาน %s เมตร ต้องอยู่ในระยะ %s เมตรจึงจะเช็คอินได้', round(v_distance), round(v_radius))::TEXT;
    RETURN;
  END IF;

  INSERT INTO worker_checkins (tenant_id, worker_id, site_id, date, checkin_at, checkin_lat, checkin_lng, checkin_distance_m)
  VALUES (v_tenant_id, v_worker_id, p_site_id, v_today, now(), p_lat, p_lng, v_distance)
  ON CONFLICT (worker_id, site_id, date) WHERE site_id IS NOT NULL DO UPDATE
    SET checkin_at = now(), checkin_lat = p_lat, checkin_lng = p_lng, checkin_distance_m = v_distance;

  UPDATE worker_assignments
  SET confirmed_at = now(), confirmed_by = 'checkin'
  WHERE worker_id = v_worker_id AND site_id = p_site_id AND date = v_today
    AND type = 'site' AND confirmed_at IS NULL AND tenant_id = v_tenant_id;

  RETURN QUERY SELECT true, v_distance, v_radius, 'เช็คอินสำเร็จ'::TEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.perform_worker_checkout(p_site_id uuid, p_lat numeric, p_lng numeric, p_ot_start time without time zone DEFAULT NULL::time without time zone, p_ot_end time without time zone DEFAULT NULL::time without time zone, p_ot_hours numeric DEFAULT NULL::numeric, p_ot_is_overnight boolean DEFAULT false, p_ot_notes text DEFAULT NULL::text)
 RETURNS TABLE(success boolean, distance_m numeric, radius_m numeric, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant_id UUID := current_tenant_id();
  v_worker_id UUID;
  v_site_lat NUMERIC;
  v_site_lng NUMERIC;
  v_radius NUMERIC;
  v_distance NUMERIC;
  v_today DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
BEGIN
  SELECT id INTO v_worker_id FROM workers WHERE email = auth.email() AND tenant_id = v_tenant_id;
  IF v_worker_id IS NULL THEN
    RETURN QUERY SELECT false, NULL::NUMERIC, NULL::NUMERIC, 'ไม่พบข้อมูลพนักงานที่ผูกกับบัญชีนี้'::TEXT;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM worker_checkins
    WHERE worker_id = v_worker_id AND site_id = p_site_id AND date = v_today AND tenant_id = v_tenant_id
  ) THEN
    RETURN QUERY SELECT false, NULL::NUMERIC, NULL::NUMERIC, 'ยังไม่ได้เช็คอินวันนี้ — เช็คอินก่อนจึงจะเช็คเอาท์ได้'::TEXT;
    RETURN;
  END IF;

  SELECT lat, lng INTO v_site_lat, v_site_lng FROM sites WHERE id = p_site_id AND tenant_id = v_tenant_id;
  IF v_site_lat IS NULL OR v_site_lng IS NULL THEN
    RETURN QUERY SELECT false, NULL::NUMERIC, NULL::NUMERIC, 'ไซท์งานนี้ยังไม่ได้ตั้งพิกัด — ติดต่อสำนักงาน'::TEXT;
    RETURN;
  END IF;

  SELECT COALESCE((SELECT value::numeric FROM app_settings WHERE tenant_id = v_tenant_id AND key = 'checkin_radius_m'), 200)
    INTO v_radius;
  v_distance := haversine_distance_m(p_lat, p_lng, v_site_lat, v_site_lng);

  IF v_distance > v_radius THEN
    RETURN QUERY SELECT false, v_distance, v_radius,
      format('คุณอยู่ห่างจากไซท์งาน %s เมตร ต้องอยู่ในระยะ %s เมตรจึงจะเช็คเอาท์ได้', round(v_distance), round(v_radius))::TEXT;
    RETURN;
  END IF;

  UPDATE worker_checkins
  SET checkout_at = now(), checkout_lat = p_lat, checkout_lng = p_lng, checkout_distance_m = v_distance
  WHERE worker_id = v_worker_id AND site_id = p_site_id AND date = v_today AND tenant_id = v_tenant_id;

  -- OT fields are optional -- the frontend (Task 7) decides whether the
  -- checkout time crosses the regular-shift-end setting and only passes
  -- these when it does. Trust level here matches admin-typed OT today
  -- (CellEditPopup.jsx): the number isn't re-derived server-side from
  -- p_ot_start/p_ot_end, same as an admin's manual entry isn't either.
  --
  -- The DO UPDATE ... WHERE guard means an auto-OT entry can only ever
  -- overwrite another auto-OT entry (identified by the exact sentinel note
  -- TodayCheckinCard.jsx writes). Admin-entered OT for the same worker/day --
  -- any other notes value, NULL included -- is left completely alone and the
  -- insert silently no-ops; the checkout itself still succeeds.
  IF p_ot_hours IS NOT NULL THEN
    INSERT INTO worker_ot (worker_id, site_id, date, start_time, end_time, ot_hours, is_overnight, notes, tenant_id)
    VALUES (v_worker_id, p_site_id, v_today, p_ot_start, p_ot_end, p_ot_hours, p_ot_is_overnight, p_ot_notes, v_tenant_id)
    ON CONFLICT (worker_id, date) DO UPDATE
      SET site_id = EXCLUDED.site_id, start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time,
          ot_hours = EXCLUDED.ot_hours, is_overnight = EXCLUDED.is_overnight, notes = EXCLUDED.notes
      WHERE worker_ot.notes = 'auto จากเช็คเอาท์';
  END IF;

  RETURN QUERY SELECT true, v_distance, v_radius, 'เช็คเอาท์สำเร็จ'::TEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_progress(p_task_id uuid, p_qty numeric, p_work_date date, p_note text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE t phase_tasks%ROWTYPE; v_id uuid;
BEGIN
  IF NOT can_manage_plan() OR NOT tenant_can_write() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์บันทึกยอด' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO t FROM phase_tasks WHERE id = p_task_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบการ์ดนี้' USING ERRCODE = 'P0002'; END IF;
  IF t.progress_mode <> 'quantity' THEN
    RAISE EXCEPTION 'การ์ดนี้ไม่ได้นับจำนวน' USING ERRCODE = '22023';
  END IF;
  IF p_qty IS NULL OR p_qty <= 0 OR t.done_qty + p_qty > t.planned_qty THEN
    RAISE EXCEPTION 'เกินจำนวนที่เหลือ %', trim_scale(t.planned_qty - t.done_qty) USING ERRCODE = '22023';
  END IF;
  INSERT INTO progress_reports (site_id, task_id, qty, work_date, note)
    VALUES (t.site_id, t.id, p_qty, COALESCE(p_work_date, (now() AT TIME ZONE 'Asia/Bangkok')::date), p_note)
    RETURNING id INTO v_id;
  RETURN v_id;
END $function$;
