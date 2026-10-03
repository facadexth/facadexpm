#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"
docker info >/dev/null 2>&1 || { echo "Docker is not running -- start Docker Desktop"; exit 1; }
require_chang
echo "Tokyo:"; psqlc "$TOKYO_DB_URL" -At -c "select current_database(), version()"
echo "CHANG:"; psqlc "$CHANG_DB_URL" -At -c "select current_database(), version()"
echo "Preflight OK"
