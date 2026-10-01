# Supabase Region Migration (Tokyo → Singapore) — Dry Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove, with zero production impact, that CHANG (the new Singapore Supabase project) can hold a faithful, verified copy of Tokyo's (the live project's) schema, data, storage, edge functions, and scheduled jobs — so the real cutover (a separate, later, explicitly-scheduled piece of work, out of scope here) can be executed with confidence instead of guesswork.

**Architecture:** Every operation in this plan runs through the already-authenticated `npx supabase` CLI session (no raw database password or service-role key is ever typed into a command or file by the implementer — confirmed during planning that `db query --linked`, `db dump --linked`, and `storage cp --linked` all proxy through the CLI's logged-in session). Tokyo is a **read-only source** throughout — nothing in this plan writes to Tokyo. CHANG is a **disposable target** — safe to wipe and redo at any point, since nothing in production points at it.

**Tech Stack:** Supabase CLI (`npx supabase`, already authenticated this session), PostgreSQL 17, Docker Desktop (required for `db dump`, see Prerequisite below).

**Spec:** `docs/superpowers/specs/2026-10-01-supabase-region-migration-design.md`

## Prerequisite (user action, not a task — blocks Task 2 onward)

`supabase db dump --linked` runs `pg_dump` inside a Docker container for version matching. This machine has no Docker, Podman, Homebrew, or local `pg_dump`/`psql` (confirmed during planning). **The user must install Docker Desktop and have it running** before Task 2 can execute. Task 1 does not require Docker and can proceed immediately; the implementer dispatched for Task 2 should first run `docker info` and stop with a clear message if it fails, rather than guessing.

## Global Constraints

- **Project refs:** Tokyo (source, live, read-only) = `yyzbgdmgyvvypfcjuhtr`. CHANG (target, disposable) = `kntspldhvcjeaubtqtkn`. Both are in org `euaznrvdndkjxsfcaqbc` and reachable via the CLI's existing authenticated session — no login step needed in any task.
- **The CLI's `--linked` flag always means "whichever project is currently linked."** There is no way to target a specific project by ref for `db query`/`db dump`/`storage cp` other than relinking first (`npx supabase link --project-ref <ref>`, confirmed during planning — no password prompt, uses the authenticated session). **Every step below that uses `--linked` states which project must be linked first.** A task that gets this wrong silently operates on the wrong project — treat "which project is linked" as a value worth double-checking before any destructive-feeling step, via `npx supabase db query --linked "SELECT current_database(), version();"` (Tokyo reports PG 17.6.1.127; CHANG reports PG 17.11).
- **End every task linked back to Tokyo.** Tokyo is this repo's default linked project for all other session work; leaving CHANG linked after a task would silently break unrelated commands run later.
- **Never materialize real secret values.** `ANTHROPIC_API_KEY`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`, `OMISE_SECRET_KEY`, `RESEND_API_KEY` are real third-party credentials. No task reads, prints, transcribes, or sets their real values — not from `.env`, not from Tokyo's secrets store, not from the user pasting them in chat. Task 4 produces only the 5 **names** as a checklist for the user to act on themselves via the Supabase dashboard.
- **`--dry-run` on `supabase db dump` prints a live, short-lived scoped database password to stdout.** Do not use `--dry-run` in any task. The normal (non-dry-run) dump command never exposes this — it stays inside the CLI's own Docker-invoked subprocess.
- **Never run `--data-only`/`--schema-only` dumps of the `vault` or `cron` schemas, and never include `vault`/`cron`/`storage` in any `--schema` flag.** Vault's encryption key is project-specific and does not survive a cross-project dump/restore (confirmed: `verify_cron_secret()` looks up `vault.decrypted_secrets WHERE name = 'line_push_cron_shared_secret'` — a corrupted or mismatched restore here breaks all 3 cron jobs silently). `storage.buckets`/`storage.objects` are managed via the Storage API/CLI in Task 3, never via a raw schema dump.
- Store every local file this plan produces (dump files, generated SQL, logs) under `supabase/region-migration/` in this repo (new directory, create it in Task 1) — not in `/tmp`, so they survive between tasks and are reviewable in the eventual PR/diff. Add `supabase/region-migration/*.sql` and `supabase/region-migration/tmp/` to `.gitignore` in Task 1 (these are large/regenerable working files, not source) but commit the small, hand-written orchestration scripts themselves.

---

### Task 1: Prepare CHANG — enable extensions, validate the restore mechanism on a small slice

**Files:**
- Create: `supabase/region-migration/` (new directory)
- Create: `supabase/region-migration/enable-extensions-chang.sql`
- Create: `supabase/region-migration/validate-slice-dump.sql` (query to extract one simple table + one dollar-quoted function's current definition from Tokyo, for the validation round-trip)
- Modify: `.gitignore` — add `supabase/region-migration/tmp/` and `supabase/region-migration/*-dump.sql`

**Interfaces:**
- Produces: confirmation that `db query --linked --file <pg_dump-style-sql>` correctly executes a file containing a dollar-quoted PL/pgSQL function body and multi-row INSERTs — the exact mechanism Task 2's full restore depends on. If this fails, Task 2 cannot proceed as designed and must be re-scoped (flag this clearly in the report rather than silently working around it).

- [ ] **Step 1: Create the working directory and gitignore entries**

```bash
mkdir -p supabase/region-migration/tmp
```

Append to `.gitignore`:
```
supabase/region-migration/tmp/
supabase/region-migration/*-dump.sql
```

- [ ] **Step 2: Confirm Tokyo is linked, then check which extensions CHANG already has**

```bash
npx supabase db query --linked "SELECT current_database(), version();"
```
Expected: version string contains `17.6.1.127` or similar Tokyo-era version (NOT `17.11`). If it shows `17.11`, CHANG is currently linked — run `npx supabase link --project-ref yyzbgdmgyvvypfcjuhtr` first.

- [ ] **Step 3: Write the extension-enable SQL**

Create `supabase/region-migration/enable-extensions-chang.sql`:
```sql
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS supabase_vault;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
```

(`plpgsql` is present on every Postgres database by default — no action needed.)

- [ ] **Step 4: Relink to CHANG and run the extension-enable SQL**

```bash
npx supabase link --project-ref kntspldhvcjeaubtqtkn
npx supabase db query --linked --file supabase/region-migration/enable-extensions-chang.sql
```
Expected: no error. (`CREATE EXTENSION IF NOT EXISTS` is idempotent — safe even if some are pre-enabled.)

- [ ] **Step 5: Verify extensions landed on CHANG**

```bash
npx supabase db query --linked "SELECT extname, extversion FROM pg_extension ORDER BY extname;"
```
Expected: `pg_cron`, `pg_net`, `pg_stat_statements`, `pgcrypto`, `plpgsql`, `supabase_vault`, `uuid-ossp` all present (versions may differ slightly from Tokyo's — that's fine, these are platform-provided).

- [ ] **Step 6: Relink to Tokyo and dump a small representative slice**

```bash
npx supabase link --project-ref yyzbgdmgyvvypfcjuhtr
npx supabase db dump --linked --schema public --data-only --file supabase/region-migration/tmp/slice-data.sql -x public.quotations -x public.invoices -x public.purchase_orders -x public.phase_tasks -x public.line_site_photos -x public.sites -x public.workers -x public.user_roles
```

This excludes the large/sensitive real tables and dumps only `app_settings` (a small, simple table confirmed to exist from Task 2's real signup-trigger seed logic) plus whatever other small tables remain — enough to prove the data-row restore mechanism without restoring real tenant business data into a not-yet-fully-provisioned CHANG.

Then separately dump the schema (DDL only, including at least one dollar-quoted function) for the same validation:
```bash
npx supabase db dump --linked --schema public --file supabase/region-migration/tmp/slice-schema-preview.sql
```

Expected: both files created, non-empty. Read `supabase/region-migration/tmp/slice-schema-preview.sql` with a text search for `generate_site_number` — confirm it contains a `CREATE OR REPLACE FUNCTION public.generate_site_number` block with a `$function$ ... $function$` or `$$ ... $$` dollar-quoted body (this is the exact pattern Task 2 depends on `db query --linked` being able to execute verbatim).

- [ ] **Step 7: Validate the restore mechanism against CHANG using just the function definition**

Extract just the `generate_site_number` function's `CREATE OR REPLACE FUNCTION ... $$;` block from `slice-schema-preview.sql` into `supabase/region-migration/tmp/validate-function.sql` (open the file, copy that one function block verbatim — it is the dollar-quoted, multi-line case this check exists to prove).

```bash
npx supabase link --project-ref kntspldhvcjeaubtqtkn
npx supabase db query --linked --file supabase/region-migration/tmp/validate-function.sql
```

Expected: no error. If this errors (e.g. on the dollar-quote syntax, or on a missing dependency like a custom type), **stop and report this as a BLOCKED finding** — Task 2's entire restore approach depends on this working, and the fix (likely: splitting the full dump into one-statement-per-file chunks, or finding a different execution path) needs a ruling before Task 2 proceeds.

- [ ] **Step 8: Verify the function landed correctly on CHANG**

```bash
npx supabase db query --linked "SELECT proname FROM pg_proc WHERE proname = 'generate_site_number';"
```
Expected: one row returned.

- [ ] **Step 9: Clean up the validation artifact and relink to Tokyo**

```bash
npx supabase db query --linked "DROP FUNCTION IF EXISTS public.generate_site_number();"
npx supabase link --project-ref yyzbgdmgyvvypfcjuhtr
```

(Dropping it from CHANG is optional cleanup — CHANG is disposable and Task 2 will recreate it properly as part of the full restore anyway — but keeps CHANG's state clean and unambiguous for whoever reviews Task 2's diff against a clean starting point.)

- [ ] **Step 10: Commit the new scripts (not the generated dump/slice files, which are gitignored)**

```bash
git add supabase/region-migration/enable-extensions-chang.sql .gitignore
git commit -m "chore: add CHANG extension-setup script for Singapore region migration dry run"
git push origin worktree-gantt-kanban:main
```

---

### Task 2: Full schema + data migration (public + auth schemas)

**Files:**
- Create: `supabase/region-migration/full-dump.sql` (gitignored, large — not committed)
- Create: `supabase/region-migration/verify-row-counts.sql`
- Create: `supabase/region-migration/row-count-report.md` (output of the verification, committed)

**Interfaces:**
- Consumes: Task 1's confirmation that `db query --linked --file` handles dollar-quoted function bodies correctly, and that CHANG already has the 6 required extensions enabled.
- Produces: CHANG's `public` and `auth` schemas fully populated and schema-identical to Tokyo's current live state. `row-count-report.md` is consumed by Task 6's final verification pass.

- [ ] **Step 1: Confirm Docker is available**

```bash
docker info
```
Expected: exits 0 with cluster/engine info. If this fails, **stop** — the Prerequisite (Docker Desktop install) has not been completed. Report BLOCKED, do not attempt a workaround.

- [ ] **Step 2: Confirm Tokyo is linked**

```bash
npx supabase db query --linked "SELECT version();"
```
Expected: contains `17.6`. If not, `npx supabase link --project-ref yyzbgdmgyvvypfcjuhtr` first.

- [ ] **Step 3: Dump Tokyo's public + auth schemas (schema + data combined)**

```bash
npx supabase db dump --linked --schema public,auth --file supabase/region-migration/full-dump.sql
```

Expected: completes without error (may take a few seconds given the 28 MB size), produces a non-empty file. This explicitly excludes `vault`, `cron`, and `storage` schemas by not naming them in `--schema` — per the spec, these are handled separately (vault/cron in Task 5, storage in Task 3) and must never be blindly restored cross-project.

- [ ] **Step 4: Sanity-check the dump file before restoring**

```bash
grep -c "^CREATE TABLE" supabase/region-migration/full-dump.sql
grep -c "^INSERT INTO" supabase/region-migration/full-dump.sql
grep -c "CREATE SCHEMA" supabase/region-migration/full-dump.sql
```

Expected: `CREATE TABLE` count is close to 82 (some of the 82 tables counted earlier may be views or partitions counted differently — a count in the 70-85 range is healthy; if it's under 40 or over 150, stop and inspect the file before restoring). `CREATE SCHEMA` should only ever mention `public` and `auth` — if `vault`, `cron`, or `storage` appear here, **stop**, the `--schema` flag did not work as expected, and this needs a ruling before proceeding (do not restore a file that touches those schemas).

- [ ] **Step 5: Relink to CHANG**

```bash
npx supabase link --project-ref kntspldhvcjeaubtqtkn
npx supabase db query --linked "SELECT version();"
```
Expected: contains `17.11`.

- [ ] **Step 6: Restore the dump into CHANG**

```bash
npx supabase db query --linked --file supabase/region-migration/full-dump.sql
```

Expected: completes without error. This is the highest-risk single step in the plan — if it fails partway through (e.g. a statement-size limit on the Management API, or an ordering issue where a later statement depends on an earlier one that failed), the error output will name the failing statement. Common, expected-safe failure: a `CREATE POLICY` or `ALTER TABLE ... OWNER TO` statement referencing a Tokyo-specific role that doesn't exist on CHANG under the same name — `--no-owner`-equivalent behavior isn't exposed as a flag on `db dump`, so if ownership statements cause errors, re-run Step 3 with `grep -v "OWNER TO\|^ALTER .* OWNER"` piped into a cleaned copy of the dump before restoring, rather than abandoning the approach.

- [ ] **Step 7: Write the row-count verification query**

Create `supabase/region-migration/verify-row-counts.sql`:
```sql
SELECT schemaname, relname, n_live_tup
FROM pg_stat_user_tables
WHERE schemaname IN ('public', 'auth')
ORDER BY schemaname, relname;
```

- [ ] **Step 8: Run it against CHANG, then against Tokyo, and compare**

```bash
npx supabase db query --linked --file supabase/region-migration/verify-row-counts.sql > supabase/region-migration/tmp/chang-counts.json
npx supabase link --project-ref yyzbgdmgyvvypfcjuhtr
npx supabase db query --linked --file supabase/region-migration/verify-row-counts.sql > supabase/region-migration/tmp/tokyo-counts.json
```

Compare the two JSON outputs table-by-table (`n_live_tup` is Postgres's live estimate, not always exact for a database this small and freshly vacuumed — cross-check any table whose counts differ with an exact `SELECT COUNT(*)` on both sides before treating it as a real discrepancy).

- [ ] **Step 9: Spot-check a handful of real rows for exact match**

Pick 3 real records (e.g. one row from `sites`, one from `workers`, one from `invoices`) and run the same `SELECT * FROM <table> WHERE id = '<uuid>'` against both Tokyo and CHANG, comparing every column.

```bash
npx supabase db query --linked "SELECT id, name, is_default FROM public.sites LIMIT 3;"
```
(Run against Tokyo first to pick 3 real IDs, then the identical query filtered to those IDs against CHANG after relinking.)

- [ ] **Step 10: Write the row-count report**

Create `supabase/region-migration/row-count-report.md` summarizing: table count match (pass/fail), any tables with count discrepancies and their resolution, the 3 spot-checked rows and their match status, `auth.users` count on both sides (expect 14/14).

- [ ] **Step 11: Relink to Tokyo and commit**

```bash
npx supabase link --project-ref yyzbgdmgyvvypfcjuhtr
git add supabase/region-migration/verify-row-counts.sql supabase/region-migration/row-count-report.md
git commit -m "feat: migrate schema+data to CHANG (Singapore), verify row-count parity"
git push origin worktree-gantt-kanban:main
```

---

### Task 3: Storage — buckets, RLS policies, and objects

**Files:**
- Create: `supabase/region-migration/create-buckets-chang.sql`
- Create: `supabase/region-migration/generate-storage-policies.sql`
- Create: `supabase/region-migration/storage-report.md` (committed)

**Interfaces:**
- Consumes: Task 2's completed schema restore (storage policies reference `public`-schema helper functions like `is_admin_or_owner()`, which must already exist on CHANG).
- Produces: CHANG's 9 buckets, matching RLS policies, and all 115 real objects, verified by count/size parity. Consumed by Task 6.

- [ ] **Step 1: Confirm Tokyo is linked, create the bucket-recreation SQL**

Create `supabase/region-migration/create-buckets-chang.sql` with the exact 9 buckets and flags captured from Tokyo (all have `file_size_limit = NULL` and `allowed_mime_types = NULL` — no restrictions configured on any bucket):

```sql
INSERT INTO storage.buckets (id, name, public) VALUES
  ('document-receipts', 'document-receipts', false),
  ('invoice-photos', 'invoice-photos', false),
  ('line-site-photos', 'line-site-photos', false),
  ('po-attachments', 'po-attachments', false),
  ('site-attachments', 'site-attachments', false),
  ('supplier-doc-examples', 'supplier-doc-examples', false),
  ('tenant-logos', 'tenant-logos', true),
  ('user-signatures', 'user-signatures', false),
  ('worker-id-cards', 'worker-id-cards', false)
ON CONFLICT (id) DO NOTHING;
```

- [ ] **Step 2: Relink to CHANG and create the buckets**

```bash
npx supabase link --project-ref kntspldhvcjeaubtqtkn
npx supabase db query --linked --file supabase/region-migration/create-buckets-chang.sql
```
Expected: no error.

- [ ] **Step 3: Verify buckets landed**

```bash
npx supabase db query --linked "SELECT id, public FROM storage.buckets ORDER BY id;"
```
Expected: 9 rows, matching the list above exactly, `tenant-logos` the only `public = true`.

- [ ] **Step 4: Relink to Tokyo, generate the exact storage.objects RLS policy DDL from the live catalog**

Querying `pg_policies` directly (rather than replaying the 12 migration files that touch `storage.objects`, several of which are historical fixes superseding earlier ones — see spec's note on this project's established pattern of trusting current live state over migration replay) guarantees the exact policies actually enforced on Tokyo today, not an approximation.

```bash
npx supabase link --project-ref yyzbgdmgyvvypfcjuhtr
```

Create `supabase/region-migration/generate-storage-policies.sql`:
```sql
SELECT format(
  'CREATE POLICY %I ON storage.objects FOR %s TO %s USING (%s)%s;',
  policyname,
  cmd,
  array_to_string(roles, ', '),
  COALESCE(qual, 'true'),
  CASE WHEN with_check IS NOT NULL THEN format(' WITH CHECK (%s)', with_check) ELSE '' END
) AS policy_ddl
FROM pg_policies
WHERE schemaname = 'storage' AND tablename = 'objects'
ORDER BY policyname;
```

```bash
npx supabase db query --linked --file supabase/region-migration/generate-storage-policies.sql > supabase/region-migration/tmp/storage-policies-raw.json
```

Expected: one `policy_ddl` string per row. Extract just the `policy_ddl` string values (one `CREATE POLICY ...;` statement per line) into a plain SQL file at `supabase/region-migration/tmp/storage-policies.sql` — this is a formatting/extraction step on the already-fetched JSON, not a new query.

- [ ] **Step 5: Relink to CHANG, apply the generated policies**

```bash
npx supabase link --project-ref kntspldhvcjeaubtqtkn
npx supabase db query --linked --file supabase/region-migration/tmp/storage-policies.sql
```

Expected: no error. If a policy references a helper function (e.g. `is_admin_or_owner()`, `tenant_id`-scoping functions) that doesn't exist on CHANG, this fails loudly — Task 2 should have already restored these as part of the `public` schema; if one is missing, that's a Task 2 completeness gap worth reporting, not something to silently patch around here.

- [ ] **Step 6: Verify policy count matches Tokyo**

```bash
npx supabase db query --linked "SELECT COUNT(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects';"
npx supabase link --project-ref yyzbgdmgyvvypfcjuhtr
npx supabase db query --linked "SELECT COUNT(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects';"
```
Expected: identical counts.

- [ ] **Step 7: Copy all storage objects, bucket by bucket, via a local round-trip**

For each of the 8 populated buckets (`document-receipts`, `invoice-photos`, `line-site-photos`, `po-attachments`, `site-attachments`, `supplier-doc-examples`, `tenant-logos`, `user-signatures` — `worker-id-cards` is empty, skip it), while linked to Tokyo:

```bash
npx supabase link --project-ref yyzbgdmgyvvypfcjuhtr
npx supabase storage cp -r "ss:///document-receipts" "supabase/region-migration/tmp/document-receipts" --linked
npx supabase storage cp -r "ss:///invoice-photos" "supabase/region-migration/tmp/invoice-photos" --linked
npx supabase storage cp -r "ss:///line-site-photos" "supabase/region-migration/tmp/line-site-photos" --linked
npx supabase storage cp -r "ss:///po-attachments" "supabase/region-migration/tmp/po-attachments" --linked
npx supabase storage cp -r "ss:///site-attachments" "supabase/region-migration/tmp/site-attachments" --linked
npx supabase storage cp -r "ss:///supplier-doc-examples" "supabase/region-migration/tmp/supplier-doc-examples" --linked
npx supabase storage cp -r "ss:///tenant-logos" "supabase/region-migration/tmp/tenant-logos" --linked
npx supabase storage cp -r "ss:///user-signatures" "supabase/region-migration/tmp/user-signatures" --linked
```

Then relink to CHANG and upload each local copy back up:

```bash
npx supabase link --project-ref kntspldhvcjeaubtqtkn
npx supabase storage cp -r "supabase/region-migration/tmp/document-receipts" "ss:///document-receipts" --linked
npx supabase storage cp -r "supabase/region-migration/tmp/invoice-photos" "ss:///invoice-photos" --linked
npx supabase storage cp -r "supabase/region-migration/tmp/line-site-photos" "ss:///line-site-photos" --linked
npx supabase storage cp -r "supabase/region-migration/tmp/po-attachments" "ss:///po-attachments" --linked
npx supabase storage cp -r "supabase/region-migration/tmp/site-attachments" "ss:///site-attachments" --linked
npx supabase storage cp -r "supabase/region-migration/tmp/supplier-doc-examples" "ss:///supplier-doc-examples" --linked
npx supabase storage cp -r "supabase/region-migration/tmp/tenant-logos" "ss:///tenant-logos" --linked
npx supabase storage cp -r "supabase/region-migration/tmp/user-signatures" "ss:///user-signatures" --linked
```

Expected: each `cp` reports the number of objects transferred; total across both directions should be 115 objects downloaded + 115 uploaded.

- [ ] **Step 8: Verify object counts and total size per bucket match**

```bash
npx supabase db query --linked "SELECT bucket_id, COUNT(*) AS object_count, pg_size_pretty(SUM(COALESCE((metadata->>'size')::bigint, 0))) AS total_size FROM storage.objects GROUP BY bucket_id ORDER BY bucket_id;"
```

Run against CHANG (currently linked), then relink to Tokyo and run the same query, compare bucket-by-bucket against the original inventory in the spec (`invoice-photos`: 48 objects/5546 KB, `line-site-photos`: 19/2950 KB, `site-attachments`: 4/1921 KB, `po-attachments`: 15/1458 KB, `supplier-doc-examples`: 5/896 KB, `document-receipts`: 29/376 KB, `user-signatures`: 6/62 KB, `tenant-logos`: 2/13 KB).

- [ ] **Step 9: Write the storage report, relink to Tokyo, commit**

Create `supabase/region-migration/storage-report.md` summarizing bucket-by-bucket object count/size parity and policy count parity.

```bash
npx supabase link --project-ref yyzbgdmgyvvypfcjuhtr
git add supabase/region-migration/create-buckets-chang.sql supabase/region-migration/generate-storage-policies.sql supabase/region-migration/storage-report.md
git commit -m "feat: migrate storage buckets, RLS policies, and 115 objects to CHANG"
git push origin worktree-gantt-kanban:main
```

---

### Task 4: Edge function redeploy + secrets checklist

**Files:**
- Create: `supabase/region-migration/deploy-functions-report.md` (committed)
- Create: `supabase/region-migration/secrets-checklist.md` (committed — the handoff artifact for the user)

**Interfaces:**
- Consumes: nothing from Tokyo (function source code is already in this repo, identical for both projects — no code changes).
- Produces: `secrets-checklist.md`, which the user reads and acts on manually. Consumed by Task 6 (functions won't fully work until secrets are entered, but deploy success itself is verifiable now).

- [ ] **Step 1: Confirm CHANG is linked**

```bash
npx supabase db query --linked "SELECT version();"
```
Expected: contains `17.11`. If not, `npx supabase link --project-ref kntspldhvcjeaubtqtkn`.

- [ ] **Step 2: Deploy all 14 functions, matching each function's exact `verify_jwt` setting**

`verify_jwt: false` (4 functions — each has its own internal auth gate, see each file's header comment): `omise-webhook`, `sign-link`, `line-webhook`, `field-form`.
`verify_jwt: true` (default, 10 functions): `omise-create-charge`, `extract-po-document`, `line-push-daily-assignments`, `line-push-quotation-followups`, `line-push-cheque-reminders`, `line-push-invoice-due`, `line-worker-offboarded`, `line-test-group`, `leave-notify`, `extract-map-coordinates`.

```bash
npx supabase functions deploy omise-webhook --project-ref kntspldhvcjeaubtqtkn --no-verify-jwt --use-api
npx supabase functions deploy sign-link --project-ref kntspldhvcjeaubtqtkn --no-verify-jwt --use-api
npx supabase functions deploy line-webhook --project-ref kntspldhvcjeaubtqtkn --no-verify-jwt --use-api
npx supabase functions deploy field-form --project-ref kntspldhvcjeaubtqtkn --no-verify-jwt --use-api
npx supabase functions deploy omise-create-charge --project-ref kntspldhvcjeaubtqtkn --use-api
npx supabase functions deploy extract-po-document --project-ref kntspldhvcjeaubtqtkn --use-api
npx supabase functions deploy line-push-daily-assignments --project-ref kntspldhvcjeaubtqtkn --use-api
npx supabase functions deploy line-push-quotation-followups --project-ref kntspldhvcjeaubtqtkn --use-api
npx supabase functions deploy line-push-cheque-reminders --project-ref kntspldhvcjeaubtqtkn --use-api
npx supabase functions deploy line-push-invoice-due --project-ref kntspldhvcjeaubtqtkn --use-api
npx supabase functions deploy line-worker-offboarded --project-ref kntspldhvcjeaubtqtkn --use-api
npx supabase functions deploy line-test-group --project-ref kntspldhvcjeaubtqtkn --use-api
npx supabase functions deploy leave-notify --project-ref kntspldhvcjeaubtqtkn --use-api
npx supabase functions deploy extract-map-coordinates --project-ref kntspldhvcjeaubtqtkn --use-api
```

Expected: each returns a success message naming the function and project ref. Record any failures verbatim in the report rather than retrying blindly.

- [ ] **Step 3: Verify all 14 deployed**

```bash
npx supabase functions list --project-ref kntspldhvcjeaubtqtkn
```
Expected: 14 functions listed, `status: ACTIVE`, `verify_jwt` matching Step 2's list exactly.

- [ ] **Step 4: Write the secrets checklist for the user (names only — no values, ever)**

Create `supabase/region-migration/secrets-checklist.md`:
```markdown
# CHANG Secrets Checklist

These 5 secrets exist on Tokyo and must be manually re-entered on CHANG via
the Supabase Dashboard (Project Settings → Edge Functions → Secrets) or your
own authenticated CLI session. Real values are never read, transcribed, or
set by Claude — enter them yourself from your own records or the LINE/Omise/
Anthropic/Resend dashboards where each was originally issued.

- [ ] `ANTHROPIC_API_KEY`
- [ ] `LINE_CHANNEL_ACCESS_TOKEN`
- [ ] `LINE_CHANNEL_SECRET`
- [ ] `OMISE_SECRET_KEY`
- [ ] `RESEND_API_KEY`

The following are platform-managed and need NO action — Supabase
auto-populates these correctly for every project, including CHANG:
`SUPABASE_ANON_KEY`, `SUPABASE_DB_URL`, `SUPABASE_JWKS`,
`SUPABASE_PUBLISHABLE_KEYS`, `SUPABASE_SECRET_KEYS`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`.

Verify after entering, via your own terminal (do not ask Claude to run this
with real values in view):
`npx supabase secrets list --project-ref kntspldhvcjeaubtqtkn`
(shows names + digests only, confirms presence without exposing values).
```

- [ ] **Step 5: Write the deploy report, commit**

Create `supabase/region-migration/deploy-functions-report.md` listing all 14 functions, their deploy status, and `verify_jwt` confirmation.

```bash
git add supabase/region-migration/deploy-functions-report.md supabase/region-migration/secrets-checklist.md
git commit -m "feat: redeploy all 14 edge functions to CHANG, add secrets checklist for user"
git push origin worktree-gantt-kanban:main
```

(No relink-to-Tokyo needed here — `functions deploy`/`functions list` took an explicit `--project-ref` and did not depend on which project `--linked` currently resolves to. Confirm current linked state is still Tokyo before Task 5, since Task 1-3 left it linked to Tokyo at their end, but this task's own commands didn't touch it.)

---

### Task 5: Recreate pg_cron jobs + Vault secrets on CHANG

**Files:**
- Create: `supabase/region-migration/create-cron-vault-chang.sql`
- Create: `supabase/region-migration/cron-vault-report.md` (committed)

**Interfaces:**
- Consumes: Task 2's restored `public.verify_cron_secret()` function (must already exist on CHANG) and Task 4's deployed function URLs (`https://kntspldhvcjeaubtqtkn.supabase.co/functions/v1/<slug>`).
- Produces: 3 working cron jobs on CHANG pointing at CHANG's own functions, proven via a manual `verify_cron_secret()` call — not by waiting for an actual 2am fire.

- [ ] **Step 1: Confirm CHANG is linked**

```bash
npx supabase db query --linked "SELECT version();"
```
Expected: contains `17.11`. If not, `npx supabase link --project-ref kntspldhvcjeaubtqtkn`.

- [ ] **Step 2: Write the Vault secrets + cron jobs SQL**

Create `supabase/region-migration/create-cron-vault-chang.sql`:
```sql
-- Fresh, randomly-generated internal shared secrets for CHANG. These are
-- self-issued secrets used only between pg_cron and this project's own
-- edge functions -- they do NOT need to match Tokyo's values, and their
-- real values never need to be known by anyone (see
-- docs/superpowers/specs/2026-10-01-supabase-region-migration-design.md,
-- "pg_cron jobs + Vault secrets" section, for why Vault secrets can't be
-- copied cross-project in the first place).
select vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'line_push_cron_auth_key');
select vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'line_push_cron_shared_secret');

select cron.schedule(
  'line-push-quotation-followups',
  '0 2 * * *',
  $$
  select net.http_post(
    url := 'https://kntspldhvcjeaubtqtkn.supabase.co/functions/v1/line-push-quotation-followups',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_auth_key'),
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_shared_secret'),
      'Content-Type', 'application/json'
    )
  )
  $$
);

select cron.schedule(
  'line-push-cheque-reminders',
  '0 2 * * *',
  $$
  select net.http_post(
    url := 'https://kntspldhvcjeaubtqtkn.supabase.co/functions/v1/line-push-cheque-reminders',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_auth_key'),
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_shared_secret'),
      'Content-Type', 'application/json'
    )
  )
  $$
);

select cron.schedule(
  'line-push-invoice-due',
  '0 2 1 * *',
  $$
  select net.http_post(
    url := 'https://kntspldhvcjeaubtqtkn.supabase.co/functions/v1/line-push-invoice-due',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_auth_key'),
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_shared_secret'),
      'Content-Type', 'application/json'
    )
  )
  $$
);
```

**Note:** this plan does NOT activate these jobs for real production use — they're created on CHANG purely to prove the mechanism works (per the spec's explicit scope: "during the dry run these jobs can be created but should either stay inactive or simply not matter, since nothing is driving real tenant traffic through CHANG yet"). Since CHANG has no real tenant data pointed at it and no real LINE webhook traffic, a 2am fire against CHANG's functions would at most be a harmless no-op (the functions query real business data that doesn't meaningfully exist in a way that would trigger an actual LINE push to a real group) — but if the implementer wants zero risk of any scheduled fire during the dry-run window, `select cron.unschedule('line-push-quotation-followups');` (and the other 2 job names) immediately after Step 4's verification can deschedule them without deleting the proof that creation worked — note this choice in the report either way.

- [ ] **Step 3: Apply it**

```bash
npx supabase db query --linked --file supabase/region-migration/create-cron-vault-chang.sql
```
Expected: no error, 2 `vault.create_secret` results (each returns a UUID) and 3 `cron.schedule` results (each returns a jobid).

- [ ] **Step 4: Verify the mechanism works end-to-end**

```bash
npx supabase db query --linked "SELECT verify_cron_secret((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'line_push_cron_shared_secret'));"
```
Expected: `true`. This proves `verify_cron_secret()` (restored as part of Task 2's `public` schema restore) correctly resolves the freshly-created CHANG-local Vault secret — the exact mechanism the 3 real cron jobs depend on at 2am.

```bash
npx supabase db query --linked "SELECT jobid, jobname, schedule, active FROM cron.job ORDER BY jobid;"
```
Expected: 3 rows, names/schedules matching Tokyo's (`line-push-quotation-followups` and `line-push-cheque-reminders` at `0 2 * * *`, `line-push-invoice-due` at `0 2 1 * *`), `command` containing `kntspldhvcjeaubtqtkn` (CHANG's own ref), not `yyzbgdmgyvvypfcjuhtr`.

- [ ] **Step 5: Write the report, relink to Tokyo, commit**

Create `supabase/region-migration/cron-vault-report.md` confirming: 2 Vault secrets created, 3 cron jobs created with CHANG's own URLs, `verify_cron_secret()` manual check passed, and whichever choice was made on Step 2's unschedule-for-safety note.

```bash
npx supabase link --project-ref yyzbgdmgyvvypfcjuhtr
git add supabase/region-migration/create-cron-vault-chang.sql supabase/region-migration/cron-vault-report.md
git commit -m "feat: recreate pg_cron jobs and Vault secrets on CHANG with rewritten URLs"
git push origin worktree-gantt-kanban:main
```

---

### Task 6: Full verification pass + final report

**Files:**
- Create: `supabase/region-migration/DRY-RUN-REPORT.md` (committed — the final deliverable of this plan)

**Interfaces:**
- Consumes: every report file from Tasks 1-5.
- Produces: a single pass/fail summary against the spec's exact 7-point verification checklist, suitable for the user to read in under 2 minutes and know whether CHANG is ready for the (separate, future) real cutover to be scheduled with confidence.

- [ ] **Step 1: Confirm Tokyo is linked (baseline for comparisons)**

```bash
npx supabase db query --linked "SELECT version();"
```
Expected: contains `17.6`.

- [ ] **Step 2: Re-run the spec's 7-point checklist, point by point, recording pass/fail for each**

1. **Row-count parity** (all 82 `public` + `auth` tables) — re-read `supabase/region-migration/row-count-report.md` from Task 2; re-verify with a fresh `SELECT COUNT(*)` on any table that wasn't a clean exact match the first time.
2. **Spot-check real rows** — confirm Task 2 Step 9's 3 spot-checked records still match.
3. **Storage parity** — re-read `supabase/region-migration/storage-report.md` from Task 3; re-verify bucket object counts with a fresh query against both projects.
4. **Extension + RLS parity** — re-confirm `pg_extension` lists match (Task 1 Step 5) and check RLS policy count on `public.phase_tasks` and `public.line_site_photos` matches between Tokyo and CHANG:
   ```bash
   npx supabase db query --linked "SELECT tablename, COUNT(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('phase_tasks', 'line_site_photos') GROUP BY tablename;"
   ```
   Run against both projects, compare.
5. **Function deploy confirmation** — re-read `supabase/region-migration/deploy-functions-report.md` from Task 4; re-run `npx supabase functions list --project-ref kntspldhvcjeaubtqtkn` to confirm all 14 are still `ACTIVE`.
6. **Cron/Vault mechanism proof** — re-read `supabase/region-migration/cron-vault-report.md` from Task 5; re-run the `verify_cron_secret()` manual check to confirm it still returns `true`.
7. **Auth schema sanity** — confirm `auth.users` count is 14 on both projects:
   ```bash
   npx supabase db query --linked "SELECT COUNT(*) FROM auth.users;"
   ```
   Run against both, compare.

- [ ] **Step 3: Write `DRY-RUN-REPORT.md`**

Structure: one line per checklist point (✅/❌ + one-sentence detail), a short "What this proves" section (CHANG can hold a faithful, working copy of Tokyo's schema, data, storage, functions, and scheduled jobs), and an explicit "What this does NOT prove" section listing the spec's own out-of-scope items verbatim (actual user login against CHANG, actual LINE webhook delivery, actual DNS/env var cutover, actual cron jobs firing for real, Free→Pro upgrade timing) — so the user has an accurate picture of what's left before the real cutover can be scheduled, not an inflated "it's done" signal.

- [ ] **Step 4: Commit**

```bash
git add supabase/region-migration/DRY-RUN-REPORT.md
git commit -m "docs: dry-run verification report for Tokyo-to-Singapore region migration"
git push origin worktree-gantt-kanban:main
```

- [ ] **Step 5: Confirm linked project is Tokyo (session default) before ending**

```bash
npx supabase db query --linked "SELECT version();"
```
Expected: contains `17.6`. If not, `npx supabase link --project-ref yyzbgdmgyvvypfcjuhtr` — leaving the session linked to CHANG would silently break any other work in this worktree that assumes Tokyo is linked.
