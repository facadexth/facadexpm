-- Sick leave quota: mirrors the existing annual_leave_days (ลากิจ) quota,
-- adding a separate annual_sick_leave_days (ลาป่วย) quota. Default 30 days/
-- year per the user's request; per-worker values are expected to be
-- adjusted manually afterward via the HR form.
ALTER TABLE workers ADD COLUMN annual_sick_leave_days INT NOT NULL DEFAULT 30; -- วันลาป่วยที่ได้รับต่อปี (โควต้า leave_sick)

-- workers_with_rate has an explicit column list (not SELECT *) -- must be
-- updated here or the new column stays invisible to every consumer of
-- useWorkers()/useAllActiveWorkers(). WITH (security_invoker = true) is
-- preserved (hard rule -- a past cross-tenant RLS leak came from a view
-- that dropped this).
-- New columns must be appended at the end of the SELECT list, not inserted
-- mid-list -- CREATE OR REPLACE VIEW rejects renaming/reordering existing
-- output columns (Postgres error 42P16).
CREATE OR REPLACE VIEW workers_with_rate WITH (security_invoker = true) AS
SELECT
  id, name, nickname, position, monthly_salary, has_social_security,
  annual_leave_days, monthly_contribution, status, created_at, updated_at,
  ROUND(monthly_salary / 26, 2) AS daily_rate,
  ROUND(monthly_salary * 0.05 / 100 * 750, 0) AS social_security_amount,
  email, show_in_assign, annual_sick_leave_days
FROM workers;
