-- CRITICAL: sites_progress was leaking every tenant's site data to
-- every other tenant.
--
-- History: 2026-08-15-03 made site_financial_summary security_invoker.
-- sites_progress queried through it, and since security_invoker checks
-- the ORIGINAL SESSION's own privileges (not an enclosing owner-rights
-- view's bypass), that broke `SET ROLE anon; SELECT * FROM
-- sites_progress;` (returned 0 rows). 2026-08-15-04 "fixed" this by
-- rewriting sites_progress to query the base tables (sites, incomes)
-- directly with NO security_invoker flag -- which restored the
-- owner-rights bypass and made the anon-returns-0-rows symptom go away,
-- but did so by making the view run as its owner (postgres, a
-- superuser) for EVERY caller, bypassing sites/incomes' RLS entirely.
--
-- sites_progress is only ever queried from inside the authenticated
-- Dashboard (src/pages/Dashboard.jsx's useSitesProgress(), behind
-- ProtectedPage/login) -- it was never actually meant to be readable by
-- `anon`. The 2026-08-15-04 fix chased the wrong symptom: "anon sees 0
-- rows" was correct, expected behavior (anon has no tenant, so it
-- should see nothing) -- the actual, unnoticed side effect was that
-- every AUTHENTICATED user, from ANY tenant, could now see EVERY OTHER
-- tenant's site names, numbers, statuses, dates, and billing
-- percentages, since owner-rights bypasses RLS for authenticated
-- callers too, not just anon ones.
--
-- Discovered live 2026-08-18 via user report: a brand-new, empty test
-- tenant's Dashboard showed the real FacadeX company's ongoing sites.
--
-- Fix: security_invoker = true. sites/incomes already have correct
-- tenant-scoped RLS (admin_reads: is_admin_or_owner() AND tenant_id =
-- current_tenant_id()) -- verified live before this migration. Query
-- body is otherwise unchanged from 2026-08-15-04.
CREATE OR REPLACE VIEW sites_progress WITH (security_invoker = true) AS
SELECT
  s.id,
  s.site_number,
  s.name,
  s.status,
  s.start_date,
  s.end_date,
  CASE WHEN s.contract_value > 0
    THEN ROUND(COALESCE(SUM(i.received_amount), 0) / s.contract_value * 100, 1)
    ELSE NULL
  END AS billing_pct
FROM sites s
LEFT JOIN incomes i ON i.site_id = s.id
GROUP BY s.id, s.site_number, s.name, s.status, s.start_date, s.end_date, s.contract_value;
