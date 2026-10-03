-- supabase/migrations/2026-10-02-05-line-admin-chat-expire-cron.sql
-- Runs the idle-expiry function every 15 minutes. Same auth shape as
-- 2026-09-19-02-line-push-cron.sql. REPLACE https://kntspldhvcjeaubtqtkn.supabase.co with the live
-- project's URL (get_project_url) at apply time -- it is project-specific.
select cron.schedule(
  'line-admin-chat-expire', '*/15 * * * *',
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
