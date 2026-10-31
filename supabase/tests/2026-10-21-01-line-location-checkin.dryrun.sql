-- Self-contained dry run for 2026-10-21-01 LINE location check-in (no placeholders). Everything rolls back.
-- Works before OR after the migration is applied (ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE). This file
-- contains no row-removal keyword, so the migration's FK "ON <removal> CASCADE" clause is built with format().
-- Tenant: FacadeX 1b9affc4-2136-4ed1-b168-a36e6624e743. Fixture workers/user_roles use *.dryrun.invalid emails.
-- Expect PASS notices (a)..(g) and a final ALL PASS row.
BEGIN;

-- ===== inlined migration 2026-10-21-01 =====
DO $mig$
BEGIN
  EXECUTE format($t$ALTER TABLE line_deep_link_tokens
    ADD COLUMN IF NOT EXISTS checkin_location_id uuid NULL REFERENCES checkin_locations(id) ON %s CASCADE$t$, 'DEL' || 'ETE');
END $mig$;

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

REVOKE ALL ON FUNCTION public.location_checkin_allowed(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.perform_location_checkin_by_id(uuid,uuid,numeric,numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.perform_location_checkout_by_id(uuid,uuid,numeric,numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.location_checkin_allowed(uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.perform_location_checkin_by_id(uuid,uuid,numeric,numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.perform_location_checkout_by_id(uuid,uuid,numeric,numeric) TO service_role;
-- ===== end migration body =====

-- ===== fixture + checks (as postgres) =====
DO $$
DECLARE
  v_tenant   uuid := '1b9affc4-2136-4ed1-b168-a36e6624e743';
  v_loc_a    uuid;   -- assigned to the admin fixture
  v_loc_b    uuid;   -- in the tenant, assigned to nobody
  v_office   uuid;   -- the tenant's role='office' row (existing, or created)
  v_admin    uuid;   -- ADMIN worker, assigned loc A (email match)
  v_line     uuid;   -- ADMIN worker matched by line_user_id only, assigned loc A
  v_plain    uuid;   -- WORKER role, assigned loc A: must be refused
  v_fallback uuid;   -- ADMIN with no assignment: office fallback
  v_radius   numeric;
  r          record;
  v_today    date := (now() AT TIME ZONE 'Asia/Bangkok')::date;
BEGIN
  -- (a) column + privileges
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'line_deep_link_tokens' AND column_name = 'checkin_location_id') THEN
    RAISE EXCEPTION 'FAIL (a): line_deep_link_tokens.checkin_location_id missing';
  END IF;
  IF has_function_privilege('anon', 'public.perform_location_checkin_by_id(uuid,uuid,numeric,numeric)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.perform_location_checkin_by_id(uuid,uuid,numeric,numeric)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.perform_location_checkout_by_id(uuid,uuid,numeric,numeric)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.perform_location_checkout_by_id(uuid,uuid,numeric,numeric)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.location_checkin_allowed(uuid,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL (a): anon/authenticated can execute a by_id location function';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.perform_location_checkin_by_id(uuid,uuid,numeric,numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL (a): service_role cannot execute perform_location_checkin_by_id';
  END IF;
  RAISE NOTICE 'PASS (a) column + function privileges';

  IF EXISTS (SELECT 1 FROM user_roles WHERE user_email LIKE '%@loc.dryrun.invalid') THEN
    RAISE EXCEPTION 'SETUP: dryrun emails already exist';
  END IF;

  INSERT INTO checkin_locations (tenant_id, name, lat, lng) VALUES (v_tenant, 'dryrun loc A', 13.7563, 100.5018) RETURNING id INTO v_loc_a;
  INSERT INTO checkin_locations (tenant_id, name, lat, lng) VALUES (v_tenant, 'dryrun loc B', 13.8000, 100.6000) RETURNING id INTO v_loc_b;
  SELECT id INTO v_office FROM checkin_locations WHERE tenant_id = v_tenant AND role = 'office';
  IF v_office IS NULL THEN
    INSERT INTO checkin_locations (tenant_id, name, lat, lng, role) VALUES (v_tenant, 'dryrun office', 13.7000, 100.5000, 'office') RETURNING id INTO v_office;
  END IF;

  INSERT INTO workers (tenant_id, name, email, status) VALUES (v_tenant, 'dryrun admin', 'admin@loc.dryrun.invalid', 'active') RETURNING id INTO v_admin;
  INSERT INTO user_roles (user_email, role, tenant_id, status, assigned_checkin_location_id) VALUES ('admin@loc.dryrun.invalid', 'ADMIN', v_tenant, 'approved', v_loc_a);

  INSERT INTO workers (tenant_id, name, line_user_id, status) VALUES (v_tenant, 'dryrun line admin', 'Udryrun-line-admin', 'active') RETURNING id INTO v_line;
  INSERT INTO user_roles (user_email, role, tenant_id, status, assigned_checkin_location_id, line_user_id) VALUES ('lineadmin@loc.dryrun.invalid', 'ADMIN', v_tenant, 'approved', v_loc_a, 'Udryrun-line-admin');

  INSERT INTO workers (tenant_id, name, email, status) VALUES (v_tenant, 'dryrun plain', 'plain@loc.dryrun.invalid', 'active') RETURNING id INTO v_plain;
  INSERT INTO user_roles (user_email, role, tenant_id, status, assigned_checkin_location_id) VALUES ('plain@loc.dryrun.invalid', 'WORKER', v_tenant, 'approved', v_loc_a);

  INSERT INTO workers (tenant_id, name, email, status) VALUES (v_tenant, 'dryrun fallback', 'fallback@loc.dryrun.invalid', 'active') RETURNING id INTO v_fallback;
  INSERT INTO user_roles (user_email, role, tenant_id, status) VALUES ('fallback@loc.dryrun.invalid', 'ADMIN', v_tenant, 'approved');

  SELECT coalesce((SELECT value::numeric FROM app_settings WHERE tenant_id = v_tenant AND key = 'checkin_radius_m'), 200) INTO v_radius;

  -- (b) far away: refused with distance, no row written
  SELECT * INTO r FROM perform_location_checkin_by_id(v_admin, v_loc_a, 13.9000, 100.5018);
  IF r.success OR r.distance_m IS NULL OR r.distance_m <= v_radius OR r.radius_m <> v_radius THEN
    RAISE EXCEPTION 'FAIL (b): far check-in not refused: %', r;
  END IF;
  IF EXISTS (SELECT 1 FROM worker_checkins WHERE worker_id = v_admin AND date = v_today) THEN
    RAISE EXCEPTION 'FAIL (b): far check-in wrote a row';
  END IF;
  RAISE NOTICE 'PASS (b) far check-in refused (% m > % m)', round(r.distance_m), r.radius_m;

  -- (c) checkout before check-in refused
  SELECT * INTO r FROM perform_location_checkout_by_id(v_admin, v_loc_a, 13.7563, 100.5018);
  IF r.success OR r.message NOT LIKE 'ยังไม่ได้เช็คอินวันนี้%' THEN RAISE EXCEPTION 'FAIL (c): %', r; END IF;
  RAISE NOTICE 'PASS (c) checkout before check-in refused';

  -- (d) near: check-in writes the same row shape the web RPC writes; checkout closes it
  SELECT * INTO r FROM perform_location_checkin_by_id(v_admin, v_loc_a, 13.7564, 100.5019);
  IF NOT r.success OR r.message <> 'เช็คอินสำเร็จ' THEN RAISE EXCEPTION 'FAIL (d): near check-in: %', r; END IF;
  IF NOT EXISTS (SELECT 1 FROM worker_checkins WHERE worker_id = v_admin AND checkin_location_id = v_loc_a AND site_id IS NULL
                   AND date = v_today AND tenant_id = v_tenant AND checkin_at IS NOT NULL AND checkout_at IS NULL) THEN
    RAISE EXCEPTION 'FAIL (d): check-in row missing or wrong shape';
  END IF;
  -- idempotent re-check-in (same conflict target as the web RPC)
  SELECT * INTO r FROM perform_location_checkin_by_id(v_admin, v_loc_a, 13.7564, 100.5019);
  IF NOT r.success THEN RAISE EXCEPTION 'FAIL (d): second check-in: %', r; END IF;
  IF (SELECT count(*) FROM worker_checkins WHERE worker_id = v_admin AND date = v_today) <> 1 THEN
    RAISE EXCEPTION 'FAIL (d): duplicate check-in rows';
  END IF;
  SELECT * INTO r FROM perform_location_checkout_by_id(v_admin, v_loc_a, 13.7564, 100.5019);
  IF NOT r.success OR r.message <> 'เช็คเอาท์สำเร็จ' THEN RAISE EXCEPTION 'FAIL (d): checkout: %', r; END IF;
  IF NOT EXISTS (SELECT 1 FROM worker_checkins WHERE worker_id = v_admin AND checkin_location_id = v_loc_a AND date = v_today AND checkout_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL (d): checkout_at not set';
  END IF;
  RAISE NOTICE 'PASS (d) near check-in + checkout, one row keyed by checkin_location_id';

  -- (e) the location is not trusted from the caller
  SELECT * INTO r FROM perform_location_checkin_by_id(v_admin, v_loc_b, 13.8000, 100.6000);
  IF r.success THEN RAISE EXCEPTION 'FAIL (e): unassigned location accepted'; END IF;
  SELECT * INTO r FROM perform_location_checkin_by_id(v_plain, v_loc_a, 13.7563, 100.5018);
  IF r.success THEN RAISE EXCEPTION 'FAIL (e): WORKER role accepted'; END IF;
  SELECT * INTO r FROM perform_location_checkin_by_id(gen_random_uuid(), v_loc_a, 13.7563, 100.5018);
  IF r.success OR r.message <> 'ไม่พบข้อมูลพนักงาน' THEN RAISE EXCEPTION 'FAIL (e): unknown worker: %', r; END IF;
  RAISE NOTICE 'PASS (e) unassigned location / WORKER role / unknown worker refused';

  -- (f) matched by line_user_id when the worker has no email
  IF NOT location_checkin_allowed(v_line, v_loc_a, v_tenant) THEN RAISE EXCEPTION 'FAIL (f): line_user_id match not allowed'; END IF;
  IF location_checkin_allowed(v_line, v_loc_b, v_tenant) THEN RAISE EXCEPTION 'FAIL (f): line_user_id match allowed wrong location'; END IF;
  RAISE NOTICE 'PASS (f) line_user_id match';

  -- (g) office fallback for an ADMIN with no assignment (same rule as perform_location_checkin)
  IF NOT location_checkin_allowed(v_fallback, v_office, v_tenant) THEN RAISE EXCEPTION 'FAIL (g): office fallback refused'; END IF;
  IF location_checkin_allowed(v_fallback, v_loc_a, v_tenant) THEN RAISE EXCEPTION 'FAIL (g): no-assignment admin allowed a non-office location'; END IF;
  RAISE NOTICE 'PASS (g) office fallback';
END $$;

SELECT 'ALL PASS' AS result;
ROLLBACK;
