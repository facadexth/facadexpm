-- Small SECURITY DEFINER getter so a WORKER-role user can read the
-- tenant's regular_shift_end_time setting (app_settings.admin_reads
-- requires is_admin_or_owner(), so a worker can't SELECT it directly).
-- Task 7 (MySchedule check-in/out) needs this value client-side to
-- decide whether checkout crosses into OT territory before it decides
-- whether to pass p_ot_* params to perform_worker_checkout at all.
-- Same SECURITY DEFINER rationale as the perform_worker_* functions in
-- 2026-09-03-02-worker-checkin-functions.sql -- a narrow, read-only
-- escape hatch for exactly one setting, not a broader RLS change.

CREATE OR REPLACE FUNCTION get_regular_shift_end_time()
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT value FROM app_settings WHERE tenant_id = current_tenant_id() AND key = 'regular_shift_end_time'), '17:00');
$$;

REVOKE EXECUTE ON FUNCTION get_regular_shift_end_time() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_regular_shift_end_time() TO authenticated;
