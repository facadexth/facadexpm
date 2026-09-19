-- supabase/migrations/2026-09-19-04-line-push-cron-secret-verify-fn.sql
--
-- CRITICAL FIX (post-review, Task 4): verify_jwt:true on the four
-- line-push-* Edge Functions was NOT sufficient access control.
-- verify_jwt only checks that the Authorization bearer is a validly-
-- signed JWT for this project -- it does not check the JWT's role
-- claim. The project's anon/publishable key IS such a JWT and is
-- intentionally public (it ships in this app's own client-side
-- bundle), so anyone holding it could previously call any of the four
-- functions directly, on demand, bypassing the cron schedule entirely
-- -- against the REAL tenant's real crew LINE group / real linked
-- OWNER. This migration adds the real access-control layer: a shared
-- secret (stored in Postgres Vault, see
-- 2026-09-19-02-line-push-cron.sql's header comment for why Vault
-- rather than a Supabase-CLI-managed function secret -- no tool in
-- this session's toolset can set Edge Function secrets, same
-- constraint documented there for the service-role key) that pg_cron
-- sends as a custom `x-cron-secret` header, verified by each function
-- BEFORE any business-logic query or LINE push.
--
-- This function is the verification each function's Deno.serve handler
-- calls via `admin.rpc('verify_cron_secret', { provided: header })`.
-- SECURITY DEFINER so it can read vault.decrypted_secrets (not
-- otherwise readable by any non-superuser role), and EXECUTE is
-- granted ONLY to service_role -- not anon, not authenticated -- so
-- this can never be turned into a public brute-force oracle against
-- the secret. Each function's own `admin` Supabase client already
-- authenticates as service_role (built from its own
-- SUPABASE_SERVICE_ROLE_KEY env var), so it can call this regardless.
create or replace function public.verify_cron_secret(provided text)
returns boolean
language sql
security definer
set search_path = public, vault
as $$
  select exists (
    select 1 from vault.decrypted_secrets
    where name = 'line_push_cron_shared_secret'
      and decrypted_secret = provided
  );
$$;

revoke all on function public.verify_cron_secret(text) from public;
revoke all on function public.verify_cron_secret(text) from anon;
revoke all on function public.verify_cron_secret(text) from authenticated;
grant execute on function public.verify_cron_secret(text) to service_role;
