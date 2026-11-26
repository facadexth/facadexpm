-- Dry run for 2026-11-26-01 (crew daily job sheet: site_jobsheet tokens + sites.safety_note). One request:
--   npx supabase db query --linked -f <this file>
-- BEGIN, pre-checks on the live constraints, the migration inlined verbatim (without its BEGIN/COMMIT),
-- cases as DO blocks with ASSERTs, then RAISE EXCEPTION 'RESULT ok' so everything rolls back. Writes nothing.
-- Demo tenant on CHANG, any of its sites / workers; demo ticket RP2611-001 for the repair_workorder case.
-- No psql meta-commands.
BEGIN;

-- ===================== pre-checks: live constraint names + values =====================
DO $$
DECLARE
  v_def text;
BEGIN
  -- action_type CHECK exists by this name and holds exactly the 8 live values
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.line_deep_link_tokens'::regclass AND contype = 'c'
     AND conname = 'line_deep_link_tokens_action_type_check';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'PRE: constraint line_deep_link_tokens_action_type_check not found';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(v_def, '''[a-z_]+''', 'g')) <> 8
     OR v_def NOT LIKE '%''material_request''%' OR v_def NOT LIKE '%''leave''%'
     OR v_def NOT LIKE '%''check_in''%' OR v_def NOT LIKE '%''check_out''%'
     OR v_def NOT LIKE '%''advance''%' OR v_def NOT LIKE '%''payslip''%'
     OR v_def NOT LIKE '%''time_clock''%' OR v_def NOT LIKE '%''repair_workorder''%' THEN
    RAISE EXCEPTION 'PRE: action_type CHECK differs from the 8 expected values: %', v_def;
  END IF;

  -- the only other CHECK on the token table is repair_ticket_check (2026-11-25-03), with its known definition
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.line_deep_link_tokens'::regclass AND contype = 'c'
              AND conname NOT IN ('line_deep_link_tokens_action_type_check',
                                  'line_deep_link_tokens_repair_ticket_check')) THEN
    RAISE EXCEPTION 'PRE: unexpected extra CHECK on line_deep_link_tokens: %',
      (SELECT string_agg(conname || ' ' || pg_get_constraintdef(oid), '; ') FROM pg_constraint
        WHERE conrelid = 'public.line_deep_link_tokens'::regclass AND contype = 'c'
          AND conname NOT IN ('line_deep_link_tokens_action_type_check',
                              'line_deep_link_tokens_repair_ticket_check'));
  END IF;
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.line_deep_link_tokens'::regclass AND contype = 'c'
     AND conname = 'line_deep_link_tokens_repair_ticket_check';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'PRE: constraint line_deep_link_tokens_repair_ticket_check not found';
  END IF;
  IF v_def NOT LIKE '%repair_workorder%' OR v_def NOT LIKE '%repair_ticket_id IS NOT NULL%' THEN
    RAISE EXCEPTION 'PRE: repair_ticket_check differs: %', v_def;
  END IF;

  -- site_id column exists (2026-10-20-03); the new CHECK names already free
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                  AND table_name = 'line_deep_link_tokens' AND column_name = 'site_id') THEN
    RAISE EXCEPTION 'PRE: line_deep_link_tokens.site_id missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN ('line_deep_link_tokens_site_jobsheet_check',
                                                           'sites_safety_note_length_check')) THEN
    RAISE EXCEPTION 'PRE: a new constraint name already exists';
  END IF;

  -- sites.safety_note not there yet
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
              AND table_name = 'sites' AND column_name = 'safety_note') THEN
    RAISE EXCEPTION 'PRE: sites.safety_note already exists';
  END IF;

  RAISE NOTICE 'pre-checks ok';
END $$;

-- ===================== inlined migration 2026-11-26-01 (BEGIN/COMMIT removed) =====================
ALTER TABLE public.line_deep_link_tokens DROP CONSTRAINT line_deep_link_tokens_action_type_check;
ALTER TABLE public.line_deep_link_tokens ADD CONSTRAINT line_deep_link_tokens_action_type_check
  CHECK (action_type = ANY (ARRAY['material_request','leave','check_in','check_out','advance','payslip','time_clock',
                                  'repair_workorder','site_jobsheet']));

ALTER TABLE public.line_deep_link_tokens ADD CONSTRAINT line_deep_link_tokens_site_jobsheet_check
  CHECK (action_type <> 'site_jobsheet' OR site_id IS NOT NULL);

ALTER TABLE public.sites ADD COLUMN safety_note text NULL;
ALTER TABLE public.sites ADD CONSTRAINT sites_safety_note_length_check
  CHECK (char_length(safety_note) <= 500);

-- ===================== dry-run cases =====================
DO $$
DECLARE
  v_tenant uuid := '8b61c890-0a90-4223-91d3-b5f8f4e89908';
  v_site uuid;
  v_ticket uuid;
  v_worker uuid;
  v_failed boolean;
  v_n int;
BEGIN
  SELECT id INTO v_site FROM sites WHERE tenant_id = v_tenant ORDER BY id LIMIT 1;
  IF v_site IS NULL THEN RAISE EXCEPTION 'SETUP: no site in the demo tenant'; END IF;
  SELECT id INTO v_worker FROM workers WHERE tenant_id = v_tenant ORDER BY id LIMIT 1;
  IF v_worker IS NULL THEN RAISE EXCEPTION 'SETUP: no worker in the demo tenant'; END IF;
  SELECT id INTO v_ticket FROM repair_tickets WHERE tenant_id = v_tenant AND ticket_number = 'RP2611-001';
  IF v_ticket IS NULL THEN RAISE EXCEPTION 'SETUP: demo ticket RP2611-001 not found'; END IF;

  -- (a) site_jobsheet token with a site -> ok
  INSERT INTO line_deep_link_tokens (tenant_id, worker_id, action_type, token, expires_at, site_id)
  VALUES (v_tenant, v_worker, 'site_jobsheet', 'dryrun-js-a', now() + interval '1 day', v_site);
  ASSERT (SELECT site_id FROM line_deep_link_tokens WHERE token = 'dryrun-js-a') = v_site,
    '(a) token row not stored with its site';
  RAISE NOTICE 'case a ok';

  -- (b) site_jobsheet token without a site -> check_violation
  v_failed := false;
  BEGIN
    INSERT INTO line_deep_link_tokens (tenant_id, worker_id, action_type, token, expires_at)
    VALUES (v_tenant, v_worker, 'site_jobsheet', 'dryrun-js-b', now() + interval '1 day');
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  ASSERT v_failed, '(b) site_jobsheet token without site was accepted';
  RAISE NOTICE 'case b ok';

  -- (c) site_jobsheet token carrying a repair ticket -> check_violation (repair_ticket_check)
  v_failed := false;
  BEGIN
    INSERT INTO line_deep_link_tokens (tenant_id, worker_id, action_type, token, expires_at, site_id, repair_ticket_id)
    VALUES (v_tenant, v_worker, 'site_jobsheet', 'dryrun-js-c', now() + interval '1 day', v_site, v_ticket);
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  ASSERT v_failed, '(c) site_jobsheet token with a repair ticket was accepted';
  RAISE NOTICE 'case c ok';

  -- (d) all 8 old action types still accepted (7 without site/ticket, repair_workorder with its ticket)
  INSERT INTO line_deep_link_tokens (tenant_id, worker_id, action_type, token, expires_at)
  SELECT v_tenant, v_worker, a, 'dryrun-js-d-' || a, now() + interval '1 day'
    FROM unnest(ARRAY['material_request','leave','check_in','check_out','advance','payslip','time_clock']) a;
  INSERT INTO line_deep_link_tokens (tenant_id, worker_id, action_type, token, expires_at, repair_ticket_id)
  VALUES (v_tenant, v_worker, 'repair_workorder', 'dryrun-js-d-repair_workorder', now() + interval '1 day', v_ticket);
  -- check_in with a site still fine (site_id stays optional for other kinds)
  INSERT INTO line_deep_link_tokens (tenant_id, worker_id, action_type, token, expires_at, site_id)
  VALUES (v_tenant, v_worker, 'check_in', 'dryrun-js-d-check_in-site', now() + interval '1 day', v_site);
  SELECT count(*) INTO v_n FROM line_deep_link_tokens WHERE token LIKE 'dryrun-js-d-%';
  ASSERT v_n = 9, format('(d) expected 9 old-type tokens, got %s', v_n);
  RAISE NOTICE 'case d ok';

  -- (e) unknown action type still rejected
  v_failed := false;
  BEGIN
    INSERT INTO line_deep_link_tokens (tenant_id, worker_id, action_type, token, expires_at, site_id)
    VALUES (v_tenant, v_worker, 'nope', 'dryrun-js-e', now() + interval '1 day', v_site);
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  ASSERT v_failed, '(e) unknown action type was accepted';
  RAISE NOTICE 'case e ok';

  -- (f) sites.safety_note: 500 chars ok, NULL ok, 501 chars -> check_violation
  UPDATE sites SET safety_note = repeat('ก', 500) WHERE id = v_site;
  ASSERT (SELECT char_length(safety_note) FROM sites WHERE id = v_site) = 500, '(f) 500-char note not stored';
  UPDATE sites SET safety_note = NULL WHERE id = v_site;
  ASSERT (SELECT safety_note FROM sites WHERE id = v_site) IS NULL, '(f) NULL note not stored';
  v_failed := false;
  BEGIN
    UPDATE sites SET safety_note = repeat('ก', 501) WHERE id = v_site;
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  ASSERT v_failed, '(f) 501-char safety_note was accepted';
  RAISE NOTICE 'case f ok';

  -- (g) anon still has no privilege on the token table (2026-11-25-03 REVOKE untouched)
  ASSERT NOT has_table_privilege('anon', 'public.line_deep_link_tokens', 'SELECT'), '(g) anon can SELECT tokens';
  ASSERT has_table_privilege('service_role', 'public.line_deep_link_tokens', 'INSERT'), '(g) service_role lost INSERT';
  RAISE NOTICE 'case g ok';
END $$;

DO $$ BEGIN RAISE EXCEPTION 'RESULT ok'; END $$;
