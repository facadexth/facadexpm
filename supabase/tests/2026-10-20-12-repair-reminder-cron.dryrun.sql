-- Dry-run for 2026-10-20-12-repair-reminder-cron.sql. Runs the migration twice (idempotency) inside a
-- transaction, checks the job row, then rolls back. Uses cron.unschedule only, no row-removal SQL keyword (the SQL tool rejects it).
BEGIN;

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

-- Second run: must replace, not duplicate.
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

DO $t$
DECLARE
  n int;
  cmd text;
BEGIN
  SELECT count(*) INTO n FROM cron.job WHERE jobname = 'repair-reminders' AND schedule = '0 6 * * *';
  IF n <> 1 THEN RAISE EXCEPTION 'a: expected exactly 1 repair-reminders job at 0 6 * * *, got %', n; END IF;
  SELECT command INTO cmd FROM cron.job WHERE jobname = 'repair-reminders';
  IF position('/functions/v1/repair-push' in cmd) = 0 THEN RAISE EXCEPTION 'b: wrong url'; END IF;
  IF position('"action":"reminders"' in cmd) = 0 THEN RAISE EXCEPTION 'c: missing body'; END IF;
  IF position('line_push_cron_shared_secret' in cmd) = 0 THEN RAISE EXCEPTION 'd: missing x-cron-secret'; END IF;
END
$t$;

SELECT 'ALL PASS' AS result;
ROLLBACK;
