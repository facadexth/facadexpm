-- 2026-10-22: a stale browser list once saved demo-tenant workers into FacadeX
-- assignments. Reject any assignment whose worker or site belongs to another tenant.
create or replace function public.guard_assignment_same_tenant()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from workers where id = new.worker_id and tenant_id = new.tenant_id) then
    raise exception 'คนงานไม่ได้อยู่ในบริษัทนี้ กรุณารีเฟรชหน้าแล้วลองใหม่';
  end if;
  if new.site_id is not null
     and not exists (select 1 from sites where id = new.site_id and tenant_id = new.tenant_id) then
    raise exception 'ไซท์ไม่ได้อยู่ในบริษัทนี้ กรุณารีเฟรชหน้าแล้วลองใหม่';
  end if;
  return new;
end $$;
revoke all on function public.guard_assignment_same_tenant() from public, anon, authenticated;

drop trigger if exists trg_assignment_same_tenant on public.worker_assignments;
create trigger trg_assignment_same_tenant
  before insert or update of worker_id, site_id, tenant_id on public.worker_assignments
  for each row execute function public.guard_assignment_same_tenant();
