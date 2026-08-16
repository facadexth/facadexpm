-- ================================================================
-- Regression tests for aggregate financial views.
--
-- Why this exists: site_financial_summary shipped with a real, silent
-- fan-out bug — joining expenses and incomes directly in one query (both
-- one-to-many from sites) produced a cartesian product per site,
-- multiplying each SUM() by the OTHER table's row count. It went
-- undetected until a site accumulated 110 expense rows and showed
-- ฿394,395,518 of income against a ฿14M contract (2813.7% billing).
-- See supabase/migrations/2026-08-16-01-fix-site-financial-summary-fanout.sql.
--
-- Run manually via the Supabase SQL editor / MCP execute_sql, or wire
-- into CI, before merging any change to these views' JOIN/GROUP BY
-- shape. Every test uses disposable fixtures (created and deleted in
-- the same transaction-less DO block) — safe to run against production.
--
-- Run: paste this whole file into the SQL editor and execute. Each
-- block RAISEs an EXCEPTION and aborts on failure; a clean run ends
-- with N "... TEST PASSED" NOTICEs and no error.
-- ================================================================

-- ── Test 1: site_financial_summary must not multiply income by expense
-- row count (or vice versa) when a site has multiple rows in both. ──
DO $$
DECLARE
  test_site_id UUID;
  result_expense NUMERIC;
  result_income NUMERIC;
BEGIN
  INSERT INTO sites (site_number, name, contract_value)
  VALUES ('__TEST-001__', '__TEST SITE fanout__', 10000)
  RETURNING id INTO test_site_id;

  -- 3 expense rows (sum = 600), 2 income rows (sum = 1200) — deliberately
  -- different counts so a fan-out bug (total × other-side row count)
  -- would be unmistakable rather than coincidentally correct.
  INSERT INTO expenses (date, description, site_id, amount, status) VALUES
    ('2026-01-01', '__TEST__', test_site_id, 100, 'pending'),
    ('2026-01-02', '__TEST__', test_site_id, 200, 'pending'),
    ('2026-01-03', '__TEST__', test_site_id, 300, 'pending');

  INSERT INTO incomes (date, site_id, description, received_amount) VALUES
    ('2026-01-01', test_site_id, '__TEST__', 500),
    ('2026-01-02', test_site_id, '__TEST__', 700);

  SELECT total_expense, total_income INTO result_expense, result_income
  FROM site_financial_summary WHERE id = test_site_id;

  IF result_expense != 600 OR result_income != 1200 THEN
    RAISE EXCEPTION 'site_financial_summary FAN-OUT REGRESSION: expected expense=600 income=1200, got expense=% income=%',
      result_expense, result_income;
  END IF;

  DELETE FROM expenses WHERE site_id = test_site_id;
  DELETE FROM incomes WHERE site_id = test_site_id;
  DELETE FROM sites WHERE id = test_site_id;

  RAISE NOTICE 'Test 1 (site_financial_summary fan-out): TEST PASSED';
END $$;

-- ── Test 2: labor_contract_summary must SUM labor_payments correctly
-- when a contract has multiple payment rows (single one-to-many join +
-- GROUP BY — correct by construction, but a future second one-to-many
-- join added to this view would silently reintroduce the same bug
-- class, so this guards the shape). ──
DO $$
DECLARE
  test_site_id UUID;
  test_sub_id UUID;
  test_contract_id UUID;
  result_gross NUMERIC;
BEGIN
  INSERT INTO sites (site_number, name) VALUES ('__TEST-002__', '__TEST SITE contract__')
  RETURNING id INTO test_site_id;

  INSERT INTO labor_subcontractors (name) VALUES ('__TEST SUBCONTRACTOR__')
  RETURNING id INTO test_sub_id;

  INSERT INTO labor_contracts (subcontractor_id, site_id, work_description, contract_amount)
  VALUES (test_sub_id, test_site_id, '__TEST__', 100000)
  RETURNING id INTO test_contract_id;

  -- 3 payment rows, gross_amount sum = 6000
  INSERT INTO labor_payments (contract_id, payment_date, gross_amount, net_amount) VALUES
    (test_contract_id, '2026-01-01', 1000, 1000),
    (test_contract_id, '2026-01-02', 2000, 2000),
    (test_contract_id, '2026-01-03', 3000, 3000);

  SELECT total_billed_gross INTO result_gross
  FROM labor_contract_summary WHERE id = test_contract_id;

  IF result_gross != 6000 THEN
    RAISE EXCEPTION 'labor_contract_summary REGRESSION: expected total_billed_gross=6000, got %', result_gross;
  END IF;

  DELETE FROM labor_payments WHERE contract_id = test_contract_id;
  DELETE FROM labor_contracts WHERE id = test_contract_id;
  DELETE FROM labor_subcontractors WHERE id = test_sub_id;
  DELETE FROM sites WHERE id = test_site_id;

  RAISE NOTICE 'Test 2 (labor_contract_summary): TEST PASSED';
END $$;

-- ── Test 3: labor_cost_by_site / ot_cost_by_site must not inflate
-- counts via their many-to-one dimension joins (workers, sites). ──
DO $$
DECLARE
  test_site_id UUID;
  test_worker_id UUID;
  result_days NUMERIC;
  result_ot_hours NUMERIC;
BEGIN
  INSERT INTO sites (site_number, name, distance_km) VALUES ('__TEST-003__', '__TEST SITE labor__', 10)
  RETURNING id INTO test_site_id;

  INSERT INTO workers (name, monthly_salary) VALUES ('__TEST WORKER__', 26000)
  RETURNING id INTO test_worker_id;

  -- 4 assignment shifts (2 full days) at this site for this worker
  INSERT INTO worker_assignments (worker_id, site_id, date, type, shift) VALUES
    (test_worker_id, test_site_id, '2026-01-01', 'site', 'morning'),
    (test_worker_id, test_site_id, '2026-01-01', 'site', 'evening'),
    (test_worker_id, test_site_id, '2026-01-02', 'site', 'morning'),
    (test_worker_id, test_site_id, '2026-01-02', 'site', 'evening');

  INSERT INTO worker_ot (worker_id, site_id, date, start_time, end_time, ot_hours) VALUES
    (test_worker_id, test_site_id, '2026-01-01', '18:00', '20:00', 2),
    (test_worker_id, test_site_id, '2026-01-02', '18:00', '21:00', 3);

  SELECT days_worked INTO result_days FROM labor_cost_by_site
  WHERE site_id = test_site_id AND worker_id = test_worker_id;
  SELECT ot_hours INTO result_ot_hours FROM ot_cost_by_site
  WHERE site_id = test_site_id AND worker_id = test_worker_id;

  IF result_days != 2 THEN
    RAISE EXCEPTION 'labor_cost_by_site REGRESSION: expected days_worked=2, got %', result_days;
  END IF;
  IF result_ot_hours != 5 THEN
    RAISE EXCEPTION 'ot_cost_by_site REGRESSION: expected ot_hours=5, got %', result_ot_hours;
  END IF;

  DELETE FROM worker_ot WHERE site_id = test_site_id;
  DELETE FROM worker_assignments WHERE site_id = test_site_id;
  DELETE FROM workers WHERE id = test_worker_id;
  DELETE FROM sites WHERE id = test_site_id;

  RAISE NOTICE 'Test 3 (labor_cost_by_site / ot_cost_by_site): TEST PASSED';
END $$;
