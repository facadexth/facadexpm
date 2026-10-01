# Task 5 Report: pg_cron jobs + Vault secrets on CHANG

**Date:** 2026-10-01
**Project:** CHANG (Singapore, ref `kntspldhvcjeaubtqtkn`), source of truth remains Tokyo (ref `yyzbgdmgyvvypfcjuhtr`, read-only, untouched by this task)

## Summary

Created 2 fresh, randomly-generated Vault secrets and 3 pg_cron jobs on CHANG,
rewritten to point at CHANG's own edge function URLs. Verified the
`verify_cron_secret()` mechanism end-to-end with both a positive and a
negative check. Per the brief's optional safety note, **unscheduled all 3
jobs immediately after verification** — see "Unschedule decision" below.

## Step 1: Confirm linking

Initial `npx supabase db query --linked "SELECT version();"` reported
`PostgreSQL 17.6` — still linked to Tokyo from a prior task. Relinked:

```
npx supabase link --project-ref kntspldhvcjeaubtqtkn
```

Re-ran the version check: `PostgreSQL 17.11 on aarch64-unknown-linux-gnu` —
confirmed linked to CHANG before proceeding.

Pre-flight sanity checks on CHANG also confirmed before applying anything:
- `public.verify_cron_secret` function exists (restored by Task 2).
- Extensions `supabase_vault`, `pg_cron`, `pg_net` are all installed.

## Step 2: SQL written

`supabase/region-migration/create-cron-vault-chang.sql` written verbatim per
the brief — 2 `vault.create_secret()` calls (`line_push_cron_auth_key`,
`line_push_cron_shared_secret`) and 3 `cron.schedule()` calls
(`line-push-quotation-followups`, `line-push-cheque-reminders`,
`line-push-invoice-due`), all URLs pointing at
`https://kntspldhvcjeaubtqtkn.supabase.co/functions/v1/<slug>`.

## Step 3: Applied

```
npx supabase db query --linked --file supabase/region-migration/create-cron-vault-chang.sql
```

No errors. The CLI's multi-statement output only surfaces the last
statement's result (`{"schedule": 3}` — jobid 3, the last `cron.schedule`
call), so all statements were verified individually afterward:

```
npx supabase db query --linked "SELECT id, name FROM vault.secrets WHERE name IN ('line_push_cron_auth_key','line_push_cron_shared_secret') ORDER BY name;"
```
```json
{
  "rows": [
    { "id": "0810fa83-b876-472e-9e7a-d844f8b60072", "name": "line_push_cron_auth_key" },
    { "id": "6fda97e8-bc00-4b77-a6a3-44394d19f184", "name": "line_push_cron_shared_secret" }
  ]
}
```

Both Vault secrets confirmed created, each with a real UUID id. (No secret
plaintext value was ever read, printed, or transcribed — `gen_random_bytes`
generated them entirely server-side.)

## Step 4: Verification

**Positive check** — real generated secret resolves correctly:

```
npx supabase db query --linked "SELECT verify_cron_secret((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'line_push_cron_shared_secret'));"
```
```json
{ "rows": [ { "verify_cron_secret": true } ] }
```
Result: **`true`**.

**Negative check** (not in the brief, added for confidence that this is a
real comparison and not a stub) — an obviously wrong value:

```
npx supabase db query --linked "SELECT verify_cron_secret('obviously-wrong-value');"
```
```json
{ "rows": [ { "verify_cron_secret": false } ] }
```
Result: **`false`**, confirming `verify_cron_secret()` is doing a genuine
comparison against the freshly-created CHANG-local Vault secret.

**cron.job contents** (before unscheduling), confirming names, schedules,
and CHANG's own URL in `command`:

```
npx supabase db query --linked "SELECT jobid, jobname, schedule, active, command FROM cron.job ORDER BY jobid;"
```

| jobid | jobname | schedule | active | url in command |
|---|---|---|---|---|
| 1 | line-push-quotation-followups | `0 2 * * *` | true | `https://kntspldhvcjeaubtqtkn.supabase.co/functions/v1/line-push-quotation-followups` |
| 2 | line-push-cheque-reminders | `0 2 * * *` | true | `https://kntspldhvcjeaubtqtkn.supabase.co/functions/v1/line-push-cheque-reminders` |
| 3 | line-push-invoice-due | `0 2 1 * *` | true | `https://kntspldhvcjeaubtqtkn.supabase.co/functions/v1/line-push-invoice-due` |

Full raw `command` text for each row confirmed the URL host is
`kntspldhvcjeaubtqtkn.supabase.co` (CHANG) in all 3 jobs — **not**
`yyzbgdmgyvvypfcjuhtr` (Tokyo). Names and schedules match Tokyo's originals
(`0 2 * * *` for the two daily jobs, `0 2 1 * *` monthly for invoice-due).

## Unschedule decision

The brief offered an optional zero-risk choice: unschedule the 3 jobs right
after verification so nothing can fire at 2am against CHANG during the
dry-run window, while the proof that creation + the secret mechanism worked
is already captured above.

**Decision: unscheduled.** Ran:

```sql
select cron.unschedule('line-push-quotation-followups');
select cron.unschedule('line-push-cheque-reminders');
select cron.unschedule('line-push-invoice-due');
```

Confirmed removal:

```
npx supabase db query --linked "SELECT jobid, jobname, active FROM cron.job ORDER BY jobid;"
```
```json
{ "rows": [] }
```

`cron.job` is now empty on CHANG — `cron.unschedule()` deletes the row
outright rather than merely setting `active = false`. This was chosen even
though the brief notes a real fire would likely be a harmless no-op (CHANG
has no real tenant/LINE data), because it costs nothing here and fully
eliminates any chance of a scheduled fire during the dry-run window. The
Vault secrets were left in place (they're inert without a scheduler
pointing at them, and deleting them wasn't requested).

The 2 Vault secrets and the SQL file itself remain the permanent record that
the mechanism was created and proven; re-running
`create-cron-vault-chang.sql`'s `cron.schedule()` calls (or a future task)
would re-activate the jobs if/when CHANG goes live for real.

## Step 5: Relink to Tokyo

```
npx supabase link --project-ref yyzbgdmgyvvypfcjuhtr
```

Ended the task linked back to Tokyo as required.

## Files changed

- `supabase/region-migration/create-cron-vault-chang.sql` (new)
- `supabase/region-migration/cron-vault-report.md` (new, this file)

## Self-review

- 2 Vault secrets created, confirmed by real UUID `id` values returned from
  `vault.secrets` — yes.
- 3 cron jobs created with correct names/schedules, pointing at CHANG's own
  URL host `kntspldhvcjeaubtqtkn` (not Tokyo's `yyzbgdmgyvvypfcjuhtr`) —
  confirmed via the full `command` text of each row before unscheduling —
  yes.
- `verify_cron_secret()` returns `true` for the real generated secret value
  (and `false` for a wrong one, ruling out a stub) — yes.
- Relinked correctly before every `--linked` command (checked `version()`
  before Step 1's relink, and relinked explicitly with
  `--project-ref kntspldhvcjeaubtqtkn` before applying anything) — yes.
- Ended linked back to Tokyo (`yyzbgdmgyvvypfcjuhtr`) — yes.
- Brief's optional "unschedule for safety" choice was made and documented —
  yes, unscheduled (see "Unschedule decision" above).
- No secret plaintext value was ever read, printed, or transcribed by this
  session — confirmed; only secret `id` (UUID) and `name` were ever
  queried/printed, never `decrypted_secret` values.
- Tokyo was not touched — confirmed; every mutating statement in this task
  ran only while linked to CHANG.
