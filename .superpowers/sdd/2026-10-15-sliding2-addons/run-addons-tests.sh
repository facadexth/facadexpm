#!/usr/bin/env bash
# Owner-run: ! bash .superpowers/sdd/2026-10-15-sliding2-addons/run-addons-tests.sh
# Assumes the catalog and part-editor migrations (through 2026-10-15-01) are applied on CHANG.
set -euo pipefail
cd "$(dirname "$0")/../../.."
REF=kntspldhvcjeaubtqtkn
OUT="$(mktemp -d)/addons.sql"
{
  echo 'BEGIN;'
  cat supabase/migrations/2026-10-18-01-item-addons.sql
  cat supabase/tests/item_addons_test.sql
  echo "SELECT 'ADDONS TESTS PASSED' AS result;"
  echo 'ROLLBACK;'
} > "$OUT"
echo "== running in one rolled-back transaction"
npx supabase db query --project-ref "$REF" --linked=false -f "$OUT"
echo "== persistence check (expect leftover = 0; applied = 0 until you apply the migration for real)"
npx supabase db query --project-ref "$REF" --linked=false \
  "select (select count(*) from information_schema.tables where table_name='estimation_item_addons') as applied, (select count(*) from tenants where company_name like '__AO TEST%') as leftover"
echo "== to apply for real:"
echo "npx supabase db query --project-ref $REF --linked=false -f supabase/migrations/2026-10-18-01-item-addons.sql"
