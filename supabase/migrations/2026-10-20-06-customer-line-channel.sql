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
