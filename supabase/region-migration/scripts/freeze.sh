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
  # Self-check on a NEW connection: a zero-row UPDATE is a harmless no-op if
  # the freeze failed, but errors with "read-only transaction" if it worked.
  if psqlc "$url" -v ON_ERROR_STOP=1 -c "UPDATE public.app_settings SET value = value WHERE false;" >/dev/null 2>&1; then
    echo "FREEZE NOT EFFECTIVE: a write succeeded after freezing. Run: freeze.sh $which off -- and do NOT continue."
    exit 1
  fi
  echo "freeze probe: write rejected (good)"
else
  psqlc "$url" -v ON_ERROR_STOP=1 -c "ALTER DATABASE postgres RESET default_transaction_read_only;"
fi
echo "$which freeze: $mode"
