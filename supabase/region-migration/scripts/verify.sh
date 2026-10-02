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
cmp "app triggers on auth.users" "select t.tgname||' '||pg_get_triggerdef(t.oid) from pg_trigger t where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal order by 1"
cmp "storage objects/bucket"  "select bucket_id||' '||count(*)||' '||coalesce(sum((metadata->>'size')::bigint),0) from storage.objects group by bucket_id order by 1"
cmp "buckets (public flag)"   "select id||' '||public from storage.buckets order by 1"
echo "-- leftover Tokyo URLs on CHANG (functions/cron) --"
q "$CHANG_DB_URL" "select 'function '||p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.prokind in ('f','p') and n.nspname in ('public','auth','storage') and p.prosrc ilike '%$TOKYO_REF%' union all select 'cron '||jobname from cron.job where command ilike '%$TOKYO_REF%'"
exit $rc
