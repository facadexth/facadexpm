-- site_financial_summary was supposed to gain default_retention_period_days
-- (from the earlier retention-tracking feature) and default_deposit_pct
-- (from 2026-08-19-03-client-deposit-tracking.sql), but only supabase/schema.sql
-- was hand-edited to show them -- the live view was never actually replaced.
-- schema.sql documents live production state (introspected, not
-- hand-authored); this migration makes that true again. Without this fix,
-- useSites() (which queries this exact view) can never return either
-- column, so re-saving a site via the Sites edit form silently blanks
-- default_retention_period_days back to NULL, and Task 2's upcoming
-- default_deposit_pct field can never round-trip.
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
  c.phone          AS client_phone,
  s.has_vat, s.contract_value_no_vat,
  s.default_vat_pct, s.default_tax_withheld_pct, s.default_retention_pct,
  s.default_retention_period_days, s.default_deposit_pct
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
