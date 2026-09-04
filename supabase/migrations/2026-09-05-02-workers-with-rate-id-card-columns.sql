-- supabase/migrations/2026-09-05-02-workers-with-rate-id-card-columns.sql
-- workers_with_rate lists its columns explicitly (not w.*) -- a view's
-- output list freezes at CREATE VIEW time and does NOT pick up later
-- ALTER TABLE ADD COLUMN changes on the underlying table. Without this,
-- useAllActiveWorkers() (which reads from this view) would never see
-- id_card_number/address/id_card_photo_path added in
-- 2026-09-05-01-worker-id-card-fields.sql, silently breaking the edit
-- form's ability to show a worker's existing ID card data.
CREATE OR REPLACE VIEW workers_with_rate WITH (security_invoker = true) AS
SELECT
  id, name, nickname, position, monthly_salary, has_social_security,
  annual_leave_days, monthly_contribution, status, created_at, updated_at,
  ROUND(monthly_salary / 26, 2) AS daily_rate,
  ROUND(monthly_salary * 0.05 / 100 * 750, 0) AS social_security_amount,
  email, show_in_assign, annual_sick_leave_days,
  id_card_number, address, id_card_photo_path
FROM workers;
