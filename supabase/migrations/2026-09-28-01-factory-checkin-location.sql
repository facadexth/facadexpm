-- supabase/migrations/2026-09-28-01-factory-checkin-location.sql
--
-- Fixes two real bugs found together while investigating "no submenu on
-- งานวันนี้" for factory-assigned workers:
--
-- 1. perform_worker_checkin_by_id's own "do you have a real assignment
--    here today" existence check only accepted type = 'site' -- a
--    worker whose today's worker_assignments row is type 'factory' (or
--    'subcontract') was ALWAYS rejected with "ไม่พบตารางงานของคุณที่ไซท์นี้
--    วันนี้", even though the LINE bot's own resolveTodaysSite() (and
--    handleTodaysJobMenu) happily includes 'site'/'factory'/'subcontract'
--    and shows them a เช็คอิน button that could never actually succeed.
--
-- 2. For factory-type work, worker_assignments.site_id points at
--    whichever CUSTOMER project the factory work is billed to (see
--    query during investigation: type='factory' rows' site_id joins to
--    real customer sites like "บ้านคุณฝ้าย เสนา", not a literal factory
--    building) -- so even with bug 1 fixed, comparing GPS distance
--    against that customer site's coordinates would never make sense: a
--    worker doing factory/shop work is physically at the factory, not
--    at the customer's address. Confirmed with the user (AskUserQuestion,
--    2026-09-28): factory-type check-in should validate against ONE
--    shared factory location instead.
--
-- New per-tenant `factory_site_id` app_setting (same key-value pattern
-- as the existing `checkin_radius_m`/`regular_shift_end_time`) points at
-- whichever real `sites` row the OWNER designates as the factory --
-- reuses the ALREADY-EXISTING lat/lng fields + "ใช้ตำแหน่งปัจจุบัน" button
-- on the Sites edit form (Sites.jsx), no new site-editing UI needed.
--
-- The other open question from the same investigation -- what to do
-- about the 139/140 sites with NO coordinates set at all -- is
-- deliberately NOT touched here: the user chose "keep rejecting until
-- coordinates are set" (AskUserQuestion, 2026-09-28), i.e. current
-- behavior for that case stays exactly as-is.

CREATE OR REPLACE FUNCTION public.perform_worker_checkin_by_id(p_worker_id uuid, p_site_id uuid, p_lat numeric, p_lng numeric)
 RETURNS TABLE(success boolean, distance_m numeric, radius_m numeric, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant_id uuid;
  v_assignment_type text;
  v_geo_site_id uuid;   -- the site whose coordinates actually get distance-checked
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

  -- งานที่โรงงาน (factory) เช็คอินตามพิกัดโรงงานที่ตั้งค่าไว้ ไม่ใช่พิกัดไซท์
  -- ลูกค้าที่งานนั้นถูกเบิกไป -- คนทำงานโรงงานตัวจริงอยู่ที่โรงงาน
  if v_assignment_type = 'factory' then
    select nullif(value, '')::uuid into v_geo_site_id
    from app_settings where tenant_id = v_tenant_id and key = 'factory_site_id';
    if v_geo_site_id is null then
      return query select false, null::numeric, null::numeric, 'ยังไม่ได้ตั้งค่าตำแหน่งโรงงาน — ติดต่อสำนักงาน'::text;
      return;
    end if;
  else
    v_geo_site_id := p_site_id;
  end if;

  select lat, lng into v_site_lat, v_site_lng from sites where id = v_geo_site_id and tenant_id = v_tenant_id;
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
  on conflict (worker_id, site_id, date) do update
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
  v_geo_site_id uuid;
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
    select nullif(value, '')::uuid into v_geo_site_id
    from app_settings where tenant_id = v_tenant_id and key = 'factory_site_id';
    if v_geo_site_id is null then
      return query select false, null::numeric, null::numeric, 'ยังไม่ได้ตั้งค่าตำแหน่งโรงงาน — ติดต่อสำนักงาน'::text;
      return;
    end if;
  else
    v_geo_site_id := p_site_id;
  end if;

  select lat, lng into v_site_lat, v_site_lng from sites where id = v_geo_site_id and tenant_id = v_tenant_id;
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
