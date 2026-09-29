-- supabase/migrations/2026-09-29-04-checkin-rpc-factory-branch.sql
-- Swaps perform_worker_checkin_by_id/perform_worker_checkout_by_id's
-- factory-branch lookup from `sites` to `checkin_locations` (spec:
-- 2026-09-29-checkin-locations-design.md). The web-app variants
-- (perform_worker_checkin/perform_worker_checkout, no _by_id) never had
-- factory-branch logic and are untouched by this migration.

CREATE OR REPLACE FUNCTION public.perform_worker_checkin_by_id(p_worker_id uuid, p_site_id uuid, p_lat numeric, p_lng numeric)
 RETURNS TABLE(success boolean, distance_m numeric, radius_m numeric, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant_id uuid;
  v_assignment_type text;
  v_geo_location_id uuid;   -- the checkin_locations/sites row whose coordinates actually get distance-checked
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

  -- งานที่โรงงาน (factory) เช็คอินตามพิกัดตำแหน่งที่ตั้งค่าไว้ ไม่ใช่พิกัด
  -- ไซท์ลูกค้าที่งานนั้นถูกเบิกไป -- คนทำงานโรงงานตัวจริงอยู่ที่โรงงาน.
  -- Prefer the assignment's own checkin_location_id (once set); fall back
  -- to the tenant-wide factory_site_id app_setting for any assignment that
  -- hasn't been given a specific location yet (no backfill of history).
  if v_assignment_type = 'factory' then
    select coalesce(
      (select checkin_location_id from worker_assignments
         where worker_id = p_worker_id and site_id = p_site_id and date = v_today
           and type = 'factory' and tenant_id = v_tenant_id limit 1),
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

  -- Same factory-location substitution as check-in, keyed off today's
  -- assignment type for this same worker/site (not stored on
  -- worker_checkins itself).
  select type into v_assignment_type from worker_assignments
  where worker_id = p_worker_id and site_id = p_site_id and date = v_today
    and type in ('site', 'factory', 'subcontract') and tenant_id = v_tenant_id
  limit 1;

  if v_assignment_type = 'factory' then
    select coalesce(
      (select checkin_location_id from worker_assignments
         where worker_id = p_worker_id and site_id = p_site_id and date = v_today
           and type = 'factory' and tenant_id = v_tenant_id limit 1),
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
