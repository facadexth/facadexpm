# Task 1 report
Implemented: supabase/migrations/2026-10-17-01-layouts-all-types.sql (13-kind CHECK on door_window_types and, per R-P1, bom_templates; layout_params JSONB + object CHECK on 3 tables; all drop-if-exists then add, re-runnable), supabase/tests/layouts_all_types_test.sql, .superpowers/sdd/2026-10-13-part-editor-layouts-all-types/run-layouts-tests.sh (chmod +x, force-added; prints apply command).
Validation: read-back only (psql not installed; DO blocks balanced 2/2; bash -n on runner ok). No DB touched, no supabase tool used.
x.* grep: only expenses_view uses e.* (schema.sql:2977 and expenses migrations); no view selects door_window_types, bom_templates or estimation_openings with .*. Stated in migration header.
Test asserts: 3 columns exist, awning_grid + params accepted, default {}, all 13 kinds accepted on both tables, bogus kind raises 23514 on both, '[]' params raises 23514 on both; each negative path RAISEs if no violation.
Concerns: estimation_openings only checked via information_schema (many NOT NULL columns); its CHECK not exercised.
