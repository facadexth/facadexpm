-- supabase/migrations/2026-10-17-03-labor-cost-divide-30.sql
-- One daily rate everywhere: monthly_salary / 30 (owner decision 2026-10-16),
-- daily_wage for pay_type='daily'. Lowers site labor cost ~13% for all months
-- (live views) — accepted by the owner. Also fixes social_security_amount
-- (was monthly_salary*0.05/100*750, a wrong formula) to LEAST(875, round(5%)).

CREATE OR REPLACE VIEW workers_with_rate WITH (security_invoker = true) AS
SELECT
  id, name, nickname, position, monthly_salary, has_social_security,
  annual_leave_days, monthly_contribution, status, created_at, updated_at,
  ROUND(CASE WHEN pay_type = 'daily' THEN COALESCE(daily_wage, 0) ELSE monthly_salary / 30 END, 2) AS daily_rate,
  LEAST(875, ROUND(monthly_salary * 0.05, 0)) AS social_security_amount,
  email, show_in_assign, annual_sick_leave_days,
  id_card_number, address, id_card_photo_path,
  employee_code, bank_code, bank_account_no, bank_account_name, bank_branch_code, pay_type, daily_wage
FROM workers;

CREATE OR REPLACE VIEW labor_cost_by_site WITH (security_invoker = true) AS
SELECT
  wa.site_id,
  s.name        AS site_name,
  s.site_number,
  wa.worker_id,
  w.name        AS worker_name,
  w.nickname,
  COUNT(*) * 0.5 AS days_worked,
  ROUND((CASE WHEN w.pay_type = 'daily' THEN COALESCE(w.daily_wage, 0) ELSE w.monthly_salary / 30 END) * (COUNT(*) * 0.5), 2) AS labor_cost
FROM worker_assignments wa
JOIN workers w ON wa.worker_id = w.id
JOIN sites s ON wa.site_id = s.id
WHERE wa.type = 'factory'
   OR (wa.type = 'site' AND (wa.confirmed_at IS NOT NULL OR NOT checkin_confirmation_required()))
GROUP BY wa.site_id, s.name, s.site_number, wa.worker_id, w.name, w.nickname, w.monthly_salary, w.pay_type, w.daily_wage;

CREATE OR REPLACE VIEW ot_cost_by_site WITH (security_invoker = true) AS
SELECT
  o.site_id,
  s.name AS site_name,
  s.site_number,
  o.worker_id,
  w.name AS worker_name,
  w.nickname,
  SUM(o.ot_hours) AS ot_hours,
  ROUND(SUM(o.ot_hours * ((CASE WHEN w.pay_type = 'daily' THEN COALESCE(w.daily_wage, 0) ELSE w.monthly_salary / 30 END) / 8) * 1.5), 2) AS ot_cost
FROM worker_ot o
JOIN workers w ON o.worker_id = w.id
JOIN sites s ON o.site_id = s.id
GROUP BY o.site_id, s.name, s.site_number, o.worker_id, w.name, w.nickname;
