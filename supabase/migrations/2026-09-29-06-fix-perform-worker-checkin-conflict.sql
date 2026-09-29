-- supabase/migrations/2026-09-29-06-fix-perform-worker-checkin-conflict.sql
-- Critical fix (final whole-branch review of check-in-locations-plan):
-- Task 1's migration (2026-09-29-03) replaced worker_checkins' plain
-- UNIQUE(worker_id, site_id, date) with the partial index
-- worker_checkins_site_unique ... WHERE site_id IS NOT NULL. Task 2
-- updated the two _by_id (LINE-bot) functions' ON CONFLICT clause to
-- match, but perform_worker_checkin (the web-app variant, no _by_id --
-- never touched by any task in that plan, since it has no factory-branch
-- logic to swap) was never updated. Postgres cannot infer a partial
-- index as an ON CONFLICT arbiter without the matching predicate, so
-- every web-app check-in for a real field-crew site assignment has been
-- failing since Task 1's migration went live. This is TodayCheckinCard's
-- entire code path -- the most-used check-in surface in the app.

CREATE OR REPLACE FUNCTION public.perform_worker_checkin(p_site_id uuid, p_lat numeric, p_lng numeric)
 RETURNS TABLE(success boolean, distance_m numeric, radius_m numeric, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant_id UUID := current_tenant_id();
  v_worker_id UUID;
  v_site_lat NUMERIC;
  v_site_lng NUMERIC;
  v_radius NUMERIC;
  v_distance NUMERIC;
  v_today DATE := CURRENT_DATE;
BEGIN
  SELECT id INTO v_worker_id FROM workers WHERE email = auth.email() AND tenant_id = v_tenant_id;
  IF v_worker_id IS NULL THEN
    RETURN QUERY SELECT false, NULL::NUMERIC, NULL::NUMERIC, 'ไม่พบข้อมูลพนักงานที่ผูกกับบัญชีนี้'::TEXT;
    RETURN;
  END IF;

  SELECT lat, lng INTO v_site_lat, v_site_lng FROM sites WHERE id = p_site_id AND tenant_id = v_tenant_id;
  IF v_site_lat IS NULL OR v_site_lng IS NULL THEN
    RETURN QUERY SELECT false, NULL::NUMERIC, NULL::NUMERIC, 'ไซท์งานนี้ยังไม่ได้ตั้งพิกัด — ติดต่อสำนักงาน'::TEXT;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM worker_assignments
    WHERE worker_id = v_worker_id AND site_id = p_site_id AND date = v_today AND type = 'site' AND tenant_id = v_tenant_id
  ) THEN
    RETURN QUERY SELECT false, NULL::NUMERIC, NULL::NUMERIC, 'ไม่พบตารางงานของคุณที่ไซท์นี้วันนี้ — ติดต่อสำนักงาน'::TEXT;
    RETURN;
  END IF;

  SELECT COALESCE((SELECT value::numeric FROM app_settings WHERE tenant_id = v_tenant_id AND key = 'checkin_radius_m'), 200)
    INTO v_radius;
  v_distance := haversine_distance_m(p_lat, p_lng, v_site_lat, v_site_lng);

  IF v_distance > v_radius THEN
    RETURN QUERY SELECT false, v_distance, v_radius,
      format('คุณอยู่ห่างจากไซท์งาน %s เมตร ต้องอยู่ในระยะ %s เมตรจึงจะเช็คอินได้', round(v_distance), round(v_radius))::TEXT;
    RETURN;
  END IF;

  INSERT INTO worker_checkins (tenant_id, worker_id, site_id, date, checkin_at, checkin_lat, checkin_lng, checkin_distance_m)
  VALUES (v_tenant_id, v_worker_id, p_site_id, v_today, now(), p_lat, p_lng, v_distance)
  ON CONFLICT (worker_id, site_id, date) WHERE site_id IS NOT NULL DO UPDATE
    SET checkin_at = now(), checkin_lat = p_lat, checkin_lng = p_lng, checkin_distance_m = v_distance;

  UPDATE worker_assignments
  SET confirmed_at = now(), confirmed_by = 'checkin'
  WHERE worker_id = v_worker_id AND site_id = p_site_id AND date = v_today
    AND type = 'site' AND confirmed_at IS NULL AND tenant_id = v_tenant_id;

  RETURN QUERY SELECT true, v_distance, v_radius, 'เช็คอินสำเร็จ'::TEXT;
END;
$function$;
