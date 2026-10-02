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
  DELETE FROM auth.users;
  -- Tokyo (and CHANG) install pg_net in schema public, so DROP SCHEMA public CASCADE
  -- removes it. net.http_post() is called by the cron jobs and notify_worker_offboarded().
  CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA public;"

echo "== schema"
# Drop two things the postgres role cannot / need not replay: the CREATE SCHEMA we already did,
# and default privileges FOR ROLE supabase_admin (objects here are owned by postgres on CHANG).
sed -e '/^CREATE SCHEMA public;$/d' -e '/^ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin /d' "$OUT/public-schema.sql" | psqlc "$CHANG_DB_URL" -v ON_ERROR_STOP=1 -q

echo "== data (auth first: public.tenants -> auth.users; FK checks off for each stream's session only)"
# PGOPTIONS is ignored by the pooler, so the SET goes in the stream itself.
{ echo "SET session_replication_role = replica;"; cat "$OUT/auth-data.sql"; }   | psqlc "$CHANG_DB_URL" -v ON_ERROR_STOP=1 -q
{ echo "SET session_replication_role = replica;"; cat "$OUT/public-data.sql"; } | psqlc "$CHANG_DB_URL" -v ON_ERROR_STOP=1 -q

echo "== recreate the app's triggers on auth.users (not part of a public-schema dump; created AFTER the data load so they do not fire on it)"
psqlc "$CHANG_DB_URL" -v ON_ERROR_STOP=1 -c "
  DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
  CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
  DROP TRIGGER IF EXISTS on_auth_user_deleted ON auth.users;
  CREATE TRIGGER on_auth_user_deleted AFTER DELETE ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_auth_user_deleted();"

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
