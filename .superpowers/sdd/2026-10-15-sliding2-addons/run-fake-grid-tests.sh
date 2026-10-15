#!/usr/bin/env bash
# Owner-run: ! bash .superpowers/sdd/2026-10-15-sliding2-addons/run-fake-grid-tests.sh
# Dry-runs supabase/migrations/2026-10-18-02-item-addon-fake-grid.sql on CHANG in one rolled-back transaction. Needs 2026-10-18-01 applied.
set -euo pipefail
cd "$(dirname "$0")/../../.."
REF=kntspldhvcjeaubtqtkn
OUT="$(mktemp -d)/fake_grid.sql"
{
  echo 'BEGIN;'
  cat supabase/migrations/2026-10-18-02-item-addon-fake-grid.sql
  cat <<'SQL'
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns WHERE table_name = 'estimation_item_addons' AND column_name IN ('fake_rows', 'fake_cols');
  IF n <> 2 THEN RAISE EXCEPTION 'fake_rows / fake_cols missing (%)', n; END IF;
  BEGIN
    UPDATE estimation_item_addons SET fake_rows = 13 WHERE false;
    INSERT INTO estimation_item_addons (tenant_id, opening_id, mode, kind, position, len_m, thick_m, rows, cols, fake_rows, fake_cols)
      SELECT tenant_id, opening_id, mode, kind, position, len_m, thick_m, rows, cols, 13, 1 FROM estimation_item_addons LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'fake_rows 13 was accepted'; END IF;
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
SELECT 'FAKE GRID TESTS PASSED' AS result;
SQL
  echo 'ROLLBACK;'
} > "$OUT"
echo "== running in one rolled-back transaction"
npx supabase db query --project-ref "$REF" --linked=false -f "$OUT"
echo "== persistence check (expect applied = 0 until you apply the migration for real)"
npx supabase db query --project-ref "$REF" --linked=false \
  "select count(*) as applied from information_schema.columns where table_name='estimation_item_addons' and column_name='fake_rows'"
echo "== to apply for real:"
echo "npx supabase db query --project-ref $REF --linked=false -f supabase/migrations/2026-10-18-02-item-addon-fake-grid.sql"
