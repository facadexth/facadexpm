-- supabase/datafix/2026-10-31-series-family-price-report.sql
-- READ ONLY. Before/after check for 2026-10-31-01 (spec section 10). The price of an item can change only if the
-- item takes its series from the project; every other input (size, template, colour, thickness ...) is untouched.
-- Query A: run BEFORE applying the migration. Query B: run AFTER. Save both outputs in the session notes.
-- Expected on CHANG (2026-10-31): HOSPITAL's one item shows series_from = 'own' in both, and no row anywhere shows
-- 'inherits' -> no price changes. Any 'inherits' row: open that item on the dev server before and after and compare.

-- A (before)
SELECT p.name AS project, o.opening_no, own.name AS own_series, def.name AS project_default_series,
       CASE WHEN o.series_id IS NOT NULL THEN 'own'
            WHEN p.default_series_id IS NOT NULL THEN 'inherits'
            ELSE 'none' END AS series_from
  FROM estimation_openings o
  JOIN estimation_projects p ON p.id = o.project_id
  LEFT JOIN alu_series own ON own.id = o.series_id
  LEFT JOIN alu_series def ON def.id = p.default_series_id
 ORDER BY p.name, o.opening_no;

-- B (after)
SELECT p.name AS project, o.opening_no, own.name AS own_series, def.name AS project_default_series, f.name AS project_family,
       CASE WHEN o.series_id IS NOT NULL THEN 'own'
            WHEN p.default_series_family_id IS NOT NULL OR p.default_series_id IS NOT NULL THEN 'inherits'
            ELSE 'none' END AS series_from
  FROM estimation_openings o
  JOIN estimation_projects p ON p.id = o.project_id
  LEFT JOIN alu_series own ON own.id = o.series_id
  LEFT JOIN alu_series def ON def.id = p.default_series_id
  LEFT JOIN alu_series_families f ON f.id = p.default_series_family_id
 ORDER BY p.name, o.opening_no;
