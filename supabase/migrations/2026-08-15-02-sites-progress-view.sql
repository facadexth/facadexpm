-- sites_progress: WORKER-safe view of site info — exposes the billing
-- percentage (income received / contract value) as a progress proxy,
-- but never the underlying money figures themselves. Built on top of
-- site_financial_summary (already computes billing_pct) rather than
-- duplicating that math.
-- See docs/superpowers/plans/2026-08-15-rls-worker-view.md
CREATE OR REPLACE VIEW sites_progress AS
SELECT
  id,
  site_number,
  name,
  status,
  start_date,
  end_date,
  billing_pct
FROM site_financial_summary;
