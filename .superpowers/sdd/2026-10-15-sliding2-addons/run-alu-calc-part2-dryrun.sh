#!/usr/bin/env bash
# Owner-run: ! bash .superpowers/sdd/2026-10-15-sliding2-addons/run-alu-calc-part2-dryrun.sh
# Dry-runs supabase/datafix/2026-10-15-import-aluminium-calculation-part2.sql on CHANG (COMMIT -> ROLLBACK), then shows live counts.
set -euo pipefail
cd "$(dirname "$0")/../../.."
REF=kntspldhvcjeaubtqtkn
SRC=supabase/datafix/2026-10-15-import-aluminium-calculation-part2.sql
OUT="$(mktemp -d)/part2_dryrun.sql"
sed 's/^COMMIT;$/ROLLBACK;/' "$SRC" > "$OUT"
grep -q '^ROLLBACK;$' "$OUT" || { echo "ROLLBACK not found"; exit 1; }
echo "== dry run (rolled back)"
npx supabase db query --project-ref "$REF" --linked=false -f "$OUT"
echo "== live counts (expect parts = 0 until applied)"
npx supabase db query --project-ref "$REF" --linked=false \
  "select (select count(*) from alu_parts) parts, (select count(*) from alu_part_prices) prices, (select count(*) from alu_finishes) finishes, (select count(*) from alu_series_types) links"
echo "== to apply for real:"
echo "npx supabase db query --project-ref $REF --linked=false -f $SRC"
