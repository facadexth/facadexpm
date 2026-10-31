-- 2026-10-21-01: LINE เช็คอิน/เช็คเอาท์ at a fixed check-in location (office admin with no
-- site assignment today). Found live 2026-10-21: โปรย (ADMIN, assigned_checkin_location_id
-- = office) got "ไม่พบงานที่มอบหมายวันนี้" from the bot, while the web's LocationCheckinCard
-- works for her.
--
-- 1) line_deep_link_tokens.checkin_location_id: a check-in/out link can name a
--    checkin_locations row instead of a site (site_id stays for site links).
-- 2) perform_location_checkin_by_id / perform_location_checkout_by_id: service-role twins
--    of perform_location_checkin/checkout (the web RPCs, which resolve everything from
--    auth.email() -- a LINE webhook has no user JWT). Same radius rule
--    (app_settings.checkin_radius_m, default 200), same worker_checkins row keyed by
--    (worker_id, checkin_location_id, date), same messages, so web and LINE agree. The
--    location is NOT trusted from the caller: the worker's user_roles row (matched by
--    workers.email = user_roles.user_email, or by the same line_user_id) must be
--    ADMIN/OWNER/PM and either have p_location_id assigned, or have no assignment while
--    p_location_id is the tenant's role='office' location -- the exact rule the web RPC
--    applies. Grants mirror perform_worker_checkin_by_id (service_role only).

ALTER TABLE line_deep_link_tokens
  ADD COLUMN IF NOT EXISTS checkin_location_id uuid NULL REFERENCES checkin_locations(id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION public.location_checkin_allowed(p_worker_id uuid, p_location_id uuid, p_tenant_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM workers w
    JOIN user_roles ur
      ON ur.tenant_id = w.tenant_id
     AND ((w.email IS NOT NULL AND ur.user_email = w.email)
          OR (w.line_user_id IS NOT NULL AND ur.line_user_id = w.line_user_id))
    JOIN checkin_locations cl ON cl.id = p_location_id AND cl.tenant_id = w.tenant_id
    WHERE w.id = p_worker_id
      AND w.tenant_id = p_tenant_id
      AND ur.role IN ('ADMIN', 'OWNER', 'PM')
      AND (ur.assigned_checkin_location_id = cl.id
           OR (ur.assigned_checkin_location_id IS NULL AND cl.role = 'office'))
  );
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

  insert into worker_checkins (tenant_id, worker_id, checkin_location_id, date, checkin_at, checkin_lat, checkin_lng, checkin_distance_m)
  values (v_tenant_id, p_worker_id, p_location_id, v_today, now(), p_lat, p_lng, v_distance)
  on conflict (worker_id, checkin_location_id, date) where checkin_location_id is not null do update
    set checkin_at = now(), checkin_lat = p_lat, checkin_lng = p_lng, checkin_distance_m = v_distance;

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
  where worker_id = p_worker_id and checkin_location_id = p_location_id and date = v_today and tenant_id = v_tenant_id;

  return query select true, v_distance, v_radius, 'เช็คเอาท์สำเร็จ'::text;
end;
$function$;

-- Server-only, same as perform_worker_checkin_by_id (2026-09-23-05): no user JWT may call
-- a function that clocks an arbitrary worker.
REVOKE ALL ON FUNCTION public.location_checkin_allowed(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.perform_location_checkin_by_id(uuid,uuid,numeric,numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.perform_location_checkout_by_id(uuid,uuid,numeric,numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.location_checkin_allowed(uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.perform_location_checkin_by_id(uuid,uuid,numeric,numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.perform_location_checkout_by_id(uuid,uuid,numeric,numeric) TO service_role;
