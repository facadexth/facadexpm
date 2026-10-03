#!/usr/bin/env bash
# Rewrites TOKYO_DB_URL / CHANG_DB_URL in .env.cutover from the IPv6-only
# "direct" form (db.<ref>.supabase.co) to the IPv4-capable Session pooler,
# by trying the two host styles Supabase uses and keeping the one that
# connects. Never prints the password. Keeps a backup at .env.cutover.bak.
source "$(dirname "$0")/lib.sh"

update_env() { # VAR value
  local tmp; tmp=$(mktemp)
  V="$2" awk -v k="$1" 'BEGIN{FS=OFS="="} $1==k {print k "=" ENVIRON["V"]; next} {print}' "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
}

fix() { # VAR ref region
  local var="$1" ref="$2" region="$3" url pw
  url="${!var}"
  case "$url" in
    *"@db.$ref.supabase.co"*) ;;
    *pooler.supabase.com*) echo "$var: already a pooler URL, leaving it"; return 0;;
    *) echo "$var: unrecognised format, leaving it"; return 1;;
  esac
  pw=$(printf '%s' "$url" | sed -E 's#^postgresql://postgres:(.*)@db\.[a-z0-9]+\.supabase\.co:5432/postgres$#\1#')
  for style in aws-0 aws-1; do
    local host="$style-$region.pooler.supabase.com"
    local cand="postgresql://postgres.$ref:$pw@$host:5432/postgres"
    local err
    if err=$(psqlc "$cand" -At -c "select 1" 2>&1 >/dev/null); then
      update_env "$var" "$cand"
      echo "$var: OK via $host"
      return 0
    fi
    # psql's own error text names the host and user, never the password.
    echo "$var: $host did not work -> $(printf '%s' "$err" | tail -n 1 | cut -c1-200)"
  done
  echo "$var: no pooler host worked (wrong password, or a different region?)"
  return 1
}

cp "$ENV_FILE" "$ENV_FILE.bak"
rc=0
fix TOKYO_DB_URL "$TOKYO_REF" ap-northeast-1 || rc=1
fix CHANG_DB_URL "$CHANG_REF" ap-southeast-1 || rc=1
exit $rc
