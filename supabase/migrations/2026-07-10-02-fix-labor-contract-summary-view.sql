-- Fix labor_contract_summary: the live view had drifted to an older,
-- simpler shape (no sites join, no subcontractor_number, no billing %,
-- no retention-release fields) while LaborContractors.jsx was extended to
-- rely on all of those columns. The view was never captured in a migration
-- file, so the drift went unnoticed. Worse, the page's query does
-- `.order('subcontractor_number')`, a column the drifted view didn't have
-- at all -- PostgREST errors on that order-by, so useLaborContracts()
-- always failed and the contracts list rendered empty regardless of
-- whether an insert succeeded (root cause of "add contract, doesn't show
-- up"). Restoring the originally-specified view
-- (docs/superpowers/plans/2026-06-29-phase2-labor-contractors.md).
DROP VIEW IF EXISTS labor_contract_summary;

CREATE VIEW labor_contract_summary AS
SELECT
  lc.id, lc.subcontractor_id, lc.site_id,
  lc.work_description, lc.contract_amount,
  lc.retention_pct, lc.withholding_tax_pct,
  lc.site_note, lc.status, lc.start_date,
  ls.name AS subcontractor_name, ls.subcontractor_number,
  s.name AS site_name, s.site_number, s.status AS site_status,
  s.end_date AS site_end_date, s.contract_value AS site_contract_value,
  -- Payment summaries (excluding retention release payments)
  COALESCE(SUM(lp.gross_amount) FILTER (WHERE NOT lp.is_retention_release), 0) AS total_billed_gross,
  COALESCE(SUM(lp.retention_amount) FILTER (WHERE NOT lp.is_retention_release), 0) AS total_retention_held,
  COALESCE(SUM(lp.net_amount) FILTER (WHERE NOT lp.is_retention_release), 0) AS total_paid_net,
  COALESCE(SUM(lp.net_amount) FILTER (WHERE lp.is_retention_release AND lp.status = 'paid'), 0) AS retention_released,
  -- Progress vs site
  CASE WHEN lc.contract_amount > 0
    THEN ROUND(COALESCE(SUM(lp.gross_amount) FILTER (WHERE NOT lp.is_retention_release),0) / lc.contract_amount * 100, 1)
    ELSE 0 END AS contractor_billing_pct,
  -- Retention release eligibility
  s.end_date + INTERVAL '6 months' AS retention_release_date,
  (s.end_date IS NOT NULL AND NOW() >= s.end_date + INTERVAL '6 months') AS retention_releasable,
  lc.contract_amount - COALESCE(SUM(lp.gross_amount) FILTER (WHERE NOT lp.is_retention_release),0) AS remaining_amount
FROM labor_contracts lc
JOIN labor_subcontractors ls ON lc.subcontractor_id = ls.id
JOIN sites s ON lc.site_id = s.id
LEFT JOIN labor_payments lp ON lp.contract_id = lc.id
GROUP BY lc.id, lc.subcontractor_id, lc.site_id, lc.work_description, lc.contract_amount,
  lc.retention_pct, lc.withholding_tax_pct, lc.site_note, lc.status, lc.start_date,
  ls.name, ls.subcontractor_number, s.name, s.site_number, s.status, s.end_date, s.contract_value;
