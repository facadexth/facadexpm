-- supabase/migrations/2026-09-19-02-line-push-cron.sql
--
-- Supabase Cron wiring for Task 4's four scheduled LINE push Edge
-- Functions. Requires pg_cron and pg_net -- verified NOT enabled on
-- this project before this migration (select * from pg_extension
-- where extname in ('pg_cron','pg_net') returned zero rows), so both
-- are enabled by a companion migration
-- (2026-09-19-03-enable-pg-cron-pg-net.sql, applied first) before this
-- file's cron.schedule() calls run.
--
-- CRITICAL FIX (post-review): the Authorization bearer below (the
-- anon/publishable JWT) is NOT sufficient access control by itself --
-- verify_jwt on the target functions only checks JWT signature
-- validity, not role, and the anon key is intentionally public (ships
-- in the client bundle). Anyone holding it could otherwise call any of
-- these four functions directly, any time, bypassing this schedule
-- entirely -- against the real tenant's real crew LINE group / real
-- linked OWNER. The `x-cron-secret` header added below is the REAL
-- access control: each function verifies it via
-- public.verify_cron_secret() (see
-- 2026-09-19-04-line-push-cron-secret-verify-fn.sql) BEFORE running
-- any business-logic query or LINE push, and rejects with 401
-- immediately if it's missing or wrong. The Authorization header is
-- kept only because it's still needed to pass verify_jwt itself.
--
-- Auth secret: this project has no prior cron/net.http_post convention
-- to follow (grepped every migration for cron.schedule/vault.create_secret/
-- net.http_post -- zero matches before this file). The brief's own
-- suggestion -- a Postgres Vault secret referenced by name, not a
-- literal key inline -- is followed here, BUT the value stored is the
-- project's anon/publishable JWT, not the true service-role key: no
-- tool available in this session can retrieve the real service-role
-- key's plaintext (checked: get_publishable_keys only returns
-- anon/publishable keys; no execute_sql/current_setting exposes it
-- either -- `current_setting('app.settings.service_role_key', true)`
-- returned NULL). This is safe because:
--   1. Supabase's verify_jwt gateway check (which every one of these
--      four functions has ON) only validates that the bearer is a
--      validly-signed JWT for this project -- it does not check the
--      JWT's role claim. Verified live: POSTing to
--      line-push-daily-assignments with this exact anon key in the
--      Authorization header returned 200, not 401.
--   2. None of these four functions use the CALLER's JWT for anything.
--      Each builds its own `admin` Supabase client from its own
--      SUPABASE_SERVICE_ROLE_KEY environment variable (auto-provisioned
--      per Edge Function by Supabase itself, not something this
--      migration or its caller ever needs to supply) and does all
--      reads/writes/pushes through that -- confirmed working end-to-end
--      in Task 4's live verification (quotations.follow_up_sent_at was
--      successfully written back using this same anon-key bearer).
-- So the cron job's bearer token only ever needs to pass the gateway
-- check, never needs write privilege of its own. If a real
-- service-role key is available later, swap the vault secret's value
-- (`select vault.update_secret(id, new_value) ...`) -- no change to
-- this file or the cron jobs themselves is needed either way, since
-- both are referenced by the secret's name, not its value.
select cron.schedule(
  'line-push-daily-assignments', '0 11 * * *',  -- 18:00 Asia/Bangkok = 11:00 UTC
  $$
  select net.http_post(
    url := 'https://yyzbgdmgyvvypfcjuhtr.supabase.co/functions/v1/line-push-daily-assignments',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_auth_key'),
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_shared_secret'),
      'Content-Type', 'application/json'
    )
  )
  $$
);

select cron.schedule(
  'line-push-quotation-followups', '0 2 * * *',  -- 09:00 Asia/Bangkok
  $$
  select net.http_post(
    url := 'https://yyzbgdmgyvvypfcjuhtr.supabase.co/functions/v1/line-push-quotation-followups',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_auth_key'),
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_shared_secret'),
      'Content-Type', 'application/json'
    )
  )
  $$
);

select cron.schedule(
  'line-push-cheque-reminders', '0 2 * * *',  -- 09:00 Asia/Bangkok
  $$
  select net.http_post(
    url := 'https://yyzbgdmgyvvypfcjuhtr.supabase.co/functions/v1/line-push-cheque-reminders',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_auth_key'),
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_shared_secret'),
      'Content-Type', 'application/json'
    )
  )
  $$
);

select cron.schedule(
  'line-push-invoice-due', '0 2 1 * *',  -- 1st of each month, 09:00 Asia/Bangkok
  $$
  select net.http_post(
    url := 'https://yyzbgdmgyvvypfcjuhtr.supabase.co/functions/v1/line-push-invoice-due',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_auth_key'),
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_shared_secret'),
      'Content-Type', 'application/json'
    )
  )
  $$
);
