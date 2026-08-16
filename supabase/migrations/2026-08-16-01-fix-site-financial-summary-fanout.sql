-- Fix a fan-out bug in site_financial_summary: joining expenses and incomes
-- directly in the same query (both one-to-many from sites) produces a
-- cartesian product per site, multiplying total_expense by the income row
-- count and total_income by the expense row count. Pre-aggregate each side
-- in its own subquery first, then join at most one row per site.
--
-- Discovered live: FX-2026-001 showed total_income = ฿394,395,518 (real
-- value ฿3,585,414 × 110 expense rows) and total_expense = ฿11,724,055
-- (real value ฿5,862,028 × 2 income rows), producing a nonsensical 2813.7%
-- billing_pct on the dashboard.
CREATE OR REPLACE VIEW site_financial_summary WITH (security_invoker = true) AS
SELECT
  s.id, s.site_number, s.name, s.status, s.start_date, s.end_date, s.contract_value,
  s.client_id, s.client_name, s.location,
  s.cost_aluminum, s.cost_glass, s.cost_equipment, s.cost_rubber, s.cost_labor, s.cost_other,
  c.name            AS client_display_name,
  c.client_number,
  COALESCE(exp.total_expense, 0)                                    AS total_expense,
  COALESCE(inc.total_income, 0)                                     AS total_income,
  COALESCE(inc.total_income, 0) - COALESCE(exp.total_expense, 0)    AS gross_profit,
  CASE WHEN s.contract_value > 0
    THEN ROUND(COALESCE(inc.total_income, 0) / s.contract_value * 100, 1)
    ELSE NULL
  END AS billing_pct,
  COALESCE(exp.outstanding_expense, 0) AS outstanding_expense,
  s.distance_km,
  s.map_url,
  c.contact_person AS client_contact_person,
  c.phone          AS client_phone
FROM sites s
LEFT JOIN clients c ON s.client_id = c.id
LEFT JOIN (
  SELECT site_id,
         SUM(amount) AS total_expense,
         SUM(CASE WHEN status IN ('pending','check_issued') THEN amount ELSE 0 END) AS outstanding_expense
  FROM expenses
  GROUP BY site_id
) exp ON exp.site_id = s.id
LEFT JOIN (
  SELECT site_id, SUM(received_amount) AS total_income
  FROM incomes
  GROUP BY site_id
) inc ON inc.site_id = s.id;
