-- Hotfix: sites.admin_updates and user_roles.owner_updates looked up the old row with
-- EXISTS (SELECT ... FROM <same table> old ...). Postgres refuses a policy that reads its
-- own table ("42P17 infinite recursion detected in policy for relation"), so every
-- UPDATE on sites and user_roles from the app failed (owner report 2026-10-17: editing a
-- site -> error). Present since 2026-08-30-01 / 2026-08-29-15. The old-row lookups move
-- into SECURITY DEFINER helpers (read as owner, no RLS) scoped to the caller's tenant.
BEGIN;

CREATE OR REPLACE FUNCTION public.site_was_ongoing(p_site_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM sites WHERE id = p_site_id AND status = 'Ongoing' AND tenant_id = current_tenant_id()) $$;

CREATE OR REPLACE FUNCTION public.user_role_held_admin_seat(p_role_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM user_roles WHERE id = p_role_id AND role IN ('OWNER','ADMIN') AND tenant_id = current_tenant_id()) $$;

REVOKE ALL ON FUNCTION public.site_was_ongoing(uuid), public.user_role_held_admin_seat(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.site_was_ongoing(uuid), public.user_role_held_admin_seat(uuid) TO authenticated;

ALTER POLICY admin_updates ON public.sites
  USING (((SELECT is_admin_or_owner()) AND (tenant_id = (SELECT current_tenant_id())) AND (SELECT tenant_can_write())))
  WITH CHECK (((SELECT is_admin_or_owner()) AND (tenant_id = (SELECT current_tenant_id())) AND (SELECT tenant_can_write())
    AND ((status IS DISTINCT FROM 'Ongoing'::text) OR site_was_ongoing(id) OR tenant_under_seat_limit('sites'::text))));

ALTER POLICY owner_updates ON public.user_roles
  USING (((SELECT is_owner()) AND (tenant_id = (SELECT current_tenant_id())) AND (SELECT tenant_can_write())))
  WITH CHECK (((SELECT is_owner()) AND (tenant_id = (SELECT current_tenant_id())) AND (SELECT tenant_can_write())
    AND ((role <> ALL (ARRAY['OWNER'::text, 'ADMIN'::text])) OR user_role_held_admin_seat(id) OR tenant_under_seat_limit('admins'::text))));

COMMIT;
