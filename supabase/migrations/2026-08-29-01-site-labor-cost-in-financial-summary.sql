-- supabase/migrations/2026-08-29-01-site-labor-cost-in-financial-summary.sql
-- Folds real, already-tracked labor cost into site_financial_summary:
--   - company-worker cost (labor_cost_by_site + ot_cost_by_site, both
--     driven by actual worker_assignments/worker_ot rows -- accrual by
--     days/hours worked, not by what's been paid out yet)
--   - subcontractor cost (labor_contract_summary.total_billed_gross --
--     gross billed to date, the same accrual basis as the worker side,
--     not total_paid_net which nets out retention/WHT actually disbursed)
--
-- sites.cost_labor (the old single manual "ค่าแรง Sub-contract" estimate
-- field) is superseded by these two real numbers and is no longer read
-- here or written by the UI -- the column itself is left untouched so no
-- historical estimate data is lost.
--
-- Both new totals are folded into total_expense/gross_profit, so every
-- site's reported profit changes the moment this ships to reflect real
-- labor cost instead of ignoring it. outstanding_expense is intentionally
-- left as-is (expenses-table only) -- labor payment/paid status is tracked
-- separately on labor_payments.status / salary_records.paid_date and is
-- out of scope here.
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
  SELECT site_id, SUM(total_billed_gross) AS subcontractor_labor_cost
  FROM labor_contract_summary
  GROUP BY site_id
)
SELECT
  s.id, s.site_number, s.name, s.status, s.start_date, s.end_date, s.contract_value,
  s.client_id, s.client_name, s.location,
  s.cost_aluminum, s.cost_glass, s.cost_equipment, s.cost_rubber, s.cost_labor, s.cost_other,
  c.name            AS client_display_name,
  c.client_number,
  COALESCE(exp.total_expense, 0)
    + COALESCE(wc.labor_cost, 0) + COALESCE(wo.ot_cost, 0)
    + COALESCE(sc.subcontractor_labor_cost, 0)                        AS total_expense,
  COALESCE(inc.total_income, 0)                                       AS total_income,
  COALESCE(inc.total_income, 0)
    - (COALESCE(exp.total_expense, 0)
       + COALESCE(wc.labor_cost, 0) + COALESCE(wo.ot_cost, 0)
       + COALESCE(sc.subcontractor_labor_cost, 0))                    AS gross_profit,
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
  COALESCE(sc.subcontractor_labor_cost, 0)             AS subcontractor_labor_cost
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
