-- supabase/migrations/2026-09-03-03-gate-labor-cost-on-confirmation.sql
-- A 'site'-type shift only counts toward payroll once confirmed (a real
-- check-in, or an admin override -- see 2026-09-03-01/02 and
-- docs/superpowers/specs/2026-09-01-worker-checkin-checkout-design.md).
-- 'factory' rows are untouched -- there's no site to check in at, they
-- keep counting immediately as before.
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
WHERE wa.type = 'factory' OR (wa.type = 'site' AND wa.confirmed_at IS NOT NULL)
GROUP BY wa.site_id, s.name, s.site_number, wa.worker_id, w.name, w.nickname, w.monthly_salary;
