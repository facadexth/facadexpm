# Dry-Run Report: Supabase Region Migration, Tokyo → Singapore (CHANG)

**Date:** 2026-10-01
**Tokyo** (source, live production, read-only throughout): `yyzbgdmgyvvypfcjuhtr`, ap-northeast-1, PostgreSQL 17.6.
**CHANG** (target, disposable dry-run copy): `kntspldhvcjeaubtqtkn`, ap-southeast-1 (Singapore), PostgreSQL 17.11.

This is the final verification pass of a 6-task dry run. All checks below were
re-run live against both projects on 2026-10-01, not copied from earlier task
reports. Read time: under 2 minutes.

**Note on evidence trail:** the per-task reports in this directory
(`row-count-report.md`, `storage-report.md`, `deploy-functions-report.md`,
`cron-vault-report.md`) point to additional raw evidence — e.g.
`.superpowers/sdd/.../task-N-report.md` and
`supabase/region-migration/tmp/spotcheck-*.json` — that is session-local and
gitignored, not committed. Anyone cloning this repo fresh will find those
specific pointers are dead links. This report's own figures above and below
are the durable, committed record; nothing load-bearing depends on the
session-local files.

## Prerequisites for re-running this dry run

- **Docker is installed but not on PATH in fresh tool invocations.** Task 1's
  own report and the task ledger record Docker as "not installed" — that was
  true when Task 1 ran, but Task 2 found it was actually installed, just
  missing from `PATH` in this environment, where shell-profile edits don't
  propagate to fresh tool invocations. Before running any Docker-dependent
  command (e.g. `supabase db dump`), run:
  `export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"`

## 7-point checklist

1. ✅ **Row-count parity** — 109/109 tables present on both sides (`public` 82 +
   `auth` 27). 107 tables matched exactly at restore time; the 2 that didn't
   (`auth.refresh_tokens`, `public.line_site_photos`) were re-counted fresh
   just now. `auth.refresh_tokens` has genuinely ticked up further on Tokyo
   (298 now, vs. 294 at Task 2 and 293 in CHANG's frozen dump snapshot) —
   expected session-token churn on a live production system between the
   one-time dump and this check, not a migration gap. `line_site_photos` has
   not moved further since Task 2 (40 then, 40 now); the 40-vs-34 gap against
   CHANG's snapshot is a storage/DB ordering artifact, addressed below under
   "Cutover risks and required actions."
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

Three further items surfaced during this dry run and remain open, independent
of the above:

- **Project-level dashboard configuration is entirely untouched by this
  plan.** Auth settings (Site URL, redirect allowlist, email templates,
  confirm-email toggles, JWT expiry, custom SMTP), API settings (exposed
  schemas, `max_rows`), network restrictions, and storage global limits all
  live in the Supabase dashboard, not in the database or storage — nothing in
  this dry run (dump, restore, or storage copy) touched them. The DB-visible
  subset of related settings (role-level statement timeouts, `search_path`
  settings) was independently verified to already match between Tokyo and
  CHANG; only the dashboard-only settings above are the gap. Left alone, the
  real cutover would leave CHANG on its out-of-the-box defaults — e.g. an
  empty redirect allowlist silently breaks password reset and email
  confirmation for every user, with no server-side error. Replicating
  Tokyo's dashboard configuration onto CHANG must be done manually before
  cutover; it is not carried by any dump.
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

## Cutover risks and required actions

These are not blockers to scheduling the cutover (see Conclusion), but they
must be accounted for in how the cutover itself is executed.

- **The only proven restore path is a cold, full restore into an empty
  target.** The spec's cutover sequence calls for a "final delta
  dump/restore," but what this dry run actually exercised was a full,
  INSERT-format restore (`public-data-only.sql`) into a CHANG database that
  started empty. That file has no `ON CONFLICT` clause — replaying it today
  against CHANG's current (post-dry-run) contents would fail immediately on
  primary key violations across the board. The real cutover is not a "run
  the same script again" operation: it must begin by wiping CHANG's `public`
  schema, `auth` data, and storage objects first. CHANG's current contents
  are a disposable dry-run snapshot, not a base to build on.
- **No wall-clock timing was captured for any phase of this dry run.** The
  restore path involved 6 chunked Management-API round-trips (after an
  initial attempt hit a 413 at 5.6MB) plus 149 storage objects copied via a
  local download/upload round-trip. How long the real write-freeze window
  needs to be is currently unknown. Measuring the end-to-end restore window
  should be an explicit cutover-prep step — e.g. timing a fresh repeat of
  this dry run, or instrumenting the real cutover itself with a rollback
  plan in case it runs long.
- **Cutover ordering: freeze writes, then dump the database, then copy
  storage — never storage first.** CHANG currently shows a real skew in
  `line-site-photos` (40 storage objects vs. 34 matching DB rows; Tokyo
  itself is a consistent 40/40). This is benign in this dry run — storage
  was copied in Task 3, roughly 90 minutes after Task 2's DB dump, so it's
  natural drift on a live system during an unhurried rehearsal — but it
  demonstrates the ordering hazard the real cutover must avoid in the
  opposite direction: if storage were copied *before* the final DB dump,
  CHANG could end up live with DB rows referencing storage objects that
  don't exist yet (broken images in the app, with no error surfaced
  anywhere). The real cutover must freeze writes first, then dump the
  database, then copy storage last (or re-sweep storage immediately after
  the DB dump) — not the other order.
- **CHANG auto-enables RLS on newly created tables; Tokyo does not.** CHANG
  shows 55 `public` functions vs. Tokyo's 54 — the extra one is an event
  trigger (`public.rls_auto_enable()` / `ensure_rls`) that forces RLS on for
  every new table. This is a Supabase-platform-version default, not a defect
  introduced by this migration, and arguably safer — but it is a real
  post-cutover behavior change: on CHANG, a newly created `public` table
  with no policies yet returns zero rows to every caller instead of erroring
  the way Tokyo currently does. Worth keeping in mind for future schema
  migrations once CHANG is the live project, across a repo with roughly 200
  active migrations.

## Conclusion

All 7 checklist points pass. The 2 known deviations from the plan's original
figures (149 vs. 115 storage objects, 12/14 vs. 14/14 functions) are both
correct, already-ruled, explained outcomes — not migration failures. CHANG is
a faithful working copy of Tokyo as of this dry run.

Two genuine blockers must be resolved before the real cutover can be
**scheduled**: the Omise function import-path bug, and entering the 5
outstanding secrets (both above). Neither requires redoing any part of this
dry run.

Everything else listed under "What this does NOT prove" — DNS/env var
cutover, cron jobs firing for real, live user login, LINE webhook delivery —
is not a prerequisite to scheduling. Those items, together with replicating
Tokyo's dashboard configuration and the ordering/wipe requirements under
"Cutover risks and required actions" above, **are the cutover itself**: the
work to be carried out, in the stated order, during the scheduled maintenance
window — not conditions to satisfy beforehand.
