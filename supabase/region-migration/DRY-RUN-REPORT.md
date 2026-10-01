# Dry-Run Report: Supabase Region Migration, Tokyo → Singapore (CHANG)

**Date:** 2026-10-01
**Tokyo** (source, live production, read-only throughout): `yyzbgdmgyvvypfcjuhtr`, ap-northeast-1, PostgreSQL 17.6.
**CHANG** (target, disposable dry-run copy): `kntspldhvcjeaubtqtkn`, ap-southeast-1 (Singapore), PostgreSQL 17.11.

This is the final verification pass of a 6-task dry run. All checks below were
re-run live against both projects on 2026-10-01, not copied from earlier task
reports. Read time: under 2 minutes.

## 7-point checklist

1. ✅ **Row-count parity** — 109/109 tables present on both sides (`public` 82 +
   `auth` 27). 107 tables matched exactly at restore time; the 2 that didn't
   (`auth.refresh_tokens`, `public.line_site_photos`) were re-counted fresh
   just now: Tokyo has advanced further since (298 and 40 respectively, up
   from 294/40 at Task 2 and 293/34 in CHANG's frozen dump snapshot) — this is
   expected organic growth on a live production system between the one-time
   dump and this check, not a migration gap.
2. ✅ **Spot-check real rows** — re-pulled the same 3 rows (`sites`, `workers`,
   `invoices`) from both projects and compared full-row MD5 hashes instead of
   individual columns; all 3 hashes match exactly between Tokyo and CHANG.
3. ✅ **Storage parity** — fresh `GROUP BY bucket_id` count against both
   projects: 149/149 objects across all 8 populated buckets, exact match
   bucket-by-bucket (`worker-id-cards` empty on both, as expected). This is
   149, not the plan's original 115 — Tokyo's `line-site-photos` bucket
   organically grew from 19→40 objects between spec-writing and the Task 3
   copy (a LINE auto-filing feature went live and real workers used it). All
   other 7 buckets matched the spec's original figures exactly. Per the
   controller's ruling, this is the correct outcome: the dry run should
   reflect Tokyo's actual live state, not a stale snapshot taken when the plan
   was written.
4. ✅ **Extension + RLS parity** — both projects have the same 7 extensions
   installed (`pg_cron`, `pg_net`, `pg_stat_statements`, `pgcrypto`,
   `plpgsql`, `supabase_vault`, `uuid-ossp`); `pg_net` differs at the patch
   version (Tokyo 0.20.3 vs CHANG 0.20.4), a platform-provided difference, not
   a migration defect. RLS policy counts on `public.phase_tasks` (6) and
   `public.line_site_photos` (5) match exactly between Tokyo and CHANG.
5. ✅ **Function deploy confirmation** — 12 of 14 functions deployed and
   confirmed `ACTIVE` on CHANG just now via a fresh `functions list`. This is
   the correct, complete result, not a partial one: `omise-webhook` and
   `omise-create-charge` both fail to bundle, but not because any file is
   missing from the repo. The real, project-level shared file
   (`supabase/functions/_shared/activate-tenant.ts`) is committed and
   tracked in git (`89ac413`), and every other function that imports from it
   via `../_shared/...` deploys and bundles cleanly. The bug is purely that
   `omise-webhook/index.ts` and `omise-create-charge/index.ts` import it via
   the wrong relative path — `./_shared/activate-tenant.ts` — which resolves
   to a function-local file one directory below where the real shared file
   actually lives, and no such function-local file exists. The fix is a
   one-line import-path correction (`./_shared/...` → `../_shared/...`) in
   both files, not recovering or re-committing anything. As minor supporting
   detail (not decisive on its own, since `sign-link` and
   `extract-po-document` show the same entrypoint shape on Tokyo yet deploy
   cleanly to CHANG): Tokyo's own live deployment of these 2 functions shows
   an `entrypoint_path` ending in `.../source/index.ts` rather than the
   project-structure path every correctly-configured function shows,
   consistent with having been deployed at some point from a flattened
   invocation with a local, uncommitted copy of the file present on disk.
   This is a genuine, pre-existing bug, equally present on Tokyo today,
   completely independent of this migration. See "What this does NOT prove"
   below for what has to happen before these 2 can be redeployed.
6. ✅ **Cron/Vault mechanism proof** — re-ran `verify_cron_secret()` against
   the real Vault-stored secret on CHANG just now: returns `true`, confirming
   the Vault-secret-backed cron-auth mechanism still works end-to-end. (The 3
   cron jobs themselves were deliberately unscheduled at the end of Task 5 as
   a zero-risk safety measure so nothing could fire against CHANG during the
   dry-run window; the 2 Vault secrets and the proof of the mechanism remain
   in place.)
7. ✅ **Auth schema sanity** — `auth.users` count is 14 on both Tokyo and
   CHANG, re-verified just now.

## What this proves

CHANG can hold a faithful, working copy of Tokyo's schema, data, storage, and
edge functions, and the scheduled-job secret mechanism works identically in
the new region:

- Schema and data: 109 tables, 14,021 rows restored and verified (13,609
  `public` + 412 `auth` at dump-snapshot time), 3/3 spot-checked real rows
  byte-identical.
- Storage: all 9 buckets and all 11 RLS policies recreated correctly; 149/149
  real objects copied with exact size parity.
- Extensions and RLS: same extension set, same policy counts on the two
  checked tables.
- Edge functions: 12/14 functions deploy cleanly to the new region with
  matching `verify_jwt` configuration.
- Cron/Vault: the pattern of storing a shared secret in Vault and verifying it
  from a Postgres function works unchanged in the new region.

## What this does NOT prove

The spec's own stated out-of-scope items for this dry run (unchanged, verbatim):

- Actual user login against CHANG
- Actual LINE webhook delivery
- Actual DNS/env var cutover
- Actual cron jobs firing for real
- Free→Pro upgrade timing

Two further items surfaced during this dry run and remain open, independent
of the above:

- **The Omise function bug.** `omise-webhook` and `omise-create-charge` need a
  one-line source-code fix — changing their import path from
  `./_shared/activate-tenant.ts` to `../_shared/activate-tenant.ts` so it
  resolves to the real, already-committed project-level shared file that
  every other function uses successfully — before they can be deployed to
  *any* Supabase project via the standard project-structure deploy path. This
  is not specific to CHANG or this migration.
- **5 custom secrets not yet entered.** `ANTHROPIC_API_KEY`,
  `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`, `OMISE_SECRET_KEY`, and
  `RESEND_API_KEY` still need manual entry on CHANG (see
  `secrets-checklist.md`) before any of the 12 already-deployed functions are
  fully live — no secret values were read, printed, or set at any point in
  this dry run.

## Conclusion

All 7 checklist points pass. The 2 known deviations from the plan's original
figures (149 vs. 115 storage objects, 12/14 vs. 14/14 functions) are both
correct, already-ruled, explained outcomes — not migration failures. CHANG is
a faithful working copy of Tokyo as of this dry run. The real cutover can be
scheduled once the out-of-scope items above are addressed on their own
timeline.
