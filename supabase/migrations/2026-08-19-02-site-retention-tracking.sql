-- Client retention (เงินประกันผลงาน) withheld from income/billing already has
-- an amount (incomes.retention) but no due date and no release tracking.
-- This is the client-side equivalent of the existing labor subcontractor
-- retention system (labor_contracts/labor_payments), which hardcodes its
-- due date as site.end_date + 6 months and is NOT touched by this migration
-- -- separate money flow, separate system.
--
-- default_retention_period_days has no default -- a wrong guessed due date
-- on financial data is worse than no due date, so existing sites simply
-- have no computed due date until someone sets this explicitly.
ALTER TABLE sites ADD COLUMN default_retention_period_days INTEGER;
ALTER TABLE sites ADD COLUMN retention_released BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sites ADD COLUMN retention_released_date DATE;

-- security_invoker = true is required on every view in this app -- a view
-- without it runs as its owner (a superuser), bypassing the querying
-- user's RLS entirely. This exact mistake caused a real cross-tenant data
-- leak in sites_progress (see 2026-08-18-01-fix-sites-progress-cross-tenant-leak.sql).
CREATE VIEW site_retention_summary WITH (security_invoker = true) AS
SELECT
  s.id AS site_id,
  s.site_number,
  s.name,
  s.end_date,
  s.default_retention_period_days,
  s.retention_released,
  s.retention_released_date,
  COALESCE(SUM(i.retention), 0) AS total_retention,
  CASE
    WHEN s.end_date IS NOT NULL AND s.default_retention_period_days IS NOT NULL
    -- DATE + INTERVAL yields a timestamp, not a date -- cast back so
    -- due_date doesn't carry a spurious 00:00:00 time component.
    THEN (s.end_date + (s.default_retention_period_days || ' days')::INTERVAL)::DATE
    ELSE NULL
  END AS due_date
FROM sites s
LEFT JOIN incomes i ON i.site_id = s.id
GROUP BY s.id, s.site_number, s.name, s.end_date, s.default_retention_period_days,
         s.retention_released, s.retention_released_date;
