-- Rolled-back check for supabase/migrations/2026-10-17-04-pm-role.sql.
-- Run: npx supabase db query --linked -f supabase/tests/2026-10-17-04-pm-role.test.sql
-- db query has no \i, so the migration body is inlined below (without its
-- BEGIN/COMMIT). Keep it in sync with the migration file. The DO block ends
-- in RAISE EXCEPTION 'RESULT ...', so nothing persists. Never run the
-- migration file alone as a test.
-- Expected: every *_MUST0 is 0, *_MUSTfalse is false, *_MUSTfail holds an
-- error, site-ops counts equal the demo tenant's real counts, w_* writes ok/1.
BEGIN;

-- ===== inlined migration body =====
-- PM (site manager) role. Sibling of ADMIN: runs sites, never reads money.
-- Spec: docs/superpowers/specs/2026-10-17-gantt-weighted-progress-design.md §13
-- Rolled-back check: supabase/tests/2026-10-17-04-pm-role.test.sql
-- Every ALTER POLICY / recreated function below is the live definition
-- (pg_policies / pg_get_functiondef, read 2026-10-17) with only the role
-- check changed.

ALTER TABLE user_roles DROP CONSTRAINT user_roles_role_check;
ALTER TABLE user_roles ADD CONSTRAINT user_roles_role_check
  CHECK (role = ANY (ARRAY['OWNER','ADMIN','PM','WORKER']));

CREATE OR REPLACE FUNCTION public.is_pm() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT COALESCE(current_user_role() = 'PM', false) $$;

CREATE OR REPLACE FUNCTION public.is_site_staff() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT COALESCE(current_user_role() IN ('OWNER','ADMIN','PM'), false) $$;

CREATE OR REPLACE FUNCTION public.can_manage_teams() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT COALESCE(current_user_role() IN ('OWNER','PM'), false) $$;

REVOKE ALL ON FUNCTION public.is_pm(), public.is_site_staff(), public.can_manage_teams() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_pm(), public.is_site_staff(), public.can_manage_teams() TO authenticated;

-- Seats: PM uses an admin seat.
CREATE OR REPLACE FUNCTION public.tenant_under_seat_limit(p_kind text, p_inclusive boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant_id UUID := current_tenant_id();
  v_limit NUMERIC;
  v_count NUMERIC;
BEGIN
  SELECT CASE p_kind
    WHEN 'admins'  THEN p.max_admins
    WHEN 'workers' THEN p.max_workers
    WHEN 'sites'   THEN p.max_sites
  END INTO v_limit
  FROM tenants t
  LEFT JOIN packages p ON p.id = t.package_id
  WHERE t.id = v_tenant_id;

  IF v_limit IS NULL THEN
    RETURN true;
  END IF;

  CASE p_kind
    WHEN 'admins' THEN
      SELECT count(*) INTO v_count FROM user_roles
      WHERE tenant_id = v_tenant_id AND role IN ('OWNER','ADMIN','PM');
    WHEN 'workers' THEN
      SELECT count(*) INTO v_count FROM workers WHERE tenant_id = v_tenant_id;
    WHEN 'sites' THEN
      SELECT count(*) INTO v_count FROM sites
      WHERE tenant_id = v_tenant_id AND status = 'Ongoing';
  END CASE;

  RETURN CASE WHEN p_inclusive THEN v_count <= v_limit ELSE v_count < v_limit END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tenant_seat_status()
 RETURNS TABLE(kind text, used bigint, max_allowed integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant_id UUID := current_tenant_id();
  v_max_admins INT;
  v_max_workers INT;
  v_max_sites INT;
BEGIN
  SELECT p.max_admins, p.max_workers, p.max_sites
  INTO v_max_admins, v_max_workers, v_max_sites
  FROM tenants t LEFT JOIN packages p ON p.id = t.package_id
  WHERE t.id = v_tenant_id;

  RETURN QUERY SELECT 'admins'::TEXT,
    (SELECT count(*) FROM user_roles WHERE tenant_id = v_tenant_id AND role IN ('OWNER','ADMIN','PM')), v_max_admins
  UNION ALL SELECT 'workers'::TEXT,
    (SELECT count(*) FROM workers WHERE tenant_id = v_tenant_id), v_max_workers
  UNION ALL SELECT 'sites'::TEXT,
    (SELECT count(*) FROM sites WHERE tenant_id = v_tenant_id AND status = 'Ongoing'), v_max_sites;
END;
$function$;

-- user_roles: OWNER may add/promote PM, subject to the admin seat limit.
ALTER POLICY owner_inserts ON user_roles
  WITH CHECK ((( SELECT is_owner() AS is_owner) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT tenant_can_write() AS tenant_can_write) AND ((role <> ALL (ARRAY['OWNER'::text, 'ADMIN'::text, 'PM'::text])) OR tenant_under_seat_limit('admins'::text))));
ALTER POLICY owner_updates ON user_roles
  WITH CHECK ((( SELECT is_owner() AS is_owner) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT tenant_can_write() AS tenant_can_write) AND ((role <> ALL (ARRAY['OWNER'::text, 'ADMIN'::text, 'PM'::text])) OR (EXISTS ( SELECT 1
   FROM user_roles old
  WHERE ((old.id = user_roles.id) AND (old.role = ANY (ARRAY['OWNER'::text, 'ADMIN'::text, 'PM'::text]))))) OR tenant_under_seat_limit('admins'::text))));

-- Site-ops policies: ( SELECT is_admin_or_owner() ) -> ( SELECT is_site_staff() ).
-- clients / suppliers: reads only; their writes stay admin.

-- site_phases
ALTER POLICY admin_reads ON site_phases
  USING ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id))));
ALTER POLICY admin_inserts ON site_phases
  WITH CHECK ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT tenant_can_write() AS tenant_can_write)));
ALTER POLICY admin_updates ON site_phases
  USING ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT tenant_can_write() AS tenant_can_write)))
  WITH CHECK ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT tenant_can_write() AS tenant_can_write)));
ALTER POLICY admin_deletes ON site_phases
  USING ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT tenant_can_write() AS tenant_can_write)));

-- phase_subtasks
ALTER POLICY admin_reads ON phase_subtasks
  USING ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id))));
ALTER POLICY admin_inserts ON phase_subtasks
  WITH CHECK ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT tenant_can_write() AS tenant_can_write)));
ALTER POLICY admin_updates ON phase_subtasks
  USING ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT tenant_can_write() AS tenant_can_write)))
  WITH CHECK ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT tenant_can_write() AS tenant_can_write)));
ALTER POLICY admin_deletes ON phase_subtasks
  USING ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT tenant_can_write() AS tenant_can_write)));

-- phase_tasks
ALTER POLICY admin_reads ON phase_tasks
  USING ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id))));
ALTER POLICY admin_inserts ON phase_tasks
  WITH CHECK ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT tenant_can_write() AS tenant_can_write)));
ALTER POLICY admin_updates ON phase_tasks
  USING ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT tenant_can_write() AS tenant_can_write)))
  WITH CHECK ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT tenant_can_write() AS tenant_can_write)));
ALTER POLICY admin_deletes ON phase_tasks
  USING ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT tenant_can_write() AS tenant_can_write)));

-- phase_task_workers
ALTER POLICY admin_reads ON phase_task_workers
  USING ((( SELECT is_site_staff() ) AND (EXISTS ( SELECT 1
   FROM phase_tasks pt
  WHERE ((pt.id = phase_task_workers.task_id) AND (pt.tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)))))));
ALTER POLICY admin_inserts ON phase_task_workers
  WITH CHECK ((( SELECT is_site_staff() ) AND ( SELECT tenant_can_write() AS tenant_can_write) AND (EXISTS ( SELECT 1
   FROM phase_tasks pt
  WHERE ((pt.id = phase_task_workers.task_id) AND (pt.tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)))))));
ALTER POLICY admin_updates ON phase_task_workers
  USING ((( SELECT is_site_staff() ) AND ( SELECT tenant_can_write() AS tenant_can_write) AND (EXISTS ( SELECT 1
   FROM phase_tasks pt
  WHERE ((pt.id = phase_task_workers.task_id) AND (pt.tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)))))))
  WITH CHECK ((( SELECT is_site_staff() ) AND ( SELECT tenant_can_write() AS tenant_can_write) AND (EXISTS ( SELECT 1
   FROM phase_tasks pt
  WHERE ((pt.id = phase_task_workers.task_id) AND (pt.tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)))))));
ALTER POLICY admin_deletes ON phase_task_workers
  USING ((( SELECT is_site_staff() ) AND ( SELECT tenant_can_write() AS tenant_can_write) AND (EXISTS ( SELECT 1
   FROM phase_tasks pt
  WHERE ((pt.id = phase_task_workers.task_id) AND (pt.tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)))))));

-- worker_assignments
ALTER POLICY admin_inserts ON worker_assignments
  WITH CHECK ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT has_module_access('payroll'::text) AS has_module_access)));
ALTER POLICY admin_updates ON worker_assignments
  USING ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT has_module_access('payroll'::text) AS has_module_access)))
  WITH CHECK ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT has_module_access('payroll'::text) AS has_module_access)));
ALTER POLICY admin_deletes ON worker_assignments
  USING ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT has_module_access('payroll'::text) AS has_module_access)));
ALTER POLICY worker_reads_own ON worker_assignments
  USING (((tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT has_module_access('payroll'::text) AS has_module_access) AND (( SELECT is_site_staff() ) OR (worker_id IN ( SELECT workers.id
   FROM workers
  WHERE (workers.email = ( SELECT auth.email() AS email)))))));

-- worker_ot
ALTER POLICY admin_inserts ON worker_ot
  WITH CHECK ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT has_module_access('payroll'::text) AS has_module_access)));
ALTER POLICY admin_updates ON worker_ot
  USING ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT has_module_access('payroll'::text) AS has_module_access)))
  WITH CHECK ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT has_module_access('payroll'::text) AS has_module_access)));
ALTER POLICY admin_deletes ON worker_ot
  USING ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT has_module_access('payroll'::text) AS has_module_access)));
ALTER POLICY worker_reads_own ON worker_ot
  USING (((tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT has_module_access('payroll'::text) AS has_module_access) AND (( SELECT is_site_staff() ) OR (worker_id IN ( SELECT workers.id
   FROM workers
  WHERE (workers.email = ( SELECT auth.email() AS email)))))));

-- site_attachments
ALTER POLICY admin_full_access ON site_attachments
  USING ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id))))
  WITH CHECK ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id))));

-- line_site_photos
ALTER POLICY admin_reads ON line_site_photos
  USING ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id))));
ALTER POLICY admin_inserts ON line_site_photos
  WITH CHECK ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT tenant_can_write() AS tenant_can_write)));
ALTER POLICY admin_updates ON line_site_photos
  USING ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id))))
  WITH CHECK ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT tenant_can_write() AS tenant_can_write)));
ALTER POLICY admin_deletes ON line_site_photos
  USING ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT tenant_can_write() AS tenant_can_write)));

-- line_issue_reports
ALTER POLICY admin_reads ON line_issue_reports
  USING ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id))));
ALTER POLICY admin_updates ON line_issue_reports
  USING ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT tenant_can_write() AS tenant_can_write)))
  WITH CHECK ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT tenant_can_write() AS tenant_can_write)));

-- line_checkins
ALTER POLICY admin_reads ON line_checkins
  USING ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id))));

-- clients
ALTER POLICY admin_reads ON clients
  USING ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id))));

-- suppliers
ALTER POLICY admin_reads ON suppliers
  USING ((( SELECT is_site_staff() ) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id))));

-- storage.objects (DROP + CREATE; same command, role and expression, only the role helper changes)
DROP POLICY site_attachments_tenant_access ON storage.objects;
CREATE POLICY site_attachments_tenant_access ON storage.objects FOR ALL TO authenticated
  USING (((bucket_id = 'site-attachments'::text) AND is_site_staff() AND ((storage.foldername(name))[1] = (current_tenant_id())::text)))
  WITH CHECK (((bucket_id = 'site-attachments'::text) AND is_site_staff() AND ((storage.foldername(name))[1] = (current_tenant_id())::text)));
DROP POLICY line_site_photos_tenant_access ON storage.objects;
CREATE POLICY line_site_photos_tenant_access ON storage.objects FOR SELECT TO authenticated
  USING (((bucket_id = 'line-site-photos'::text) AND ((storage.foldername(name))[1] = (current_tenant_id())::text) AND is_site_staff()));
DROP POLICY line_site_photos_uploads ON storage.objects;
CREATE POLICY line_site_photos_uploads ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (((bucket_id = 'line-site-photos'::text) AND ((storage.foldername(name))[1] = (current_tenant_id())::text) AND (is_site_staff() OR (my_worker_id() IS NOT NULL)) AND tenant_can_write()));
DROP POLICY line_site_photos_deletes ON storage.objects;
CREATE POLICY line_site_photos_deletes ON storage.objects FOR DELETE TO authenticated
  USING (((bucket_id = 'line-site-photos'::text) AND ((storage.foldername(name))[1] = (current_tenant_id())::text) AND (is_site_staff() OR (my_worker_id() IS NOT NULL))));


-- New PM-only policies (the existing FOR ALL admin policies are untouched).
CREATE POLICY pm_full_access ON leave_requests FOR ALL
  USING (( SELECT is_pm() ) AND tenant_id = ( SELECT current_tenant_id() ))
  WITH CHECK (( SELECT is_pm() ) AND tenant_id = ( SELECT current_tenant_id() ));
CREATE POLICY pm_reads ON worker_checkins FOR SELECT
  USING (( SELECT is_pm() ) AND tenant_id = ( SELECT current_tenant_id() ));
CREATE POLICY pm_reads ON units FOR SELECT
  USING (( SELECT is_pm() ) AND tenant_id = ( SELECT current_tenant_id() ));

-- RPC role checks: PM may use office check-in/out and web push.
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
  v_today date := current_date;
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

CREATE OR REPLACE FUNCTION public.register_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_email  TEXT := auth.jwt() ->> 'email';
  v_tenant UUID := current_tenant_id();
  v_known  BOOLEAN;
BEGIN
  IF v_email IS NULL OR v_tenant IS NULL OR NOT is_site_staff() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_endpoint IS NULL OR p_endpoint !~ '^https://' OR length(p_endpoint) > 1000
     OR coalesce(p_p256dh, '') = '' OR coalesce(p_auth, '') = '' THEN
    RAISE EXCEPTION 'invalid subscription' USING ERRCODE = '22023';
  END IF;

  SELECT EXISTS (SELECT 1 FROM push_subscriptions WHERE endpoint = p_endpoint) INTO v_known;
  IF NOT v_known AND (SELECT count(*) FROM push_subscriptions WHERE user_email = v_email) >= 20 THEN
    RAISE EXCEPTION 'too many devices' USING ERRCODE = '54000';
  END IF;

  INSERT INTO push_subscriptions (tenant_id, user_email, endpoint, p256dh_key, auth_key, user_agent)
  VALUES (v_tenant, v_email, p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  ON CONFLICT (endpoint) DO UPDATE
    SET tenant_id = EXCLUDED.tenant_id, user_email = EXCLUDED.user_email,
        p256dh_key = EXCLUDED.p256dh_key, auth_key = EXCLUDED.auth_key,
        user_agent = EXCLUDED.user_agent, failure_count = 0;
END;
$function$;


-- ===== end of migration body =====

DO $$
DECLARE
  v_tenant uuid; v_email text := 'pm-test@example.invalid'; r jsonb := '{}';
  n int; v_site uuid; v_worker uuid; v_leave uuid; v_phase uuid; v_task uuid;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE company_name ILIKE '%สร้างดี%' LIMIT 1;  -- demo tenant
  SELECT id INTO v_site FROM sites WHERE tenant_id = v_tenant ORDER BY created_at LIMIT 1;
  SELECT id INTO v_worker FROM workers WHERE tenant_id = v_tenant ORDER BY created_at LIMIT 1;
  SELECT id INTO v_leave FROM leave_requests WHERE tenant_id = v_tenant ORDER BY requested_at LIMIT 1;
  r := r || jsonb_build_object('tenant', v_tenant, 'have_site', v_site IS NOT NULL,
         'have_worker', v_worker IS NOT NULL, 'have_leave', v_leave IS NOT NULL);
  INSERT INTO user_roles (user_email, role, tenant_id, status) VALUES (v_email, 'PM', v_tenant, 'approved');
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_email, 'role', 'authenticated', 'sub', gen_random_uuid())::text, true);
  SET LOCAL ROLE authenticated;
  r := r || jsonb_build_object('current_tenant_ok', current_tenant_id() = v_tenant);

  -- site ops: must equal the demo tenant's real counts
  SELECT count(*) INTO n FROM site_phases;  r := r || jsonb_build_object('site_phases', n);
  SELECT count(*) INTO n FROM phase_tasks;  r := r || jsonb_build_object('phase_tasks', n);
  SELECT count(*) INTO n FROM phase_subtasks; r := r || jsonb_build_object('phase_subtasks', n);
  SELECT count(*) INTO n FROM worker_assignments; r := r || jsonb_build_object('worker_assignments', n);
  SELECT count(*) INTO n FROM worker_ot; r := r || jsonb_build_object('worker_ot', n);
  SELECT count(*) INTO n FROM leave_requests; r := r || jsonb_build_object('leave_requests', n);
  SELECT count(*) INTO n FROM line_site_photos; r := r || jsonb_build_object('line_site_photos', n);
  SELECT count(*) INTO n FROM site_attachments; r := r || jsonb_build_object('site_attachments', n);
  SELECT count(*) INTO n FROM worker_checkins; r := r || jsonb_build_object('worker_checkins', n);
  SELECT count(*) INTO n FROM units; r := r || jsonb_build_object('units', n);
  SELECT count(*) INTO n FROM clients; r := r || jsonb_build_object('clients', n);
  SELECT count(*) INTO n FROM suppliers; r := r || jsonb_build_object('suppliers', n);

  -- money: all must be 0
  SELECT count(*) INTO n FROM sites;     r := r || jsonb_build_object('sites_MUST0', n);
  SELECT count(*) INTO n FROM workers;   r := r || jsonb_build_object('workers_MUST0', n);
  SELECT count(*) INTO n FROM incomes;   r := r || jsonb_build_object('incomes_MUST0', n);
  SELECT count(*) INTO n FROM expenses;  r := r || jsonb_build_object('expenses_MUST0', n);
  SELECT count(*) INTO n FROM invoices;  r := r || jsonb_build_object('invoices_MUST0', n);
  SELECT count(*) INTO n FROM quotations; r := r || jsonb_build_object('quotations_MUST0', n);
  SELECT count(*) INTO n FROM quotation_items; r := r || jsonb_build_object('quotation_items_MUST0', n);
  SELECT count(*) INTO n FROM cheques;   r := r || jsonb_build_object('cheques_MUST0', n);
  SELECT count(*) INTO n FROM salary_records; r := r || jsonb_build_object('salary_MUST0', n);
  SELECT count(*) INTO n FROM purchase_order_items; r := r || jsonb_build_object('po_items_MUST0', n);
  SELECT count(*) INTO n FROM inventory_stock_balances; r := r || jsonb_build_object('balances_MUST0', n);
  SELECT count(*) INTO n FROM site_financial_summary; r := r || jsonb_build_object('sfs_MUST0', n);
  SELECT count(*) INTO n FROM labor_payments; r := r || jsonb_build_object('labor_payments_MUST0', n);
  SELECT count(*) INTO n FROM app_settings; r := r || jsonb_build_object('app_settings_MUST0', n);
  r := r || jsonb_build_object('is_pm', is_pm(), 'is_site_staff', is_site_staff(),
         'can_manage_teams', can_manage_teams(), 'is_admin_or_owner_MUSTfalse', is_admin_or_owner());

  -- PM writes (each in its own subtransaction; SQLERRM recorded on failure)
  BEGIN
    INSERT INTO site_phases (site_id, name, tenant_id) VALUES (v_site, 'PM test phase', v_tenant) RETURNING id INTO v_phase;
    r := r || jsonb_build_object('w_site_phases_insert', 'ok');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('w_site_phases_insert', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    UPDATE site_phases SET status = 'in_progress' WHERE id = v_phase;
    GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('w_site_phases_update_rows', n);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('w_site_phases_update_rows', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    INSERT INTO phase_tasks (phase_id, site_id, name, tenant_id) VALUES (v_phase, v_site, 'PM test task', v_tenant) RETURNING id INTO v_task;
    r := r || jsonb_build_object('w_phase_tasks_insert', 'ok');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('w_phase_tasks_insert', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    UPDATE phase_tasks SET status = 'in_progress' WHERE id = v_task;
    GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('w_phase_tasks_status_rows', n);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('w_phase_tasks_status_rows', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    INSERT INTO worker_assignments (worker_id, site_id, date, shift, type, tenant_id)
      VALUES (v_worker, v_site, DATE '2099-01-01', 'morning', 'site', v_tenant);
    r := r || jsonb_build_object('w_worker_assignments_insert', 'ok');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('w_worker_assignments_insert', SQLSTATE || ' ' || SQLERRM);
  END;
  IF v_leave IS NOT NULL THEN
    BEGIN
      UPDATE leave_requests SET status = 'approved', reviewed_by = v_email, reviewed_at = now() WHERE id = v_leave;
      GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('w_leave_requests_status_rows', n);
    EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('w_leave_requests_status_rows', SQLSTATE || ' ' || SQLERRM);
    END;
  END IF;

  -- PM must not write money / sites / users
  BEGIN
    UPDATE sites SET name = name WHERE tenant_id = v_tenant;
    GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('w_sites_update_rows_MUST0', n);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('w_sites_update_rows_MUST0', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    INSERT INTO user_roles (user_email, role, tenant_id) VALUES ('pm-test-2@example.invalid', 'WORKER', v_tenant);
    r := r || jsonb_build_object('w_user_roles_insert_MUSTfail', 'ok');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('w_user_roles_insert_MUSTfail', SQLSTATE || ' ' || SQLERRM);
  END;

  RAISE EXCEPTION 'RESULT %', r;
END $$;
ROLLBACK;
