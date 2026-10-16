#!/usr/bin/env bash
# Owner-run: ! bash /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/alu-cost-catalog/.superpowers/sdd/2026-10-17-mn-import/run-mn-import-dryrun.sh
# Dry-runs supabase/datafix/2026-10-17-import-mn-catalogue.sql on CHANG as ONE rolled-back transaction
# (BEGIN; the datafix; counts; ROLLBACK), then shows the live counts (expect MN provider 0 until applied for real).
# Prints MN DRY RUN PASSED when every guard held and the counts equal the generator's numbers.
set -euo pipefail
ROOT=/Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/alu-cost-catalog
REF=kntspldhvcjeaubtqtkn                      # CHANG (Singapore). NEVER the retired Tokyo project yyzbgdmgyvvypfcjuhtr.
SRC="$ROOT/supabase/datafix/2026-10-17-import-mn-catalogue.sql"
[ -f "$SRC" ] || { echo "missing $SRC"; exit 1; }
[ "$REF" = kntspldhvcjeaubtqtkn ] || { echo "refusing: REF must be CHANG kntspldhvcjeaubtqtkn"; exit 1; }
grep -q '^COMMIT;$' "$SRC" || { echo "COMMIT not found in $SRC"; exit 1; }
OUT="$(mktemp -d)/mn_import_dryrun.sql"
{
  sed '/^COMMIT;$/d' "$SRC"     # keeps the datafix's own BEGIN; drops its COMMIT
  cat <<'SQL'
-- the DO block raises (and the whole transaction fails) unless every guard and count held, so reaching this line = passed
SELECT CASE WHEN p.id IS NOT NULL
            THEN 'MN DRY RUN PASSED' ELSE 'MN DRY RUN: PROVIDER MISSING' END AS result,
       (SELECT count(*) FROM alu_series s WHERE s.provider_id = p.id) AS series,
       (SELECT count(*) FROM alu_profiles x WHERE x.provider_id = p.id) AS profiles,
       (SELECT count(*) FROM alu_series_profiles sp JOIN alu_series s ON s.id = sp.series_id WHERE s.provider_id = p.id) AS series_profiles,
       (SELECT count(*) FROM alu_finishes f WHERE f.provider_id = p.id) AS finishes,
       (SELECT count(*) FROM alu_profile_variants v JOIN alu_profiles x ON x.id = v.profile_id WHERE x.provider_id = p.id) AS variants,
       (SELECT count(*) FROM alu_piece_prices pp JOIN alu_profile_variants v ON v.id = pp.variant_id JOIN alu_profiles x ON x.id = v.profile_id WHERE x.provider_id = p.id) AS piece_prices,
       (SELECT count(*) FROM alu_series_types st JOIN alu_series s ON s.id = st.series_id WHERE s.provider_id = p.id) AS series_types
  FROM (SELECT 1) one LEFT JOIN alu_providers p ON p.name = 'บจก. แม่น้ำเมทอลซัพพลาย' AND p.tenant_id = '1b9affc4-2136-4ed1-b168-a36e6624e743';
ROLLBACK;
SQL
} > "$OUT"
grep -q '^ROLLBACK;$' "$OUT" || { echo "ROLLBACK not found in $OUT"; exit 1; }
grep -q '^COMMIT;$' "$OUT" && { echo "COMMIT still in $OUT"; exit 1; }
echo "== dry run (rolled back): expect 'MN DRY RUN PASSED' and the counts in docs/catalogs/mn/IMPORT-REPORT.md (Row counts); an ABORT line means a guard failed"
npx supabase db query --project-ref "$REF" --linked=false -f "$OUT"
echo "== live counts after the dry run (expect mn_providers = 0 until applied for real)"
npx supabase db query --project-ref "$REF" --linked=false \
  "select (select count(*) from alu_providers where name = 'บจก. แม่น้ำเมทอลซัพพลาย') as mn_providers, (select count(*) from alu_profiles) as profiles_all, (select count(*) from alu_piece_prices) as piece_prices_all"
echo "== idempotency check after applying: run the same dry run again; it must still pass (every insert reports 0)."
echo "== to apply for real:"
echo "npx supabase db query --project-ref $REF --linked=false -f $SRC"
