-- supabase/migrations/2026-09-01-01-fix-payment-forecast-coalesce-order.sql
-- payment_forecast previously grouped by DATE_TRUNC('month',
-- COALESCE(check_date, date)) -- never referencing due_date at all, even
-- though due_date is the real "when is this actually due" field for
-- credit-term expenses (see expenses.due_date). A credit-term row's
-- check_date and due_date can land in different months (a cheque written
-- for a Sept installment against an Aug-dated purchase), and the view
-- silently used the wrong one, undercounting/overcounting the Dashboard's
-- "ยอดที่ต้องชำระ (รายเดือน)" KPI per month.
--
-- Also fixes the click-through mismatch: navigating from that KPI to
-- Expenses filtered by month (dateField='due') used a DIFFERENT, and
-- separately buggy, date resolution (see src/lib/expenseFilters.js fix in
-- the same commit) -- the two were never guaranteed to agree. Both now
-- use the same COALESCE(due_date, check_date, date) priority: credit rows
-- key off due_date, cheque rows off check_date, everything else off the
-- plain transaction date.
CREATE OR REPLACE VIEW payment_forecast WITH (security_invoker = true) AS
SELECT
  DATE_TRUNC('month', COALESCE(due_date, check_date, date)) AS forecast_month,
  SUM(amount)                                      AS total_due,
  COUNT(*)                                         AS invoice_count,
  payment_method,
  status
FROM expenses
WHERE status IN ('pending','check_issued')
GROUP BY 1, 4, 5
ORDER BY 1;
