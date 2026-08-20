-- Not every HR employee needs day-to-day site scheduling (office staff,
-- management, etc.) -- this lets ADMIN+ hide a worker from the Assign
-- roster (picker UI only) without touching their HR record or any of
-- their existing worker_assignments/OT history. Defaults true so every
-- existing worker keeps appearing exactly as before this ships.
ALTER TABLE workers ADD COLUMN show_in_assign BOOLEAN NOT NULL DEFAULT true;

-- workers_with_rate has an explicit column list (not SELECT *), so the
-- new column must be added here too or useWorkers() can never see it.
-- security_invoker = true is required on every view in this app -- a view
-- without it runs as its owner (a superuser), bypassing the querying
-- user's RLS entirely. This exact mistake caused a real cross-tenant data
-- leak in sites_progress (see 2026-08-18-01-fix-sites-progress-cross-tenant-leak.sql).
CREATE OR REPLACE VIEW workers_with_rate WITH (security_invoker = true) AS
SELECT
  id, name, nickname, position, monthly_salary, has_social_security,
  annual_leave_days, monthly_contribution, status, created_at, updated_at,
  ROUND(monthly_salary / 26, 2) AS daily_rate,
  ROUND(monthly_salary * 0.05 / 100 * 750, 0) AS social_security_amount,
  email, show_in_assign
FROM workers;
