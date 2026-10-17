-- Rolled-back check for supabase/migrations/2026-10-17-06-pm-ops-rpcs.sql.
-- Run: npx supabase db query --linked -f supabase/tests/2026-10-17-06-pm-ops-rpcs.test.sql
-- db query has no \i, so the migration bodies are inlined below, in apply
-- order: the 04 recursion hotfix (owned by branch fix/rls-self-recursion),
-- then 05, then 06. Each is byte-identical to its file between BEGIN; and
-- COMMIT;. Keep them in sync. The DO block ends in RAISE EXCEPTION
-- 'RESULT ...', so nothing persists.
-- Expected: *_MUST0 is 0, *_MUSTfalse is false, *_MUSTtrue is true,
-- *_eq_real is true, w_* writes 'ok'.
BEGIN;

-- ===== inlined 2026-10-17-04-rls-self-recursion-fix.sql (hotfix branch fix/rls-self-recursion) body =====

CREATE OR REPLACE FUNCTION public.site_was_ongoing(p_site_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM sites WHERE id = p_site_id AND status = 'Ongoing' AND tenant_id = current_tenant_id()) $$;

CREATE OR REPLACE FUNCTION public.user_role_held_admin_seat(p_role_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM user_roles WHERE id = p_role_id AND role IN ('OWNER','ADMIN') AND tenant_id = current_tenant_id()) $$;

REVOKE ALL ON FUNCTION public.site_was_ongoing(uuid), public.user_role_held_admin_seat(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.site_was_ongoing(uuid), public.user_role_held_admin_seat(uuid) TO authenticated;

ALTER POLICY admin_updates ON public.sites
  USING (((SELECT is_admin_or_owner()) AND (tenant_id = (SELECT current_tenant_id())) AND (SELECT tenant_can_write())))
  WITH CHECK (((SELECT is_admin_or_owner()) AND (tenant_id = (SELECT current_tenant_id())) AND (SELECT tenant_can_write())
    AND ((status IS DISTINCT FROM 'Ongoing'::text) OR site_was_ongoing(id) OR tenant_under_seat_limit('sites'::text))));

ALTER POLICY owner_updates ON public.user_roles
  USING (((SELECT is_owner()) AND (tenant_id = (SELECT current_tenant_id())) AND (SELECT tenant_can_write())))
  WITH CHECK (((SELECT is_owner()) AND (tenant_id = (SELECT current_tenant_id())) AND (SELECT tenant_can_write())
    AND ((role <> ALL (ARRAY['OWNER'::text, 'ADMIN'::text])) OR user_role_held_admin_seat(id) OR tenant_under_seat_limit('admins'::text))));

-- ===== end of 04 body =====

-- ===== inlined 2026-10-17-05-pm-role.sql body =====

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
-- owner_updates must not read user_roles inside its own policy (42P17 infinite
-- recursion, fixed by 2026-10-17-04): the old-row seat lookup goes through the
-- SECURITY DEFINER helper from 04, widened here to count PM as an admin seat.
CREATE OR REPLACE FUNCTION public.user_role_held_admin_seat(p_role_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM user_roles WHERE id = p_role_id AND role IN ('OWNER','ADMIN','PM') AND tenant_id = current_tenant_id()) $$;
REVOKE ALL ON FUNCTION public.user_role_held_admin_seat(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.user_role_held_admin_seat(uuid) TO authenticated;

ALTER POLICY owner_updates ON user_roles
  WITH CHECK ((( SELECT is_owner() AS is_owner) AND (tenant_id = ( SELECT current_tenant_id() AS current_tenant_id)) AND ( SELECT tenant_can_write() AS tenant_can_write) AND ((role <> ALL (ARRAY['OWNER'::text, 'ADMIN'::text, 'PM'::text])) OR user_role_held_admin_seat(id) OR tenant_under_seat_limit('admins'::text))));

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

-- ===== end of 05 body =====

-- ===== inlined 2026-10-17-06-pm-ops-rpcs.sql body =====

CREATE OR REPLACE FUNCTION public.pm_sites()
RETURNS TABLE(id uuid, site_number text, name text, short_name text, status text, start_date date, end_date date,
              client_id uuid, client_name text, location text, map_url text, lat numeric, lng numeric,
              distance_km numeric, travel_minutes integer, is_default boolean, notes text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT s.id, s.site_number, s.name, s.short_name, s.status, s.start_date, s.end_date,
         s.client_id, COALESCE(c.name, s.client_name), s.location, s.map_url, s.lat, s.lng,
         s.distance_km, s.travel_minutes, s.is_default, s.notes, s.created_at
  FROM sites s LEFT JOIN clients c ON c.id = s.client_id
  WHERE s.tenant_id = current_tenant_id() AND is_site_staff()
  ORDER BY s.created_at DESC
$$;

CREATE OR REPLACE FUNCTION public.pm_update_site(p_site_id uuid, p_patch jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE k text;
  allowed text[] := ARRAY['name','short_name','status','start_date','end_date','location','map_url','lat','lng','distance_km','travel_minutes','notes'];
BEGIN
  IF NOT is_site_staff() OR NOT tenant_can_write() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_patch) LOOP
    IF NOT k = ANY (allowed) THEN RAISE EXCEPTION 'field not allowed: %', k USING ERRCODE = '22023'; END IF;
  END LOOP;
  -- Finishing a site moves leftover stock and stamps end_date (the OWNER/ADMIN
  -- finish flow), so a PM may not set Completed; an already-Completed site may stay so.
  IF p_patch->>'status' = 'Completed'
     AND NOT EXISTS (SELECT 1 FROM sites WHERE id = p_site_id AND status = 'Completed') THEN
    RAISE EXCEPTION 'PM cannot complete a site' USING ERRCODE = '22023';
  END IF;
  -- Ongoing seat rule from the sites admin_updates policy
  IF p_patch ? 'status' AND p_patch->>'status' = 'Ongoing'
     AND NOT EXISTS (SELECT 1 FROM sites WHERE id = p_site_id AND status = 'Ongoing' AND tenant_id = current_tenant_id())
     AND NOT tenant_under_seat_limit('sites') THEN
    RAISE EXCEPTION 'site seat limit reached' USING ERRCODE = '54000';
  END IF;
  UPDATE sites s SET
    name           = CASE WHEN p_patch ? 'name' THEN p_patch->>'name' ELSE s.name END,
    short_name     = CASE WHEN p_patch ? 'short_name' THEN NULLIF(p_patch->>'short_name','') ELSE s.short_name END,
    status         = CASE WHEN p_patch ? 'status' THEN p_patch->>'status' ELSE s.status END,
    start_date     = CASE WHEN p_patch ? 'start_date' THEN (p_patch->>'start_date')::date ELSE s.start_date END,
    end_date       = CASE WHEN p_patch ? 'end_date' THEN (p_patch->>'end_date')::date ELSE s.end_date END,
    location       = CASE WHEN p_patch ? 'location' THEN p_patch->>'location' ELSE s.location END,
    map_url        = CASE WHEN p_patch ? 'map_url' THEN p_patch->>'map_url' ELSE s.map_url END,
    lat            = CASE WHEN p_patch ? 'lat' THEN (p_patch->>'lat')::numeric ELSE s.lat END,
    lng            = CASE WHEN p_patch ? 'lng' THEN (p_patch->>'lng')::numeric ELSE s.lng END,
    distance_km    = CASE WHEN p_patch ? 'distance_km' THEN (p_patch->>'distance_km')::numeric ELSE s.distance_km END,
    travel_minutes = CASE WHEN p_patch ? 'travel_minutes' THEN (p_patch->>'travel_minutes')::integer ELSE s.travel_minutes END,
    notes          = CASE WHEN p_patch ? 'notes' THEN p_patch->>'notes' ELSE s.notes END,
    updated_at     = now()
  WHERE s.id = p_site_id AND s.tenant_id = current_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'site not found' USING ERRCODE = 'P0002'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.pm_workers()
RETURNS TABLE(id uuid, name text, nickname text, "position" text, status text, email text, show_in_assign boolean,
              line_user_id text, annual_leave_days integer, annual_sick_leave_days integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT w.id, w.name, w.nickname, w.position, w.status, w.email, w.show_in_assign,
         w.line_user_id, w.annual_leave_days, w.annual_sick_leave_days
  FROM workers w
  WHERE w.tenant_id = current_tenant_id() AND is_site_staff()
  ORDER BY w.name
$$;

CREATE OR REPLACE FUNCTION public.pm_purchase_orders()
RETURNS TABLE(id uuid, po_number text, site_id uuid, supplier_id uuid, supplier_name text, date date, status text,
              notes text, received_date date, ordered_by text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT po.id, po.po_number, po.site_id, po.supplier_id, sp.name, po.date, po.status,
         po.notes, po.received_date, po.ordered_by, po.created_at
  FROM purchase_orders po LEFT JOIN suppliers sp ON sp.id = po.supplier_id
  WHERE po.tenant_id = current_tenant_id() AND is_site_staff() AND has_module_access('purchase_orders')
  ORDER BY po.created_at DESC
$$;

CREATE OR REPLACE FUNCTION public.pm_purchase_order_items(p_po_id uuid)
RETURNS TABLE(id uuid, po_id uuid, description text, quantity numeric, unit text, sort_order integer,
              inventory_item_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT i.id, i.po_id, i.description, i.quantity, i.unit, i.sort_order, i.inventory_item_id
  FROM purchase_order_items i JOIN purchase_orders po ON po.id = i.po_id
  WHERE i.po_id = p_po_id
    AND po.tenant_id = current_tenant_id() AND i.tenant_id = current_tenant_id()
    AND is_site_staff() AND has_module_access('purchase_orders')
  ORDER BY i.sort_order, i.id
$$;

CREATE OR REPLACE FUNCTION public.pm_inventory_on_hand(p_site_id uuid DEFAULT NULL)
RETURNS TABLE(inventory_item_id uuid, code text, name text, base_unit text, site_id uuid,
              quantity_on_hand numeric, updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT b.inventory_item_id, it.code, it.name, it.base_unit, b.site_id, b.quantity_on_hand, b.updated_at
  FROM inventory_stock_balances b JOIN inventory_items it ON it.id = b.inventory_item_id
  WHERE b.tenant_id = current_tenant_id() AND it.tenant_id = current_tenant_id()
    AND (p_site_id IS NULL OR b.site_id = p_site_id)
    AND is_site_staff() AND has_module_access('purchase_orders')
  ORDER BY it.name, b.site_id
$$;

-- Used by the worker_team_members policy: a PM cannot SELECT workers.
CREATE OR REPLACE FUNCTION public.worker_in_my_tenant(p_worker_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM workers WHERE id = p_worker_id AND tenant_id = current_tenant_id()) $$;

REVOKE ALL ON FUNCTION public.pm_sites(), public.pm_update_site(uuid, jsonb), public.pm_workers(),
  public.pm_purchase_orders(), public.pm_purchase_order_items(uuid), public.pm_inventory_on_hand(uuid),
  public.worker_in_my_tenant(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_sites(), public.pm_update_site(uuid, jsonb), public.pm_workers(),
  public.pm_purchase_orders(), public.pm_purchase_order_items(uuid), public.pm_inventory_on_hand(uuid),
  public.worker_in_my_tenant(uuid) TO authenticated;

-- Teams: OWNER or PM manage them (was is_owner()). The live worker_team_members
-- with_check (read 2026-10-17) checked the worker with EXISTS on workers, which a
-- PM cannot read, so it now calls worker_in_my_tenant().
ALTER POLICY owner_writes ON worker_teams
  USING (( SELECT can_manage_teams() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT tenant_can_write() ))
  WITH CHECK (( SELECT can_manage_teams() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT tenant_can_write() ));
ALTER POLICY owner_writes ON worker_team_members
  USING (( SELECT can_manage_teams() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT tenant_can_write() ))
  WITH CHECK (( SELECT can_manage_teams() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT tenant_can_write() )
    AND EXISTS (SELECT 1 FROM worker_teams t WHERE t.id = worker_team_members.team_id AND t.tenant_id = ( SELECT current_tenant_id() ))
    AND worker_in_my_tenant(worker_id));

-- ===== end of 06 body =====

DO $$
DECLARE
  v_tenant uuid; r jsonb := '{}'; n int; b boolean;
  v_pm text := 'pm-test@example.invalid'; v_admin text := 'pm-test-admin@example.invalid';
  v_wk text := 'pm-test-worker@example.invalid';
  v_site uuid; v_worker uuid; v_po uuid; v_team uuid; v_open uuid; v_done uuid;
  real_sites int; real_workers int; real_pos int; real_po_items int; real_bal int; real_bal_site int;
  v_other_po uuid; v_other_site uuid; real_other_po_items int; real_other_bal int;
  money text[] := ARRAY['monthly_salary','contract_value','contract_value_no_vat','unit_price','line_total',
                        'weighted_average_cost','cost_labor','cost_other','discount_pct','has_vat'];
BEGIN
  -- as the table owner: the demo tenant's real counts
  SELECT id INTO v_tenant FROM tenants WHERE company_name ILIKE '%สร้างดี%' LIMIT 1;
  SELECT id INTO v_site FROM sites WHERE tenant_id = v_tenant ORDER BY created_at LIMIT 1;
  SELECT id INTO v_open FROM sites WHERE tenant_id = v_tenant AND status <> 'Completed' ORDER BY created_at LIMIT 1;
  SELECT id INTO v_done FROM sites WHERE tenant_id = v_tenant AND status = 'Completed' ORDER BY created_at LIMIT 1;
  SELECT id INTO v_worker FROM workers WHERE tenant_id = v_tenant ORDER BY created_at LIMIT 1;
  SELECT po_id INTO v_po FROM purchase_order_items WHERE tenant_id = v_tenant GROUP BY po_id ORDER BY count(*) DESC LIMIT 1;
  SELECT count(*) INTO real_sites FROM sites WHERE tenant_id = v_tenant;
  SELECT count(*) INTO real_workers FROM workers WHERE tenant_id = v_tenant;
  SELECT count(*) INTO real_pos FROM purchase_orders WHERE tenant_id = v_tenant;
  SELECT count(*) INTO real_po_items FROM purchase_order_items WHERE po_id = v_po;
  SELECT count(*) INTO real_bal FROM inventory_stock_balances WHERE tenant_id = v_tenant;
  SELECT count(*) INTO real_bal_site FROM inventory_stock_balances b
    WHERE b.tenant_id = v_tenant AND b.site_id = (SELECT id FROM sites WHERE tenant_id = v_tenant AND is_default LIMIT 1);
  -- another tenant's PO (with items) and site (with stock), for the cross-tenant checks
  SELECT po_id INTO v_other_po FROM purchase_order_items WHERE tenant_id <> v_tenant GROUP BY po_id ORDER BY count(*) DESC LIMIT 1;
  SELECT b.site_id INTO v_other_site FROM inventory_stock_balances b JOIN sites s ON s.id = b.site_id
    WHERE b.tenant_id <> v_tenant AND s.tenant_id = b.tenant_id GROUP BY b.site_id ORDER BY count(*) DESC LIMIT 1;
  SELECT count(*) INTO real_other_po_items FROM purchase_order_items WHERE po_id = v_other_po;
  SELECT count(*) INTO real_other_bal FROM inventory_stock_balances WHERE site_id = v_other_site;
  r := r || jsonb_build_object('other_po_found', v_other_po IS NOT NULL, 'real_other_po_items', real_other_po_items,
         'other_site_found', v_other_site IS NOT NULL, 'real_other_site_bal', real_other_bal);
  r := r || jsonb_build_object('tenant', v_tenant, 'real_sites', real_sites, 'real_workers', real_workers,
         'real_pos', real_pos, 'real_po_items', real_po_items, 'real_bal', real_bal, 'real_bal_default_site', real_bal_site);
  -- worker_team_members PK is (worker_id) and every demo worker already has a
  -- team; free v_worker so the PM insert below tests RLS, not the PK (rolled back).
  DELETE FROM worker_team_members WHERE worker_id = v_worker;
  INSERT INTO user_roles (user_email, role, tenant_id, status) VALUES
    (v_pm, 'PM', v_tenant, 'approved'), (v_admin, 'ADMIN', v_tenant, 'approved'), (v_wk, 'WORKER', v_tenant, 'approved');

  -- ===== PM =====
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_pm, 'role', 'authenticated', 'sub', gen_random_uuid())::text, true);
  SET LOCAL ROLE authenticated;
  r := r || jsonb_build_object('pm_current_tenant_ok', current_tenant_id() = v_tenant,
         'pm_has_module_purchase_orders', has_module_access('purchase_orders'));

  SELECT count(*), COALESCE(bool_or(to_jsonb(s) ?| money), false) INTO n, b FROM pm_sites() s;
  r := r || jsonb_build_object('pm_sites', n, 'pm_sites_eq_real', n = real_sites, 'pm_sites_money_keys_MUSTfalse', b);
  SELECT count(*), COALESCE(bool_or(to_jsonb(w) ? 'monthly_salary'), false) INTO n, b FROM pm_workers() w;
  r := r || jsonb_build_object('pm_workers', n, 'pm_workers_eq_real', n = real_workers, 'pm_workers_salary_key_MUSTfalse', b);
  SELECT COALESCE(bool_or(to_jsonb(w) ?| money), false) INTO b FROM pm_workers() w;
  r := r || jsonb_build_object('pm_workers_money_keys_MUSTfalse', b);
  SELECT count(*), COALESCE(bool_or(to_jsonb(p) ?| money), false) INTO n, b FROM pm_purchase_orders() p;
  r := r || jsonb_build_object('pm_pos', n, 'pm_pos_eq_real', n = real_pos, 'pm_pos_money_keys_MUSTfalse', b);
  SELECT count(*), COALESCE(bool_or(to_jsonb(i) ?| money), false) INTO n, b FROM pm_purchase_order_items(v_po) i;
  r := r || jsonb_build_object('pm_po_items', n, 'pm_po_items_eq_real', n = real_po_items, 'pm_po_items_money_keys_MUSTfalse', b);
  SELECT count(*), COALESCE(bool_or(to_jsonb(i) ?| money), false) INTO n, b FROM pm_inventory_on_hand() i;
  r := r || jsonb_build_object('pm_on_hand', n, 'pm_on_hand_eq_real', n = real_bal, 'pm_on_hand_money_keys_MUSTfalse', b);
  SELECT count(*) INTO n FROM pm_inventory_on_hand((SELECT id FROM pm_sites() WHERE is_default LIMIT 1));
  r := r || jsonb_build_object('pm_on_hand_default_site_eq_real', n = real_bal_site);

  BEGIN
    PERFORM pm_update_site(v_site, '{"notes":"x","short_name":"PMT","travel_minutes":15}');
    SELECT notes = 'x' AND short_name = 'PMT' AND travel_minutes = 15 INTO b FROM pm_sites() WHERE id = v_site;
    r := r || jsonb_build_object('w_pm_update_site', 'ok', 'pm_update_site_applied_MUSTtrue', b);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('w_pm_update_site', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    PERFORM pm_update_site(v_site, '{"contract_value":1}');
    r := r || jsonb_build_object('pm_update_site_contract_value_22023_MUSTtrue', false);
  EXCEPTION WHEN SQLSTATE '22023' THEN r := r || jsonb_build_object('pm_update_site_contract_value_22023_MUSTtrue', true);
  END;
  BEGIN
    PERFORM pm_update_site(v_open, '{"status":"Completed"}');
    r := r || jsonb_build_object('pm_update_site_complete_22023_MUSTtrue', false);
  EXCEPTION WHEN SQLSTATE '22023' THEN r := r || jsonb_build_object('pm_update_site_complete_22023_MUSTtrue', SQLERRM = 'PM cannot complete a site');
  END;
  SELECT status <> 'Completed' INTO b FROM pm_sites() WHERE id = v_open;
  r := r || jsonb_build_object('pm_complete_rejected_status_kept_MUSTtrue', b);
  IF v_done IS NOT NULL THEN
    BEGIN
      PERFORM pm_update_site(v_done, '{"status":"Completed","notes":"z"}');
      r := r || jsonb_build_object('w_pm_update_site_keep_completed', 'ok');
    EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('w_pm_update_site_keep_completed', SQLSTATE || ' ' || SQLERRM);
    END;
  ELSE
    r := r || jsonb_build_object('w_pm_update_site_keep_completed', 'ok (no Completed site in demo tenant, skipped)');
  END IF;
  BEGIN
    PERFORM pm_update_site(gen_random_uuid(), '{"notes":"x"}');
    r := r || jsonb_build_object('pm_update_site_unknown_P0002_MUSTtrue', false);
  EXCEPTION WHEN SQLSTATE 'P0002' THEN r := r || jsonb_build_object('pm_update_site_unknown_P0002_MUSTtrue', true);
  END;

  -- cross-tenant: the demo-tenant PM gets nothing from another tenant
  SELECT count(*) INTO n FROM pm_purchase_order_items(v_other_po);
  r := r || jsonb_build_object('pm_other_tenant_po_items_MUST0', n);
  SELECT count(*) INTO n FROM pm_inventory_on_hand(v_other_site);
  r := r || jsonb_build_object('pm_other_tenant_on_hand_MUST0', n);
  BEGIN
    PERFORM pm_update_site(v_other_site, '{"notes":"x"}');
    r := r || jsonb_build_object('pm_update_site_other_tenant_P0002_MUSTtrue', false);
  EXCEPTION WHEN SQLSTATE 'P0002' THEN r := r || jsonb_build_object('pm_update_site_other_tenant_P0002_MUSTtrue', true);
  END;

  BEGIN
    INSERT INTO worker_teams (tenant_id, name) VALUES (v_tenant, 'PM test team') RETURNING id INTO v_team;
    r := r || jsonb_build_object('w_pm_worker_teams_insert', 'ok');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('w_pm_worker_teams_insert', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    INSERT INTO worker_team_members (team_id, worker_id, tenant_id) VALUES (v_team, v_worker, v_tenant);
    r := r || jsonb_build_object('w_pm_worker_team_members_insert', 'ok');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('w_pm_worker_team_members_insert', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    INSERT INTO worker_team_members (team_id, worker_id, tenant_id) VALUES (v_team, gen_random_uuid(), v_tenant);
    r := r || jsonb_build_object('w_pm_member_foreign_worker_MUSTfail', 'ok');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('w_pm_member_foreign_worker_MUSTfail', SQLSTATE || ' ' || SQLERRM);
  END;

  -- money: all must still be 0 for PM
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

  -- ===== ADMIN: site staff, so pm_* return rows; cannot manage teams =====
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_admin, 'role', 'authenticated', 'sub', gen_random_uuid())::text, true);
  SELECT count(*) INTO n FROM pm_sites(); r := r || jsonb_build_object('admin_pm_sites_eq_real', n = real_sites);
  SELECT count(*) INTO n FROM pm_workers(); r := r || jsonb_build_object('admin_pm_workers_eq_real', n = real_workers);
  BEGIN
    INSERT INTO worker_teams (tenant_id, name) VALUES (v_tenant, 'ADMIN test team');
    r := r || jsonb_build_object('w_admin_worker_teams_insert_MUSTfail', 'ok');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('w_admin_worker_teams_insert_MUSTfail', SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===== WORKER: every pm_* returns 0, pm_update_site raises 42501 =====
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_wk, 'role', 'authenticated', 'sub', gen_random_uuid())::text, true);
  r := r || jsonb_build_object('worker_current_tenant_ok', current_tenant_id() = v_tenant);
  SELECT count(*) INTO n FROM pm_sites(); r := r || jsonb_build_object('worker_pm_sites_MUST0', n);
  SELECT count(*) INTO n FROM pm_workers(); r := r || jsonb_build_object('worker_pm_workers_MUST0', n);
  SELECT count(*) INTO n FROM pm_purchase_orders(); r := r || jsonb_build_object('worker_pm_pos_MUST0', n);
  SELECT count(*) INTO n FROM pm_purchase_order_items(v_po); r := r || jsonb_build_object('worker_pm_po_items_MUST0', n);
  SELECT count(*) INTO n FROM pm_inventory_on_hand(); r := r || jsonb_build_object('worker_pm_on_hand_MUST0', n);
  BEGIN
    PERFORM pm_update_site(v_site, '{"notes":"y"}');
    r := r || jsonb_build_object('worker_pm_update_site_42501_MUSTtrue', false);
  EXCEPTION WHEN SQLSTATE '42501' THEN r := r || jsonb_build_object('worker_pm_update_site_42501_MUSTtrue', true);
  END;

  -- ===== anon: no EXECUTE =====
  RESET ROLE;
  SELECT has_function_privilege('anon', 'public.pm_sites()', 'EXECUTE')
      OR has_function_privilege('anon', 'public.pm_update_site(uuid,jsonb)', 'EXECUTE')
      OR has_function_privilege('anon', 'public.pm_workers()', 'EXECUTE')
      OR has_function_privilege('anon', 'public.pm_purchase_orders()', 'EXECUTE')
      OR has_function_privilege('anon', 'public.pm_purchase_order_items(uuid)', 'EXECUTE')
      OR has_function_privilege('anon', 'public.pm_inventory_on_hand(uuid)', 'EXECUTE')
      OR has_function_privilege('anon', 'public.worker_in_my_tenant(uuid)', 'EXECUTE') INTO b;
  r := r || jsonb_build_object('anon_execute_any_MUSTfalse', b);

  -- check: this RAISE is load-bearing. It aborts the DO block so none of the
  -- rows written above survive, and it is how the RESULT reaches the output.
  -- The ROLLBACK below then undoes the inlined DDL. Never remove either.
  RAISE EXCEPTION 'RESULT %', r;
END $$;
ROLLBACK;
