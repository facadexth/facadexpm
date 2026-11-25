-- Dry run for 2026-11-25-03 (repair work order: crew tokens + receipt type). One request:
--   npx supabase db query --linked -f <this file>
-- BEGIN, pre-checks on the live constraints, the migration inlined verbatim (without its BEGIN/COMMIT),
-- cases as DO blocks with ASSERTs, then RAISE EXCEPTION 'RESULT ok' so everything rolls back. Writes nothing.
-- Demo tenant on CHANG, demo ticket RP2611-001 looked up by number. No psql meta-commands.
BEGIN;

-- ===================== pre-checks: live constraint names + values =====================
DO $$
DECLARE
  v_def text;
BEGIN
  -- action_type CHECK exists by this name and holds exactly the 7 live values
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.line_deep_link_tokens'::regclass AND contype = 'c'
     AND conname = 'line_deep_link_tokens_action_type_check';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'PRE: constraint line_deep_link_tokens_action_type_check not found';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(v_def, '''[a-z_]+''', 'g')) <> 7
     OR v_def NOT LIKE '%''material_request''%' OR v_def NOT LIKE '%''leave''%'
     OR v_def NOT LIKE '%''check_in''%' OR v_def NOT LIKE '%''check_out''%'
     OR v_def NOT LIKE '%''advance''%' OR v_def NOT LIKE '%''payslip''%'
     OR v_def NOT LIKE '%''time_clock''%' THEN
    RAISE EXCEPTION 'PRE: action_type CHECK differs from the 7 expected values: %', v_def;
  END IF;

  -- no other CHECK on the token table that the new one could contradict
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.line_deep_link_tokens'::regclass AND contype = 'c'
              AND conname <> 'line_deep_link_tokens_action_type_check') THEN
    RAISE EXCEPTION 'PRE: unexpected extra CHECK on line_deep_link_tokens: %',
      (SELECT string_agg(conname || ' ' || pg_get_constraintdef(oid), '; ') FROM pg_constraint
        WHERE conrelid = 'public.line_deep_link_tokens'::regclass AND contype = 'c'
          AND conname <> 'line_deep_link_tokens_action_type_check');
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
              AND table_name = 'line_deep_link_tokens' AND column_name = 'repair_ticket_id') THEN
    RAISE EXCEPTION 'PRE: repair_ticket_id already exists';
  END IF;

  -- document_type CHECKs exist by name and hold exactly the 4 live values
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.document_receipts'::regclass AND contype = 'c'
     AND conname = 'document_receipts_document_type_check';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'PRE: constraint document_receipts_document_type_check not found';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(v_def, '''[a-z_]+''', 'g')) <> 4
     OR v_def NOT LIKE '%''cheque''%' OR v_def NOT LIKE '%''quotation''%'
     OR v_def NOT LIKE '%''invoice''%' OR v_def NOT LIKE '%''delivery_report''%' THEN
    RAISE EXCEPTION 'PRE: document_receipts document_type CHECK differs: %', v_def;
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.document_receipt_links'::regclass AND contype = 'c'
     AND conname = 'document_receipt_links_document_type_check';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'PRE: constraint document_receipt_links_document_type_check not found';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(v_def, '''[a-z_]+''', 'g')) <> 4
     OR v_def NOT LIKE '%''cheque''%' OR v_def NOT LIKE '%''quotation''%'
     OR v_def NOT LIKE '%''invoice''%' OR v_def NOT LIKE '%''delivery_report''%' THEN
    RAISE EXCEPTION 'PRE: document_receipt_links document_type CHECK differs: %', v_def;
  END IF;

  RAISE NOTICE 'pre-checks ok';
END $$;

-- ===================== inlined migration 2026-11-25-03 (BEGIN/COMMIT removed) =====================
ALTER TABLE public.line_deep_link_tokens
  ADD COLUMN repair_ticket_id uuid NULL REFERENCES public.repair_tickets(id) ON DELETE CASCADE;

CREATE INDEX line_deep_link_tokens_repair_ticket ON public.line_deep_link_tokens (repair_ticket_id)
  WHERE repair_ticket_id IS NOT NULL;

ALTER TABLE public.line_deep_link_tokens DROP CONSTRAINT line_deep_link_tokens_action_type_check;
ALTER TABLE public.line_deep_link_tokens ADD CONSTRAINT line_deep_link_tokens_action_type_check
  CHECK (action_type = ANY (ARRAY['material_request','leave','check_in','check_out','advance','payslip','time_clock',
                                  'repair_workorder']));

ALTER TABLE public.line_deep_link_tokens ADD CONSTRAINT line_deep_link_tokens_repair_ticket_check
  CHECK ((action_type = 'repair_workorder') = (repair_ticket_id IS NOT NULL));

REVOKE ALL ON public.line_deep_link_tokens FROM PUBLIC, anon;

ALTER TABLE public.document_receipts DROP CONSTRAINT document_receipts_document_type_check;
ALTER TABLE public.document_receipts ADD CONSTRAINT document_receipts_document_type_check
  CHECK (document_type IN ('cheque', 'quotation', 'invoice', 'delivery_report', 'repair_ticket'));

ALTER TABLE public.document_receipt_links DROP CONSTRAINT document_receipt_links_document_type_check;
ALTER TABLE public.document_receipt_links ADD CONSTRAINT document_receipt_links_document_type_check
  CHECK (document_type IN ('cheque', 'quotation', 'invoice', 'delivery_report', 'repair_ticket'));

-- ===================== dry-run cases =====================
DO $$
DECLARE
  v_tenant uuid := '8b61c890-0a90-4223-91d3-b5f8f4e89908';
  v_ticket uuid;
  v_worker uuid;
  v_failed boolean;
  v_n int;
BEGIN
  SELECT id INTO v_ticket FROM repair_tickets WHERE tenant_id = v_tenant AND ticket_number = 'RP2611-001';
  IF v_ticket IS NULL THEN RAISE EXCEPTION 'SETUP: demo ticket RP2611-001 not found'; END IF;
  SELECT id INTO v_worker FROM workers WHERE tenant_id = v_tenant ORDER BY id LIMIT 1;
  IF v_worker IS NULL THEN RAISE EXCEPTION 'SETUP: no worker in the demo tenant'; END IF;

  -- (a) repair_workorder token with a ticket id -> ok
  INSERT INTO line_deep_link_tokens (tenant_id, worker_id, action_type, token, expires_at, repair_ticket_id)
  VALUES (v_tenant, v_worker, 'repair_workorder', 'dryrun-wo-a', now() + interval '1 day', v_ticket);
  ASSERT (SELECT repair_ticket_id FROM line_deep_link_tokens WHERE token = 'dryrun-wo-a') = v_ticket,
    '(a) token row not stored with its ticket';
  RAISE NOTICE 'case a ok';

  -- (b) repair_workorder token without a ticket id -> check_violation
  v_failed := false;
  BEGIN
    INSERT INTO line_deep_link_tokens (tenant_id, worker_id, action_type, token, expires_at)
    VALUES (v_tenant, v_worker, 'repair_workorder', 'dryrun-wo-b', now() + interval '1 day');
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  ASSERT v_failed, '(b) repair_workorder token without ticket was accepted';
  RAISE NOTICE 'case b ok';

  -- (c) another action type carrying a ticket id -> check_violation
  v_failed := false;
  BEGIN
    INSERT INTO line_deep_link_tokens (tenant_id, worker_id, action_type, token, expires_at, repair_ticket_id)
    VALUES (v_tenant, v_worker, 'leave', 'dryrun-wo-c', now() + interval '1 day', v_ticket);
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  ASSERT v_failed, '(c) leave token with a ticket id was accepted';
  RAISE NOTICE 'case c ok';

  -- (d) every old action type still accepted without a ticket id
  INSERT INTO line_deep_link_tokens (tenant_id, worker_id, action_type, token, expires_at)
  SELECT v_tenant, v_worker, a, 'dryrun-wo-d-' || a, now() + interval '1 day'
    FROM unnest(ARRAY['material_request','leave','check_in','check_out','advance','payslip','time_clock']) a;
  SELECT count(*) INTO v_n FROM line_deep_link_tokens WHERE token LIKE 'dryrun-wo-d-%';
  ASSERT v_n = 7, format('(d) expected 7 old-type tokens, got %s', v_n);
  RAISE NOTICE 'case d ok';

  -- (e) unknown action type still rejected
  v_failed := false;
  BEGIN
    INSERT INTO line_deep_link_tokens (tenant_id, worker_id, action_type, token, expires_at)
    VALUES (v_tenant, v_worker, 'nope', 'dryrun-wo-e', now() + interval '1 day');
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  ASSERT v_failed, '(e) unknown action type was accepted';
  RAISE NOTICE 'case e ok';

  -- (f) document_receipts + document_receipt_links rows of type repair_ticket -> ok
  INSERT INTO document_receipts (tenant_id, document_type, document_id, signer_name, signature_path, signed_by)
  VALUES (v_tenant, 'repair_ticket', v_ticket, 'dryrun ลูกค้า', v_tenant::text || '/dryrun-sig.png', 'dryrun');
  INSERT INTO document_receipt_links (tenant_id, document_type, document_id, created_by)
  VALUES (v_tenant, 'repair_ticket', v_ticket, 'dryrun');
  ASSERT (SELECT count(*) FROM document_receipts WHERE document_type = 'repair_ticket' AND document_id = v_ticket
            AND signed_by = 'dryrun') = 1, '(f) receipt row missing';
  RAISE NOTICE 'case f ok';

  -- (g) the old types still accepted, an unknown one rejected
  INSERT INTO document_receipt_links (tenant_id, document_type, document_id, created_by)
  SELECT v_tenant, t, gen_random_uuid(), 'dryrun'
    FROM unnest(ARRAY['cheque','quotation','invoice','delivery_report']) t;
  v_failed := false;
  BEGIN
    INSERT INTO document_receipts (tenant_id, document_type, document_id, signer_name, signature_path, signed_by)
    VALUES (v_tenant, 'nope', v_ticket, 'x', 'x', 'dryrun');
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  ASSERT v_failed, '(g) unknown document_type was accepted';
  RAISE NOTICE 'case g ok';

  -- (h) anon has no privilege on the token table
  ASSERT NOT has_table_privilege('anon', 'public.line_deep_link_tokens', 'SELECT'), '(h) anon can SELECT tokens';
  ASSERT NOT has_table_privilege('anon', 'public.line_deep_link_tokens', 'INSERT'), '(h) anon can INSERT tokens';
  ASSERT has_table_privilege('service_role', 'public.line_deep_link_tokens', 'INSERT'), '(h) service_role lost INSERT';
  RAISE NOTICE 'case h ok';
END $$;

DO $$ BEGIN RAISE EXCEPTION 'RESULT ok'; END $$;
