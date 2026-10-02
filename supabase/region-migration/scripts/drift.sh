#!/usr/bin/env bash
# usage: drift.sh snapshot | check
# Tokyo cannot be reliably frozen (PostgREST opens its own READ WRITE
# transactions, so default_transaction_read_only does not stop app writes --
# proven on 2026-10-03). Instead we DETECT writes: Postgres keeps
# cumulative insert/update/delete counters per table. `snapshot` records
# them before the dump; `check` compares right before the flip. If any
# counter moved, rows were written after the dump started and the dump is
# stale: dump and restore again. Read-only on Tokyo.
source "$(dirname "$0")/lib.sh"
SNAP="$OUT/tokyo-write-counters.txt"

counters() {
  sleep 3  # stats are flushed to the shared view up to ~1s after a write
  psqlc "$TOKYO_DB_URL" -At -c "
    select schemaname||'.'||relname||' ins='||n_tup_ins||' upd='||n_tup_upd||' del='||n_tup_del
      from pg_stat_user_tables where schemaname = 'public'
    union all
    -- auth.users: sign-ins touch last_sign_in_at (updates), so only count NEW and DELETED users
    select 'auth.users ins='||n_tup_ins||' del='||n_tup_del
      from pg_stat_user_tables where schemaname = 'auth' and relname = 'users'
    order by 1"
}

case "${1:-}" in
  snapshot) counters > "$SNAP"; echo "write-counter snapshot saved ($(wc -l < "$SNAP" | tr -d ' ') tables) at $(date '+%H:%M:%S')";;
  check)
    [ -s "$SNAP" ] || { echo "no snapshot -- run: drift.sh snapshot (it runs automatically at the start of dump-tokyo.sh)"; exit 2; }
    counters > "$OUT/tokyo-write-counters.now"
    if diff "$SNAP" "$OUT/tokyo-write-counters.now" > "$OUT/drift.diff"; then
      echo "NO WRITES on Tokyo since the snapshot -- the dump is current."
    else
      echo "WRITES HAPPENED on Tokyo since the snapshot -- the dump is STALE. Changed tables:"
      grep '^>' "$OUT/drift.diff" | sed 's/^> /   /'
      echo "Re-run dump-tokyo.sh and restore-chang.sh (and copy-storage), then check again."
      exit 1
    fi;;
  *) echo "usage: drift.sh snapshot|check"; exit 2;;
esac
