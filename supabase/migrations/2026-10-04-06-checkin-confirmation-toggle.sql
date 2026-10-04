-- "Shift must be confirmed (real check-in or admin override) before it counts as wages/travel"
-- becomes a per-company switch: app_settings key `require_checkin_confirmation`.
-- Default OFF (the check-in flow is not in everyday use yet): every site shift counts, as it
-- did before the confirmation gate (2026-09-03-03 / -08). Turn it on in HR settings and the
-- gate applies again: only confirmed site shifts count.

CREATE OR REPLACE FUNCTION checkin_confirmation_required() RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE((SELECT value FROM app_settings
                   WHERE key = 'require_checkin_confirmation' AND tenant_id = current_tenant_id()) = 'true', false)
$$;
REVOKE ALL ON FUNCTION checkin_confirmation_required() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_confirmation_required() TO authenticated, service_role;

CREATE OR REPLACE VIEW labor_cost_by_site WITH (security_invoker = true) AS
SELECT
  wa.site_id,
  s.name        AS site_name,
  s.site_number,
  wa.worker_id,
  w.name        AS worker_name,
  w.nickname,
  COUNT(*) * 0.5 AS days_worked,
  ROUND(w.monthly_salary / 26 * (COUNT(*) * 0.5), 2) AS labor_cost
FROM worker_assignments wa
JOIN workers w ON wa.worker_id = w.id
JOIN sites s ON wa.site_id = s.id
WHERE wa.type = 'factory'
   OR (wa.type = 'site' AND (wa.confirmed_at IS NOT NULL OR NOT checkin_confirmation_required()))
GROUP BY wa.site_id, s.name, s.site_number, wa.worker_id, w.name, w.nickname, w.monthly_salary;

CREATE OR REPLACE VIEW site_travel_cost WITH (security_invoker = true) AS
SELECT wa.site_id,
       COUNT(DISTINCT wa.date) AS travel_days,
       s.distance_km,
       ROUND(COUNT(DISTINCT wa.date) * COALESCE(s.distance_km, 0) * 2
             * (SELECT value::numeric FROM app_settings WHERE key = 'travel_rate_per_km'), 2) AS travel_cost
FROM worker_assignments wa
JOIN sites s ON wa.site_id = s.id
WHERE wa.type = 'site' AND (wa.confirmed_at IS NOT NULL OR NOT checkin_confirmation_required())
GROUP BY wa.site_id, s.distance_km;
