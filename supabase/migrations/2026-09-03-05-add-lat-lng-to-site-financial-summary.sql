-- supabase/migrations/2026-09-03-05-add-lat-lng-to-site-financial-summary.sql
--
-- Follow-up fix from the WHOLE-BRANCH review of the worker check-in/check-out
-- feature (not part of the original 7-task plan in
-- docs/superpowers/plans/2026-09-01-worker-checkin-checkout.md).
--
-- Task 1 (2026-09-03-01-worker-checkin-schema.sql) added sites.lat / sites.lng,
-- but site_financial_summary was never extended. Sites.jsx's SiteForm is
-- populated from THIS VIEW, not from the raw `sites` table, so `initial` had no
-- lat/lng keys and the form's blank inputs won on every save -- editing ANY
-- existing site silently wrote lat = NULL, lng = NULL, wiping the coordinates
-- the check-in radius check depends on. CRITICAL: this was live and wrong.
--
-- CREATE OR REPLACE VIEW requires every existing column to keep its name and
-- ordinal position, so lat/lng are appended at the END of the select list --
-- the same constraint that already forced worker_labor_cost /
-- subcontractor_labor_cost to the end.

CREATE OR REPLACE VIEW site_financial_summary WITH (security_invoker = true) AS
WITH quotation_discount AS (
  -- Mirrors quotationCalc.js's calcQuotationTotals discount math exactly:
  -- discount_pct takes precedence over discount_amount if both are set,
  -- and the multiplier is clamped so a discount larger than the raw total
  -- can never produce a negative price.
  SELECT q.id AS quotation_id,
         CASE
           WHEN COALESCE(q.discount_pct, 0) <> 0 THEN GREATEST(0, 1 - q.discount_pct / 100)
           WHEN q.discount_amount IS NOT NULL AND COALESCE(qt.raw_total, 0) > 0
             THEN GREATEST(0, (qt.raw_total - q.discount_amount) / qt.raw_total)
           ELSE 1
         END AS price_multiplier
  FROM quotations q
  LEFT JOIN (
    SELECT quotation_id, SUM(line_total) AS raw_total
    FROM quotation_items
    GROUP BY quotation_id
  ) qt ON qt.quotation_id = q.id
),
-- Real, already-tracked labor cost -- see
-- 2026-08-29-01-site-labor-cost-in-financial-summary.sql and
-- 2026-08-29-02-subcontractor-labor-cost-from-real-expenses.sql. Worker
-- cost is accrual by days/hours worked (labor_cost_by_site +
-- ot_cost_by_site) -- no real `expenses` row is ever created for it, so
-- it's added on top of exp.total_expense below. Subcontractor cost is
-- real, actually-paid `expenses` rows (is_subcontract = true, written by
-- LaborContractors.jsx's handleMarkPaid) -- those rows are already
-- counted inside exp.total_expense, so subcontractor_labor_cost is NOT
-- added again; it's exposed only as a labeled subset for display.
-- sites.cost_labor is no longer read here -- superseded by these two real
-- numbers.
worker_cost AS (
  SELECT site_id, SUM(labor_cost) AS labor_cost
  FROM labor_cost_by_site
  GROUP BY site_id
),
worker_ot AS (
  SELECT site_id, SUM(ot_cost) AS ot_cost
  FROM ot_cost_by_site
  GROUP BY site_id
),
subcontractor_cost AS (
  SELECT site_id, SUM(amount) AS subcontractor_labor_cost
  FROM expenses
  WHERE is_subcontract = true
  GROUP BY site_id
)
SELECT
  s.id, s.site_number, s.name, s.status, s.start_date, s.end_date, s.contract_value,
  s.client_id, s.client_name, s.location,
  s.cost_aluminum, s.cost_glass, s.cost_equipment, s.cost_rubber, s.cost_labor, s.cost_other,
  c.name            AS client_display_name,
  c.client_number,
  COALESCE(exp.total_expense, 0)
    + COALESCE(wc.labor_cost, 0) + COALESCE(wo.ot_cost, 0)             AS total_expense,
  COALESCE(inc.total_income, 0)                                       AS total_income,
  COALESCE(inc.total_income, 0)
    - (COALESCE(exp.total_expense, 0)
       + COALESCE(wc.labor_cost, 0) + COALESCE(wo.ot_cost, 0))         AS gross_profit,
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
  END AS invoiced_pct,
  -- Appended at the end: CREATE OR REPLACE VIEW requires existing column
  -- name/position to stay stable, so new columns must land last.
  COALESCE(wc.labor_cost, 0) + COALESCE(wo.ot_cost, 0) AS worker_labor_cost,
  COALESCE(sc.subcontractor_labor_cost, 0)             AS subcontractor_labor_cost,
  -- GPS check-in coordinates (added 2026-09-03-05). SiteForm's edit mode is
  -- populated from THIS view, not from `sites` -- without these two columns
  -- every site edit silently wrote lat/lng back as NULL.
  s.lat, s.lng
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
LEFT JOIN worker_cost wc ON wc.site_id = s.id
LEFT JOIN worker_ot wo ON wo.site_id = s.id
LEFT JOIN subcontractor_cost sc ON sc.site_id = s.id
LEFT JOIN (
  SELECT q.site_id,
         SUM(
           qiu.cumulative_pct / 100 * qiu.unit_qty * qi.unit_price
           * COALESCE(qd.price_multiplier, 1)
           * CASE WHEN q.has_vat AND NOT q.price_includes_vat THEN 1.07 ELSE 1 END
         ) AS invoiced_amount
  FROM quotation_item_units qiu
  JOIN quotation_items qi ON qi.id = qiu.quotation_item_id
  JOIN quotations q ON q.id = qi.quotation_id
  LEFT JOIN quotation_discount qd ON qd.quotation_id = q.id
  WHERE q.site_id IS NOT NULL
  GROUP BY q.site_id
) inv ON inv.site_id = s.id;
