-- PM (site manager) role. Sibling of ADMIN: runs sites, never reads money.
-- Spec: docs/superpowers/specs/2026-10-17-gantt-weighted-progress-design.md §13
-- Depends on: 2026-10-17-04-rls-self-recursion-fix.sql (user_role_held_admin_seat, site_was_ongoing).
-- Rolled-back check: supabase/tests/2026-10-17-05-pm-role.test.sql
-- Every ALTER POLICY / recreated function below is the live definition
-- (pg_policies / pg_get_functiondef, read 2026-10-17) with only the role
-- check changed, except user_role_held_admin_seat() and the owner_updates
-- policy: those are not live copies but are redefined from the 04 hotfix
-- (which must be applied first) to count PM as an admin seat.
BEGIN;

-- Release guard: 04 must already be applied (05 widens its helper).
DO $$ BEGIN IF to_regprocedure('public.site_was_ongoing(uuid)') IS NULL THEN RAISE EXCEPTION 'apply 2026-10-17-04 first'; END IF; END $$;

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
-- Shift confirmation (Assign / CellEditPopup) needs these three settings;
-- every other app_settings key stays OWNER/ADMIN only.
CREATE POLICY pm_reads ON app_settings FOR SELECT
  USING ((SELECT is_pm()) AND tenant_id = (SELECT current_tenant_id()) AND key IN ('require_checkin_confirmation','regular_shift_end_time','checkin_radius_m'));

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

COMMIT;
