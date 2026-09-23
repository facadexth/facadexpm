-- supabase/migrations/2026-09-23-03-worker-offboarded-trigger.sql
--
-- Wires up the proactive half of line-worker-offboarded (deployed since
-- this session's earlier work but never actually called automatically
-- -- only line-webhook's own REACTIVE fallback alert fired, and only
-- once the offboarded worker happened to message the bot again). Fires
-- the moment an admin actually flips a worker's status to 'inactive',
-- instead of waiting on that.
--
-- Same net.http_post + Vault-secret pattern as the four line-push-*
-- cron jobs (see 2026-09-19-02-line-push-cron.sql's own header comment
-- for the full rationale on why a Vault secret rather than a literal
-- key) -- SECURITY DEFINER so the trigger function can read
-- vault.decrypted_secrets (not otherwise readable by the authenticated
-- role a normal admin UPDATE runs as), EXECUTE not granted to anyone,
-- only ever invoked by the trigger itself.
create or replace function public.notify_worker_offboarded()
returns trigger
language plpgsql
security definer
set search_path = public, vault
as $$
begin
  -- Only the actual active->inactive transition, not every update to an
  -- already-inactive row (editing an inactive worker's other fields --
  -- salary, position -- must not re-fire this every time) and not the
  -- reverse (reactivating someone needs no alert).
  if new.status = 'inactive' and old.status is distinct from 'inactive' then
    perform net.http_post(
      url := 'https://yyzbgdmgyvvypfcjuhtr.supabase.co/functions/v1/line-worker-offboarded',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_auth_key'),
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_shared_secret'),
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object('worker_id', new.id)
    );
  end if;
  return new;
end;
$$;

revoke all on function public.notify_worker_offboarded() from public;
revoke all on function public.notify_worker_offboarded() from anon;
revoke all on function public.notify_worker_offboarded() from authenticated;

drop trigger if exists trg_worker_offboarded on public.workers;
create trigger trg_worker_offboarded
  after update on public.workers
  for each row
  execute function public.notify_worker_offboarded();
