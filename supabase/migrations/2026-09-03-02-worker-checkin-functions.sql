-- Create SECURITY DEFINER functions for GPS-verified worker check-in/out.
--
-- Both perform_worker_* functions run SECURITY DEFINER so a WORKER-role
-- caller (who has no direct write access to worker_checkins/
-- worker_assignments/worker_ot, and no read access to app_settings) can
-- still confirm their OWN attendance through a narrow, server-validated
-- path. v_worker_id is ALWAYS resolved from auth.email() internally --
-- never trust a client-supplied worker id -- so a worker can only ever
-- check themselves in/out.

CREATE OR REPLACE FUNCTION haversine_distance_m(lat1 NUMERIC, lng1 NUMERIC, lat2 NUMERIC, lng2 NUMERIC)
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
AS $$
  -- Standard haversine formula, earth radius 6371000m. Returns meters.
  SELECT 6371000 * 2 * asin(sqrt(
    sin(radians(lat2 - lat1) / 2) ^ 2 +
    cos(radians(lat1)) * cos(radians(lat2)) * sin(radians(lng2 - lng1) / 2) ^ 2
  ));
$$;

CREATE OR REPLACE FUNCTION perform_worker_checkin(p_site_id UUID, p_lat NUMERIC, p_lng NUMERIC)
RETURNS TABLE(success BOOLEAN, distance_m NUMERIC, radius_m NUMERIC, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
    WHERE worker_id = v_worker_id AND site_id = p_site_id AND date = v_today AND type = 'site'
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
  ON CONFLICT (worker_id, site_id, date) DO UPDATE
    SET checkin_at = now(), checkin_lat = p_lat, checkin_lng = p_lng, checkin_distance_m = v_distance;

  -- First confirmation wins -- don't clobber an admin override that may
  -- already be set (confirmed_by = admin's email, not 'checkin').
  UPDATE worker_assignments
  SET confirmed_at = now(), confirmed_by = 'checkin'
  WHERE worker_id = v_worker_id AND site_id = p_site_id AND date = v_today
    AND type = 'site' AND confirmed_at IS NULL;

  RETURN QUERY SELECT true, v_distance, v_radius, 'เช็คอินสำเร็จ'::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION perform_worker_checkout(
  p_site_id UUID, p_lat NUMERIC, p_lng NUMERIC,
  p_ot_start TIME DEFAULT NULL, p_ot_end TIME DEFAULT NULL,
  p_ot_hours NUMERIC DEFAULT NULL, p_ot_is_overnight BOOLEAN DEFAULT false, p_ot_notes TEXT DEFAULT NULL
)
RETURNS TABLE(success BOOLEAN, distance_m NUMERIC, radius_m NUMERIC, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  IF NOT EXISTS (SELECT 1 FROM worker_checkins WHERE worker_id = v_worker_id AND site_id = p_site_id AND date = v_today) THEN
    RETURN QUERY SELECT false, NULL::NUMERIC, NULL::NUMERIC, 'ยังไม่ได้เช็คอินวันนี้ — เช็คอินก่อนจึงจะเช็คเอาท์ได้'::TEXT;
    RETURN;
  END IF;

  SELECT lat, lng INTO v_site_lat, v_site_lng FROM sites WHERE id = p_site_id AND tenant_id = v_tenant_id;
  SELECT COALESCE((SELECT value::numeric FROM app_settings WHERE tenant_id = v_tenant_id AND key = 'checkin_radius_m'), 200)
    INTO v_radius;
  v_distance := haversine_distance_m(p_lat, p_lng, v_site_lat, v_site_lng);

  IF v_distance > v_radius THEN
    RETURN QUERY SELECT false, v_distance, v_radius,
      format('คุณอยู่ห่างจากไซท์งาน %s เมตร ต้องอยู่ในระยะ %s เมตรจึงจะเช็คเอาท์ได้', round(v_distance), round(v_radius))::TEXT;
    RETURN;
  END IF;

  UPDATE worker_checkins
  SET checkout_at = now(), checkout_lat = p_lat, checkout_lng = p_lng, checkout_distance_m = v_distance
  WHERE worker_id = v_worker_id AND site_id = p_site_id AND date = v_today;

  -- OT fields are optional -- the frontend (Task 7) decides whether the
  -- checkout time crosses the regular-shift-end setting and only passes
  -- these when it does. Trust level here matches admin-typed OT today
  -- (CellEditPopup.jsx): the number isn't re-derived server-side from
  -- p_ot_start/p_ot_end, same as an admin's manual entry isn't either.
  IF p_ot_hours IS NOT NULL THEN
    INSERT INTO worker_ot (worker_id, site_id, date, start_time, end_time, ot_hours, is_overnight, notes, tenant_id)
    VALUES (v_worker_id, p_site_id, v_today, p_ot_start, p_ot_end, p_ot_hours, p_ot_is_overnight, p_ot_notes, v_tenant_id)
    ON CONFLICT (worker_id, date) DO UPDATE
      SET site_id = p_site_id, start_time = p_ot_start, end_time = p_ot_end,
          ot_hours = p_ot_hours, is_overnight = p_ot_is_overnight, notes = p_ot_notes;
  END IF;

  RETURN QUERY SELECT true, v_distance, v_radius, 'เช็คเอาท์สำเร็จ'::TEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION perform_worker_checkin(UUID, NUMERIC, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION perform_worker_checkout(UUID, NUMERIC, NUMERIC, TIME, TIME, NUMERIC, BOOLEAN, TEXT) TO authenticated;
