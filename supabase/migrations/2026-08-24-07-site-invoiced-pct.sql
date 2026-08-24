-- supabase/migrations/2026-08-24-07-site-invoiced-pct.sql
-- Adds a second, distinct progress figure alongside the existing
-- billing_pct (= % collected, driven by incomes -- unchanged). invoiced_pct
-- answers "how much of the contract has been billed" the instant an
-- invoice is created, computed the same pure-derived-view way billing_pct
-- already is -- nothing stored on sites itself. See spec's "Site Progress"
-- section. CREATE OR REPLACE VIEW of the exact existing definition
-- (supabase/schema.sql, search site_financial_summary) plus one new LEFT
-- JOIN and two new columns -- every existing column is untouched.
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
  s.default_retention_period_days, s.default_deposit_pct,
  COALESCE(inv.invoiced_amount, 0) AS invoiced_amount,
  CASE WHEN s.contract_value > 0
    THEN ROUND(COALESCE(inv.invoiced_amount, 0) / s.contract_value * 100, 1)
    ELSE NULL
  END AS invoiced_pct
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
) inc ON inc.site_id = s.id
LEFT JOIN (
  SELECT q.site_id,
         SUM(qiu.cumulative_pct / 100 * qiu.unit_qty * qi.unit_price) AS invoiced_amount
  FROM quotation_item_units qiu
  JOIN quotation_items qi ON qi.id = qiu.quotation_item_id
  JOIN quotations q ON q.id = qi.quotation_id
  WHERE q.site_id IS NOT NULL
  GROUP BY q.site_id
) inv ON inv.site_id = s.id;
