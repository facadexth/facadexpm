-- Self-contained dry run for Task 3 (no placeholders). Paste into the Supabase SQL Editor; everything rolls back.
-- Inlines migrations -06, -07, -08 byte-identical, then re-runs Task 2's DO block (a)-(j), then Task 3's (a)-(h).
BEGIN;

-- ===== inlined migration 2026-10-20-06 =====
-- 2026-10-20-06: customer LINE channel (tenant's own OA) with Vault-held credentials.
-- The channel secret / access token live ONLY in Vault; this table holds their ids (not secrets).
-- Authenticated owners can read the row and edit contact_phone / contact_hours only.
-- basic_id, display_name, verified_at are written by the service role (edge function, later task).

CREATE TABLE public.customer_line_channels (
  tenant_id       uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  channel_id      text NOT NULL,
  webhook_key     text NOT NULL UNIQUE,
  secret_vault_id uuid,
  token_vault_id  uuid,
  basic_id        text,
  display_name    text,
  contact_phone   text,
  contact_hours   text,
  verified_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.customer_line_channels ENABLE ROW LEVEL SECURITY;

-- Supabase grants ALL to anon/authenticated on new tables; strip it so the column grant below is meaningful.
REVOKE ALL ON public.customer_line_channels FROM anon, authenticated;
GRANT SELECT ON public.customer_line_channels TO authenticated;
GRANT UPDATE (contact_phone, contact_hours) ON public.customer_line_channels TO authenticated;

CREATE POLICY owner_select ON public.customer_line_channels
  FOR SELECT TO authenticated
  USING ((SELECT is_owner()) AND tenant_id = (SELECT current_tenant_id()));

CREATE POLICY owner_update ON public.customer_line_channels
  FOR UPDATE TO authenticated
  USING ((SELECT is_owner()) AND tenant_id = (SELECT current_tenant_id()) AND (SELECT tenant_can_write()))
  WITH CHECK ((SELECT is_owner()) AND tenant_id = (SELECT current_tenant_id()) AND (SELECT tenant_can_write()));

-- No INSERT / DELETE policy or grant for authenticated.

-- Save (create on first call). Blank secret/token = keep existing. Returns the webhook_key.
CREATE OR REPLACE FUNCTION public.save_customer_line_credentials(
  p_channel_id text, p_channel_secret text, p_access_token text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, vault, extensions
AS $$
DECLARE
  v_tenant uuid := current_tenant_id();
  v_row    public.customer_line_channels%ROWTYPE;
  v_secret text := NULLIF(btrim(p_channel_secret), '');
  v_token  text := NULLIF(btrim(p_access_token), '');
  v_chan   text := NULLIF(btrim(p_channel_id), '');
  v_changed boolean := false;
BEGIN
  IF NOT is_owner() THEN RAISE EXCEPTION 'not_owner'; END IF;
  IF NOT has_module_access('line_bot') THEN RAISE EXCEPTION 'module_missing'; END IF;
  IF NOT tenant_can_write() THEN RAISE EXCEPTION 'read_only'; END IF;

  SELECT * INTO v_row FROM public.customer_line_channels WHERE tenant_id = v_tenant FOR UPDATE;

  IF NOT FOUND THEN
    IF v_chan IS NULL OR v_secret IS NULL OR v_token IS NULL THEN
      RAISE EXCEPTION 'missing_credentials';
    END IF;
    INSERT INTO public.customer_line_channels
      (tenant_id, channel_id, webhook_key, secret_vault_id, token_vault_id)
    VALUES (v_tenant, v_chan, encode(gen_random_bytes(12), 'hex'),
            vault.create_secret(v_secret, 'customer_line_secret_' || v_tenant),
            vault.create_secret(v_token,  'customer_line_token_'  || v_tenant))
    RETURNING * INTO v_row;
    RETURN v_row.webhook_key;
  END IF;

  IF v_chan IS NOT NULL AND v_chan IS DISTINCT FROM v_row.channel_id THEN
    v_row.channel_id := v_chan; v_changed := true;
  END IF;
  IF v_secret IS NOT NULL THEN
    PERFORM vault.update_secret(v_row.secret_vault_id, v_secret);
    v_changed := true;
  END IF;
  IF v_token IS NOT NULL THEN
    PERFORM vault.update_secret(v_row.token_vault_id, v_token);
    v_changed := true;
  END IF;

  IF v_changed THEN
    UPDATE public.customer_line_channels
       SET channel_id = v_row.channel_id, verified_at = NULL, updated_at = now()
     WHERE tenant_id = v_tenant;
  END IF;
  RETURN v_row.webhook_key;
END;
$$;

REVOKE ALL ON FUNCTION public.save_customer_line_credentials(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_customer_line_credentials(text, text, text) TO authenticated;

-- Deleting a channel row (directly or via tenant cascade) also deletes its two Vault secrets,
-- so a later first save can re-create them (vault.secrets.name is unique).
CREATE OR REPLACE FUNCTION public.customer_line_channels_delete_vault()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, vault
AS $$
BEGIN
  DELETE FROM vault.secrets WHERE id IN (OLD.secret_vault_id, OLD.token_vault_id);
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.customer_line_channels_delete_vault() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER customer_line_channels_delete_vault
  BEFORE DELETE ON public.customer_line_channels
  FOR EACH ROW EXECUTE FUNCTION public.customer_line_channels_delete_vault();

-- Readers for the webhook / push edge functions (service role only).
CREATE OR REPLACE FUNCTION public.customer_line_creds_by_key(p_key text)
RETURNS TABLE(tenant_id uuid, channel_secret text, access_token text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, vault
AS $$
  SELECT c.tenant_id, s.decrypted_secret, t.decrypted_secret
    FROM public.customer_line_channels c
    JOIN vault.decrypted_secrets s ON s.id = c.secret_vault_id
    JOIN vault.decrypted_secrets t ON t.id = c.token_vault_id
   WHERE c.webhook_key = p_key;
$$;

CREATE OR REPLACE FUNCTION public.customer_line_creds_by_tenant(p_tenant uuid)
RETURNS TABLE(tenant_id uuid, channel_secret text, access_token text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, vault
AS $$
  SELECT c.tenant_id, s.decrypted_secret, t.decrypted_secret
    FROM public.customer_line_channels c
    JOIN vault.decrypted_secrets s ON s.id = c.secret_vault_id
    JOIN vault.decrypted_secrets t ON t.id = c.token_vault_id
   WHERE c.tenant_id = p_tenant;
$$;

REVOKE ALL ON FUNCTION public.customer_line_creds_by_key(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.customer_line_creds_by_tenant(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_line_creds_by_key(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.customer_line_creds_by_tenant(uuid) TO service_role;

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

  -- One claim per client: any other open code for the same client (e.g. from two staff
  -- creating invites at once) dies now, so a second person cannot take the link over later.
  UPDATE public.customer_line_invites i
     SET revoked_at = now()
   WHERE i.tenant_id = p_tenant AND i.client_id = v_client
     AND i.used_at IS NULL AND i.revoked_at IS NULL;

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

-- ===== inlined migration 2026-10-20-08 =====
-- 2026-10-20-08: customer LINE requests (ring the in-app bell) and the customer_visible photo flag.
-- Requests are inserted only by the service role (the customer webhook, a later task); the owner/admin
-- can read them and mark them handled. pending_counts() is copied from the LIVE definition (2026-10-19)
-- with one new key, customer_requests_open.

CREATE TABLE public.customer_line_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  line_user_id text NOT NULL,
  client_id    uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  kind         text NOT NULL CHECK (kind IN ('quote','repair')),
  display_name text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  handled_at   timestamptz,
  handled_by   text
);

-- At most one open request per person per kind.
CREATE UNIQUE INDEX customer_line_requests_open_one
  ON public.customer_line_requests (tenant_id, line_user_id, kind)
  WHERE handled_at IS NULL;

ALTER TABLE public.customer_line_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.customer_line_requests FROM anon, authenticated;
GRANT SELECT ON public.customer_line_requests TO authenticated;
GRANT UPDATE (handled_at, handled_by) ON public.customer_line_requests TO authenticated;

CREATE POLICY admin_select ON public.customer_line_requests
  FOR SELECT TO authenticated
  USING ((SELECT is_admin_or_owner())
         AND tenant_id = (SELECT current_tenant_id()));

CREATE POLICY admin_update ON public.customer_line_requests
  FOR UPDATE TO authenticated
  USING ((SELECT is_admin_or_owner())
         AND tenant_id = (SELECT current_tenant_id())
         AND (SELECT tenant_can_write()))
  WITH CHECK ((SELECT is_admin_or_owner())
         AND tenant_id = (SELECT current_tenant_id())
         AND (SELECT tenant_can_write()));

-- Photos the customer may see in their LINE (Phase 1b reads this flag).
ALTER TABLE public.line_site_photos ADD COLUMN customer_visible boolean NOT NULL DEFAULT false;
ALTER TABLE public.site_attachments ADD COLUMN customer_visible boolean NOT NULL DEFAULT false;

-- Only PM/admin/owner may change the flag. Workers can insert/update their own line_site_photos
-- through RLS, so without this they could set customer_visible directly via PostgREST.
-- Same convention as scn_block_edit_when_posted: the rule binds direct client access only
-- (current_user authenticated/anon). SECURITY DEFINER RPCs (set_customer_visible, which checks
-- the role itself) run as the function owner, and the service role is not restricted.
-- Moving a row to another site always clears the flag, for every caller.
CREATE OR REPLACE FUNCTION public.guard_customer_visible()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.site_id IS DISTINCT FROM OLD.site_id THEN
    NEW.customer_visible := false;
  END IF;

  IF (TG_OP = 'INSERT' AND NEW.customer_visible)
     OR (TG_OP = 'UPDATE' AND NEW.customer_visible IS DISTINCT FROM OLD.customer_visible
         AND NOT (NEW.site_id IS DISTINCT FROM OLD.site_id)) THEN
    IF current_user = 'anon' THEN
      RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
    ELSIF current_user = 'authenticated' THEN
      IF NOT ((SELECT is_admin_or_owner()) OR (SELECT is_pm())) THEN
        RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_customer_visible() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER line_site_photos_guard_customer_visible
  BEFORE INSERT OR UPDATE ON public.line_site_photos
  FOR EACH ROW EXECUTE FUNCTION public.guard_customer_visible();

CREATE TRIGGER site_attachments_guard_customer_visible
  BEFORE INSERT OR UPDATE ON public.site_attachments
  FOR EACH ROW EXECUTE FUNCTION public.guard_customer_visible();

CREATE OR REPLACE FUNCTION public.set_customer_visible(p_kind text, p_id uuid, p_visible boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := current_tenant_id();
BEGIN
  IF v_tenant IS NULL
     OR NOT (is_admin_or_owner() OR is_pm())
     OR NOT tenant_can_write() THEN
    RAISE EXCEPTION 'not_allowed';
  END IF;

  IF p_kind = 'line_site_photo' THEN
    UPDATE public.line_site_photos SET customer_visible = p_visible
     WHERE id = p_id AND tenant_id = v_tenant;
  ELSIF p_kind = 'site_attachment' THEN
    UPDATE public.site_attachments SET customer_visible = p_visible
     WHERE id = p_id AND tenant_id = v_tenant;
  ELSE
    RAISE EXCEPTION 'bad_kind';
  END IF;

  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_customer_visible(text, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_customer_visible(text, uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.pending_counts()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH today AS (
    SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date AS d
  ),
  cheque_window AS (
    SELECT COALESCE(
      (SELECT CASE WHEN value ~ '^[0-9]+$' THEN value::int END
         FROM app_settings WHERE key = 'cheque_reminder_days' LIMIT 1),
      3) AS n
  )
  SELECT jsonb_build_object(
    'leave_pending',
      (SELECT count(*) FROM leave_requests WHERE status = 'pending'),
    'po_draft',
      (SELECT count(*) FROM purchase_orders WHERE status = 'draft'),
    'issues_open',
      (SELECT count(*) FROM line_issue_reports WHERE status = 'open'),
    'cheques_due',
      (SELECT count(*) FROM cheques c, today, cheque_window w
        WHERE c.status <> 'cashed' AND c.check_date <= today.d + w.n),
    'quotations_followup',
      (SELECT count(*) FROM quotations q, today
        WHERE q.status = 'sent' AND NOT q.on_hold
          AND q.valid_until IS NOT NULL
          AND q.valid_until <= today.d + 7),
    'offboarded_in_group',
      (SELECT count(*) FROM workers w
        WHERE w.status = 'inactive' AND w.line_offboarding_alerted_at IS NOT NULL
          AND (w.line_group_removed_at IS NULL OR w.line_group_removed_at < w.line_offboarding_alerted_at)),
    'advances_pending',
      CASE WHEN is_admin_or_owner()
           THEN (SELECT count(*) FROM salary_advances
                  WHERE tenant_id = current_tenant_id() AND status = 'pending')
           ELSE 0 END,
    'customer_requests_open',
      CASE WHEN is_owner()
           THEN (SELECT count(*) FROM customer_line_requests
                  WHERE tenant_id = current_tenant_id() AND handled_at IS NULL)
           ELSE 0 END
  );
$function$;

-- ===== end migration bodies =====

-- Task 2 assertions
DO $t$
DECLARE
  v_tenant uuid := '8b61c890-0a90-4223-91d3-b5f8f4e89908';
  v_other uuid := (SELECT id FROM tenants WHERE id <> '8b61c890-0a90-4223-91d3-b5f8f4e89908' LIMIT 1);
  v_client uuid; v_site uuid; v_site_nc uuid; r record; c1 text; c2 text; c3 text; n int; v_client_y uuid; v_site_c uuid; v_site_d uuid; v_client_j uuid; v_site_j uuid;
BEGIN
  INSERT INTO clients (tenant_id, client_number, name) VALUES (v_tenant, 'ZZT2-' || substr(md5(random()::text),1,8), 'ZZ Dry Run Client') RETURNING id INTO v_client;
  INSERT INTO sites (tenant_id, site_number, name, client_id) VALUES (v_tenant, 'ZZT2-A', 'ZZ site with client', v_client) RETURNING id INTO v_site;
  INSERT INTO sites (tenant_id, site_number, name, client_id) VALUES (v_tenant, 'ZZT2-B', 'ZZ site no client', NULL) RETURNING id INTO v_site_nc;

  PERFORM set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-000000000001','role','authenticated','email','demo-owner@facadex.co.th')::text, true);
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

  PERFORM set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-000000000001','role','authenticated','email','demo-owner@facadex.co.th')::text, true);
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
  PERFORM set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-000000000001','role','authenticated','email','demo-owner@facadex.co.th')::text, true);
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

  -- (j) claiming one code revokes every other open code of the same client (two staff invited at once).
  -- Reuses client Y / site C from (h) (no open codes, no account) so no extra site counts toward the package limit.
  v_client_j := v_client_y; v_site_j := v_site_c;
  INSERT INTO customer_line_invites (tenant_id, client_id, site_id, code, expires_at, created_by)
  VALUES (v_tenant, v_client_j, v_site_j, 'ZZJAA2', now() + interval '7 days', 'dryrun'),
         (v_tenant, v_client_j, v_site_j, 'ZZJAA3', now() + interval '7 days', 'dryrun');
  SELECT * INTO r FROM claim_customer_invite(v_tenant, 'ZZJAA2', 'U_zz_j1', 'Name J1');
  IF r.status <> 'ok' THEN RAISE EXCEPTION 'FAIL (j): first claim %', r.status; END IF;
  SELECT count(*) INTO n FROM customer_line_invites
   WHERE client_id = v_client_j AND code = 'ZZJAA3' AND used_at IS NULL AND revoked_at IS NOT NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL (j): other open code not revoked'; END IF;
  SELECT * INTO r FROM claim_customer_invite(v_tenant, 'ZZJAA3', 'U_zz_j2', 'Name J2');
  IF r.status <> 'invalid' THEN RAISE EXCEPTION 'FAIL (j): second code claimed %', r.status; END IF;
  SELECT count(*) INTO n FROM customer_line_accounts WHERE client_id = v_client_j AND line_user_id = 'U_zz_j1';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL (j): first link lost'; END IF;
  RAISE NOTICE 'PASS (j)';
END
$t$;

-- Task 3 assertions
DO $t$
DECLARE
  v_tenant uuid := '8b61c890-0a90-4223-91d3-b5f8f4e89908';
  v_other uuid := (SELECT id FROM tenants WHERE id <> '8b61c890-0a90-4223-91d3-b5f8f4e89908' LIMIT 1);
  v_client uuid; v_site uuid; v_worker uuid; v_worker_o uuid; v_site_o uuid;
  v_photo uuid; v_photo_o uuid; v_att uuid; v_att_o uuid; n int; v_flag boolean; v_cnt text; v_site2 uuid;
BEGIN
  IF v_other IS NULL THEN RAISE EXCEPTION 'FAIL (setup): needs a second tenant'; END IF;
  INSERT INTO clients (tenant_id, client_number, name) VALUES (v_tenant, 'ZZT3-' || substr(md5(random()::text),1,8), 'ZZ T3 Client') RETURNING id INTO v_client;
  INSERT INTO sites (tenant_id, site_number, name, client_id) VALUES (v_tenant, 'ZZT3-A', 'ZZ T3 site', v_client) RETURNING id INTO v_site;
  INSERT INTO sites (tenant_id, site_number, name) VALUES (v_other, 'ZZT3-O', 'ZZ T3 other site') RETURNING id INTO v_site_o;
  INSERT INTO workers (tenant_id, name, monthly_salary) VALUES (v_tenant, 'ZZ T3 worker', 1000) RETURNING id INTO v_worker;
  INSERT INTO workers (tenant_id, name, monthly_salary) VALUES (v_other, 'ZZ T3 worker other', 1000) RETURNING id INTO v_worker_o;
  INSERT INTO line_site_photos (tenant_id, worker_id, site_id, date, photo_path) VALUES (v_tenant, v_worker, v_site, current_date, 'zz/own.jpg') RETURNING id INTO v_photo;
  INSERT INTO line_site_photos (tenant_id, worker_id, site_id, date, photo_path) VALUES (v_other, v_worker_o, v_site_o, current_date, 'zz/other.jpg') RETURNING id INTO v_photo_o;
  INSERT INTO site_attachments (tenant_id, site_id, file_path, file_name) VALUES (v_tenant, v_site, 'zz/own.pdf', 'own.pdf') RETURNING id INTO v_att;
  INSERT INTO site_attachments (tenant_id, site_id, file_path, file_name) VALUES (v_other, v_site_o, 'zz/other.pdf', 'other.pdf') RETURNING id INTO v_att_o;

  -- (a) the same open request twice leaves one row
  INSERT INTO customer_line_requests (tenant_id, line_user_id, client_id, kind, display_name) VALUES (v_tenant, 'U_zz_r1', v_client, 'quote', 'ZZ') ON CONFLICT DO NOTHING;
  INSERT INTO customer_line_requests (tenant_id, line_user_id, client_id, kind, display_name) VALUES (v_tenant, 'U_zz_r1', v_client, 'quote', 'ZZ') ON CONFLICT DO NOTHING;
  SELECT count(*) INTO n FROM customer_line_requests WHERE tenant_id = v_tenant AND line_user_id = 'U_zz_r1' AND kind = 'quote';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL (a): expected 1 row, got %', n; END IF;
  RAISE NOTICE 'PASS (a)';

  PERFORM set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-000000000001','role','authenticated','email','demo-owner@facadex.co.th')::text, true);
  EXECUTE 'SET LOCAL role authenticated';

  -- (b) owner sees 1 open
  v_cnt := (pending_counts()->>'customer_requests_open');
  IF v_cnt <> '1' THEN RAISE EXCEPTION 'FAIL (b): expected 1, got %', v_cnt; END IF;
  RAISE NOTICE 'PASS (b)';

  -- (c) handled -> 0 (owner updates through RLS and column grant)
  UPDATE customer_line_requests SET handled_at = now(), handled_by = 'demo-owner@facadex.co.th'
   WHERE tenant_id = v_tenant AND line_user_id = 'U_zz_r1';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL (c): owner update touched % rows', n; END IF;
  v_cnt := (pending_counts()->>'customer_requests_open');
  IF v_cnt <> '0' THEN RAISE EXCEPTION 'FAIL (c): expected 0, got %', v_cnt; END IF;
  RAISE NOTICE 'PASS (c)';

  -- authenticated cannot insert requests or update other columns
  BEGIN
    INSERT INTO customer_line_requests (tenant_id, line_user_id, kind) VALUES (v_tenant, 'U_zz_r2', 'repair');
    RAISE EXCEPTION 'FAIL (grants): authenticated could insert';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS (grants insert)';
  END;
  BEGIN
    UPDATE customer_line_requests SET kind = 'repair' WHERE tenant_id = v_tenant;
    RAISE EXCEPTION 'FAIL (grants): authenticated could update kind';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS (grants update)';
  END;

  -- (d) another tenant's photo / attachment raises not_found; unknown kind raises bad_kind
  BEGIN
    PERFORM set_customer_visible('line_site_photo', v_photo_o, true);
    RAISE EXCEPTION 'FAIL (d): other tenant photo accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'not_found' THEN RAISE EXCEPTION 'FAIL (d): got %', SQLERRM; END IF;
  END;
  BEGIN
    PERFORM set_customer_visible('site_attachment', v_att_o, true);
    RAISE EXCEPTION 'FAIL (d): other tenant attachment accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'not_found' THEN RAISE EXCEPTION 'FAIL (d): got %', SQLERRM; END IF;
  END;
  BEGIN
    PERFORM set_customer_visible('nope', v_photo, true);
    RAISE EXCEPTION 'FAIL (d): bad kind accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'bad_kind' THEN RAISE EXCEPTION 'FAIL (d): got %', SQLERRM; END IF;
  END;
  EXECUTE 'RESET ROLE';
  SELECT customer_visible INTO v_flag FROM line_site_photos WHERE id = v_photo_o;
  IF v_flag THEN RAISE EXCEPTION 'FAIL (d): other tenant photo was flipped'; END IF;
  RAISE NOTICE 'PASS (d)';

  -- (e) own photo and attachment flip, both ways
  PERFORM set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-000000000001','role','authenticated','email','demo-owner@facadex.co.th')::text, true);
  EXECUTE 'SET LOCAL role authenticated';
  PERFORM set_customer_visible('line_site_photo', v_photo, true);
  PERFORM set_customer_visible('site_attachment', v_att, true);
  EXECUTE 'RESET ROLE';
  SELECT customer_visible INTO v_flag FROM line_site_photos WHERE id = v_photo;
  IF v_flag IS NOT TRUE THEN RAISE EXCEPTION 'FAIL (e): photo not flipped on'; END IF;
  SELECT customer_visible INTO v_flag FROM site_attachments WHERE id = v_att;
  IF v_flag IS NOT TRUE THEN RAISE EXCEPTION 'FAIL (e): attachment not flipped on'; END IF;
  EXECUTE 'SET LOCAL role authenticated';
  PERFORM set_customer_visible('line_site_photo', v_photo, false);
  EXECUTE 'RESET ROLE';
  SELECT customer_visible INTO v_flag FROM line_site_photos WHERE id = v_photo;
  IF v_flag IS NOT FALSE THEN RAISE EXCEPTION 'FAIL (e): photo not flipped off'; END IF;
  RAISE NOTICE 'PASS (e)';

  -- anon cannot call it
  EXECUTE 'SET LOCAL role anon';
  BEGIN
    PERFORM set_customer_visible('line_site_photo', v_photo, true);
    RAISE EXCEPTION 'FAIL (grants): anon could call set_customer_visible';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS (grants anon)';
  END;
  EXECUTE 'RESET ROLE';

  -- (f) a worker (WORKER role, not admin/owner/PM) cannot set customer_visible directly
  INSERT INTO user_roles (user_email, role, tenant_id) VALUES ('zz-dryrun-worker@facadex.invalid', 'WORKER', v_tenant);
  UPDATE workers SET email = 'zz-dryrun-worker@facadex.invalid' WHERE id = v_worker;
  -- an existing demo site as the move target (no new site counts toward the package limit)
  SELECT id INTO v_site2 FROM sites WHERE tenant_id = v_tenant AND id <> v_site ORDER BY created_at LIMIT 1;
  IF v_site2 IS NULL THEN RAISE EXCEPTION 'FAIL (f setup): needs a second demo site'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-000000000002','role','authenticated','email','zz-dryrun-worker@facadex.invalid')::text, true);
  EXECUTE 'SET LOCAL role authenticated';
  IF (SELECT is_admin_or_owner()) OR (SELECT is_pm()) THEN RAISE EXCEPTION 'FAIL (f setup): worker resolved as privileged'; END IF;
  IF my_worker_id() IS DISTINCT FROM v_worker THEN RAISE EXCEPTION 'FAIL (f setup): my_worker_id did not resolve'; END IF;
  BEGIN
    INSERT INTO line_site_photos (tenant_id, worker_id, site_id, date, photo_path, customer_visible)
    VALUES (v_tenant, v_worker, v_site, current_date, 'zz/w1.jpg', true);
    RAISE EXCEPTION 'FAIL (f): worker inserted a customer-visible photo';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'not_allowed' THEN RAISE EXCEPTION 'FAIL (f): insert got %', SQLERRM; END IF;
  END;
  -- the normal worker upload (flag left at its default) still works
  INSERT INTO line_site_photos (tenant_id, worker_id, site_id, date, photo_path)
  VALUES (v_tenant, v_worker, v_site, current_date, 'zz/w2.jpg');
  -- WHERE true reads no column, so only the worker_updates_own USING applies (own rows)
  BEGIN
    UPDATE line_site_photos SET customer_visible = true WHERE true;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE EXCEPTION 'FAIL (f): worker update not blocked (% rows)', n;
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'not_allowed' THEN RAISE EXCEPTION 'FAIL (f): update got %', SQLERRM; END IF;
  END;
  EXECUTE 'RESET ROLE';
  SELECT count(*) INTO n FROM line_site_photos WHERE worker_id = v_worker AND customer_visible;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL (f): % worker photos flagged', n; END IF;
  SELECT count(*) INTO n FROM line_site_photos WHERE worker_id = v_worker;
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL (f): expected 2 worker photos, got %', n; END IF;
  RAISE NOTICE 'PASS (f)';

  -- (g) moving a row to another site clears the flag, for any caller
  UPDATE line_site_photos SET customer_visible = true WHERE id = v_photo;
  UPDATE site_attachments SET customer_visible = true WHERE id = v_att;
  UPDATE line_site_photos SET site_id = v_site2 WHERE id = v_photo;
  UPDATE site_attachments SET site_id = v_site2 WHERE id = v_att;
  SELECT customer_visible INTO v_flag FROM line_site_photos WHERE id = v_photo;
  IF v_flag IS NOT FALSE THEN RAISE EXCEPTION 'FAIL (g): moved photo kept its flag'; END IF;
  SELECT customer_visible INTO v_flag FROM site_attachments WHERE id = v_att;
  IF v_flag IS NOT FALSE THEN RAISE EXCEPTION 'FAIL (g): moved attachment kept its flag'; END IF;
  UPDATE line_site_photos SET site_id = v_site, customer_visible = true WHERE id = v_photo;
  SELECT customer_visible INTO v_flag FROM line_site_photos WHERE id = v_photo;
  IF v_flag IS NOT FALSE THEN RAISE EXCEPTION 'FAIL (g): move + flag in one update kept the flag'; END IF;
  -- a worker moving their own flagged photo is allowed and clears it (no not_allowed)
  UPDATE line_site_photos SET customer_visible = true WHERE id = v_photo;
  PERFORM set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-000000000002','role','authenticated','email','zz-dryrun-worker@facadex.invalid')::text, true);
  EXECUTE 'SET LOCAL role authenticated';
  UPDATE line_site_photos SET site_id = v_site2 WHERE true;
  GET DIAGNOSTICS n = ROW_COUNT;
  EXECUTE 'RESET ROLE';
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL (g): worker move touched % rows', n; END IF;
  SELECT customer_visible INTO v_flag FROM line_site_photos WHERE id = v_photo;
  IF v_flag IS NOT FALSE THEN RAISE EXCEPTION 'FAIL (g): worker-moved photo kept its flag'; END IF;
  RAISE NOTICE 'PASS (g)';

  -- (h) the owner still sets the flag, directly and via the RPC, with the guard in place
  PERFORM set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-000000000001','role','authenticated','email','demo-owner@facadex.co.th')::text, true);
  EXECUTE 'SET LOCAL role authenticated';
  UPDATE line_site_photos SET customer_visible = true WHERE id = v_photo;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL (h): owner direct update touched % rows', n; END IF;
  PERFORM set_customer_visible('line_site_photo', v_photo, false);
  PERFORM set_customer_visible('site_attachment', v_att, true);
  EXECUTE 'RESET ROLE';
  SELECT customer_visible INTO v_flag FROM line_site_photos WHERE id = v_photo;
  IF v_flag IS NOT FALSE THEN RAISE EXCEPTION 'FAIL (h): RPC did not clear the photo flag'; END IF;
  SELECT customer_visible INTO v_flag FROM site_attachments WHERE id = v_att;
  IF v_flag IS NOT TRUE THEN RAISE EXCEPTION 'FAIL (h): RPC did not set the attachment flag'; END IF;
  RAISE NOTICE 'PASS (h)';
END
$t$;

SELECT 'ALL PASS' AS result;
ROLLBACK;
