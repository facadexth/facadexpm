-- Self-contained dry run for 2026-10-21-02 assembly-point check-in (no placeholders). Everything rolls back.
-- Works before OR after the migration is applied (IF NOT EXISTS / DROP CONSTRAINT IF EXISTS / CREATE OR REPLACE),
-- EXCEPT the token CHECK swap, which drops the live constraint by name first (same as 2026-10-20-02).
-- This file contains no row-removal keyword. Tenant: FacadeX 1b9affc4-2136-4ed1-b168-a36e6624e743; fixtures
-- are dryrun-named rows; app_settings assembly_* are changed inside the transaction only.
-- Expect PASS notices (a)..(i) and a final ALL PASS row.
BEGIN;

-- ===== inlined migration 2026-10-21-02 =====
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
-- ===== end migration body =====

-- ===== fixture + checks (as postgres) =====
DO $$
DECLARE
  v_tenant uuid := '1b9affc4-2136-4ed1-b168-a36e6624e743';
  v_loc    uuid;
  v_site_a uuid;
  v_site_x uuid;
  v_w1     uuid;   -- assembly day at site A (tenant default = assembly)
  v_w2     uuid;   -- misses the leave tap
  v_w3     uuid;   -- first site X overrides to 'none'
  v_radius numeric;
  r        record;
  v_today  date := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  v_ok     boolean;
  v_adm    uuid;   -- ADMIN whose assigned office location is also the assembly point
  v_at     timestamptz;
BEGIN
  -- (a) schema + privileges
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sites' AND column_name = 'assembly_mode')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'worker_checkins' AND column_name = 'is_assembly') THEN
    RAISE EXCEPTION 'FAIL (a): new columns missing';
  END IF;
  IF has_function_privilege('anon', 'public.perform_assembly_tap_by_id(uuid,text,numeric,numeric)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.perform_assembly_tap_by_id(uuid,text,numeric,numeric)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.worker_assembly_location(uuid,date)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.worker_assembly_location(uuid,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL (a): anon/authenticated can execute an assembly function';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.perform_assembly_tap_by_id(uuid,text,numeric,numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL (a): service_role cannot execute perform_assembly_tap_by_id';
  END IF;
  -- every existing row still satisfies the old NOT NULL rule (the CHECK was added without NOT VALID)
  IF EXISTS (SELECT 1 FROM worker_checkins WHERE NOT is_assembly AND checkin_at IS NULL) THEN
    RAISE EXCEPTION 'FAIL (a): non-assembly row with null checkin_at';
  END IF;
  RAISE NOTICE 'PASS (a) schema + privileges';

  INSERT INTO checkin_locations (tenant_id, name, lat, lng) VALUES (v_tenant, 'dryrun โรงงาน', 13.7563, 100.5018) RETURNING id INTO v_loc;
  INSERT INTO sites (site_number, name, tenant_id, lat, lng) VALUES ('__DRY-ASM-A__', '__dryrun asm A__', v_tenant, 13.8000, 100.6000) RETURNING id INTO v_site_a;
  INSERT INTO sites (site_number, name, tenant_id, lat, lng, assembly_mode) VALUES ('__DRY-ASM-X__', '__dryrun asm X__', v_tenant, 13.8000, 100.6000, 'none') RETURNING id INTO v_site_x;
  INSERT INTO app_settings (tenant_id, key, value) VALUES (v_tenant, 'assembly_mode', 'none')
    ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value;
  INSERT INTO app_settings (tenant_id, key, value) VALUES (v_tenant, 'assembly_location_id', v_loc::text)
    ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value;

  INSERT INTO workers (tenant_id, name, status) VALUES (v_tenant, 'dryrun asm 1', 'active') RETURNING id INTO v_w1;
  INSERT INTO workers (tenant_id, name, status) VALUES (v_tenant, 'dryrun asm 2', 'active') RETURNING id INTO v_w2;
  INSERT INTO workers (tenant_id, name, status) VALUES (v_tenant, 'dryrun asm 3', 'active') RETURNING id INTO v_w3;
  INSERT INTO worker_assignments (tenant_id, worker_id, site_id, date, shift, type) VALUES
    (v_tenant, v_w1, v_site_a, v_today, 'morning', 'site'),
    (v_tenant, v_w2, v_site_a, v_today, 'morning', 'site'),
    (v_tenant, v_w3, v_site_a, v_today, 'evening', 'site'),
    (v_tenant, v_w3, v_site_x, v_today, 'morning', 'site');

  -- (b) tenant mode 'none' -> no assembly day; RPC refuses
  IF EXISTS (SELECT 1 FROM worker_assembly_location(v_w1, v_today)) THEN RAISE EXCEPTION 'FAIL (b): mode none still returned a location'; END IF;
  SELECT * INTO r FROM perform_assembly_tap_by_id(v_w1, 'leave', 13.7563, 100.5018);
  IF r.success THEN RAISE EXCEPTION 'FAIL (b): tap accepted with mode none'; END IF;
  RAISE NOTICE 'PASS (b) off by default';

  UPDATE app_settings SET value = 'assembly' WHERE tenant_id = v_tenant AND key = 'assembly_mode';

  -- (c) mode resolution: tenant default, first-site override
  SELECT * INTO r FROM worker_assembly_location(v_w1, v_today);
  IF r.location_id IS DISTINCT FROM v_loc THEN RAISE EXCEPTION 'FAIL (c): w1 should get the assembly location'; END IF;
  IF EXISTS (SELECT 1 FROM worker_assembly_location(v_w3, v_today)) THEN RAISE EXCEPTION 'FAIL (c): first site X (none) should win'; END IF;
  UPDATE sites SET assembly_mode = 'assembly' WHERE id = v_site_x;
  IF NOT EXISTS (SELECT 1 FROM worker_assembly_location(v_w3, v_today)) THEN RAISE EXCEPTION 'FAIL (c): site override assembly ignored'; END IF;
  IF EXISTS (SELECT 1 FROM worker_assembly_location(v_w1, v_today + 1)) THEN RAISE EXCEPTION 'FAIL (c): a day without work returned a location'; END IF;
  RAISE NOTICE 'PASS (c) mode resolution';

  SELECT coalesce((SELECT value::numeric FROM app_settings WHERE tenant_id = v_tenant AND key = 'checkin_radius_m'), 200) INTO v_radius;

  -- (d) leave: far refused with distance + location name, near writes the assembly row
  SELECT * INTO r FROM perform_assembly_tap_by_id(v_w1, 'leave', 13.9000, 100.5018);
  IF r.success OR r.distance_m <= v_radius OR r.message NOT LIKE 'คุณอยู่ห่างจากdryrun โรงงาน%' THEN RAISE EXCEPTION 'FAIL (d): far leave: %', r; END IF;
  IF EXISTS (SELECT 1 FROM worker_checkins WHERE worker_id = v_w1) THEN RAISE EXCEPTION 'FAIL (d): far leave wrote a row'; END IF;
  SELECT * INTO r FROM perform_assembly_tap_by_id(v_w1, 'leave', 13.7564, 100.5019);
  IF NOT r.success THEN RAISE EXCEPTION 'FAIL (d): near leave: %', r; END IF;
  IF NOT EXISTS (SELECT 1 FROM worker_checkins WHERE worker_id = v_w1 AND checkin_location_id = v_loc AND is_assembly AND checkin_at IS NOT NULL AND checkout_at IS NULL AND date = v_today) THEN
    RAISE EXCEPTION 'FAIL (d): assembly row wrong';
  END IF;
  SELECT * INTO r FROM perform_assembly_tap_by_id(v_w1, 'leave', 13.7564, 100.5019);
  IF NOT r.success OR (SELECT count(*) FROM worker_checkins WHERE worker_id = v_w1) <> 1 THEN RAISE EXCEPTION 'FAIL (d): repeat leave'; END IF;
  RAISE NOTICE 'PASS (d) leave';

  -- (e) site arrive via the existing RPC (assembly row does not block it), return refused while open
  SELECT * INTO r FROM perform_worker_checkin_by_id(v_w1, v_site_a, 13.8000, 100.6000);
  IF NOT r.success THEN RAISE EXCEPTION 'FAIL (e): site check-in: %', r; END IF;
  SELECT * INTO r FROM perform_assembly_tap_by_id(v_w1, 'return', 13.7564, 100.5019);
  IF r.success OR r.message NOT LIKE 'ยังไม่ได้เช็คเอาท์ที่%' THEN RAISE EXCEPTION 'FAIL (e): return with open site: %', r; END IF;
  SELECT * INTO r FROM perform_worker_checkout_by_id(v_w1, v_site_a, 13.8000, 100.6000);
  IF NOT r.success THEN RAISE EXCEPTION 'FAIL (e): site checkout: %', r; END IF;
  SELECT * INTO r FROM perform_assembly_tap_by_id(v_w1, 'return', 13.7564, 100.5019);
  IF NOT r.success THEN RAISE EXCEPTION 'FAIL (e): return: %', r; END IF;
  IF NOT EXISTS (SELECT 1 FROM worker_checkins WHERE worker_id = v_w1 AND is_assembly AND checkin_at IS NOT NULL AND checkout_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL (e): return not recorded';
  END IF;
  RAISE NOTICE 'PASS (e) arrive / leave site / return';

  -- (f) missed leave: leave after site check-in refused; return-only row allowed (checkin_at null)
  SELECT * INTO r FROM perform_worker_checkin_by_id(v_w2, v_site_a, 13.8000, 100.6000);
  IF NOT r.success THEN RAISE EXCEPTION 'FAIL (f): w2 site check-in: %', r; END IF;
  SELECT * INTO r FROM perform_assembly_tap_by_id(v_w2, 'leave', 13.7564, 100.5019);
  IF r.success THEN RAISE EXCEPTION 'FAIL (f): leave after arriving accepted'; END IF;
  SELECT * INTO r FROM perform_worker_checkout_by_id(v_w2, v_site_a, 13.8000, 100.6000);
  SELECT * INTO r FROM perform_assembly_tap_by_id(v_w2, 'return', 13.7564, 100.5019);
  IF NOT r.success THEN RAISE EXCEPTION 'FAIL (f): return-only: %', r; END IF;
  IF NOT EXISTS (SELECT 1 FROM worker_checkins WHERE worker_id = v_w2 AND is_assembly AND checkin_at IS NULL AND checkout_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL (f): return-only row shape';
  END IF;
  RAISE NOTICE 'PASS (f) missed leave';

  -- (g) a non-assembly row still needs its check-in columns
  v_ok := false;
  BEGIN
    INSERT INTO worker_checkins (tenant_id, worker_id, site_id, date, checkin_at, checkin_lat, checkin_lng, checkin_distance_m)
    VALUES (v_tenant, v_w3, v_site_x, v_today, NULL, NULL, NULL, NULL);
  EXCEPTION WHEN check_violation THEN v_ok := true;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL (g): non-assembly row without check-in accepted'; END IF;
  v_ok := false;
  BEGIN
    INSERT INTO worker_checkins (tenant_id, worker_id, site_id, date, is_assembly, checkin_at) VALUES (v_tenant, v_w3, v_site_x, v_today + 1, true, now());
  EXCEPTION WHEN check_violation THEN v_ok := true;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL (g): assembly row without location accepted'; END IF;
  RAISE NOTICE 'PASS (g) constraints';

  -- (h) token type + bad step
  INSERT INTO line_deep_link_tokens (tenant_id, worker_id, action_type, token, expires_at)
  VALUES (v_tenant, v_w1, 'time_clock', 'dryrun-asm-' || gen_random_uuid(), now() + interval '30 minutes');
  SELECT * INTO r FROM perform_assembly_tap_by_id(v_w1, 'sideways', 13.7564, 100.5019);
  IF r.success THEN RAISE EXCEPTION 'FAIL (h): bad step accepted'; END IF;
  RAISE NOTICE 'PASS (h) time_clock token + step validation';

  -- (i) office location check-in/out never overwrite an assembly row
  IF EXISTS (SELECT 1 FROM user_roles WHERE user_email = 'adm@asm.dryrun.invalid') THEN RAISE EXCEPTION 'SETUP: dryrun email exists'; END IF;
  INSERT INTO workers (tenant_id, name, email, status) VALUES (v_tenant, 'dryrun asm admin', 'adm@asm.dryrun.invalid', 'active') RETURNING id INTO v_adm;
  INSERT INTO user_roles (user_email, role, tenant_id, status, assigned_checkin_location_id) VALUES ('adm@asm.dryrun.invalid', 'ADMIN', v_tenant, 'approved', v_loc);
  INSERT INTO worker_assignments (tenant_id, worker_id, site_id, date, shift, type) VALUES (v_tenant, v_adm, v_site_a, v_today, 'morning', 'site');
  SELECT * INTO r FROM perform_assembly_tap_by_id(v_adm, 'leave', 13.7564, 100.5019);
  IF NOT r.success THEN RAISE EXCEPTION 'FAIL (i): admin leave: %', r; END IF;
  SELECT checkin_at INTO v_at FROM worker_checkins WHERE worker_id = v_adm AND is_assembly;
  SELECT * INTO r FROM perform_location_checkin_by_id(v_adm, v_loc, 13.7564, 100.5019);
  IF r.success OR r.message NOT LIKE 'วันนี้ตำแหน่งนี้เป็นจุดรวมพล%' THEN RAISE EXCEPTION 'FAIL (i): office check-in over assembly row: %', r; END IF;
  SELECT * INTO r FROM perform_location_checkout_by_id(v_adm, v_loc, 13.7564, 100.5019);
  IF r.success OR r.message NOT LIKE 'วันนี้ตำแหน่งนี้เป็นจุดรวมพล%' THEN RAISE EXCEPTION 'FAIL (i): office checkout over assembly row: %', r; END IF;
  IF NOT EXISTS (SELECT 1 FROM worker_checkins WHERE worker_id = v_adm AND is_assembly AND checkin_at = v_at AND checkout_at IS NULL)
     OR (SELECT count(*) FROM worker_checkins WHERE worker_id = v_adm) <> 1 THEN
    RAISE EXCEPTION 'FAIL (i): assembly row changed';
  END IF;
  RAISE NOTICE 'PASS (i) office location RPCs leave the assembly row alone';
END $$;

SELECT 'ALL PASS' AS result;
ROLLBACK;
