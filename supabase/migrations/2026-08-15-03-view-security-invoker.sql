-- Make every financial/salary view respect RLS on its underlying base
-- tables, by re-checking the QUERYING user's own privileges instead of
-- the view owner's (Postgres views default to owner-rights, which is
-- why Task 6's base-table RLS alone doesn't actually protect anything
-- queried through these views — see Task 7 of
-- docs/superpowers/plans/2026-08-15-rls-worker-view.md for the full
-- explanation).
--
-- sites_progress is DELIBERATELY EXCLUDED — it must keep owner-rights
-- so WORKER (who has zero base-table access to sites/expenses/incomes)
-- can still read it. Do not add security_invoker to that view.
ALTER VIEW expenses_view          SET (security_invoker = true);
ALTER VIEW incomes_view           SET (security_invoker = true);
ALTER VIEW site_financial_summary SET (security_invoker = true);
ALTER VIEW payment_forecast       SET (security_invoker = true);
ALTER VIEW labor_cost_by_site     SET (security_invoker = true);
ALTER VIEW ot_cost_by_site        SET (security_invoker = true);
ALTER VIEW site_travel_cost       SET (security_invoker = true);
ALTER VIEW workers_with_rate      SET (security_invoker = true);
ALTER VIEW labor_contract_summary SET (security_invoker = true);
