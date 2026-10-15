#!/usr/bin/env bash
# Owner-run: ! bash .superpowers/sdd/2026-10-15-sliding2-addons/run-templates-all-types-dryrun.sh
# One rolled-back transaction: migration 2026-10-18-03 (part / position key format) + datafix 2026-10-15-templates-all-types.sql,
# then counts. Prints TEMPLATES DRY RUN PASSED when every template inserted.
set -euo pipefail
cd "$(dirname "$0")/../../.."
REF=kntspldhvcjeaubtqtkn
OUT="$(mktemp -d)/tpl_all.sql"
{
  echo 'BEGIN;'
  cat supabase/migrations/2026-10-18-03-part-keys-all-layouts.sql
  sed -e '/^BEGIN;$/d' -e '/^COMMIT;$/d' supabase/datafix/2026-10-15-templates-all-types.sql
  echo "SELECT CASE WHEN (SELECT count(*) FROM bom_templates WHERE layout_kind IS NOT NULL) >= 22 THEN 'TEMPLATES DRY RUN PASSED' ELSE 'MISSING TEMPLATES' END AS result, (SELECT count(*) FROM bom_templates) templates, (SELECT count(*) FROM bom_template_position_profiles) lines, (SELECT count(*) FROM bom_template_hardware WHERE part_id IS NOT NULL) hw_priced, (SELECT count(*) FROM door_window_types WHERE layout_kind IS NOT NULL) typed;"
  echo 'ROLLBACK;'
} > "$OUT"
npx supabase db query --project-ref "$REF" --linked=false -f "$OUT"
echo "== to apply for real (in this order):"
echo "npx supabase db query --project-ref $REF --linked=false -f supabase/migrations/2026-10-18-03-part-keys-all-layouts.sql"
echo "npx supabase db query --project-ref $REF --linked=false -f supabase/datafix/2026-10-15-templates-all-types.sql"
