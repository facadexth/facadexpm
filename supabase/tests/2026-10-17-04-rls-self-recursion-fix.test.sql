-- Rolled-back check for 2026-10-17-04-rls-self-recursion-fix.sql. Inlines the migration body; the closing RAISE keeps it from persisting.
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

DO $$
DECLARE v_email text; v_t uuid; v_site uuid; v_ongoing uuid; v_role uuid; r jsonb := '{}'; n int;
BEGIN
  SELECT ur.user_email, ur.tenant_id INTO v_email, v_t FROM user_roles ur JOIN tenants t ON t.id = ur.tenant_id
   WHERE ur.role = 'OWNER' AND t.company_name ILIKE '%สร้างดี%' LIMIT 1;
  SELECT id INTO v_site FROM sites WHERE tenant_id = v_t AND status <> 'Ongoing' LIMIT 1;
  SELECT id INTO v_ongoing FROM sites WHERE tenant_id = v_t AND status = 'Ongoing' LIMIT 1;
  SELECT id INTO v_role FROM user_roles WHERE tenant_id = v_t AND user_email = v_email;
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_email, 'role', 'authenticated', 'sub', gen_random_uuid())::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN UPDATE sites SET notes = coalesce(notes,'') || '' WHERE id = v_site; GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('site_not_ongoing', n);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('site_not_ongoing', SQLSTATE || ' ' || SQLERRM); END;
  BEGIN UPDATE sites SET notes = coalesce(notes,'') || '' WHERE id = v_ongoing; GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('site_ongoing', n);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('site_ongoing', SQLSTATE || ' ' || SQLERRM); END;
  BEGIN UPDATE user_roles SET display_name = display_name WHERE id = v_role; GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('user_role_self', n);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('user_role_self', SQLSTATE || ' ' || SQLERRM); END;
  RAISE EXCEPTION 'RESULT %', r;
END $$;
ROLLBACK;
