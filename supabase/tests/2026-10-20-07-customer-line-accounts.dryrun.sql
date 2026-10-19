BEGIN;
-- @@PREPEND_06@@

-- ===== inlined migration 2026-10-20-07 =====
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

-- ===== end migration body =====

DO $t$
DECLARE
  v_tenant uuid := '__TENANT_ID__';
  v_other uuid := (SELECT id FROM tenants WHERE id <> '__TENANT_ID__' LIMIT 1);
  v_client uuid; v_site uuid; v_site_nc uuid; r record; c1 text; c2 text; c3 text; n int; v_client_y uuid; v_site_c uuid; v_site_d uuid;
BEGIN
  INSERT INTO clients (tenant_id, client_number, name) VALUES (v_tenant, 'ZZT2-' || substr(md5(random()::text),1,8), 'ZZ Dry Run Client') RETURNING id INTO v_client;
  INSERT INTO sites (tenant_id, site_number, name, client_id) VALUES (v_tenant, 'ZZT2-A', 'ZZ site with client', v_client) RETURNING id INTO v_site;
  INSERT INTO sites (tenant_id, site_number, name, client_id) VALUES (v_tenant, 'ZZT2-B', 'ZZ site no client', NULL) RETURNING id INTO v_site_nc;

  PERFORM set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-000000000001','role','authenticated','email','__OWNER_EMAIL__')::text, true);
  EXECUTE 'SET LOCAL role authenticated';

  SELECT * INTO r FROM create_customer_invite(v_site);
  c1 := r.code;
  IF c1 !~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$' THEN RAISE EXCEPTION 'FAIL (a): bad code %', c1; END IF;
  IF r.expires_at < now() + interval '7 days' - interval '1 minute' OR r.expires_at > now() + interval '7 days' + interval '1 minute' THEN RAISE EXCEPTION 'FAIL (a): bad expiry %', r.expires_at; END IF;
  IF r.client_id IS DISTINCT FROM v_client OR r.client_name <> 'ZZ Dry Run Client' THEN RAISE EXCEPTION 'FAIL (a): bad client'; END IF;
  RAISE NOTICE 'PASS (a)';

  SELECT * INTO r FROM create_customer_invite(v_site);
  c2 := r.code;
  SELECT count(*) INTO n FROM customer_line_invites WHERE client_id = v_client AND revoked_at IS NOT NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL (b): expected 1 revoked, got %', n; END IF;

  BEGIN
    PERFORM * FROM claim_customer_invite(v_tenant, c2, 'U_zz_1', 'Name');
    RAISE EXCEPTION 'FAIL (grants): authenticated could claim';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS (grants)';
  END;

  EXECUTE 'RESET ROLE';
  SELECT * INTO r FROM claim_customer_invite(v_tenant, c1, 'U_zz_1', 'Name');
  IF r.status <> 'invalid' THEN RAISE EXCEPTION 'FAIL (b): revoked code claimed %', r.status; END IF;
  RAISE NOTICE 'PASS (b)';

  SELECT * INTO r FROM claim_customer_invite(v_other, c2, 'U_zz_1', 'Name');
  IF r.status <> 'invalid' THEN RAISE EXCEPTION 'FAIL (e): other tenant claimed %', r.status; END IF;
  RAISE NOTICE 'PASS (e)';

  SELECT * INTO r FROM claim_customer_invite(v_tenant, lower(' ' || c2 || ' '), 'U_zz_1', 'Name One');
  IF r.status <> 'ok' OR r.client_id IS DISTINCT FROM v_client OR r.client_name <> 'ZZ Dry Run Client' THEN RAISE EXCEPTION 'FAIL (c): status %', r.status; END IF;
  SELECT count(*) INTO n FROM customer_line_accounts WHERE client_id = v_client AND line_user_id = 'U_zz_1';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL (c): account rows %', n; END IF;
  RAISE NOTICE 'PASS (c)';

  SELECT * INTO r FROM claim_customer_invite(v_tenant, c2, 'U_zz_1', 'Name One');
  IF r.status <> 'invalid' THEN RAISE EXCEPTION 'FAIL (d): reused code %', r.status; END IF;
  RAISE NOTICE 'PASS (d)';

  PERFORM set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-000000000001','role','authenticated','email','__OWNER_EMAIL__')::text, true);
  EXECUTE 'SET LOCAL role authenticated';
  SELECT * INTO r FROM create_customer_invite(v_site);
  c3 := r.code;
  EXECUTE 'RESET ROLE';
  SELECT * INTO r FROM claim_customer_invite(v_tenant, c3, 'U_zz_2', 'Name Two');
  IF r.status <> 'ok' THEN RAISE EXCEPTION 'FAIL (f): status %', r.status; END IF;
  SELECT count(*) INTO n FROM customer_line_accounts WHERE client_id = v_client;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL (f): rows for client %', n; END IF;
  SELECT count(*) INTO n FROM customer_line_accounts WHERE tenant_id = v_tenant AND line_user_id = 'U_zz_1';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL (f): old user still linked'; END IF;
  RAISE NOTICE 'PASS (f)';

  EXECUTE 'SET LOCAL role authenticated';
  BEGIN
    PERFORM * FROM create_customer_invite(v_site_nc);
    RAISE EXCEPTION 'FAIL (g): no exception';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'site_has_no_client' THEN RAISE EXCEPTION 'FAIL (g): got %', SQLERRM; END IF;
  END;
  RAISE NOTICE 'PASS (g)';
  EXECUTE 'RESET ROLE';

  INSERT INTO clients (tenant_id, client_number, name) VALUES (v_tenant, 'ZZT2Y-' || substr(md5(random()::text),1,8), 'ZZ Client Y') RETURNING id INTO v_client_y;
  INSERT INTO sites (tenant_id, site_number, name, client_id) VALUES (v_tenant, 'ZZT2-C', 'ZZ site moved', v_client) RETURNING id INTO v_site_c;
  INSERT INTO sites (tenant_id, site_number, name, client_id) VALUES (v_tenant, 'ZZT2-D', 'ZZ site deleted', v_client) RETURNING id INTO v_site_d;
  PERFORM set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-000000000001','role','authenticated','email','__OWNER_EMAIL__')::text, true);
  EXECUTE 'SET LOCAL role authenticated';
  SELECT * INTO r FROM create_customer_invite(v_site_c);
  c1 := r.code;
  EXECUTE 'RESET ROLE';
  UPDATE sites SET client_id = v_client_y WHERE id = v_site_c;
  SELECT * INTO r FROM claim_customer_invite(v_tenant, c1, 'U_zz_h', 'Name H');
  IF r.status <> 'invalid' THEN RAISE EXCEPTION 'FAIL (h): moved site claimed %', r.status; END IF;
  SELECT count(*) INTO n FROM customer_line_accounts WHERE line_user_id = 'U_zz_h' OR client_id = v_client_y;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL (h): account rows %', n; END IF;
  RAISE NOTICE 'PASS (h)';
  EXECUTE 'SET LOCAL role authenticated';
  SELECT * INTO r FROM create_customer_invite(v_site_d);
  c2 := r.code;
  EXECUTE 'RESET ROLE';
  DELETE FROM sites WHERE id = v_site_d;
  SELECT * INTO r FROM claim_customer_invite(v_tenant, c2, 'U_zz_i', 'Name I');
  IF r.status <> 'invalid' THEN RAISE EXCEPTION 'FAIL (i): deleted site claimed %', r.status; END IF;
  RAISE NOTICE 'PASS (i)';
END
$t$;

SELECT 'ALL PASS' AS result;
ROLLBACK;
