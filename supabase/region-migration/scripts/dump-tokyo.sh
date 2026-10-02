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
