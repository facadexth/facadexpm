-- supabase/migrations/2026-09-09-04-site-last-activity-date.sql
-- Adds last_activity_date to site_financial_summary -- the most recent
-- date across the three tables that represent someone actually doing
-- something on a site (an expense logged, income received, or a worker
-- assigned to work there). Lets Sites.jsx default-sort "most recently
-- active site first" instead of always by site_number.
-- WITH (security_invoker = true) preserved -- see
-- 2026-08-16-01-fix-site-financial-summary-fanout.sql's own comment on
-- why every view here carries it (a real cross-tenant RLS leak
-- happened once from a view that omitted it).
CREATE OR REPLACE VIEW site_financial_summary WITH (security_invoker = true) AS
WITH quotation_discount AS (
  SELECT q.id AS quotation_id,
    CASE
      WHEN COALESCE(q.discount_pct, 0) <> 0 THEN GREATEST(0, 1 - q.discount_pct / 100)
      WHEN q.discount_amount IS NOT NULL AND COALESCE(qt.raw_total, 0) > 0 THEN GREATEST(0, (qt.raw_total - q.discount_amount) / qt.raw_total)
      ELSE 1
    END AS price_multiplier
  FROM quotations q
  LEFT JOIN (
    SELECT quotation_items.quotation_id, sum(quotation_items.line_total) AS raw_total
    FROM quotation_items GROUP BY quotation_items.quotation_id
  ) qt ON qt.quotation_id = q.id
), worker_cost AS (
  SELECT labor_cost_by_site.site_id, sum(labor_cost_by_site.labor_cost) AS labor_cost
  FROM labor_cost_by_site GROUP BY labor_cost_by_site.site_id
), worker_ot AS (
  SELECT ot_cost_by_site.site_id, sum(ot_cost_by_site.ot_cost) AS ot_cost
  FROM ot_cost_by_site GROUP BY ot_cost_by_site.site_id
), subcontractor_cost AS (
  SELECT expenses.site_id, sum(expenses.amount) AS subcontractor_labor_cost
  FROM expenses WHERE expenses.is_subcontract = true GROUP BY expenses.site_id
), activity AS (
  SELECT site_id, max(last_date) AS last_activity_date FROM (
    SELECT site_id, max(date) AS last_date FROM expenses GROUP BY site_id
    UNION ALL
    SELECT site_id, max(date) AS last_date FROM incomes WHERE site_id IS NOT NULL GROUP BY site_id
    UNION ALL
    SELECT site_id, max(date) AS last_date FROM worker_assignments GROUP BY site_id
  ) all_dates
  GROUP BY site_id
)
SELECT
  s.id, s.site_number, s.name, s.status, s.start_date, s.end_date, s.contract_value,
  s.client_id, s.client_name, s.location,
  s.cost_aluminum, s.cost_glass, s.cost_equipment, s.cost_rubber, s.cost_labor, s.cost_other,
  c.name AS client_display_name, c.client_number,
  COALESCE(exp.total_expense, 0) + COALESCE(wc.labor_cost, 0) + COALESCE(wo.ot_cost, 0) AS total_expense,
  COALESCE(inc.total_income, 0) AS total_income,
  COALESCE(inc.total_income, 0) - (COALESCE(exp.total_expense, 0) + COALESCE(wc.labor_cost, 0) + COALESCE(wo.ot_cost, 0)) AS gross_profit,
  CASE WHEN s.contract_value > 0 THEN round(COALESCE(inc.total_income, 0) / s.contract_value * 100, 1) ELSE NULL END AS billing_pct,
  COALESCE(exp.outstanding_expense, 0) AS outstanding_expense,
  s.distance_km, s.map_url,
  c.contact_person AS client_contact_person, c.phone AS client_phone,
  s.has_vat, s.contract_value_no_vat, s.default_vat_pct, s.default_tax_withheld_pct,
  s.default_retention_pct, s.default_retention_period_days, s.default_deposit_pct,
  COALESCE(inv.invoiced_amount, 0) AS invoiced_amount,
  CASE WHEN s.contract_value > 0 THEN round(COALESCE(inv.invoiced_amount, 0) / s.contract_value * 100, 1) ELSE NULL END AS invoiced_pct,
  COALESCE(wc.labor_cost, 0) + COALESCE(wo.ot_cost, 0) AS worker_labor_cost,
  COALESCE(sc.subcontractor_labor_cost, 0) AS subcontractor_labor_cost,
  s.lat, s.lng,
  act.last_activity_date
FROM sites s
LEFT JOIN clients c ON s.client_id = c.id
LEFT JOIN (
  SELECT expenses.site_id, sum(expenses.amount) AS total_expense,
    sum(CASE WHEN expenses.status = ANY (ARRAY['pending'::text, 'check_issued'::text]) THEN expenses.amount ELSE 0 END) AS outstanding_expense
  FROM expenses GROUP BY expenses.site_id
) exp ON exp.site_id = s.id
LEFT JOIN (
  SELECT incomes.site_id, sum(incomes.received_amount) AS total_income
  FROM incomes GROUP BY incomes.site_id
) inc ON inc.site_id = s.id
LEFT JOIN worker_cost wc ON wc.site_id = s.id
LEFT JOIN worker_ot wo ON wo.site_id = s.id
LEFT JOIN subcontractor_cost sc ON sc.site_id = s.id
LEFT JOIN (
  SELECT q.site_id,
    sum(qiu.cumulative_pct / 100 * qiu.unit_qty * qi.unit_price * COALESCE(qd.price_multiplier, 1) *
      CASE WHEN q.has_vat AND NOT q.price_includes_vat THEN 1.07 ELSE 1 END) AS invoiced_amount
  FROM quotation_item_units qiu
  JOIN quotation_items qi ON qi.id = qiu.quotation_item_id
  JOIN quotations q ON q.id = qi.quotation_id
  LEFT JOIN quotation_discount qd ON qd.quotation_id = q.id
  WHERE q.site_id IS NOT NULL
  GROUP BY q.site_id
) inv ON inv.site_id = s.id
LEFT JOIN activity act ON act.site_id = s.id;
