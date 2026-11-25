-- Dry run for 2026-11-25-01 (repair form). One request: npx supabase db query --linked -f <this file>.
-- BEGIN, the migration inlined verbatim, cases (setup, a..h) as DO blocks with ASSERTs, then ROLLBACK. Writes nothing.
-- Real demo-tenant ids on CHANG; fake LINE user Udryrun000. No psql meta-commands.
BEGIN;

-- ===================== inlined migration 2026-11-25-01 =====================
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

-- ===================== dry-run cases =====================
-- Demo tenant on CHANG. Client A owns site A (non-Cancelled); site B belongs to client B.
-- Tokens: A (valid, case a/b), C (valid, wrong site), D (valid, foreign path), E (expired), R (purpose review).

DO $$
DECLARE
  v_tenant uuid := '8b61c890-0a90-4223-91d3-b5f8f4e89908';
  v_client_a uuid := '29f9774d-a9d9-45c5-9563-adc0ab1b5c9f';
  v_base jsonb;
BEGIN
  ASSERT EXISTS (SELECT 1 FROM user_roles WHERE user_email = 'demo-admin@facadex.co.th' AND tenant_id = v_tenant),
    'SETUP: demo-admin has no role in the demo tenant';
  ASSERT EXISTS (SELECT 1 FROM sites WHERE id = 'f43c173f-4523-41dd-868c-6d8008c7e98d' AND client_id = v_client_a
                  AND tenant_id = v_tenant AND status IS DISTINCT FROM 'Cancelled'), 'SETUP: site A not usable';
  ASSERT EXISTS (SELECT 1 FROM sites WHERE id = '79c9413a-5100-494e-b2d4-252fb02e55b7'
                  AND client_id = '31dfb4e3-d3c4-4c36-8bfa-482fd6593fcc'), 'SETUP: site B not client B''s';
  ASSERT NOT EXISTS (SELECT 1 FROM repair_tickets WHERE line_user_id = 'Udryrun000'), 'SETUP: stray dry-run tickets';

  INSERT INTO customer_link_tokens (tenant_id, client_id, line_user_id, purpose, token, expires_at) VALUES
    (v_tenant, v_client_a, 'Udryrun000', 'repair_form', 'dryrun-tok-a', now() + interval '24 hours'),
    (v_tenant, v_client_a, 'Udryrun000', 'repair_form', 'dryrun-tok-c', now() + interval '24 hours'),
    (v_tenant, v_client_a, 'Udryrun000', 'repair_form', 'dryrun-tok-d', now() + interval '24 hours'),
    (v_tenant, v_client_a, 'Udryrun000', 'repair_form', 'dryrun-tok-e', now() - interval '1 minute'),
    (v_tenant, v_client_a, 'Udryrun000', 'review',      'dryrun-tok-r', now() + interval '24 hours');

  -- bell baseline as the demo admin
  PERFORM set_config('request.jwt.claims', json_build_object('email', 'demo-admin@facadex.co.th', 'role', 'authenticated',
    'sub', 'b90ad5cb-fe84-43eb-956b-da295e2390f0')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_base := pending_counts();
  EXECUTE 'RESET ROLE';
  ASSERT v_base ? 'repair_pending', 'SETUP: pending_counts has no repair_pending key';
  PERFORM set_config('dryrun.base_pending', v_base->>'repair_pending', true);
  RAISE NOTICE 'setup ok (repair_pending baseline %)', v_base->>'repair_pending';
END $$;

-- (a) valid payload, 2 items, 3 media
DO $$
DECLARE
  v_tenant uuid := '8b61c890-0a90-4223-91d3-b5f8f4e89908';
  v_tok customer_link_tokens%ROWTYPE;
  v_pre text;
  v_d1 date := (now() AT TIME ZONE 'Asia/Bangkok')::date + 2;
  v_d2 date := (now() AT TIME ZONE 'Asia/Bangkok')::date + 5;
  r jsonb;
  t repair_tickets%ROWTYPE;
  v_item1 uuid;
  v_n int;
  v_cnt jsonb;
BEGIN
  SELECT * INTO v_tok FROM customer_link_tokens WHERE token = 'dryrun-tok-a';
  v_pre := v_tenant::text || '/form-' || v_tok.id::text || '/';
  r := submit_repair_form('dryrun-tok-a', jsonb_build_object(
    'tenantId', '00000000-0000-0000-0000-000000000000',   -- must be ignored
    'siteId', 'f43c173f-4523-41dd-868c-6d8008c7e98d',
    'description', E'1. ห้องนอน (ชั้น 2) — รั่วซึม\n2. ครัว — อื่นๆ: กระจกมีฝ้า',
    'preferredDays', jsonb_build_array(v_d1::text, v_d2::text),
    'preferredSlot', 'morning',
    'items', jsonb_build_array(
      jsonb_build_object('location', 'ห้องนอน', 'room', 'ชั้น 2', 'symptom', 'รั่วซึม', 'files', jsonb_build_array(
        jsonb_build_object('path', v_pre || 'i1-a.jpg', 'mediaType', 'image', 'bytes', 123456),
        jsonb_build_object('path', v_pre || 'i1-b.mov', 'mediaType', 'video', 'bytes', 7654321))),
      jsonb_build_object('location', 'ครัว', 'symptom', 'อื่นๆ', 'note', 'กระจกมีฝ้า', 'files', jsonb_build_array(
        jsonb_build_object('path', v_pre || 'i2-a.png', 'mediaType', 'image', 'bytes', 2048))))));
  ASSERT r->>'status' = 'ok', format('(a) status %s', r);
  SELECT * INTO t FROM repair_tickets WHERE id = (r->>'ticket_id')::uuid;
  ASSERT t.id IS NOT NULL, '(a) ticket row missing';
  ASSERT t.ticket_number = r->>'ticket_number' AND t.ticket_number LIKE 'RP____-%', format('(a) number %s', t.ticket_number);
  ASSERT t.tenant_id = v_tenant, '(a) tenant not from token';
  ASSERT t.client_id = '29f9774d-a9d9-45c5-9563-adc0ab1b5c9f' AND t.site_id = 'f43c173f-4523-41dd-868c-6d8008c7e98d', '(a) client/site';
  ASSERT t.status = 'pending_review' AND t.source = 'line' AND t.line_user_id = 'Udryrun000' AND t.created_by = 'line-form',
    format('(a) status=%s source=%s line=%s by=%s', t.status, t.source, t.line_user_id, t.created_by);
  ASSERT t.description LIKE '1. ห้องนอน (ชั้น 2) — รั่วซึม%', format('(a) description %s', t.description);
  ASSERT t.preferred_days = ARRAY[v_d1, v_d2] AND t.preferred_slot = 'morning', format('(a) days %s slot %s', t.preferred_days, t.preferred_slot);

  SELECT count(*) INTO v_n FROM repair_ticket_items WHERE ticket_id = t.id AND tenant_id = v_tenant;
  ASSERT v_n = 2, format('(a) %s item rows', v_n);
  SELECT id INTO v_item1 FROM repair_ticket_items WHERE ticket_id = t.id AND seq = 1
     AND location = 'ห้องนอน' AND room = 'ชั้น 2' AND symptom = 'รั่วซึม' AND note IS NULL AND result IS NULL;
  ASSERT v_item1 IS NOT NULL, '(a) item 1 fields';
  ASSERT EXISTS (SELECT 1 FROM repair_ticket_items WHERE ticket_id = t.id AND seq = 2 AND location = 'ครัว'
                  AND room IS NULL AND symptom = 'อื่นๆ' AND note = 'กระจกมีฝ้า'), '(a) item 2 fields';

  SELECT count(*) INTO v_n FROM repair_ticket_media WHERE ticket_id = t.id AND item_id IS NOT NULL
     AND role = 'customer' AND tenant_id = v_tenant;
  ASSERT v_n = 3, format('(a) %s media rows with item_id', v_n);
  SELECT count(*) INTO v_n FROM repair_ticket_media WHERE item_id = v_item1;
  ASSERT v_n = 2, format('(a) item 1 has %s media', v_n);
  ASSERT EXISTS (SELECT 1 FROM repair_ticket_media WHERE item_id = v_item1 AND storage_path = v_pre || 'i1-b.mov'
                  AND media_type = 'video' AND file_name = 'i1-b.mov' AND mime = 'video/quicktime' AND size_bytes = 7654321),
    '(a) video media fields';
  ASSERT EXISTS (SELECT 1 FROM repair_ticket_media WHERE item_id = v_item1 AND file_name = 'i1-a.jpg' AND mime = 'image/jpeg'),
    '(a) jpg mime';
  ASSERT EXISTS (SELECT 1 FROM repair_ticket_media WHERE ticket_id = t.id AND item_id <> v_item1 AND file_name = 'i2-a.png'
                  AND mime = 'image/png' AND size_bytes = 2048), '(a) png on item 2';

  SELECT * INTO v_tok FROM customer_link_tokens WHERE token = 'dryrun-tok-a';
  ASSERT v_tok.used_at IS NOT NULL AND v_tok.ref_id = t.id, '(a) token not claimed';

  -- bell key counts the new ticket
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_cnt := pending_counts();
  EXECUTE 'RESET ROLE';
  ASSERT (v_cnt->>'repair_pending')::int = current_setting('dryrun.base_pending')::int + 1,
    format('(a) repair_pending %s, baseline %s', v_cnt->>'repair_pending', current_setting('dryrun.base_pending'));
  RAISE NOTICE 'case a ok (ticket %)', t.ticket_number;
END $$;

-- (b) same token again -> already, same number, still one ticket
DO $$
DECLARE
  r jsonb;
  v_num text;
  v_n int;
BEGIN
  SELECT ticket_number INTO v_num FROM repair_tickets WHERE line_user_id = 'Udryrun000';
  r := submit_repair_form('dryrun-tok-a', jsonb_build_object('siteId', 'f43c173f-4523-41dd-868c-6d8008c7e98d',
         'items', jsonb_build_array(jsonb_build_object('location', 'ครัว', 'symptom', 'รั่วซึม', 'files', '[]'::jsonb))));
  ASSERT r->>'status' = 'already' AND r->>'ticket_number' = v_num, format('(b) %s, expected %s', r, v_num);
  SELECT count(*) INTO v_n FROM repair_tickets WHERE line_user_id = 'Udryrun000';
  ASSERT v_n = 1, format('(b) %s tickets', v_n);
  RAISE NOTICE 'case b ok';
END $$;

-- (c) fresh token, another client's site -> invalid/site, nothing written
DO $$
DECLARE
  v_tok customer_link_tokens%ROWTYPE;
  v_pre text;
  r jsonb;
  v_n int;
BEGIN
  SELECT * INTO v_tok FROM customer_link_tokens WHERE token = 'dryrun-tok-c';
  v_pre := v_tok.tenant_id::text || '/form-' || v_tok.id::text || '/';
  r := submit_repair_form('dryrun-tok-c', jsonb_build_object('siteId', '79c9413a-5100-494e-b2d4-252fb02e55b7',
         'description', 'x', 'items', jsonb_build_array(jsonb_build_object('location', 'ครัว', 'symptom', 'รั่วซึม',
           'files', jsonb_build_array(jsonb_build_object('path', v_pre || 'a.jpg', 'mediaType', 'image', 'bytes', 1))))));
  ASSERT r = jsonb_build_object('status', 'invalid', 'reason', 'site'), format('(c) %s', r);
  r := submit_repair_form('dryrun-tok-c', jsonb_build_object('siteId', 'not-a-uuid',
         'items', jsonb_build_array(jsonb_build_object('location', 'ครัว', 'symptom', 'รั่วซึม', 'files', '[]'::jsonb))));
  ASSERT r->>'reason' = 'site', format('(c) bad uuid %s', r);
  SELECT count(*) INTO v_n FROM repair_tickets WHERE line_user_id = 'Udryrun000';
  ASSERT v_n = 1, format('(c) %s tickets', v_n);
  SELECT count(*) INTO v_n FROM repair_ticket_media WHERE storage_path LIKE v_pre || '%';
  ASSERT v_n = 0, '(c) media written';
  ASSERT (SELECT used_at IS NULL FROM customer_link_tokens WHERE token = 'dryrun-tok-c'), '(c) token claimed';
  RAISE NOTICE 'case c ok';
END $$;

-- (d) path under another token's folder (and other bad paths) -> invalid/path, nothing written
DO $$
DECLARE
  v_tenant text := '8b61c890-0a90-4223-91d3-b5f8f4e89908';
  v_other uuid;
  v_own uuid;
  r jsonb;
  v_bad text;
  v_n int;
BEGIN
  SELECT id INTO v_other FROM customer_link_tokens WHERE token = 'dryrun-tok-a';
  SELECT id INTO v_own FROM customer_link_tokens WHERE token = 'dryrun-tok-d';
  FOREACH v_bad IN ARRAY ARRAY[
    v_tenant || '/form-' || v_other::text || '/x.jpg',                      -- another token's folder
    '00000000-0000-0000-0000-000000000000/form-' || v_own::text || '/x.jpg', -- another tenant
    v_tenant || '/form-' || v_own::text || '/../x.jpg',                     -- traversal
    v_tenant || '/form-' || v_own::text || '/x.exe',                        -- unknown extension
    v_tenant || '/form-' || v_own::text || '/'                              -- folder only
  ] LOOP
    r := submit_repair_form('dryrun-tok-d', jsonb_build_object('siteId', 'f43c173f-4523-41dd-868c-6d8008c7e98d',
           'description', 'x', 'items', jsonb_build_array(
             jsonb_build_object('location', 'ครัว', 'symptom', 'รั่วซึม', 'files', jsonb_build_array(
               jsonb_build_object('path', v_tenant || '/form-' || v_own::text || '/ok.jpg', 'mediaType', 'image', 'bytes', 1))),
             jsonb_build_object('location', 'ห้องน้ำ', 'symptom', 'รั่วซึม', 'files', jsonb_build_array(
               jsonb_build_object('path', v_bad, 'mediaType', 'image', 'bytes', 1))))));
    ASSERT r = jsonb_build_object('status', 'invalid', 'reason', 'path'), format('(d) %s -> %s', v_bad, r);
  END LOOP;
  SELECT count(*) INTO v_n FROM repair_tickets WHERE line_user_id = 'Udryrun000';
  ASSERT v_n = 1, format('(d) %s tickets', v_n);
  ASSERT (SELECT used_at IS NULL FROM customer_link_tokens WHERE token = 'dryrun-tok-d'), '(d) token claimed';
  RAISE NOTICE 'case d ok';
END $$;

-- (e) expired token -> invalid/expired
DO $$
DECLARE r jsonb;
BEGIN
  r := submit_repair_form('dryrun-tok-e', jsonb_build_object('siteId', 'f43c173f-4523-41dd-868c-6d8008c7e98d',
         'items', jsonb_build_array(jsonb_build_object('location', 'ครัว', 'symptom', 'รั่วซึม', 'files', '[]'::jsonb))));
  ASSERT r = jsonb_build_object('status', 'invalid', 'reason', 'expired'), format('(e) %s', r);
  RAISE NOTICE 'case e ok';
END $$;

-- (f) demo admin through RLS: SELECT + real UPDATE on repair_ticket_items; tokens table not readable
DO $$
DECLARE
  v_ticket uuid;
  v_n int;
  v_res text;
BEGIN
  SELECT id INTO v_ticket FROM repair_tickets WHERE line_user_id = 'Udryrun000';
  PERFORM set_config('request.jwt.claims', json_build_object('email', 'demo-admin@facadex.co.th', 'role', 'authenticated',
    'sub', 'b90ad5cb-fe84-43eb-956b-da295e2390f0')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_n FROM repair_ticket_items WHERE ticket_id = v_ticket;
  ASSERT v_n = 2, format('(f) admin sees %s items', v_n);
  UPDATE repair_ticket_items SET result = 'fixed' WHERE ticket_id = v_ticket AND seq = 1;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  ASSERT v_n = 1, format('(f) update touched %s rows', v_n);
  SELECT count(*) INTO v_n FROM repair_ticket_media WHERE ticket_id = v_ticket AND item_id IS NOT NULL;
  ASSERT v_n = 3, format('(f) admin sees %s media', v_n);
  BEGIN
    PERFORM 1 FROM customer_link_tokens LIMIT 1;
    v_res := 'readable';
  EXCEPTION WHEN insufficient_privilege THEN
    v_res := 'denied';
  END;
  EXECUTE 'RESET ROLE';
  ASSERT v_res = 'denied', '(f) authenticated can read customer_link_tokens';
  ASSERT (SELECT result FROM repair_ticket_items WHERE ticket_id = v_ticket AND seq = 1) = 'fixed', '(f) result not saved';
  RAISE NOTICE 'case f ok';
END $$;

-- (g) anon / authenticated cannot EXECUTE submit_repair_form; service_role can
DO $$
DECLARE v_res text;
BEGIN
  ASSERT NOT has_function_privilege('anon', 'public.submit_repair_form(text, jsonb)', 'EXECUTE'), '(g) anon has EXECUTE';
  ASSERT NOT has_function_privilege('authenticated', 'public.submit_repair_form(text, jsonb)', 'EXECUTE'), '(g) authenticated has EXECUTE';
  ASSERT has_function_privilege('service_role', 'public.submit_repair_form(text, jsonb)', 'EXECUTE'), '(g) service_role lacks EXECUTE';
  EXECUTE 'SET LOCAL ROLE anon';
  BEGIN
    PERFORM submit_repair_form('dryrun-tok-c', '{}'::jsonb);
    v_res := 'ran';
  EXCEPTION WHEN insufficient_privilege THEN
    v_res := 'denied';
  END;
  EXECUTE 'RESET ROLE';
  ASSERT v_res = 'denied', '(g) anon call was not denied';
  RAISE NOTICE 'case g ok';
END $$;

-- (h) extra: unknown token and a review-purpose token -> invalid/not_found (ruling R3); empty items -> invalid/empty
DO $$
DECLARE r jsonb;
BEGIN
  r := submit_repair_form('dryrun-no-such-token', '{}'::jsonb);
  ASSERT r = jsonb_build_object('status', 'invalid', 'reason', 'not_found'), format('(h) unknown %s', r);
  r := submit_repair_form('dryrun-tok-r', jsonb_build_object('siteId', 'f43c173f-4523-41dd-868c-6d8008c7e98d'));
  ASSERT r = jsonb_build_object('status', 'invalid', 'reason', 'not_found'), format('(h) review %s', r);
  r := submit_repair_form('dryrun-tok-c', jsonb_build_object('siteId', 'f43c173f-4523-41dd-868c-6d8008c7e98d', 'items', '[]'::jsonb));
  ASSERT r = jsonb_build_object('status', 'invalid', 'reason', 'empty'), format('(h) empty %s', r);
  r := submit_repair_form('dryrun-tok-c', jsonb_build_object('siteId', 'f43c173f-4523-41dd-868c-6d8008c7e98d'));
  ASSERT r->>'reason' = 'empty', format('(h) no items key %s', r);
  RAISE NOTICE 'case h ok';
END $$;

ROLLBACK;
