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
