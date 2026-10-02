-- supabase/migrations/2026-10-02-03-checkin-location-roles.sql
-- Lets an owner tag one checkin_locations row as the tenant's "factory"
-- and (new) one row as the tenant's "office", right on the location
-- itself, instead of the separate app_settings.factory_site_id select.
-- One of each per tenant (partial unique index), matching the user's
-- explicit "stay with one office, one factory" scope decision.
--
-- factory_site_id is NOT dropped -- it stays as a harmless legacy
-- tertiary fallback in the factory-branch RPCs below. The backfill makes
-- the new role column agree with it immediately, so existing tenants see
-- zero behavior change until an owner touches the new dropdown.

ALTER TABLE checkin_locations ADD COLUMN role text CHECK (role IN ('factory', 'office'));

CREATE UNIQUE INDEX checkin_locations_tenant_role_uniq ON checkin_locations(tenant_id, role) WHERE role IS NOT NULL;

-- Backfill: whichever location a tenant's current factory_site_id points
-- at becomes that tenant's role='factory' row.
UPDATE checkin_locations cl
SET role = 'factory'
FROM app_settings a
WHERE a.tenant_id = cl.tenant_id
  AND a.key = 'factory_site_id'
  AND nullif(a.value, '') IS NOT NULL
  AND cl.id = nullif(a.value, '')::uuid;

-- perform_location_checkin/checkout: add an office fallback. Today these
-- resolve the location ONLY from user_roles.assigned_checkin_location_id
-- (deliberately -- no client-supplied location, so it can't be spoofed).
-- New: if that's null and the caller is ADMIN/OWNER, fall back to the
-- tenant's single role='office' location -- still fully server-resolved,
-- so "no assign needed" doesn't open any spoofing surface.

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
  v_today date := current_date;
begin
  select role, assigned_checkin_location_id into v_role, v_location_id
  from user_roles where user_email = auth.email() and tenant_id = v_tenant_id;

  if v_role is null or v_role not in ('ADMIN', 'OWNER') then
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

REVOKE EXECUTE ON FUNCTION perform_location_checkin(NUMERIC, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION perform_location_checkin(NUMERIC, NUMERIC) TO authenticated;

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
  v_today date := current_date;
begin
  select role, assigned_checkin_location_id into v_role, v_location_id
  from user_roles where user_email = auth.email() and tenant_id = v_tenant_id;

  if v_role is null or v_role not in ('ADMIN', 'OWNER') then
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

REVOKE EXECUTE ON FUNCTION perform_location_checkout(NUMERIC, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION perform_location_checkout(NUMERIC, NUMERIC) TO authenticated;

-- Factory-branch RPCs (LINE bot path): prefer the new role='factory' row
-- over app_settings.factory_site_id, ahead of the old value in the
-- coalesce chain. worker_assignments.checkin_location_id (a specific
-- per-assignment override) still wins over both when set.

CREATE OR REPLACE FUNCTION public.perform_worker_checkin_by_id(p_worker_id uuid, p_site_id uuid, p_lat numeric, p_lng numeric)
 RETURNS TABLE(success boolean, distance_m numeric, radius_m numeric, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant_id uuid;
  v_assignment_type text;
  v_geo_location_id uuid;
  v_site_lat numeric;
  v_site_lng numeric;
  v_radius numeric;
  v_distance numeric;
  v_today date := current_date;
begin
  select tenant_id into v_tenant_id from workers where id = p_worker_id;
  if v_tenant_id is null then
    return query select false, null::numeric, null::numeric, 'ไม่พบข้อมูลพนักงาน'::text;
    return;
  end if;

  select type into v_assignment_type from worker_assignments
  where worker_id = p_worker_id and site_id = p_site_id and date = v_today
    and type in ('site', 'factory', 'subcontract') and tenant_id = v_tenant_id
  limit 1;

  if v_assignment_type is null then
    return query select false, null::numeric, null::numeric, 'ไม่พบตารางงานของคุณที่ไซท์นี้วันนี้ — ติดต่อสำนักงาน'::text;
    return;
  end if;

  if v_assignment_type = 'factory' then
    select coalesce(
      (select checkin_location_id from worker_assignments
         where worker_id = p_worker_id and site_id = p_site_id and date = v_today
           and type = 'factory' and tenant_id = v_tenant_id limit 1),
      (select id from checkin_locations where tenant_id = v_tenant_id and role = 'factory' limit 1),
      (select nullif(value, '')::uuid from app_settings
         where tenant_id = v_tenant_id and key = 'factory_site_id')
    ) into v_geo_location_id;
    if v_geo_location_id is null then
      return query select false, null::numeric, null::numeric, 'ยังไม่ได้ตั้งค่าตำแหน่งโรงงาน — ติดต่อสำนักงาน'::text;
      return;
    end if;
    select lat, lng into v_site_lat, v_site_lng from checkin_locations where id = v_geo_location_id and tenant_id = v_tenant_id;
  else
    v_geo_location_id := p_site_id;
    select lat, lng into v_site_lat, v_site_lng from sites where id = v_geo_location_id and tenant_id = v_tenant_id;
  end if;

  if v_site_lat is null or v_site_lng is null then
    return query select false, null::numeric, null::numeric, 'ไซท์งานนี้ยังไม่ได้ตั้งพิกัด — ติดต่อสำนักงาน'::text;
    return;
  end if;

  select coalesce((select value::numeric from app_settings where tenant_id = v_tenant_id and key = 'checkin_radius_m'), 200)
    into v_radius;
  v_distance := haversine_distance_m(p_lat, p_lng, v_site_lat, v_site_lng);

  if v_distance > v_radius then
    return query select false, v_distance, v_radius,
      format('คุณอยู่ห่างจากไซท์งาน %s เมตร ต้องอยู่ในระยะ %s เมตรจึงจะเช็คอินได้', round(v_distance), round(v_radius))::text;
    return;
  end if;

  insert into worker_checkins (tenant_id, worker_id, site_id, date, checkin_at, checkin_lat, checkin_lng, checkin_distance_m)
  values (v_tenant_id, p_worker_id, p_site_id, v_today, now(), p_lat, p_lng, v_distance)
  on conflict (worker_id, site_id, date) where site_id is not null do update
    set checkin_at = now(), checkin_lat = p_lat, checkin_lng = p_lng, checkin_distance_m = v_distance;

  update worker_assignments
  set confirmed_at = now(), confirmed_by = 'checkin'
  where worker_id = p_worker_id and site_id = p_site_id and date = v_today
    and type = v_assignment_type and confirmed_at is null and tenant_id = v_tenant_id;

  return query select true, v_distance, v_radius, 'เช็คอินสำเร็จ'::text;
end;
$function$;

CREATE OR REPLACE FUNCTION public.perform_worker_checkout_by_id(p_worker_id uuid, p_site_id uuid, p_lat numeric, p_lng numeric)
 RETURNS TABLE(success boolean, distance_m numeric, radius_m numeric, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant_id uuid;
  v_assignment_type text;
  v_geo_location_id uuid;
  v_site_lat numeric;
  v_site_lng numeric;
  v_radius numeric;
  v_distance numeric;
  v_today date := current_date;
begin
  select tenant_id into v_tenant_id from workers where id = p_worker_id;
  if v_tenant_id is null then
    return query select false, null::numeric, null::numeric, 'ไม่พบข้อมูลพนักงาน'::text;
    return;
  end if;

  if not exists (
    select 1 from worker_checkins
    where worker_id = p_worker_id and site_id = p_site_id and date = v_today and tenant_id = v_tenant_id
  ) then
    return query select false, null::numeric, null::numeric, 'ยังไม่ได้เช็คอินวันนี้ — เช็คอินก่อนจึงจะเช็คเอาท์ได้'::text;
    return;
  end if;

  select type into v_assignment_type from worker_assignments
  where worker_id = p_worker_id and site_id = p_site_id and date = v_today
    and type in ('site', 'factory', 'subcontract') and tenant_id = v_tenant_id
  limit 1;

  if v_assignment_type = 'factory' then
    select coalesce(
      (select checkin_location_id from worker_assignments
         where worker_id = p_worker_id and site_id = p_site_id and date = v_today
           and type = 'factory' and tenant_id = v_tenant_id limit 1),
      (select id from checkin_locations where tenant_id = v_tenant_id and role = 'factory' limit 1),
      (select nullif(value, '')::uuid from app_settings
         where tenant_id = v_tenant_id and key = 'factory_site_id')
    ) into v_geo_location_id;
    if v_geo_location_id is null then
      return query select false, null::numeric, null::numeric, 'ยังไม่ได้ตั้งค่าตำแหน่งโรงงาน — ติดต่อสำนักงาน'::text;
      return;
    end if;
    select lat, lng into v_site_lat, v_site_lng from checkin_locations where id = v_geo_location_id and tenant_id = v_tenant_id;
  else
    v_geo_location_id := p_site_id;
    select lat, lng into v_site_lat, v_site_lng from sites where id = v_geo_location_id and tenant_id = v_tenant_id;
  end if;

  if v_site_lat is null or v_site_lng is null then
    return query select false, null::numeric, null::numeric, 'ไซท์งานนี้ยังไม่ได้ตั้งพิกัด — ติดต่อสำนักงาน'::text;
    return;
  end if;

  select coalesce((select value::numeric from app_settings where tenant_id = v_tenant_id and key = 'checkin_radius_m'), 200)
    into v_radius;
  v_distance := haversine_distance_m(p_lat, p_lng, v_site_lat, v_site_lng);

  if v_distance > v_radius then
    return query select false, v_distance, v_radius,
      format('คุณอยู่ห่างจากไซท์งาน %s เมตร ต้องอยู่ในระยะ %s เมตรจึงจะเช็คเอาท์ได้', round(v_distance), round(v_radius))::text;
    return;
  end if;

  update worker_checkins
  set checkout_at = now(), checkout_lat = p_lat, checkout_lng = p_lng, checkout_distance_m = v_distance
  where worker_id = p_worker_id and site_id = p_site_id and date = v_today and tenant_id = v_tenant_id;

  return query select true, v_distance, v_radius, 'เช็คเอาท์สำเร็จ'::text;
end;
$function$;
