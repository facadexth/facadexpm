-- 2026-10-20-07: customer LINE accounts (one LINE user per client) and one-time invite codes.
-- Rows are written only through the SECURITY DEFINER functions below; authenticated can read
-- (and admins/owners can unlink = delete an account).

CREATE TABLE public.customer_line_accounts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  client_id         uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  line_user_id      text NOT NULL,
  line_display_name text,
  linked_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz,
  UNIQUE (tenant_id, client_id),
  UNIQUE (tenant_id, line_user_id)
);

CREATE TABLE public.customer_line_invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  client_id   uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  site_id     uuid REFERENCES public.sites(id) ON DELETE SET NULL,
  code        text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  revoked_at  timestamptz,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX customer_line_invites_open_code
  ON public.customer_line_invites (tenant_id, code)
  WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX customer_line_invites_client ON public.customer_line_invites (tenant_id, client_id);

ALTER TABLE public.customer_line_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_line_invites  ENABLE ROW LEVEL SECURITY;

-- Supabase grants ALL to anon/authenticated on new tables; strip it, then grant only what is needed.
REVOKE ALL ON public.customer_line_accounts FROM anon, authenticated;
REVOKE ALL ON public.customer_line_invites  FROM anon, authenticated;
GRANT SELECT, DELETE ON public.customer_line_accounts TO authenticated;
GRANT SELECT ON public.customer_line_invites TO authenticated;

CREATE POLICY staff_select ON public.customer_line_accounts
  FOR SELECT TO authenticated
  USING (((SELECT is_admin_or_owner()) OR (SELECT is_pm()))
         AND tenant_id = (SELECT current_tenant_id()));

CREATE POLICY admin_delete ON public.customer_line_accounts
  FOR DELETE TO authenticated
  USING ((SELECT is_admin_or_owner())
         AND tenant_id = (SELECT current_tenant_id())
         AND (SELECT tenant_can_write()));

CREATE POLICY staff_select ON public.customer_line_invites
  FOR SELECT TO authenticated
  USING (((SELECT is_admin_or_owner()) OR (SELECT is_pm()))
         AND tenant_id = (SELECT current_tenant_id()));

-- Create a one-time invite for the client of a site. Revokes the client's earlier open invites.
CREATE OR REPLACE FUNCTION public.create_customer_invite(p_site_id uuid)
RETURNS TABLE(code text, expires_at timestamptz, client_id uuid, client_name text, basic_id text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_tenant   uuid := current_tenant_id();
  v_client   uuid;
  v_name     text;
  v_basic    text;
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code     text;
  v_bytes    bytea;
  v_exp      timestamptz := now() + interval '7 days';
  v_try      int := 0;
BEGIN
  IF v_tenant IS NULL
     OR NOT (is_admin_or_owner() OR is_pm())
     OR NOT has_module_access('line_bot')
     OR NOT tenant_can_write() THEN
    RAISE EXCEPTION 'not_allowed';
  END IF;

  SELECT s.client_id INTO v_client
    FROM public.sites s WHERE s.id = p_site_id AND s.tenant_id = v_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'site_not_found'; END IF;
  IF v_client IS NULL THEN RAISE EXCEPTION 'site_has_no_client'; END IF;

  SELECT c.name INTO v_name FROM public.clients c WHERE c.id = v_client AND c.tenant_id = v_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'site_not_found'; END IF;

  SELECT ch.basic_id INTO v_basic FROM public.customer_line_channels ch WHERE ch.tenant_id = v_tenant;

  UPDATE public.customer_line_invites i
     SET revoked_at = now()
   WHERE i.tenant_id = v_tenant AND i.client_id = v_client
     AND i.used_at IS NULL AND i.revoked_at IS NULL;

  LOOP
    v_try := v_try + 1;
    v_bytes := extensions.gen_random_bytes(6);
    v_code := '';
    FOR n IN 0..5 LOOP
      v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, n) % 31) + 1, 1);
    END LOOP;
    BEGIN
      INSERT INTO public.customer_line_invites
        (tenant_id, client_id, site_id, code, expires_at, created_by)
      VALUES (v_tenant, v_client, p_site_id, v_code, v_exp, auth.email());
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF v_try >= 10 THEN RAISE; END IF;
    END;
  END LOOP;

  RETURN QUERY SELECT v_code, v_exp, v_client, v_name, v_basic;
END;
$$;

REVOKE ALL ON FUNCTION public.create_customer_invite(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_customer_invite(uuid) TO authenticated;

-- Claim an invite from the webhook (service role only). The conditional UPDATE ... RETURNING is the
-- atomic claim: of concurrent calls with the same code, exactly one gets a row.
CREATE OR REPLACE FUNCTION public.claim_customer_invite(
  p_tenant uuid, p_code text, p_line_user_id text, p_display_name text)
RETURNS TABLE(status text, client_id uuid, client_name text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_client uuid;
  v_name   text;
BEGIN
  UPDATE public.customer_line_invites i
     SET used_at = now()
   WHERE i.tenant_id = p_tenant
     AND i.code = upper(btrim(p_code))
     AND i.used_at IS NULL AND i.revoked_at IS NULL
     AND i.expires_at > now()
     AND i.site_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.sites s
                  WHERE s.id = i.site_id AND s.tenant_id = p_tenant AND s.client_id = i.client_id)
  RETURNING i.client_id INTO v_client;

  IF v_client IS NULL THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  DELETE FROM public.customer_line_accounts a
   WHERE a.tenant_id = p_tenant
     AND (a.client_id = v_client OR a.line_user_id = p_line_user_id);

  INSERT INTO public.customer_line_accounts (tenant_id, client_id, line_user_id, line_display_name)
  VALUES (p_tenant, v_client, p_line_user_id, p_display_name);

  SELECT c.name INTO v_name FROM public.clients c WHERE c.id = v_client AND c.tenant_id = p_tenant;
  RETURN QUERY SELECT 'ok'::text, v_client, v_name;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_customer_invite(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_customer_invite(uuid, text, text, text) TO service_role;
