# Supabase Region Migration (Tokyo → Singapore) — Design

**Status:** Approved for dry-run implementation. The live cutover is a separate, later, explicitly-scheduled step — this spec covers both phases but only the dry run is implemented from this spec's plan.

## Context

FacadeXPM's live Supabase project (`facadexpm`, ref `yyzbgdmgyvvypfcjuhtr`) is hosted in `ap-northeast-1` (Tokyo). The product's real and target market is East + Southeast Asia (Thailand, Vietnam, Malaysia, Indonesia, Philippines, with secondary reach into Japan/Korea) — Tokyo adds meaningless latency for Japan/Korea but real, avoidable latency for the mainland SE Asia market that is FacadeXPM's actual near-term customer base.

A new, empty target project has been created: **CHANG** (ref `kntspldhvcjeaubtqtkn`, region `ap-southeast-1`, Postgres `17.11.0.002` — one minor version ahead of Tokyo's `17.6.1.127`; this is expected to be compatible but the dry run is exactly how we confirm that before it matters).

There is also a third, older, **inactive, unlinked** project called `facadex` (ref `vhbqljxauuklaijolyhd`, region `ap-southeast-1`, created 2026-04-28) — an abandoned earlier attempt. It is not touched by this migration and exists only so CHANG isn't confused with it.

Supabase has no live region-change feature. Moving regions means standing up a new project and migrating everything into it, then cutting production traffic over.

## Decisions made during brainstorming

- **Cutover downtime:** a brief offline window is acceptable. This rules out replication/dual-write complexity — a clean freeze-write → dump/restore → flip approach is sufficient and lower-risk for a database this size.
- **CHANG's plan tier:** stays on **Free** through the dry run and the eventual cutover; upgrading to Pro happens afterward, as a separate decision, independent of this migration. (Tracked separately — see `todo-supabase-region-migration-se-asia.md` and the earlier Free→Pro cost conversation. Pro upgrade is a same-project billing change, unrelated to this region move.)
- **Rollback window:** the old Tokyo project is paused (not deleted) indefinitely after cutover, with no forced deletion deadline.
- **Sequencing:** prove the full migration against CHANG via a **dry run with zero production impact** first. The live cutover is scheduled and executed separately, later, only after the dry run is verified clean.

## Current live-project inventory (captured 2026-10-01, grounds this spec in real state, not estimates)

**Database:** 28 MB, 82 tables in `public`, 14 rows in `auth.users`.

**Enabled extensions:** `pg_cron` (1.6.4), `pg_net` (0.20.3), `pg_stat_statements` (1.11), `pgcrypto` (1.3), `plpgsql` (1.0), `supabase_vault` (0.3.1), `uuid-ossp` (1.1). CHANG must have the same set enabled before restore, or the restore will fail on first use of a dependent type/function.

**Storage:** 115 objects, ~13 MB, across 8 populated buckets (`invoice-photos`, `line-site-photos`, `site-attachments`, `po-attachments`, `document-receipts`, `supplier-doc-examples`, `user-signatures`, `tenant-logos`) plus one empty bucket (`worker-id-cards`). Bucket `public`/private flags must match exactly (`tenant-logos` is public; every other bucket is private).

**Edge functions (14 total, all `ACTIVE`):** `omise-create-charge`, `omise-webhook`, `sign-link`, `extract-po-document`, `line-webhook`, `line-push-daily-assignments`, `line-push-quotation-followups`, `line-push-cheque-reminders`, `line-push-invoice-due`, `line-worker-offboarded`, `field-form`, `line-test-group`, `leave-notify`, `extract-map-coordinates`. `verify_jwt` is `false` for `omise-webhook`, `sign-link`, `line-webhook`, and `field-form` (each has its own internal auth gate instead — see each function's own header comment); `true` for every other function.

**Custom secrets requiring manual re-entry on CHANG** (names only — real values are never seen or entered by Claude, confirmed via `supabase secrets list`, which only ever returns name + a digest, never the real value):
- `ANTHROPIC_API_KEY`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`
- `OMISE_SECRET_KEY`
- `RESEND_API_KEY`

Five more secret names shown by `supabase secrets list` (`SUPABASE_ANON_KEY`, `SUPABASE_DB_URL`, `SUPABASE_JWKS`, `SUPABASE_PUBLISHABLE_KEYS`, `SUPABASE_SECRET_KEYS`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`) are Supabase's own platform-managed secrets, auto-populated per-project. These do **not** need migration — CHANG already has its own correct values for these the moment it exists.

**pg_cron jobs (3 active) — the critical landmine this spec exists to document:**

| jobid | jobname | schedule | calls |
|---|---|---|---|
| 2 | `line-push-quotation-followups` | `0 2 * * *` | `line-push-quotation-followups` |
| 3 | `line-push-cheque-reminders` | `0 2 * * *` | `line-push-cheque-reminders` |
| 4 | `line-push-invoice-due` | `0 2 1 * *` | `line-push-invoice-due` |

Each job's `command` calls `net.http_post` with the URL **hardcoded to Tokyo** (`https://yyzbgdmgyvvypfcjuhtr.supabase.co/functions/v1/...`), and pulls its `Authorization` bearer and `x-cron-secret` header values from **Supabase Vault** (`vault.decrypted_secrets`, names `line_push_cron_auth_key` and `line_push_cron_shared_secret`). The receiving functions verify the `x-cron-secret` header against the same Vault secret via `public.verify_cron_secret()` (SECURITY DEFINER SQL function, restored automatically as part of the normal `public` schema dump — see `supabase/migrations/2026-09-19-04-line-push-cron-secret-verify-fn.sql`).

Two consequences that a naive `pg_dump`/`pg_restore` would get wrong:
1. **The cron job URLs must be rewritten** to CHANG's own function URL (`https://kntspldhvcjeaubtqtkn.supabase.co/functions/v1/...`) — a blind restore would leave CHANG's cron jobs calling Tokyo's functions forever, silently.
2. **Vault secrets are not portable across projects.** Postgres Vault encrypts values with a project-specific root key; a plain `pg_dump` of the `vault` schema would restore ciphertext that CHANG's own key cannot decrypt (`vault.decrypted_secrets` would either error or return garbage). The `vault` schema must be **excluded** from the dump, and the two secrets (`line_push_cron_auth_key`, `line_push_cron_shared_secret`) must be **freshly created on CHANG** via `vault.create_secret()`, under the same names `verify_cron_secret()` looks up. Since these are purely internal, self-issued shared secrets between `pg_cron` and the edge functions (not third-party credentials), generating new random values for CHANG is correct and requires no credential to pass through chat or through Claude at all.

## Architecture

Two Supabase projects exist side by side during the dry run: Tokyo (`facadexpm`, live, read-only source — never written to by this process) and CHANG (Singapore, empty, fully disposable/re-creatable target). A set of scripts drive a one-way copy. Nothing in production — app env vars, DNS, the LINE Developers Console webhook URL — points at CHANG during or after the dry run. The dry run proves the migration mechanics work; it does not go live.

## Components

### 1. Schema + data migration

`pg_dump` the **current live state** of Tokyo's `public` and `auth` schemas (not a replay of the ~200+ incremental migration files — those filenames don't match the Supabase CLI's expected pattern, a problem already hit earlier this session with `migration list`/`db push`; dumping live state directly is simpler and guaranteed to match reality). Explicitly **exclude the `vault` and `cron` schemas** from this dump — both are project-specific and handled separately (components 5 and the cron-rewrite step below) rather than carried over verbatim.

Flags: `--no-owner --no-acl` (avoid role-ownership mismatches between the two projects' internal role sets). Restore via `psql`/`pg_restore` against CHANG's connection string.

Before restoring, CHANG must have the same extension set enabled (`pg_cron`, `pg_net`, `pg_stat_statements`, `pgcrypto`, `supabase_vault`, `uuid-ossp` — `plpgsql` is always present) — enabling missing extensions is a one-line `create extension if not exists` per extension, run first.

### 2. Storage migration

A script lists every object across the 8 populated buckets on Tokyo via the Storage API, downloads each (13 MB total — trivial, seconds), recreates the same 9 buckets (8 populated + `worker-id-cards`) on CHANG with matching `public`/private flags, and re-uploads every object at its exact original path. Idempotent and safely re-runnable: re-running after a partial failure just re-uploads, no dedup logic needed given the trivial size.

### 3. Edge function redeploy

Redeploy all 14 functions as-is to CHANG: `npx supabase functions deploy <slug> --project-ref kntspldhvcjeaubtqtkn [--no-verify-jwt for line-webhook]`, matching each function's current `verify_jwt` setting exactly (see inventory above). No source code changes — this is a target-project redeploy of the exact code already in this repo.

### 4. Secrets

I enumerate the 5 custom secret **names** (never values) that need re-entry (see inventory above) and hand the list to the user. The user enters the real values into CHANG themselves, via the Supabase dashboard or their own authenticated CLI session — never through Claude, consistent with this project's standing credential-handling rule. The 7 platform-managed `SUPABASE_*` secrets need no action; they're already correct on CHANG by virtue of it being its own project.

### 5. pg_cron jobs + Vault secrets (CHANG-specific, not a restore)

On CHANG, after the schema restore lands:
1. Create two fresh Vault secrets with random values: `line_push_cron_auth_key`, `line_push_cron_shared_secret` (via `vault.create_secret()`, run directly in this migration's own SQL — the values never need to be known by anyone, they just need to match between the Vault entry and what `verify_cron_secret()` looks up).
2. Create the same 3 cron jobs (`line-push-quotation-followups` at `0 2 * * *`, `line-push-cheque-reminders` at `0 2 * * *`, `line-push-invoice-due` at `0 2 1 * *`), each `net.http_post`-ing CHANG's own function URL (`https://kntspldhvcjeaubtqtkn.supabase.co/functions/v1/<slug>`) instead of Tokyo's.

This step only matters once CHANG is live (post-cutover) — during the dry run these jobs can be created but should either stay inactive or simply not matter, since nothing is driving real tenant traffic through CHANG yet. They're included here so the dry run proves the *mechanism* (Vault secret creation + cron job creation against the restored schema) works, without risk of a dry-run cron job actually firing a real LINE push to the real crew group.

## Data flow (dry run)

```
Tokyo (read-only source)
  │
  ├─ pg_dump (public + auth schemas, --no-owner --no-acl) ──► local .sql file ──► pg_restore ──► CHANG
  ├─ Storage API: list + download 115 objects ──► local tmp ──► Storage API: create buckets + upload ──► CHANG
  ├─ supabase functions deploy × 14 (same source, this repo) ──────────────────► CHANG
  └─ (secrets: user enters 5 values directly into CHANG dashboard — bypasses Claude entirely)

CHANG (freshly populated, still fully disposable)
  └─ vault.create_secret() × 2 + cron.schedule() × 3 (CHANG's own URLs) — proves the mechanism only
```

No component in this flow writes to Tokyo. No component points any part of the live app (frontend env vars, LINE webhook URL, DNS) at CHANG.

## Error handling

Since nothing points at CHANG until the later cutover, CHANG is **disposable** throughout the dry run. Any failure (missing extension, restore error, a storage upload that fails partway, a cron/vault step that errors) is handled by fixing the script and re-running against CHANG — worst case, wipe CHANG's `public` schema and restore again. Zero risk to Tokyo's live data at any point, since every operation reads from Tokyo and writes only to CHANG or to local temp files.

## Testing / verification plan (what "dry run complete" means)

1. **Row-count parity:** for every one of the 82 `public` tables, `SELECT COUNT(*)` on Tokyo matches the same on CHANG.
2. **Spot-check real rows:** pick a handful of real records (e.g. a specific site, a specific invoice) and confirm every column matches exactly between Tokyo and CHANG.
3. **Storage parity:** object count and total bucket size per bucket matches between Tokyo and CHANG (all 9 buckets, including the empty one).
4. **Extension + RLS parity:** `pg_extension` list matches; spot-check that RLS is enabled with the same policy count on a representative table (e.g. `phase_tasks`, `line_site_photos`) via `pg_policies`.
5. **Function deploy confirmation:** all 14 `supabase functions deploy` calls return success against CHANG.
6. **Cron/Vault mechanism proof:** the 2 Vault secrets and 3 cron jobs are created successfully on CHANG and `verify_cron_secret()` returns `true` for the freshly-created secret value when called manually — proves the mechanism without needing a real cron fire.
7. **Auth schema sanity:** `auth.users` count on CHANG is 14, matching Tokyo (full login flow can't be tested yet without secrets wired into a pointed-at-CHANG frontend, which is out of scope for the dry run).

Explicitly **not** tested in the dry run (these are cutover-phase concerns, out of scope here): actual user login against CHANG, actual LINE webhook delivery to CHANG, actual DNS/env var cutover, actual cron jobs firing for real.

## Out of scope for this spec's implementation plan (future, separate work)

- The actual scheduled cutover (freeze writes on Tokyo → final delta dump/restore → flip Vercel/app env vars → re-point the LINE Developers Console webhook URL → verify live → pause Tokyo).
- Deciding and executing the Free→Pro upgrade for CHANG (tracked separately).
- Deleting the old, already-inactive, unrelated `facadex` project (ref `vhbqljxauuklaijolyhd`) — untouched by this work.
