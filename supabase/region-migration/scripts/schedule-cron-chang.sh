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
