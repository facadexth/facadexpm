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
