-- supabase/migrations/2026-10-03-03-line-admin-chat-expire-cron-5min.sql
-- With a 30 minute idle limit and a warning 10 minutes before it, the expiry job
-- must run more often than every 15 minutes. cron.schedule() with an existing
-- job name replaces that job's schedule.
select cron.schedule(
  'line-admin-chat-expire', '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://kntspldhvcjeaubtqtkn.supabase.co/functions/v1/line-admin-chat-expire',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_auth_key'),
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_shared_secret'),
      'Content-Type', 'application/json'
    )
  )
  $$
);
