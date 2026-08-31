-- supabase/migrations/2026-09-02-05-fix-payment-forecast-check-date-priority.sql
-- User-reported bug: the Dashboard's "ยอดที่ต้องชำระ" card showed a cheque-
-- linked expense under July when the cheque is actually due 4/9
-- (September). Root cause: payment_forecast's COALESCE(due_date,
-- check_date, date) checked due_date FIRST -- a check-payment expense can
-- carry a stale due_date left over from before it was linked to a cheque
-- (e.g. auto-filled from the supplier's credit term while payment_method
-- was still 'transfer', never cleared after switching to 'check' and
-- linking a cheque). Confirmed live: 11 real expenses have both due_date
-- and check_date set to DIFFERENT months, all cheque-linked -- due_date
-- won every time, all showing the wrong (earlier) month.
--
-- check_date is the one kept in sync with the cheque itself (see
-- expense_sync_check_date_from_cheque, 2026-09-01-06) -- it must win the
-- coalesce whenever it's set. Swapped priority to COALESCE(check_date,
-- due_date, date). src/lib/expenseFilters.js's applyDateFilter() MUST
-- match this exactly (fixed in the same commit) or the Dashboard total
-- and clicking through to Expenses filtered by that month disagree again.
CREATE OR REPLACE VIEW payment_forecast WITH (security_invoker = true) AS
SELECT
  DATE_TRUNC('month', COALESCE(check_date, due_date, date)) AS forecast_month,
  SUM(amount)                                      AS total_due,
  COUNT(*)                                         AS invoice_count,
  payment_method,
  status
FROM expenses
WHERE status IN ('pending','check_issued')
GROUP BY 1, 4, 5
ORDER BY 1;
