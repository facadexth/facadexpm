-- 2026-10-21-02: assembly-point check-in (รวมพลที่บริษัท/โรงงานก่อน).
-- Spec: docs/superpowers/specs/2026-10-21-assembly-checkin-design.md
--
-- 1) sites.assembly_mode: per-site override. NULL = ตามบริษัท (app_settings 'assembly_mode').
-- 2) worker_checkins.is_assembly: the worker's one assembly row for the day, keyed like the
--    office check-in by (worker_id, checkin_location_id, date). checkin_at = left the assembly
--    point, checkout_at = back at it. NOT NULL on the four checkin_* columns moves into a CHECK
--    that every NON-assembly row still satisfies, so an assembly row can hold only the return
--    tap when the worker missed the leave tap (missed taps are filled at read time, never
--    written).
-- 3) line_deep_link_tokens action_type + 'time_clock' (the one link on an assembly day).
--    The list is the live one from 2026-10-20-02, extended only.
-- 4) worker_assembly_location(worker, date): the single rule. First site of the day
--    (site/factory/subcontract; morning before evening, then site name) -> its assembly_mode,
--    else app_settings 'assembly_mode', else 'none'. Returns the tenant's checkin_locations
--    row named by app_settings 'assembly_location_id' (with coordinates) only when the mode is
--    'assembly'; no row = today's behaviour.
-- 5) perform_assembly_tap_by_id(worker, 'leave'|'return', lat, lng): geofenced write, same
--    radius rule (app_settings checkin_radius_m, default 200) and Bangkok date as the other
--    by_id RPCs. Service role only, like perform_worker_checkin_by_id.
-- Tenants that never set 'assembly_mode' get no row from (4), so nothing changes for them.

ALTER TABLE sites ADD COLUMN IF NOT EXISTS assembly_mode text NULL;
ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_assembly_mode_check;
ALTER TABLE sites ADD CONSTRAINT sites_assembly_mode_check CHECK (assembly_mode IS NULL OR assembly_mode IN ('none', 'assembly'));

ALTER TABLE worker_checkins ADD COLUMN IF NOT EXISTS is_assembly boolean NOT NULL DEFAULT false;
ALTER TABLE worker_checkins
  ALTER COLUMN checkin_at DROP NOT NULL,
  ALTER COLUMN checkin_lat DROP NOT NULL,
  ALTER COLUMN checkin_lng DROP NOT NULL,
  ALTER COLUMN checkin_distance_m DROP NOT NULL;
ALTER TABLE worker_checkins DROP CONSTRAINT IF EXISTS worker_checkins_checkin_required;
ALTER TABLE worker_checkins ADD CONSTRAINT worker_checkins_checkin_required
  CHECK (is_assembly OR (checkin_at IS NOT NULL AND checkin_lat IS NOT NULL AND checkin_lng IS NOT NULL AND checkin_distance_m IS NOT NULL));
ALTER TABLE worker_checkins DROP CONSTRAINT IF EXISTS worker_checkins_assembly_location;
ALTER TABLE worker_checkins ADD CONSTRAINT worker_checkins_assembly_location
  CHECK (NOT is_assembly OR checkin_location_id IS NOT NULL);

ALTER TABLE line_deep_link_tokens DROP CONSTRAINT line_deep_link_tokens_action_type_check;
ALTER TABLE line_deep_link_tokens ADD CONSTRAINT line_deep_link_tokens_action_type_check
  CHECK (action_type = ANY (ARRAY['material_request','leave','check_in','check_out','advance','payslip','time_clock']));

CREATE OR REPLACE FUNCTION public.worker_assembly_location(p_worker_id uuid, p_date date)
 RETURNS TABLE(location_id uuid, location_name text, lat numeric, lng numeric)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH w AS (
    SELECT id, tenant_id FROM workers WHERE id = p_worker_id
  ), first_site AS (
    SELECT s.assembly_mode
    FROM worker_assignments wa
    JOIN w ON w.id = wa.worker_id AND w.tenant_id = wa.tenant_id
    JOIN sites s ON s.id = wa.site_id AND s.tenant_id = wa.tenant_id
    WHERE wa.date = p_date AND wa.site_id IS NOT NULL AND wa.type IN ('site', 'factory', 'subcontract')
    ORDER BY (wa.shift = 'evening') NULLS FIRST, s.name
    LIMIT 1
  ), mode AS (
    SELECT w.tenant_id,
           coalesce(fs.assembly_mode,
                    (SELECT value FROM app_settings a WHERE a.tenant_id = w.tenant_id AND a.key = 'assembly_mode'),
                    'none') AS m
    FROM w JOIN first_site fs ON true
  )
  SELECT cl.id, cl.name, cl.lat, cl.lng
  FROM mode
  JOIN app_settings a ON a.tenant_id = mode.tenant_id AND a.key = 'assembly_location_id'
  JOIN checkin_locations cl ON cl.tenant_id = mode.tenant_id AND cl.id::text = trim(a.value)
  WHERE mode.m = 'assembly' AND cl.lat IS NOT NULL AND cl.lng IS NOT NULL;
$function$;

CREATE OR REPLACE FUNCTION public.perform_assembly_tap_by_id(p_worker_id uuid, p_step text, p_lat numeric, p_lng numeric)
 RETURNS TABLE(success boolean, distance_m numeric, radius_m numeric, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant_id uuid;
  v_loc record;
  v_row worker_checkins%rowtype;
  v_found boolean;
  v_radius numeric;
  v_distance numeric;
  v_open_site text;
  v_today date := (now() AT TIME ZONE 'Asia/Bangkok')::date;
begin
  if p_step is null or p_step not in ('leave', 'return') then
    return query select false, null::numeric, null::numeric, 'ขั้นตอนไม่ถูกต้อง'::text;
    return;
  end if;

  select tenant_id into v_tenant_id from workers where id = p_worker_id;
  if v_tenant_id is null then
    return query select false, null::numeric, null::numeric, 'ไม่พบข้อมูลพนักงาน'::text;
    return;
  end if;

  select * into v_loc from worker_assembly_location(p_worker_id, v_today) limit 1;
  if v_loc.location_id is null then
    return query select false, null::numeric, null::numeric, 'วันนี้ไม่ได้ตั้งให้รวมพลก่อนออกไซท์ — ติดต่อสำนักงาน'::text;
    return;
  end if;

  select coalesce((select value::numeric from app_settings where tenant_id = v_tenant_id and key = 'checkin_radius_m'), 200) into v_radius;
  v_distance := haversine_distance_m(p_lat, p_lng, v_loc.lat, v_loc.lng);
  if v_distance > v_radius then
    return query select false, v_distance, v_radius,
      format('คุณอยู่ห่างจาก%s %s เมตร ต้องอยู่ในระยะ %s เมตรจึงจะบันทึกได้', v_loc.location_name, round(v_distance), round(v_radius))::text;
    return;
  end if;

  select * into v_row from worker_checkins
  where worker_id = p_worker_id and checkin_location_id = v_loc.location_id and date = v_today and tenant_id = v_tenant_id;
  v_found := found;
  if v_found and not v_row.is_assembly then
    return query select false, null::numeric, null::numeric,
      format('วันนี้เช็คอินที่ %s แบบสำนักงานไปแล้ว — ติดต่อแอดมิน', v_loc.location_name)::text;
    return;
  end if;

  if p_step = 'leave' then
    if v_found and v_row.checkin_at is not null then
      return query select true, v_distance, v_radius, format('บันทึกออกจาก%s ไว้แล้ว', v_loc.location_name)::text;
      return;
    end if;
    if v_found and v_row.checkout_at is not null then
      return query select false, null::numeric, null::numeric, format('วันนี้บันทึกกลับถึง%s ไปแล้ว', v_loc.location_name)::text;
      return;
    end if;
    if exists (select 1 from worker_checkins where worker_id = p_worker_id and date = v_today and tenant_id = v_tenant_id
                 and site_id is not null and checkin_at is not null) then
      return query select false, null::numeric, null::numeric, 'วันนี้ถึงไซท์ไปแล้ว — ไม่ต้องบันทึกออกจากจุดรวมพล'::text;
      return;
    end if;
    insert into worker_checkins (tenant_id, worker_id, checkin_location_id, date, is_assembly, checkin_at, checkin_lat, checkin_lng, checkin_distance_m)
    values (v_tenant_id, p_worker_id, v_loc.location_id, v_today, true, now(), p_lat, p_lng, v_distance)
    on conflict (worker_id, checkin_location_id, date) where checkin_location_id is not null do update
      set checkin_at = now(), checkin_lat = p_lat, checkin_lng = p_lng, checkin_distance_m = v_distance
      where worker_checkins.is_assembly and worker_checkins.checkin_at is null;
    return query select true, v_distance, v_radius, format('บันทึกออกจาก%s แล้ว — เริ่มนับเวลางาน', v_loc.location_name)::text;
    return;
  end if;

  -- return
  select s.name into v_open_site from worker_checkins c join sites s on s.id = c.site_id
  where c.worker_id = p_worker_id and c.date = v_today and c.tenant_id = v_tenant_id
    and c.site_id is not null and c.checkin_at is not null and c.checkout_at is null
  limit 1;
  if v_open_site is not null then
    return query select false, null::numeric, null::numeric,
      format('ยังไม่ได้เช็คเอาท์ที่ %s — เช็คเอาท์ไซท์ก่อนจึงจะบันทึกกลับถึง%s ได้', v_open_site, v_loc.location_name)::text;
    return;
  end if;
  if v_found and v_row.checkout_at is not null then
    return query select true, v_distance, v_radius, format('บันทึกกลับถึง%s ไว้แล้ว', v_loc.location_name)::text;
    return;
  end if;
  if v_found then
    update worker_checkins
    set checkout_at = now(), checkout_lat = p_lat, checkout_lng = p_lng, checkout_distance_m = v_distance
    where id = v_row.id;
  else
    -- Missed the leave tap: the row holds the return only (leave is filled at read time).
    insert into worker_checkins (tenant_id, worker_id, checkin_location_id, date, is_assembly,
                                 checkin_at, checkin_lat, checkin_lng, checkin_distance_m,
                                 checkout_at, checkout_lat, checkout_lng, checkout_distance_m)
    values (v_tenant_id, p_worker_id, v_loc.location_id, v_today, true,
            null, null, null, null,
            now(), p_lat, p_lng, v_distance);
  end if;
  return query select true, v_distance, v_radius, format('บันทึกกลับถึง%s แล้ว — จบเวลางาน', v_loc.location_name)::text;
end;
$function$;

-- 6) Office location check-in/out never touch an assembly row (review fix 2026-10-21). The four
--    location RPCs are re-issued with their bodies copied from 2026-10-20-05 (web) and
--    2026-10-21-01 (by_id); the only change: refuse when today's row at that location is an
--    assembly row, and "not is_assembly" on the conflict update and the checkout update.
--    CREATE OR REPLACE keeps the existing grants.

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

  if exists (
    select 1 from worker_checkins
    where worker_id = v_worker_id and checkin_location_id = v_location_id and date = v_today and tenant_id = v_tenant_id and is_assembly
  ) then
    return query select false, null::numeric, null::numeric, 'วันนี้ตำแหน่งนี้เป็นจุดรวมพลของคุณแล้ว — ใช้ปุ่มเช็คอินในไลน์ หรือติดต่อแอดมิน'::text;
    return;
  end if;

  insert into worker_checkins (tenant_id, worker_id, checkin_location_id, date, checkin_at, checkin_lat, checkin_lng, checkin_distance_m)
  values (v_tenant_id, v_worker_id, v_location_id, v_today, now(), p_lat, p_lng, v_distance)
  on conflict (worker_id, checkin_location_id, date) where checkin_location_id is not null do update
    set checkin_at = now(), checkin_lat = p_lat, checkin_lng = p_lng, checkin_distance_m = v_distance
    where not worker_checkins.is_assembly;

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

  if exists (
    select 1 from worker_checkins
    where worker_id = v_worker_id and checkin_location_id = v_location_id and date = v_today and tenant_id = v_tenant_id and is_assembly
  ) then
    return query select false, null::numeric, null::numeric, 'วันนี้ตำแหน่งนี้เป็นจุดรวมพลของคุณแล้ว — ใช้ปุ่มเช็คอินในไลน์ หรือติดต่อแอดมิน'::text;
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
  where worker_id = v_worker_id and checkin_location_id = v_location_id and date = v_today and tenant_id = v_tenant_id and not is_assembly;

  return query select true, v_distance, v_radius, 'เช็คเอาท์สำเร็จ'::text;
end;
$function$;

CREATE OR REPLACE FUNCTION public.perform_location_checkin_by_id(p_worker_id uuid, p_location_id uuid, p_lat numeric, p_lng numeric)
 RETURNS TABLE(success boolean, distance_m numeric, radius_m numeric, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant_id uuid;
  v_loc_lat numeric;
  v_loc_lng numeric;
  v_radius numeric;
  v_distance numeric;
  v_today date := (now() AT TIME ZONE 'Asia/Bangkok')::date;
begin
  select tenant_id into v_tenant_id from workers where id = p_worker_id;
  if v_tenant_id is null then
    return query select false, null::numeric, null::numeric, 'ไม่พบข้อมูลพนักงาน'::text;
    return;
  end if;

  if not location_checkin_allowed(p_worker_id, p_location_id, v_tenant_id) then
    return query select false, null::numeric, null::numeric, 'ยังไม่ได้ตั้งค่าตำแหน่งเช็คอินสำหรับบัญชีนี้ — ติดต่อเจ้าของระบบ'::text;
    return;
  end if;

  select lat, lng into v_loc_lat, v_loc_lng from checkin_locations where id = p_location_id and tenant_id = v_tenant_id;
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

  if exists (
    select 1 from worker_checkins
    where worker_id = p_worker_id and checkin_location_id = p_location_id and date = v_today and tenant_id = v_tenant_id and is_assembly
  ) then
    return query select false, null::numeric, null::numeric, 'วันนี้ตำแหน่งนี้เป็นจุดรวมพลของคุณแล้ว — ใช้ปุ่มเช็คอินในไลน์ หรือติดต่อแอดมิน'::text;
    return;
  end if;

  insert into worker_checkins (tenant_id, worker_id, checkin_location_id, date, checkin_at, checkin_lat, checkin_lng, checkin_distance_m)
  values (v_tenant_id, p_worker_id, p_location_id, v_today, now(), p_lat, p_lng, v_distance)
  on conflict (worker_id, checkin_location_id, date) where checkin_location_id is not null do update
    set checkin_at = now(), checkin_lat = p_lat, checkin_lng = p_lng, checkin_distance_m = v_distance
    where not worker_checkins.is_assembly;

  return query select true, v_distance, v_radius, 'เช็คอินสำเร็จ'::text;
end;
$function$;

CREATE OR REPLACE FUNCTION public.perform_location_checkout_by_id(p_worker_id uuid, p_location_id uuid, p_lat numeric, p_lng numeric)
 RETURNS TABLE(success boolean, distance_m numeric, radius_m numeric, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant_id uuid;
  v_loc_lat numeric;
  v_loc_lng numeric;
  v_radius numeric;
  v_distance numeric;
  v_today date := (now() AT TIME ZONE 'Asia/Bangkok')::date;
begin
  select tenant_id into v_tenant_id from workers where id = p_worker_id;
  if v_tenant_id is null then
    return query select false, null::numeric, null::numeric, 'ไม่พบข้อมูลพนักงาน'::text;
    return;
  end if;

  if not location_checkin_allowed(p_worker_id, p_location_id, v_tenant_id) then
    return query select false, null::numeric, null::numeric, 'ยังไม่ได้ตั้งค่าตำแหน่งเช็คอินสำหรับบัญชีนี้ — ติดต่อเจ้าของระบบ'::text;
    return;
  end if;

  if exists (
    select 1 from worker_checkins
    where worker_id = p_worker_id and checkin_location_id = p_location_id and date = v_today and tenant_id = v_tenant_id and is_assembly
  ) then
    return query select false, null::numeric, null::numeric, 'วันนี้ตำแหน่งนี้เป็นจุดรวมพลของคุณแล้ว — ใช้ปุ่มเช็คอินในไลน์ หรือติดต่อแอดมิน'::text;
    return;
  end if;

  if not exists (
    select 1 from worker_checkins
    where worker_id = p_worker_id and checkin_location_id = p_location_id and date = v_today and tenant_id = v_tenant_id
  ) then
    return query select false, null::numeric, null::numeric, 'ยังไม่ได้เช็คอินวันนี้ — เช็คอินก่อนจึงจะเช็คเอาท์ได้'::text;
    return;
  end if;

  select lat, lng into v_loc_lat, v_loc_lng from checkin_locations where id = p_location_id and tenant_id = v_tenant_id;
  if v_loc_lat is null or v_loc_lng is null then
    return query select false, null::numeric, null::numeric, 'ไม่พบตำแหน่งที่กำหนด — ติดต่อเจ้าของระบบ'::text;
    return;
  end if;

  select coalesce((select value::numeric from app_settings where tenant_id = v_tenant_id and key = 'checkin_radius_m'), 200) into v_radius;
  v_distance := haversine_distance_m(p_lat, p_lng, v_loc_lat, v_loc_lng);

  if v_distance > v_radius then
    return query select false, v_distance, v_radius,
      format('คุณอยู่ห่างจากตำแหน่งที่กำหนด %s เมตร ต้องอยู่ในระยะ %s เมตรจึงจะเช็คเอาท์ได้', round(v_distance), round(v_radius))::text;
    return;
  end if;

  update worker_checkins
  set checkout_at = now(), checkout_lat = p_lat, checkout_lng = p_lng, checkout_distance_m = v_distance
  where worker_id = p_worker_id and checkin_location_id = p_location_id and date = v_today and tenant_id = v_tenant_id and not is_assembly;

  return query select true, v_distance, v_radius, 'เช็คเอาท์สำเร็จ'::text;
end;
$function$;

REVOKE ALL ON FUNCTION public.worker_assembly_location(uuid,date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.perform_assembly_tap_by_id(uuid,text,numeric,numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.worker_assembly_location(uuid,date) TO service_role;
GRANT EXECUTE ON FUNCTION public.perform_assembly_tap_by_id(uuid,text,numeric,numeric) TO service_role;
