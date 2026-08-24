-- supabase/migrations/2026-08-25-01-invoiced-amount-discount-vat-fix.sql
-- Fixes two money bugs in site_financial_summary.invoiced_amount, both
-- introduced with the column itself in 2026-08-24-07-site-invoiced-pct.sql:
--
--   1. DISCOUNT was ignored. quotation_items.line_total / unit_price are
--      stored UNDISCOUNTED -- the quotation's discount lives only on the
--      header (quotations.discount_pct / discount_amount) and is applied by
--      quotationCalc.js at total time. Summing raw unit_price therefore
--      overstated invoiced_amount by the whole discount. This is the same
--      underlying bug as the JS-side one fixed in Invoices.jsx
--      (discountMultiplier()), but a SEPARATE instance of it: this view
--      reads quotation_item_units + quotation_items directly and never
--      touches invoice_items, so the JS fix does not reach it.
--
--   2. VAT was missing. sites.contract_value is VAT-INCLUSIVE, but the
--      cumulative_pct * unit_qty * unit_price product is pre-VAT whenever
--      a quotation has has_vat AND NOT price_includes_vat (the normal
--      case) -- so a site billed to 100% displayed as ~93.5%.
--
-- CREATE OR REPLACE VIEW of the exact existing definition plus the new
-- quotation_discount CTE; only the `inv` subquery's SUM expression
-- changes. Every existing column is untouched, in its existing order
-- (CREATE OR REPLACE VIEW requires that anyway).
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
)
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
