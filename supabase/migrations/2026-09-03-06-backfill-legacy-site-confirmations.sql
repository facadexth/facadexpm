-- supabase/migrations/2026-09-03-06-backfill-legacy-site-confirmations.sql
--
-- Follow-up fix from the WHOLE-BRANCH review of the worker check-in/check-out
-- feature (not part of the original 7-task plan in
-- docs/superpowers/plans/2026-09-01-worker-checkin-checkout.md).
--
-- CRITICAL, and live-and-wrong at the time this ran.
--
-- 2026-09-03-03-gate-labor-cost-on-confirmation.sql made labor_cost_by_site
-- require `confirmed_at IS NOT NULL` for every type='site' row. But
-- worker_assignments.confirmed_at only came into existence in
-- 2026-09-03-01-worker-checkin-schema.sql, so EVERY historical site shift had
-- confirmed_at = NULL and was retroactively dropped from labor cost -- which
-- also flows into site_financial_summary.worker_labor_cost, .total_expense and
-- .gross_profit. Real, already-worked, already-paid shifts stopped counting.
--
-- This grandfathers every site shift dated BEFORE the feature's go-live day as
-- confirmed. confirmed_by = 'legacy' is a deliberate sentinel, distinct from
-- 'checkin' (a real GPS check-in) and from an admin's email (a manual
-- override), so backfilled rows stay visually distinguishable in the Assign
-- grid's confirmation indicator (src/pages/assign/CellEditPopup.jsx).
-- confirmed_at uses created_at (when the shift was actually planned), falling
-- back to the shift date, so the timestamp shown is never invented.
--
-- Rows dated today or later are deliberately NOT touched -- from go-live day
-- onward the gate is real and a worker must actually check in (or an admin
-- must override).
--
-- One-time data correction, not a schema change: there is intentionally no
-- rollback path, and supabase/schema.sql is unchanged (it tracks structure
-- only).
--
-- Live result on project yyzbgdmgyvvypfcjuhtr: 463 rows updated; afterwards
-- `SELECT count(*) FROM worker_assignments WHERE type='site' AND confirmed_at
-- IS NULL AND date < CURRENT_DATE` = 0, and labor_cost_by_site went from
-- 28 rows / 42.5 days / 33,348.96 THB back to 87 rows / 274.0 days /
-- 211,007.82 THB.

UPDATE worker_assignments
SET confirmed_at = COALESCE(created_at, date::timestamptz),
    confirmed_by = 'legacy'
WHERE type = 'site'
  AND confirmed_at IS NULL
  AND date < CURRENT_DATE;
