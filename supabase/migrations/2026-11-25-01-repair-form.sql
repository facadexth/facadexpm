-- 2026-11-25-01: LINE customer repair form (CRM phase 1).
-- repair_ticket_items (one row per problem on a ticket, admin/owner RLS like repair_tickets),
-- repair_ticket_media.item_id (which item a photo/video belongs to), repair_tickets.preferred_days /
-- preferred_slot (the customer's wished visit days), customer_link_tokens (24 h one-use links sent in LINE,
-- service role only; one admin_reads policy) and submit_repair_form(), the atomic claim + insert that the
-- repair-form edge function calls with the service role.
-- Payload keys are camelCase, the FormPayload shape in supabase/functions/_shared/repair-form.ts (ruling R1):
--   { siteId, description, preferredDays: ['YYYY-MM-DD'], preferredSlot,
--     items: [{ location, room, symptom, note, files: [{ path, mediaType, bytes }] }] }
-- description is filled by the function (itemsDescription + optional note, ruling R6); the function also runs
-- validateRepairForm. This RPC re-checks only what the function cannot be trusted with: the token, the site
-- belongs to the token's client, and every file sits under <tenant_id>/form-<token_id>/.
-- The tenant, client and LINE user always come from the token row, never from the payload.
-- No view selects repair_tickets.* or repair_ticket_media.* (grep of supabase/migrations 2026-11-25), so no
-- view needs recreating for the new columns. pending_counts() 'repair_pending' already counts
-- status = 'pending_review', so it needs no change.

-- ---- repair_ticket_items ----
CREATE TABLE public.repair_ticket_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  ticket_id   uuid NOT NULL REFERENCES public.repair_tickets(id) ON DELETE CASCADE,
  seq         int NOT NULL,
  location    text NOT NULL,
  room        text,
  symptom     text NOT NULL,
  note        text,
  result      text CHECK (result IN ('fixed','partial','not_fixed')),
  result_note text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, seq)
);

CREATE INDEX repair_ticket_items_tenant_ticket ON public.repair_ticket_items (tenant_id, ticket_id);

ALTER TABLE public.repair_ticket_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.repair_ticket_items FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.repair_ticket_items TO authenticated;

CREATE POLICY admin_select ON public.repair_ticket_items FOR SELECT TO authenticated
  USING ((SELECT is_admin_or_owner()) AND tenant_id = (SELECT current_tenant_id()));

CREATE POLICY admin_insert ON public.repair_ticket_items FOR INSERT TO authenticated
  WITH CHECK ((SELECT is_admin_or_owner()) AND tenant_id = (SELECT current_tenant_id()) AND (SELECT tenant_can_write()));

CREATE POLICY admin_update ON public.repair_ticket_items FOR UPDATE TO authenticated
  USING ((SELECT is_admin_or_owner()) AND tenant_id = (SELECT current_tenant_id()) AND (SELECT tenant_can_write()))
  WITH CHECK ((SELECT is_admin_or_owner()) AND tenant_id = (SELECT current_tenant_id()) AND (SELECT tenant_can_write()));

CREATE POLICY admin_delete ON public.repair_ticket_items FOR DELETE TO authenticated
  USING ((SELECT is_admin_or_owner()) AND tenant_id = (SELECT current_tenant_id()) AND (SELECT tenant_can_write()));

-- ---- media → item ----
ALTER TABLE public.repair_ticket_media
  ADD COLUMN item_id uuid NULL REFERENCES public.repair_ticket_items(id) ON DELETE SET NULL;

CREATE INDEX repair_ticket_media_item ON public.repair_ticket_media (item_id) WHERE item_id IS NOT NULL;

-- ---- preferred visit days on the ticket ----
ALTER TABLE public.repair_tickets
  ADD COLUMN preferred_days date[] CHECK (preferred_days IS NULL OR cardinality(preferred_days) <= 3),
  ADD COLUMN preferred_slot text CHECK (preferred_slot IN ('morning','afternoon','all_day'));

-- ---- customer_link_tokens (service role only) ----
CREATE TABLE public.customer_link_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  client_id    uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  line_user_id text NOT NULL,
  purpose      text NOT NULL CHECK (purpose IN ('repair_form','review')),
  token        text NOT NULL UNIQUE,
  ref_id       uuid,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX customer_link_tokens_tenant_client ON public.customer_link_tokens (tenant_id, client_id);

ALTER TABLE public.customer_link_tokens ENABLE ROW LEVEL SECURITY;
-- No anon/authenticated grants (global constraint: service-role-only object). The admin_reads policy is
-- kept so a later staff screen only needs GRANT SELECT ... TO authenticated.
REVOKE ALL ON public.customer_link_tokens FROM PUBLIC, anon, authenticated;

CREATE POLICY admin_reads ON public.customer_link_tokens FOR SELECT TO authenticated
  USING ((SELECT is_admin_or_owner()) AND tenant_id = (SELECT current_tenant_id()));

-- ---- submit_repair_form ----
-- Returns {status:'ok', ticket_id, ticket_number} | {status:'already', ticket_number}
--       | {status:'invalid', reason} with reason in 'expired','not_found','site','path','empty'.
-- 'path' also covers a file whose mediaType is not image/video, whose extension is not one of
-- jpg/jpeg/png/mp4/mov/webm, or whose path repeats inside the payload (all mean "upload again").
-- Every check runs before the first insert, so an invalid call writes nothing.
CREATE OR REPLACE FUNCTION public.submit_repair_form(p_token text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tok       public.customer_link_tokens%ROWTYPE;
  v_prefix  text;
  v_site    uuid;
  v_items   jsonb;
  v_item    jsonb;
  v_file    jsonb;
  v_path    text;
  v_ext     text;
  v_paths   text[] := '{}';
  v_days    date[];
  v_slot    text;
  v_ticket  uuid;
  v_number  text;
  v_item_id uuid;
  v_seq     int := 0;
BEGIN
  SELECT * INTO tok FROM public.customer_link_tokens WHERE token = p_token FOR UPDATE;
  IF NOT FOUND OR tok.purpose <> 'repair_form' THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'not_found');
  END IF;

  IF tok.used_at IS NOT NULL THEN
    SELECT ticket_number INTO v_number FROM public.repair_tickets WHERE id = tok.ref_id;
    RETURN jsonb_build_object('status', 'already', 'ticket_number', v_number);
  END IF;

  IF tok.expires_at <= now() THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'expired');
  END IF;

  v_items := p_payload->'items';
  IF v_items IS NULL OR jsonb_typeof(v_items) <> 'array' OR jsonb_array_length(v_items) = 0 THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'empty');
  END IF;

  IF COALESCE(p_payload->>'siteId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'site');
  END IF;
  SELECT s.id INTO v_site FROM public.sites s
   WHERE s.id = (p_payload->>'siteId')::uuid
     AND s.tenant_id = tok.tenant_id
     AND s.client_id = tok.client_id
     AND s.status IS DISTINCT FROM 'Cancelled';
  IF v_site IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'site');
  END IF;

  -- Every file: under this token's folder, known type and extension, not repeated.
  v_prefix := tok.tenant_id::text || '/form-' || tok.id::text || '/';
  FOR v_item IN SELECT value FROM jsonb_array_elements(v_items) LOOP
    IF jsonb_typeof(v_item->'files') IS DISTINCT FROM 'array' THEN CONTINUE; END IF;
    FOR v_file IN SELECT value FROM jsonb_array_elements(v_item->'files') LOOP
      v_path := v_file->>'path';
      IF v_path IS NULL
         OR left(v_path, length(v_prefix)) <> v_prefix
         OR length(v_path) = length(v_prefix)
         OR position('..' IN v_path) > 0
         OR v_path = ANY(v_paths)
         OR COALESCE(v_file->>'mediaType', '') NOT IN ('image', 'video')
         OR lower(substring(v_path FROM '\.([A-Za-z0-9]+)$')) IS NULL
         OR lower(substring(v_path FROM '\.([A-Za-z0-9]+)$')) NOT IN ('jpg', 'jpeg', 'png', 'mp4', 'mov', 'webm') THEN
        RETURN jsonb_build_object('status', 'invalid', 'reason', 'path');
      END IF;
      v_paths := v_paths || v_path;
    END LOOP;
  END LOOP;

  IF jsonb_typeof(p_payload->'preferredDays') = 'array' AND jsonb_array_length(p_payload->'preferredDays') > 0 THEN
    SELECT array_agg(d.value::date ORDER BY d.ord) INTO v_days
      FROM jsonb_array_elements_text(p_payload->'preferredDays') WITH ORDINALITY AS d(value, ord);
  END IF;
  v_slot := NULLIF(p_payload->>'preferredSlot', '');

  INSERT INTO public.repair_tickets
    (tenant_id, site_id, client_id, source, line_user_id, status, description,
     preferred_days, preferred_slot, created_by)
  VALUES
    (tok.tenant_id, v_site, tok.client_id, 'line', tok.line_user_id, 'pending_review', p_payload->>'description',
     v_days, v_slot, 'line-form')
  RETURNING id, ticket_number INTO v_ticket, v_number;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_items) LOOP
    v_seq := v_seq + 1;
    INSERT INTO public.repair_ticket_items (tenant_id, ticket_id, seq, location, room, symptom, note)
    VALUES (tok.tenant_id, v_ticket, v_seq, v_item->>'location', NULLIF(btrim(v_item->>'room'), ''),
            v_item->>'symptom', NULLIF(btrim(v_item->>'note'), ''))
    RETURNING id INTO v_item_id;

    IF jsonb_typeof(v_item->'files') IS DISTINCT FROM 'array' THEN CONTINUE; END IF;
    FOR v_file IN SELECT value FROM jsonb_array_elements(v_item->'files') LOOP
      v_path := v_file->>'path';
      v_ext := lower(substring(v_path FROM '\.([A-Za-z0-9]+)$'));
      INSERT INTO public.repair_ticket_media
        (tenant_id, ticket_id, item_id, role, media_type, storage_path, file_name, mime, size_bytes)
      VALUES
        (tok.tenant_id, v_ticket, v_item_id, 'customer', v_file->>'mediaType', v_path,
         regexp_replace(v_path, '^.*/', ''),
         CASE v_ext WHEN 'jpg' THEN 'image/jpeg' WHEN 'jpeg' THEN 'image/jpeg' WHEN 'png' THEN 'image/png'
                    WHEN 'mp4' THEN 'video/mp4' WHEN 'mov' THEN 'video/quicktime' WHEN 'webm' THEN 'video/webm' END,
         CASE WHEN (v_file->>'bytes') ~ '^[0-9]+$' THEN (v_file->>'bytes')::bigint END);
    END LOOP;
  END LOOP;

  UPDATE public.customer_link_tokens SET used_at = now(), ref_id = v_ticket WHERE id = tok.id;

  RETURN jsonb_build_object('status', 'ok', 'ticket_id', v_ticket, 'ticket_number', v_number);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_repair_form(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_repair_form(text, jsonb) TO service_role;
