-- Fixes a real architecture gap surfaced by user feedback on the crew-bot
-- reference doc: the LINE bot's เช็คอิน/เช็คเอาท์ was writing to its own
-- line_checkins table with NO geofencing at all -- completely
-- disconnected from the real, more sophisticated check-in system the
-- web app already has (TodayCheckinCard.jsx -> perform_worker_checkin/
-- perform_worker_checkout RPCs -> worker_checkins table, sites.lat/lng,
-- app_settings.checkin_radius_m, haversine_distance_m()). Confirmed live:
-- line_checkins had zero rows, so nothing is lost switching the bot onto
-- the real system instead of maintaining a second, lesser one.
--
-- perform_worker_checkin/checkout resolve the worker via
-- `WHERE email = auth.email()` -- only meaningful for an authenticated
-- user's own session, which the LINE webhook (service-role client, no
-- particular user's JWT) never has. These _by_id twins take the worker
-- id directly instead (already resolved+authenticated by the webhook's
-- own LINE-signature verification), otherwise running the EXACT same
-- validation/geofence/insert logic as the originals -- one source of
-- truth for the distance math and error copy, not a second
-- implementation to drift out of sync. Locked to service_role only:
-- anon/authenticated must keep going through the real RPCs (which
-- enforce it's genuinely their own account), never these.
create or replace function public.perform_worker_checkin_by_id(p_worker_id uuid, p_site_id uuid, p_lat numeric, p_lng numeric)
returns table(success boolean, distance_m numeric, radius_m numeric, message text)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tenant_id uuid;
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

  select lat, lng into v_site_lat, v_site_lng from sites where id = p_site_id and tenant_id = v_tenant_id;
  if v_site_lat is null or v_site_lng is null then
    return query select false, null::numeric, null::numeric, 'ไซท์งานนี้ยังไม่ได้ตั้งพิกัด — ติดต่อสำนักงาน'::text;
    return;
  end if;

  if not exists (
    select 1 from worker_assignments
    where worker_id = p_worker_id and site_id = p_site_id and date = v_today and type = 'site' and tenant_id = v_tenant_id
  ) then
    return query select false, null::numeric, null::numeric, 'ไม่พบตารางงานของคุณที่ไซท์นี้วันนี้ — ติดต่อสำนักงาน'::text;
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
    and type = 'site' and confirmed_at is null and tenant_id = v_tenant_id;

  return query select true, v_distance, v_radius, 'เช็คอินสำเร็จ'::text;
end;
$$;

revoke all on function public.perform_worker_checkin_by_id(uuid,uuid,numeric,numeric) from public;
revoke all on function public.perform_worker_checkin_by_id(uuid,uuid,numeric,numeric) from anon;
revoke all on function public.perform_worker_checkin_by_id(uuid,uuid,numeric,numeric) from authenticated;
grant execute on function public.perform_worker_checkin_by_id(uuid,uuid,numeric,numeric) to service_role;

-- Checkout twin. Deliberately does NOT include perform_worker_checkout's
-- optional OT (overtime) auto-detection -- that depends on the regular-
-- shift-end setting + same-session time math the web app's
-- TodayCheckinCard.jsx already owns; the bot's checkout stays a plain
-- geofenced checkout for now, OT entry stays an admin/web-app action.
create or replace function public.perform_worker_checkout_by_id(p_worker_id uuid, p_site_id uuid, p_lat numeric, p_lng numeric)
returns table(success boolean, distance_m numeric, radius_m numeric, message text)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tenant_id uuid;
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

  select lat, lng into v_site_lat, v_site_lng from sites where id = p_site_id and tenant_id = v_tenant_id;
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
$$;

revoke all on function public.perform_worker_checkout_by_id(uuid,uuid,numeric,numeric) from public;
revoke all on function public.perform_worker_checkout_by_id(uuid,uuid,numeric,numeric) from anon;
revoke all on function public.perform_worker_checkout_by_id(uuid,uuid,numeric,numeric) from authenticated;
grant execute on function public.perform_worker_checkout_by_id(uuid,uuid,numeric,numeric) to service_role;

-- line_checkins is now dead: the bot writes to worker_checkins (the real
-- table) instead. Confirmed zero rows live before dropping.
drop table if exists line_checkins;
