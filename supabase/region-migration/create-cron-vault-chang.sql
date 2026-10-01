-- Fresh, randomly-generated internal shared secrets for CHANG. These are
-- self-issued secrets used only between pg_cron and this project's own
-- edge functions -- they do NOT need to match Tokyo's values, and their
-- real values never need to be known by anyone (see
-- docs/superpowers/specs/2026-10-01-supabase-region-migration-design.md,
-- "pg_cron jobs + Vault secrets" section, for why Vault secrets can't be
-- copied cross-project in the first place).
select vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'line_push_cron_auth_key');
select vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'line_push_cron_shared_secret');

select cron.schedule(
  'line-push-quotation-followups',
  '0 2 * * *',
  $$
  select net.http_post(
    url := 'https://kntspldhvcjeaubtqtkn.supabase.co/functions/v1/line-push-quotation-followups',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_auth_key'),
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_shared_secret'),
      'Content-Type', 'application/json'
    )
  )
  $$
);

select cron.schedule(
  'line-push-cheque-reminders',
  '0 2 * * *',
  $$
  select net.http_post(
    url := 'https://kntspldhvcjeaubtqtkn.supabase.co/functions/v1/line-push-cheque-reminders',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_auth_key'),
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_shared_secret'),
      'Content-Type', 'application/json'
    )
  )
  $$
);

select cron.schedule(
  'line-push-invoice-due',
  '0 2 1 * *',
  $$
  select net.http_post(
    url := 'https://kntspldhvcjeaubtqtkn.supabase.co/functions/v1/line-push-invoice-due',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_auth_key'),
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_shared_secret'),
      'Content-Type', 'application/json'
    )
  )
  $$
);
