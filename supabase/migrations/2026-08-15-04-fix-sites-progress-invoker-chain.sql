-- Fix sites_progress: it was defined as `SELECT ... FROM
-- site_financial_summary`, which Task 7 (2026-08-15-03) correctly set to
-- security_invoker=true so DIRECT queries against it respect RLS. But
-- security_invoker checks the ORIGINAL SESSION'S OWN privileges, not
-- "whichever role an enclosing owner-rights view happens to be
-- impersonating" -- so sites_progress's own owner-rights bypass never
-- reached the base tables once its one dependency turned invoker-rights.
-- Discovered live, immediately after applying RLS to production
-- (2026-08-15-01-enable-rls.sql): `SET ROLE anon; SELECT count(*) FROM
-- sites_progress;` returned 0 instead of every site.
--
-- Fix: sites_progress now computes billing_pct directly from sites +
-- incomes (both base tables, not a view), so its owner-rights bypass
-- applies directly with no intermediate invoker-rights hop. Formula is
-- unchanged, copied verbatim from site_financial_summary's own
-- billing_pct expression.
CREATE OR REPLACE VIEW sites_progress AS
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
