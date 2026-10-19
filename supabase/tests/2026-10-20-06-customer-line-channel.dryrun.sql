-- Dry run for 2026-10-20-06-customer-line-channel.sql. Controller replaces
-- __OWNER_EMAIL__ (a real OWNER of a tenant with the line_bot module) and __TENANT_ID__.
-- Everything is rolled back. Expect PASS notices for a, b, c, grants, e1, d/e2, f, g and no exception.
BEGIN;

-- clean slate for this tenant's vault secrets inside the transaction (rolled back)
DELETE FROM vault.secrets WHERE name IN ('customer_line_secret___TENANT_ID__', 'customer_line_token___TENANT_ID__');

-- ===== inlined migration body =====
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
-- ===== end migration body =====

SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-000000000001', 'role', 'authenticated',
                    'email', '__OWNER_EMAIL__')::text, true);

-- (a) save returns a 24-char key; also the module/owner gates resolved for this user
DO $$
DECLARE k text;
BEGIN
  k := public.save_customer_line_credentials('1234567890', 'SECRET-AAA', 'TOKEN-AAA');
  IF k IS NULL OR length(k) <> 24 THEN RAISE EXCEPTION 'FAIL (a): key not 24 chars: %', k; END IF;
  PERFORM set_config('test.key', k, true);
  RAISE NOTICE 'PASS (a) key=%', k;
END $$;

-- (b) authenticated sees the row, no secret/token columns, no plaintext values
DO $$
DECLARE r jsonb; n int;
BEGIN
  SELECT count(*) INTO n FROM public.customer_line_channels;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL (b): owner should see exactly 1 row, saw %', n; END IF;
  SELECT to_jsonb(c) INTO r FROM public.customer_line_channels c;
  IF r ?| ARRAY['secret','token','channel_secret','access_token'] THEN
    RAISE EXCEPTION 'FAIL (b): secret/token column exposed: %', r;
  END IF;
  IF r::text LIKE '%SECRET-AAA%' OR r::text LIKE '%TOKEN-AAA%' THEN
    RAISE EXCEPTION 'FAIL (b): plaintext credential in row';
  END IF;
  RAISE NOTICE 'PASS (b)';
END $$;

-- (c) authenticated cannot call the readers
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.customer_line_creds_by_key(current_setting('test.key'));
    RAISE EXCEPTION 'FAIL (c): by_key callable by authenticated';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.customer_line_creds_by_tenant('__TENANT_ID__');
    RAISE EXCEPTION 'FAIL (c): by_tenant callable by authenticated';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS (c)';
END $$;

-- (extra) column grants: contact edit ok; basic_id edit and INSERT/DELETE denied
DO $$
DECLARE n int;
BEGIN
  UPDATE public.customer_line_channels SET contact_phone = '021234567', contact_hours = '9-17';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL (grants): owner could not update contact_phone (% rows)', n; END IF;
  BEGIN
    UPDATE public.customer_line_channels SET basic_id = '@x';
    RAISE EXCEPTION 'FAIL (grants): authenticated updated basic_id';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.customer_line_channels SET verified_at = now();
    RAISE EXCEPTION 'FAIL (grants): authenticated updated verified_at';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.customer_line_channels;
    RAISE EXCEPTION 'FAIL (grants): authenticated deleted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.customer_line_channels (tenant_id, channel_id, webhook_key) VALUES (gen_random_uuid(), 'x', 'y');
    RAISE EXCEPTION 'FAIL (grants): authenticated inserted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS (grants)';
END $$;

-- (e) second save with blank secret/token keeps old values and key; verified_at reset
RESET ROLE;
UPDATE public.customer_line_channels SET verified_at = now(), basic_id = '@b' WHERE tenant_id = '__TENANT_ID__';
SET LOCAL role authenticated;
DO $$
DECLARE k text; k2 text; v timestamptz;
BEGIN
  k := current_setting('test.key');
  k2 := public.save_customer_line_credentials('1234567890', '   ', NULL);
  IF k2 <> k THEN RAISE EXCEPTION 'FAIL (e): webhook key changed'; END IF;
  SELECT verified_at INTO v FROM public.customer_line_channels;
  IF v IS NULL THEN RAISE EXCEPTION 'FAIL (e): verified_at cleared by a no-change save'; END IF;
  RAISE NOTICE 'PASS (e1) blank save returns same key';
END $$;

-- (d) as postgres the reader returns the saved plaintext
RESET ROLE;
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.customer_line_creds_by_key(current_setting('test.key'));
  IF r.tenant_id IS DISTINCT FROM '__TENANT_ID__'::uuid OR r.channel_secret <> 'SECRET-AAA' OR r.access_token <> 'TOKEN-AAA' THEN
    RAISE EXCEPTION 'FAIL (d): by_key returned %', r;
  END IF;
  SELECT * INTO r FROM public.customer_line_creds_by_tenant('__TENANT_ID__');
  IF r.channel_secret <> 'SECRET-AAA' OR r.access_token <> 'TOKEN-AAA' THEN
    RAISE EXCEPTION 'FAIL (d): by_tenant returned %', r;
  END IF;
  RAISE NOTICE 'PASS (d) and (e2) blank save kept old secret/token';
END $$;

-- (f) changing only the token updates it, keeps the secret, clears verified_at
UPDATE public.customer_line_channels SET verified_at = now() WHERE tenant_id = '__TENANT_ID__';
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-000000000001', 'role', 'authenticated',
                    'email', '__OWNER_EMAIL__')::text, true);
SELECT public.save_customer_line_credentials('1234567890', '', 'TOKEN-BBB');
RESET ROLE;
DO $$
DECLARE r record; v timestamptz;
BEGIN
  SELECT * INTO r FROM public.customer_line_creds_by_tenant('__TENANT_ID__');
  IF r.channel_secret <> 'SECRET-AAA' OR r.access_token <> 'TOKEN-BBB' THEN
    RAISE EXCEPTION 'FAIL (f): creds after token change: %', r;
  END IF;
  SELECT verified_at INTO v FROM public.customer_line_channels WHERE tenant_id = '__TENANT_ID__';
  IF v IS NOT NULL THEN RAISE EXCEPTION 'FAIL (f): verified_at not cleared'; END IF;
  RAISE NOTICE 'PASS (f)';
END $$;

-- (g) first save with a blank value raises missing_credentials; non-owner raises not_owner
DELETE FROM public.customer_line_channels WHERE tenant_id = '__TENANT_ID__';
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-000000000001', 'role', 'authenticated',
                    'email', '__OWNER_EMAIL__')::text, true);
DO $$
BEGIN
  BEGIN
    PERFORM public.save_customer_line_credentials('1234567890', 'S', '');
    RAISE EXCEPTION 'FAIL (g): no error on blank first-save token';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'missing_credentials' THEN RAISE EXCEPTION 'FAIL (g): got %', SQLERRM; END IF;
  END;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', '00000000-0000-0000-0000-000000000002', 'role', 'authenticated',
                      'email', 'nobody-' || gen_random_uuid() || '@example.invalid')::text, true);
  BEGIN
    PERFORM public.save_customer_line_credentials('1234567890', 'S', 'T');
    RAISE EXCEPTION 'FAIL (g): stranger could save';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'not_owner' THEN RAISE EXCEPTION 'FAIL (g): stranger got %', SQLERRM; END IF;
  END;
  RAISE NOTICE 'PASS (g)';
END $$;

-- (h) deleting the channel row removes both Vault secrets; a fresh first save then succeeds
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-000000000001', 'role', 'authenticated',
                    'email', '__OWNER_EMAIL__')::text, true);
SELECT public.save_customer_line_credentials('1234567890', 'SECRET-CCC', 'TOKEN-CCC');
RESET ROLE;
DELETE FROM public.customer_line_channels WHERE tenant_id = '__TENANT_ID__';
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM vault.secrets
   WHERE name IN ('customer_line_secret___TENANT_ID__', 'customer_line_token___TENANT_ID__');
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL (h): % vault secrets orphaned after delete', n; END IF;
END $$;
SET LOCAL role authenticated;
DO $$
DECLARE k text;
BEGIN
  k := public.save_customer_line_credentials('1234567890', 'SECRET-DDD', 'TOKEN-DDD');
  IF length(k) <> 24 THEN RAISE EXCEPTION 'FAIL (h): re-save after delete failed'; END IF;
  RAISE NOTICE 'PASS (h)';
END $$;

ROLLBACK;
