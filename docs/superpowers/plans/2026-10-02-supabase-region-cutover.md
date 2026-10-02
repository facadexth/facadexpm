# Supabase Region Cutover (Tokyo → Singapore/CHANG) Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Tasks 3 and 6 are run by the human operator in their own terminal (`! ./script`), not by an agent** — they handle database passwords and service-role keys that must never pass through Claude.

**Goal:** Move FacadeXPM production from the Tokyo Supabase project to the Singapore project (CHANG) with one short, announced write-freeze, a measured window, and a defined rollback.

**Architecture:** Freeze Tokyo writes at the database level → dump Tokyo (`public` schema + data, `auth` data) with `pg_dump` run inside a Docker container → wipe and restore into CHANG with `psql` → rewrite every hardcoded Tokyo URL → copy storage → deploy all edge functions from `main` → recreate cron jobs → verify → flip the app/LINE/Omise to CHANG. Tokyo is left frozen (read-only) rather than paused, so stale clients get a clear error instead of silently writing data that would be lost.

**Tech Stack:** Supabase (Postgres 17, Storage, Edge Functions, pg_cron, Vault), `pg_dump`/`psql` from the `postgres:17` Docker image, Node (supabase-js) for storage copy, GitHub Actions + cPanel for the frontend.

**Spec / prior work:** `docs/superpowers/specs/2026-10-01-supabase-region-migration-design.md`, `supabase/region-migration/DRY-RUN-REPORT.md`. The dry run's restore tooling was improvised and **not committed** (it is gone from disk), so this plan rebuilds it as committed, repeatable scripts.

## Global Constraints

- **Tokyo is never deleted.** After cutover it stays frozen (read-only), then is paused later. Rollback depends on it.
- **No credential passes through Claude.** DB URLs and service-role keys live only in the operator's gitignored `.env.cutover`. Agents write and review scripts; the operator runs them.
- **Order is fixed: freeze → dump DB → wipe/restore CHANG → copy storage last.** Never copy storage before the final DB dump (broken-image hazard from the dry-run report).
- **Every script that writes refuses to run unless its target is CHANG** (ref `kntspldhvcjeaubtqtkn`), and nothing writes to Tokyo except the freeze/unfreeze scripts.
- **Schedule the window outside these times (Asia/Bangkok):** 09:00 and 18:00 (cron pushes, 02:00 / 11:00 UTC) and the crew's working hours. Recommended: after 22:00 Bangkok.
- Tokyo project ref `yyzbgdmgyvvypfcjuhtr`; CHANG project ref `kntspldhvcjeaubtqtkn`.
- Existing test command `npm test` (301 tests) must still pass after any code change.
- Do not apply the LINE-privacy plan's migration until cutover is finished; it is applied to CHANG afterwards (see Task 7).

## Landmines found beyond the dry run (all must be handled)

| # | Where | Problem | Handled in |
|---|---|---|---|
| 1 | DB function `public.notify_worker_offboarded` | Hardcodes the Tokyo URL. The dump copies it unchanged (confirmed: on CHANG it already points to Tokyo), so a worker being deactivated would call Tokyo's function. | Task 2 `restore-chang.sh` rewrites it |
| 2 | `public.tenants.logo_url` (1 row) | Stores a full Tokyo storage URL; after the move the logo would load from the frozen Tokyo project. | Task 2 `restore-chang.sh` rewrites it |
| 3 | 3 `pg_cron` jobs | Hardcode Tokyo URLs; `cron` schema is not dumped. | Task 2 `schedule-cron-chang.sh` |
| 4 | Sessions | CHANG has a different JWT secret, so every logged-in user is signed out and must log in again (passwords carry over). | Task 6 announcement |
| 5 | Installed PWAs | Old app bundles keep calling Tokyo until updated (`registerType: 'prompt'`). | Tokyo stays frozen; Task 6/7 |
| 6 | Dashboard-only settings | Auth redirect allowlist, Site URL, email templates, SMTP are not in any dump; an empty allowlist silently breaks password reset for everyone. | Task 4 |
| 7 | Free plan | CHANG is on Free: no backups and projects pause after a week of inactivity. | Task 4 (decision) |
| 8 | `src/pages/Signup.jsx` | Hardcodes the Tokyo URL, but nothing imports the page (dead code; `Login.jsx` has its own signup) and the `signup` function is not deployed on Tokyo. | Task 5 (cleanup only) |

## File Structure

| File | Responsibility |
|---|---|
| `.env.cutover.example` (create) | Template listing the variables the operator fills into the gitignored `.env.cutover`. |
| `.gitignore` (modify) | Ignore `.env.cutover` and `supabase/region-migration/out/`. |
| `supabase/region-migration/scripts/lib.sh` (create) | Shared setup: load env, Docker `pg_dump`/`psql` wrappers, CHANG-only guard, timing helper. |
| `supabase/region-migration/scripts/preflight.sh` (create) | Check Docker and both DB connections. |
| `supabase/region-migration/scripts/freeze.sh` (create) | Make a database read-only / undo it (`tokyo` or `chang`). |
| `supabase/region-migration/scripts/dump-tokyo.sh` (create) | Dump Tokyo. Read-only on Tokyo. |
| `supabase/region-migration/scripts/restore-chang.sh` (create) | Wipe CHANG, restore, rewrite hardcoded URLs. |
| `supabase/region-migration/scripts/copy-storage.mjs` (create) | Copy all storage objects Tokyo → CHANG (wipes CHANG's first). |
| `supabase/region-migration/scripts/schedule-cron-chang.sh` (create) | Create the 3 cron jobs on CHANG with CHANG URLs. |
| `supabase/region-migration/scripts/verify.sh` (create) | Compare Tokyo and CHANG: row counts, policies, grants, storage, leftover Tokyo URLs. |
| `supabase/region-migration/REHEARSAL-LOG.md` (create) | Timings and findings from each rehearsal. |
| `src/pages/Signup.jsx` (delete) | Dead code carrying a Tokyo URL. |

---

### Task 1: Operator setup and preflight

**Files:**
- Create: `.env.cutover.example`, `supabase/region-migration/scripts/lib.sh`, `supabase/region-migration/scripts/preflight.sh`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `lib.sh` exports `OUT` (dir), `TOKYO_REF`, `CHANG_REF`, `pgdump ...`, `psqlc <url> ...`, `require_chang`, `now`. Every later script starts with `source "$(dirname "$0")/lib.sh"`.

- [ ] **Step 1: Ignore secrets and outputs**

Append to `.gitignore`:

```
.env.cutover
supabase/region-migration/out/
```

- [ ] **Step 2: Create the env template**

`.env.cutover.example`:

```bash
# Copy to .env.cutover (gitignored) and fill in. Never paste these into chat.
# DB URLs: Supabase Dashboard -> project -> Connect -> "Session pooler" URI (port 5432),
# with the real database password substituted in.
TOKYO_DB_URL=
CHANG_DB_URL=
# API URLs and service-role keys: Dashboard -> Project Settings -> API
TOKYO_URL=https://yyzbgdmgyvvypfcjuhtr.supabase.co
TOKYO_SERVICE_ROLE_KEY=
CHANG_URL=https://kntspldhvcjeaubtqtkn.supabase.co
CHANG_SERVICE_ROLE_KEY=
```

- [ ] **Step 3: Write `lib.sh`**

```bash
#!/usr/bin/env bash
# Shared setup for the region-cutover scripts. Sourced, not run.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ENV_FILE="$ROOT/.env.cutover"
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE -- copy .env.cutover.example and fill it in"; exit 1; }
set -a; source "$ENV_FILE"; set +a

OUT="$ROOT/supabase/region-migration/out"
mkdir -p "$OUT"
TOKYO_REF=yyzbgdmgyvvypfcjuhtr
CHANG_REF=kntspldhvcjeaubtqtkn
PG_IMAGE=postgres:17

# Docker's CLI is installed but not always on PATH in fresh shells.
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"

pgdump() { docker run --rm -i -v "$OUT":/out "$PG_IMAGE" pg_dump "$@"; }
# usage: psqlc <connection-url> [psql args...]   (PGOPTIONS is passed through if set)
psqlc()  { local url="$1"; shift; docker run --rm -i -v "$OUT":/out -e PGOPTIONS "$PG_IMAGE" psql "$url" "$@"; }
now()    { date +%s; }

# Every writing script calls this first.
require_chang() {
  case "$CHANG_DB_URL" in *"$CHANG_REF"*) ;; *) echo "CHANG_DB_URL does not contain $CHANG_REF -- refusing"; exit 1;; esac
  case "$CHANG_DB_URL" in *"$TOKYO_REF"*) echo "CHANG_DB_URL contains the Tokyo ref -- refusing"; exit 1;; esac
}
```

- [ ] **Step 4: Write `preflight.sh`**

```bash
#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"
docker info >/dev/null 2>&1 || { echo "Docker is not running -- start Docker Desktop"; exit 1; }
require_chang
echo "Tokyo:"; psqlc "$TOKYO_DB_URL" -At -c "select current_database(), version()"
echo "CHANG:"; psqlc "$CHANG_DB_URL" -At -c "select current_database(), version()"
echo "Preflight OK"
```

- [ ] **Step 5: Operator runs it**

The operator copies `.env.cutover.example` to `.env.cutover`, fills it in, then runs `! chmod +x supabase/region-migration/scripts/*.sh && ! ./supabase/region-migration/scripts/preflight.sh`.
Expected: two lines of `postgres | PostgreSQL 17.x ...` then `Preflight OK`. If a connection fails, fix the URL (session pooler, port 5432, correct password) before continuing.

- [ ] **Step 6: Commit**

```bash
git add .gitignore .env.cutover.example supabase/region-migration/scripts/lib.sh supabase/region-migration/scripts/preflight.sh
git commit -m "chore: cutover script scaffolding and preflight"
```

---

### Task 2: Cutover scripts

**Files:**
- Create: `freeze.sh`, `dump-tokyo.sh`, `restore-chang.sh`, `copy-storage.mjs`, `schedule-cron-chang.sh`, `verify.sh` (all in `supabase/region-migration/scripts/`)

**Interfaces:**
- Consumes: Task 1's `lib.sh`.
- Produces: `out/public-schema.sql`, `out/public-data.sql`, `out/auth-data.sql` (from dump); scripts print elapsed seconds for each phase for the rehearsal log.

- [ ] **Step 1: `freeze.sh`**

```bash
#!/usr/bin/env bash
# usage: freeze.sh <tokyo|chang> <on|off>
# 'on' makes every NEW write fail with "cannot execute ... in a read-only
# transaction" (from the app, edge functions, cron, LINE webhook -- all
# of them) and terminates existing connections so nothing keeps writing on
# an old session. 'off' undoes it. Reads and pg_dump keep working.
source "$(dirname "$0")/lib.sh"
which="${1:?tokyo|chang}"; mode="${2:?on|off}"
if [ "$which" = tokyo ]; then url="$TOKYO_DB_URL"; else require_chang; url="$CHANG_DB_URL"; fi
if [ "$mode" = on ]; then
  psqlc "$url" -v ON_ERROR_STOP=1 -c "ALTER DATABASE postgres SET default_transaction_read_only = on;"
  psqlc "$url" -c "select count(pg_terminate_backend(pid)) as terminated from pg_stat_activity where datname = 'postgres' and pid <> pg_backend_pid() and usename not in ('supabase_admin');"
else
  psqlc "$url" -v ON_ERROR_STOP=1 -c "ALTER DATABASE postgres RESET default_transaction_read_only;"
fi
echo "$which freeze: $mode"
```

- [ ] **Step 2: `dump-tokyo.sh`**

```bash
#!/usr/bin/env bash
# Read-only on Tokyo.
source "$(dirname "$0")/lib.sh"
t0=$(now)
pgdump "$TOKYO_DB_URL" --schema=public --schema-only --no-owner -f /out/public-schema.sql
pgdump "$TOKYO_DB_URL" --schema=public --data-only --no-owner -f /out/public-data.sql
# auth: data only (CHANG's auth schema is platform-provisioned). schema_migrations
# is CHANG's own bookkeeping and must not be overwritten.
pgdump "$TOKYO_DB_URL" --schema=auth --data-only --no-owner --exclude-table=auth.schema_migrations -f /out/auth-data.sql
echo "DUMP seconds: $(( $(now) - t0 ))"; ls -l "$OUT"/*.sql
```

- [ ] **Step 3: `restore-chang.sh`**

```bash
#!/usr/bin/env bash
# DESTRUCTIVE on CHANG only: drops and recreates its public schema and
# deletes its auth users, then restores the dump from dump-tokyo.sh.
source "$(dirname "$0")/lib.sh"
require_chang
for f in public-schema public-data auth-data; do [ -s "$OUT/$f.sql" ] || { echo "missing $OUT/$f.sql -- run dump-tokyo.sh"; exit 1; }; done
t0=$(now)

echo "== wipe CHANG"
psqlc "$CHANG_DB_URL" -v ON_ERROR_STOP=1 -c "
  DROP SCHEMA public CASCADE;
  CREATE SCHEMA public;
  GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
  DELETE FROM auth.users;"

echo "== schema"
sed '/^CREATE SCHEMA public;$/d' "$OUT/public-schema.sql" | psqlc "$CHANG_DB_URL" -v ON_ERROR_STOP=1 -q

echo "== data (FK checks off for this session only)"
PGOPTIONS='-c session_replication_role=replica' psqlc "$CHANG_DB_URL" -v ON_ERROR_STOP=1 -q -f /out/public-data.sql
PGOPTIONS='-c session_replication_role=replica' psqlc "$CHANG_DB_URL" -v ON_ERROR_STOP=1 -q -f /out/auth-data.sql

echo "== rewrite hardcoded Tokyo URLs"
# 1. notify_worker_offboarded() carries a Tokyo URL in its body.
psqlc "$CHANG_DB_URL" -At -c "select pg_get_functiondef('public.notify_worker_offboarded'::regproc)" \
  | sed "s/$TOKYO_REF/$CHANG_REF/g" | psqlc "$CHANG_DB_URL" -v ON_ERROR_STOP=1 -q
# 2. tenants.logo_url stores a full storage URL.
psqlc "$CHANG_DB_URL" -v ON_ERROR_STOP=1 -c "UPDATE public.tenants SET logo_url = replace(logo_url, '$TOKYO_REF', '$CHANG_REF') WHERE logo_url LIKE '%$TOKYO_REF%';"

echo "== leftover Tokyo references (must be 0 rows)"
psqlc "$CHANG_DB_URL" -At -c "
select 'function ' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where p.prokind in ('f','p') and n.nspname in ('public','auth','storage') and p.prosrc ilike '%$TOKYO_REF%'
union all select 'cron ' || jobname from cron.job where command ilike '%$TOKYO_REF%'
union all select 'column ' || table_name || '.' || column_name from (
  select c.table_name, c.column_name,
    (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I where %I::text ilike %L', c.table_name, c.column_name, '%$TOKYO_REF%'), false, true, '')))[1]::text::int as n
  from information_schema.columns c join information_schema.tables t on t.table_name = c.table_name and t.table_schema = c.table_schema and t.table_type = 'BASE TABLE'
  where c.table_schema = 'public' and c.data_type in ('text','character varying','jsonb','json')) x where n > 0;"
echo "RESTORE seconds: $(( $(now) - t0 ))"
```

- [ ] **Step 4: `copy-storage.mjs`**

```js
// usage: node copy-storage.mjs   (reads TOKYO_URL/CHANG_URL and service keys from the environment)
// Reads Tokyo, writes CHANG only. Wipes CHANG's objects in each bucket first so the copy is exact.
import { createClient } from '@supabase/supabase-js'

const { TOKYO_URL, TOKYO_SERVICE_ROLE_KEY, CHANG_URL, CHANG_SERVICE_ROLE_KEY } = process.env
if (!TOKYO_URL || !CHANG_URL || !TOKYO_SERVICE_ROLE_KEY || !CHANG_SERVICE_ROLE_KEY) throw new Error('missing env')
if (!CHANG_URL.includes('kntspldhvcjeaubtqtkn') || CHANG_URL === TOKYO_URL) throw new Error('refusing: CHANG_URL is not CHANG')

const tokyo = createClient(TOKYO_URL, TOKYO_SERVICE_ROLE_KEY)
const chang = createClient(CHANG_URL, CHANG_SERVICE_ROLE_KEY)

async function listAll(client, bucket, prefix = '') {
  const out = []
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await client.storage.from(bucket).list(prefix, { limit: 100, offset })
    if (error) throw error
    for (const e of data) {
      const path = prefix ? `${prefix}/${e.name}` : e.name
      if (e.id === null) out.push(...await listAll(client, bucket, path)) // a folder
      else out.push({ path, size: e.metadata?.size ?? 0, type: e.metadata?.mimetype })
    }
    if (data.length < 100) break
  }
  return out
}

const t0 = Date.now()
const { data: buckets, error: bErr } = await tokyo.storage.listBuckets()
if (bErr) throw bErr
let total = 0
for (const b of buckets) {
  const { data: existing } = await chang.storage.getBucket(b.id)
  if (!existing) {
    const { error } = await chang.storage.createBucket(b.id, { public: b.public })
    if (error) throw error
  } else if (existing.public !== b.public) {
    const { error } = await chang.storage.updateBucket(b.id, { public: b.public })
    if (error) throw error
  }
  const old = await listAll(chang, b.id)
  for (let i = 0; i < old.length; i += 100) {
    const { error } = await chang.storage.from(b.id).remove(old.slice(i, i + 100).map((o) => o.path))
    if (error) throw error
  }
  const objs = await listAll(tokyo, b.id)
  for (const o of objs) {
    const { data: blob, error: dErr } = await tokyo.storage.from(b.id).download(o.path)
    if (dErr) throw new Error(`download ${b.id}/${o.path}: ${dErr.message}`)
    const { error: uErr } = await chang.storage.from(b.id).upload(o.path, blob, { contentType: o.type, upsert: true })
    if (uErr) throw new Error(`upload ${b.id}/${o.path}: ${uErr.message}`)
  }
  const after = await listAll(chang, b.id)
  const ok = after.length === objs.length && after.reduce((s, o) => s + o.size, 0) === objs.reduce((s, o) => s + o.size, 0)
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${b.id}: tokyo=${objs.length} chang=${after.length}`)
  if (!ok) process.exitCode = 1
  total += objs.length
}
console.log(`STORAGE objects=${total} seconds=${Math.round((Date.now() - t0) / 1000)}`)
```

Run it with the env loaded: `set -a; source .env.cutover; set +a; node supabase/region-migration/scripts/copy-storage.mjs`.

- [ ] **Step 5: `schedule-cron-chang.sh`**

```bash
#!/usr/bin/env bash
# Creates the 3 production cron jobs on CHANG with CHANG URLs. The Vault
# secrets already exist on CHANG from the dry run (cron-vault-report.md); they
# are internal shared secrets, not copied from Tokyo, so nothing to carry over.
source "$(dirname "$0")/lib.sh"
require_chang
psqlc "$CHANG_DB_URL" -At -c "select count(*) from vault.decrypted_secrets where name in ('line_push_cron_auth_key','line_push_cron_shared_secret')" | grep -qx 2 \
  || { echo "Vault secrets missing on CHANG -- run the create_secret lines of supabase/region-migration/create-cron-vault-chang.sql first"; exit 1; }
job() { # name schedule
  psqlc "$CHANG_DB_URL" -v ON_ERROR_STOP=1 -c "select cron.schedule('$1', '$2', \$\$
    select net.http_post(
      url := '$CHANG_URL/functions/v1/$1',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_auth_key'),
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_shared_secret'),
        'Content-Type', 'application/json'))
    \$\$);"
}
job line-push-quotation-followups '0 2 * * *'
job line-push-cheque-reminders    '0 2 * * *'
job line-push-invoice-due         '0 2 1 * *'
psqlc "$CHANG_DB_URL" -c "select jobname, schedule, active from cron.job order by jobname;"
```

- [ ] **Step 6: `verify.sh`**

```bash
#!/usr/bin/env bash
# Compares Tokyo and CHANG. Prints DIFF lines; exit code 1 if any.
source "$(dirname "$0")/lib.sh"
rc=0
q() { psqlc "$1" -At -c "$2"; }
cmp() { # label query
  diff <(q "$TOKYO_DB_URL" "$2") <(q "$CHANG_DB_URL" "$2") >"$OUT/diff.txt" && echo "OK   $1" || { echo "DIFF $1"; sed 's/^/     /' "$OUT/diff.txt" | head -20; rc=1; }
}
cmp "row counts (public+auth)" "select table_schema||'.'||table_name||' '||(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', table_schema, table_name), false, true, '')))[1]::text from information_schema.tables where table_schema in ('public','auth') and table_type='BASE TABLE' and table_name not in ('schema_migrations') order by 1"
cmp "RLS policies"            "select schemaname||'.'||tablename||' '||policyname from pg_policies where schemaname in ('public','storage') order by 1"
cmp "table grants (public)"   "select table_name||' '||grantee||' '||privilege_type from information_schema.role_table_grants where table_schema='public' and grantee in ('anon','authenticated','service_role') order by 1"
cmp "functions (public)"      "select p.proname||' '||md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind in ('f','p') order by 1"
cmp "storage objects/bucket"  "select bucket_id||' '||count(*)||' '||coalesce(sum((metadata->>'size')::bigint),0) from storage.objects group by bucket_id order by 1"
cmp "buckets (public flag)"   "select id||' '||public from storage.buckets order by 1"
echo "-- leftover Tokyo URLs on CHANG (functions/cron) --"
q "$CHANG_DB_URL" "select 'function '||p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.prokind in ('f','p') and n.nspname in ('public','auth','storage') and p.prosrc ilike '%$TOKYO_REF%' union all select 'cron '||jobname from cron.job where command ilike '%$TOKYO_REF%'"
exit $rc
```

(Function-body hashes will legitimately differ for `notify_worker_offboarded`, because its URL was rewritten. Treat exactly that one line as expected.)

- [ ] **Step 7: Syntax-check and commit**

Run: `for f in supabase/region-migration/scripts/*.sh; do bash -n "$f" && echo "ok $f"; done && node --check supabase/region-migration/scripts/copy-storage.mjs && echo ok mjs`
Expected: `ok` for every file.

```bash
git add supabase/region-migration/scripts
git commit -m "feat: committed, repeatable Tokyo-to-CHANG cutover scripts"
```

---

### Task 3: Rehearsal on CHANG (operator runs; produces the timings)

**Files:**
- Create: `supabase/region-migration/REHEARSAL-LOG.md`

This is a full dress rehearsal of the scripts against the real Tokyo data. It overwrites CHANG, which is safe because CHANG is not live. It is also where the untested assumptions in Task 2 (schema-drop grants, `auth` delete, `session_replication_role`, freeze effect) get proven or fixed.

- [ ] **Step 1: Run the full sequence and time each phase**

The operator runs, in order, each as `! ./supabase/region-migration/scripts/<name>`:
`preflight.sh` → `dump-tokyo.sh` → `restore-chang.sh` → (storage) `set -a; source .env.cutover; set +a; node supabase/region-migration/scripts/copy-storage.mjs` → `verify.sh`.
Note the printed `DUMP seconds`, `RESTORE seconds`, `STORAGE ... seconds`.
Expected: `restore-chang.sh` ends with an empty "leftover Tokyo references" list; `copy-storage.mjs` prints `OK` for every bucket; `verify.sh` shows `OK` on every line except the one expected `notify_worker_offboarded` hash line. Fix any script that fails (an agent can edit scripts from the error output; commit each fix) and rerun from the failing step. If a re-dump is needed because Tokyo changed, rerun `dump-tokyo.sh` too.

- [ ] **Step 2: Prove the freeze actually blocks writes (on CHANG)**

Run `! ./supabase/region-migration/scripts/freeze.sh chang on`. Then try a write through the real API path, using CHANG's service role from the operator's shell:
`set -a; source .env.cutover; set +a; curl -s -X POST "$CHANG_URL/rest/v1/app_settings" -H "apikey: $CHANG_SERVICE_ROLE_KEY" -H "Authorization: Bearer $CHANG_SERVICE_ROLE_KEY" -H "Content-Type: application/json" -d '{"key":"freeze_probe","value":"x"}'`
Expected: a JSON error mentioning `read-only transaction`. (If `app_settings` needs other required columns, use any table; the point is that a write is rejected.) Then run `freeze.sh chang off` and repeat the curl — expect success, then delete the probe row.
If the write is **not** rejected (e.g. the pooler keeps old connections writable), the freeze design is wrong: stop and ask for a different freeze mechanism before ever freezing Tokyo.

- [ ] **Step 3: Smoke test the restored copy through the real app**

On the operator's machine run the app against CHANG: `VITE_SUPABASE_URL=<CHANG_URL> VITE_SUPABASE_ANON_KEY=<CHANG anon key> npm run dev` (the anon key is public; it comes from the Dashboard or `get_publishable_keys`). Log in with a real account, open Dashboard, Invoices, an image (storage), and Settings. Expected: data and images load. (A password-reset email needs Task 4 first.)

- [ ] **Step 4: Record and commit**

Write `supabase/region-migration/REHEARSAL-LOG.md` with: date, seconds for dump/restore/storage/verify, total, anything that needed fixing, and a one-line **write-freeze window estimate** = dump + restore + storage + functions deploy (~minutes, measured) + a 30-minute margin for the manual flips in Task 6.

```bash
git add supabase/region-migration/REHEARSAL-LOG.md supabase/region-migration/scripts
git commit -m "docs: cutover rehearsal log with measured timings"
```

---

### Task 4: CHANG project configuration and plan decision (operator, Dashboard)

These live only in the Supabase Dashboard and are not carried by any dump. Do them on CHANG, copying each value from Tokyo's Dashboard:

- [ ] **Step 1: Authentication → URL Configuration:** Site URL = `https://pm.facadex.co.th`; Redirect URLs = the same list as Tokyo (an empty list silently breaks password reset and email confirmation for everyone).
- [ ] **Step 2: Authentication → Email Templates, SMTP (Resend), Providers, and Sign In/Up settings:** match Tokyo (confirm-email toggle, password rules, JWT expiry, rate limits).
- [ ] **Step 3: Project Settings → API:** exposed schemas and `max_rows` match Tokyo. Storage global file-size limit matches.
- [ ] **Step 4: Verify** by requesting a password reset for a test user against the rehearsal app from Task 3 Step 3; the email must arrive and its link must open the app.
- [ ] **Step 5: Decide the plan tier (the owner decides, not the agent).** CHANG is on Free: no automatic backups, and the project pauses after a week of inactivity. Production data on that tier has no restore point. Recommendation: upgrade CHANG to Pro before it goes live. If the owner chooses to stay on Free for now, record that decision and the risk in `REHEARSAL-LOG.md`.

---

### Task 5: Code and pipeline readiness

**Files:**
- Delete: `src/pages/Signup.jsx`

- [ ] **Step 1: Remove the dead Signup page**

Confirm nothing imports it: `grep -rn "pages/Signup\|Signup.jsx" src` (expect no results). Then `git rm src/pages/Signup.jsx`.

- [ ] **Step 2: Verify**

Run: `npm test && npx vite build 2>&1 | tail -2`
Expected: all pass, build succeeds.

- [ ] **Step 3: Confirm the deploy pipeline is healthy before relying on it**

The frontend deploy goes GitHub Actions → `deploy` branch → cPanel's own pull step, which has failed before. Push one trivial commit (this cleanup) and confirm in the live app's Settings page that the version number changed. If the cPanel step does not pick it up, fix that **before** scheduling the cutover; the plan's fallback is to build locally with CHANG's URL/anon key and upload a zip (the project's established method; save it in the main project folder).

- [ ] **Step 4: Record rollback values and commit**

Write Tokyo's current frontend values (`VITE_SUPABASE_URL`; the anon key is public) into `REHEARSAL-LOG.md` under "Rollback values", so reverting the GitHub secrets is a copy-paste. Commit:

```bash
git add -A src/pages supabase/region-migration/REHEARSAL-LOG.md
git commit -m "chore: remove dead Signup page, record rollback values"
```

---

### Task 6: Cutover day (operator runs; an agent can assist with the non-secret commands)

**Preconditions (all true before starting):** Task 3 rehearsal passed with timings logged; Task 4 done and tier decided; Task 5 pipeline confirmed; all 5 secrets exist on CHANG (done); staff warned they will be asked to log in again and the system will be unavailable for the estimated window; the window is outside the Bangkok 09:00 and 18:00 cron times and crew hours.

**Go/no-go checkpoints are marked ⛔. At any ⛔, if a check fails, run Rollback A and stop.**

- [ ] **Step 1: Freeze Tokyo.** `! ./supabase/region-migration/scripts/freeze.sh tokyo on` — expected `tokyo freeze: on`. Writes everywhere now fail by design. Note the time.
- [ ] **Step 2: Dump.** `! ./supabase/region-migration/scripts/dump-tokyo.sh`
- [ ] **Step 3: Wipe and restore CHANG.** `! ./supabase/region-migration/scripts/restore-chang.sh` — ⛔ the "leftover Tokyo references" list must be empty.
- [ ] **Step 4: Copy storage (last).** `set -a; source .env.cutover; set +a; node supabase/region-migration/scripts/copy-storage.mjs` — ⛔ every bucket prints `OK`.
- [ ] **Step 5: Deploy all edge functions from `main` to CHANG** (agent can run this; no secrets involved). CHANG's copies are from 1 Oct and are stale. For each function directory in `supabase/functions` except `_shared`, run `npx supabase functions deploy <slug> --project-ref kntspldhvcjeaubtqtkn` adding `--no-verify-jwt` for exactly `omise-webhook`, `sign-link`, `line-webhook`, `field-form`. Then `npx supabase functions list --project-ref kntspldhvcjeaubtqtkn` — ⛔ every function `ACTIVE` with `verify_jwt` matching Tokyo's list. (`signup` and `create-user` exist in the repo but are not deployed on Tokyo; do not deploy them unless Tokyo has them.)
- [ ] **Step 6: Schedule cron on CHANG.** `! ./supabase/region-migration/scripts/schedule-cron-chang.sh` — expect 3 active jobs listed.
- [ ] **Step 7: Verify the copy.** `! ./supabase/region-migration/scripts/verify.sh` — ⛔ every line `OK` except the single expected `notify_worker_offboarded` hash line.
- [ ] **Step 8: Smoke test on CHANG before flipping anyone.** Run the app locally against CHANG as in Task 3 Step 3: log in, open data and an image. ⛔ must work.
- [ ] **Step 9: Flip the frontend.** Set the GitHub repository secrets `VITE_SUPABASE_URL` (CHANG URL) and `VITE_SUPABASE_ANON_KEY` (CHANG anon key) — `gh secret set` run by the operator — then trigger a build (push any commit, or re-run the deploy workflow). Confirm the new version is live in Settings and the browser's network tab calls `kntspldhvcjeaubtqtkn.supabase.co`.
- [ ] **Step 10: Flip LINE.** In the LINE Developers Console set the webhook URL to `https://kntspldhvcjeaubtqtkn.supabase.co/functions/v1/line-webhook`, press Verify, and send a test message to the bot. ⛔ Verify must succeed.
- [ ] **Step 11: Flip Omise.** In the Omise dashboard set the webhook endpoint to `https://kntspldhvcjeaubtqtkn.supabase.co/functions/v1/omise-webhook`.
- [ ] **Step 12: Live checks.** Log in as a real user; create and delete a throwaway record; send `งานวันนี้` to the bot from a linked worker; open a tenant logo; trigger one cron function manually using the cron secret (or wait for the next scheduled run) and confirm it authenticates.
- [ ] **Step 13: Leave Tokyo frozen.** Do not unfreeze and do not pause yet. Frozen Tokyo makes any stale client fail loudly rather than write data that would be lost. Tell staff to refresh the app if they see errors.
- [ ] **Step 14: Record.** Append the real timings and any surprises to `REHEARSAL-LOG.md` and commit.

**Rollback A (before Step 9, i.e. before any user reaches CHANG):** `! ./supabase/region-migration/scripts/freeze.sh tokyo off`. Nothing else changed for users; CHANG is simply discarded. Total user impact: the freeze period.

**Rollback B (after Step 9, before CHANG has meaningful new data):** revert the two GitHub secrets to the logged Tokyo values and redeploy the frontend; set the LINE and Omise webhook URLs back to Tokyo; `freeze.sh tokyo off`. Writes made on CHANG since the flip are lost, so only use this inside the first hour and say so to staff.

**After meaningful writes on CHANG, do not roll back** (it would discard real data). Fix forward instead.

---

### Task 7: After cutover

- [ ] **Step 1: Watch for 48 hours.** Check edge function logs on CHANG for errors, confirm the next scheduled cron runs fire, confirm staff can log in, and that password reset works.
- [ ] **Step 2: Re-link the Supabase CLI to CHANG** (`supabase/.temp/linked-project.json` still points at Tokyo): `npx supabase link --project-ref kntspldhvcjeaubtqtkn`, and update any memory/notes that name the live project id.
- [ ] **Step 3: Apply the LINE hybrid-privacy plan to CHANG** (`docs/superpowers/plans/2026-10-02-line-hybrid-privacy.md`, Task 8 Step 3). It was deliberately held until now.
- [ ] **Step 4: Pause Tokyo** (not delete) after the 48-hour watch, once no client has called it. Keep it paused for at least 30 days as the rollback copy.
- [ ] **Step 5: Revisit the Pro upgrade** if it was deferred in Task 4.
