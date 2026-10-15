#!/usr/bin/env bash
# Owner-run: ! bash .superpowers/sdd/2026-10-15-sliding2-addons/run-profile-import-dryrun.sh
# Dry-runs supabase/datafix/2026-10-13-import-aluminium-calculation-xlsx.sql on CHANG with COMMIT replaced by ROLLBACK,
# then shows the live counts (expect profiles = 0 until the datafix is applied for real).
set -euo pipefail
cd "$(dirname "$0")/../../.."
REF=kntspldhvcjeaubtqtkn
SRC=supabase/datafix/2026-10-13-import-aluminium-calculation-xlsx.sql
OUT="$(mktemp -d)/import_dryrun.sql"
sed 's/^COMMIT;$/ROLLBACK;/' "$SRC" > "$OUT"
grep -q '^ROLLBACK;$' "$OUT" || { echo "ROLLBACK not found in $OUT"; exit 1; }
echo "== dry run (rolled back): read the NOTICE lines"
npx supabase db query --project-ref "$REF" --linked=false -f "$OUT"
echo "== live counts after dry run (expect profiles = 0)"
npx supabase db query --project-ref "$REF" --linked=false \
  "select (select count(*) from alu_profiles) as profiles, (select count(*) from alu_series) as series, (select count(*) from infill_types) as glass"
echo "== to apply for real:"
echo "npx supabase db query --project-ref $REF --linked=false -f $SRC"
