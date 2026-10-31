-- 2026-10-20-12: daily repair-appointment reminder. 06:00 UTC = 13:00 Bangkok; repair-push reminds customers
-- about tickets scheduled for Bangkok tomorrow. Apply AFTER the repair-push edge function is deployed.
-- Idempotent: drops an existing 'repair-reminders' job first. Header pattern copied from
-- supabase/region-migration/create-cron-vault-chang.sql (Vault auth key + shared x-cron-secret).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'repair-reminders') THEN
    PERFORM cron.unschedule('repair-reminders');
  END IF;
END
$$;

select cron.schedule(
  'repair-reminders',
  '0 6 * * *',
  $$
  select net.http_post(
    url := 'https://kntspldhvcjeaubtqtkn.supabase.co/functions/v1/repair-push',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_auth_key'),
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_shared_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{"action":"reminders"}'::jsonb
  )
  $$
);
