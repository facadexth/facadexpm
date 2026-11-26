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

  -- PM RPCs (R11): live definitions still match 2026-10-17-06, which the migration copies
  IF pg_get_function_result('public.pm_sites()'::regprocedure) <>
     'TABLE(id uuid, site_number text, name text, short_name text, status text, start_date date, end_date date, '
     'client_id uuid, client_name text, location text, map_url text, lat numeric, lng numeric, distance_km numeric, '
     'travel_minutes integer, is_default boolean, notes text, created_at timestamp with time zone)' THEN
    RAISE EXCEPTION 'PRE: pm_sites() result differs from 2026-10-17-06: %',
      pg_get_function_result('public.pm_sites()'::regprocedure);
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.pm_update_site(uuid,jsonb)'::regprocedure) NOT LIKE
     '%ARRAY[''name'',''short_name'',''status'',''start_date'',''end_date'',''location'',''map_url'',''lat'',''lng'',''distance_km'',''travel_minutes'',''notes''];%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.pm_update_site(uuid,jsonb)'::regprocedure) LIKE '%safety_note%' THEN
    RAISE EXCEPTION 'PRE: pm_update_site whitelist differs from 2026-10-17-06';
  END IF;
  -- nothing tracked depends on pm_sites() (a view or BEGIN ATOMIC body would block the DROP)
  IF EXISTS (SELECT 1 FROM pg_depend WHERE refobjid = 'public.pm_sites()'::regprocedure AND deptype = 'n') THEN
    RAISE EXCEPTION 'PRE: objects depend on pm_sites(): %',
      (SELECT string_agg(classid::regclass::text || ' ' || objid, ', ') FROM pg_depend
        WHERE refobjid = 'public.pm_sites()'::regprocedure AND deptype = 'n');
  END IF;

  -- app_settings pm_reads still the 2026-10-24-01 definition: SELECT, is_pm + tenant, exactly 5 keys
  SELECT pg_get_expr(polqual, polrelid) INTO v_def FROM pg_policy
   WHERE polrelid = 'public.app_settings'::regclass AND polname = 'pm_reads' AND polcmd = 'r';
  IF v_def IS NULL THEN RAISE EXCEPTION 'PRE: app_settings pm_reads (SELECT) not found'; END IF;
  IF (SELECT count(*) FROM regexp_matches(v_def, '''[a-z_]+''::text', 'g')) <> 5
     OR v_def NOT LIKE '%is_pm()%' OR v_def NOT LIKE '%current_tenant_id()%'
     OR v_def NOT LIKE '%''require_checkin_confirmation''%' OR v_def NOT LIKE '%''regular_shift_end_time''%'
     OR v_def NOT LIKE '%''checkin_radius_m''%' OR v_def NOT LIKE '%''phase_template''%'
     OR v_def NOT LIKE '%''phase_templates_extra''%' THEN
    RAISE EXCEPTION 'PRE: app_settings pm_reads differs from 2026-10-24-01: %', v_def;
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

-- ---------------------------------------------------------------- PM RPCs (R11)
DROP FUNCTION public.pm_sites();
CREATE FUNCTION public.pm_sites()
RETURNS TABLE(id uuid, site_number text, name text, short_name text, status text, start_date date, end_date date,
              client_id uuid, client_name text, location text, map_url text, lat numeric, lng numeric,
              distance_km numeric, travel_minutes integer, is_default boolean, notes text, created_at timestamptz,
              safety_note text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT s.id, s.site_number, s.name, s.short_name, s.status, s.start_date, s.end_date,
         s.client_id, COALESCE(c.name, s.client_name), s.location, s.map_url, s.lat, s.lng,
         s.distance_km, s.travel_minutes, s.is_default, s.notes, s.created_at,
         s.safety_note
  FROM sites s LEFT JOIN clients c ON c.id = s.client_id
  WHERE s.tenant_id = current_tenant_id() AND is_site_staff()
  ORDER BY s.created_at DESC, s.id
$$;

CREATE OR REPLACE FUNCTION public.pm_update_site(p_site_id uuid, p_patch jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE k text;
  allowed text[] := ARRAY['name','short_name','status','start_date','end_date','location','map_url','lat','lng','distance_km','travel_minutes','notes','safety_note'];
BEGIN
  IF NOT is_site_staff() OR NOT tenant_can_write() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_patch) LOOP
    IF NOT k = ANY (allowed) THEN RAISE EXCEPTION 'field not allowed: %', k USING ERRCODE = '22023'; END IF;
  END LOOP;
  -- Unknown or other-tenant site: P0002 before any status guard, so the error
  -- code says nothing about another tenant's site status.
  IF NOT EXISTS (SELECT 1 FROM sites WHERE id = p_site_id AND tenant_id = current_tenant_id()) THEN
    RAISE EXCEPTION 'site not found' USING ERRCODE = 'P0002';
  END IF;
  -- Finishing a site moves leftover stock and stamps end_date (the OWNER/ADMIN
  -- finish flow), so a PM may not set Completed; an already-Completed site may stay so.
  IF p_patch->>'status' = 'Completed'
     AND NOT EXISTS (SELECT 1 FROM sites WHERE id = p_site_id AND status = 'Completed' AND tenant_id = current_tenant_id()) THEN
    RAISE EXCEPTION 'PM cannot complete a site' USING ERRCODE = '22023';
  END IF;
  -- Ongoing seat rule from the sites admin_updates policy
  IF p_patch ? 'status' AND p_patch->>'status' = 'Ongoing'
     AND NOT EXISTS (SELECT 1 FROM sites WHERE id = p_site_id AND status = 'Ongoing' AND tenant_id = current_tenant_id())
     AND NOT tenant_under_seat_limit('sites') THEN
    RAISE EXCEPTION 'site seat limit reached' USING ERRCODE = '54000';
  END IF;
  UPDATE sites s SET
    name           = CASE WHEN p_patch ? 'name' THEN p_patch->>'name' ELSE s.name END,
    short_name     = CASE WHEN p_patch ? 'short_name' THEN NULLIF(p_patch->>'short_name','') ELSE s.short_name END,
    status         = CASE WHEN p_patch ? 'status' THEN p_patch->>'status' ELSE s.status END,
    start_date     = CASE WHEN p_patch ? 'start_date' THEN (p_patch->>'start_date')::date ELSE s.start_date END,
    end_date       = CASE WHEN p_patch ? 'end_date' THEN (p_patch->>'end_date')::date ELSE s.end_date END,
    location       = CASE WHEN p_patch ? 'location' THEN p_patch->>'location' ELSE s.location END,
    map_url        = CASE WHEN p_patch ? 'map_url' THEN p_patch->>'map_url' ELSE s.map_url END,
    lat            = CASE WHEN p_patch ? 'lat' THEN (p_patch->>'lat')::numeric ELSE s.lat END,
    lng            = CASE WHEN p_patch ? 'lng' THEN (p_patch->>'lng')::numeric ELSE s.lng END,
    distance_km    = CASE WHEN p_patch ? 'distance_km' THEN (p_patch->>'distance_km')::numeric ELSE s.distance_km END,
    travel_minutes = CASE WHEN p_patch ? 'travel_minutes' THEN (p_patch->>'travel_minutes')::integer ELSE s.travel_minutes END,
    notes          = CASE WHEN p_patch ? 'notes' THEN p_patch->>'notes' ELSE s.notes END,
    safety_note    = CASE WHEN p_patch ? 'safety_note' THEN NULLIF(btrim(p_patch->>'safety_note'),'') ELSE s.safety_note END,
    updated_at     = now()
  WHERE s.id = p_site_id AND s.tenant_id = current_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'site not found' USING ERRCODE = 'P0002'; END IF;
END $$;

REVOKE ALL ON FUNCTION public.pm_sites(), public.pm_update_site(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_sites(), public.pm_update_site(uuid, jsonb) TO authenticated;

-- ---------------------------------------------------------------- app_settings pm_reads (PM reads the default)
-- Live definition from 2026-10-24-01-boq-default-splits-site-weights.sql, one key appended so a PM's
-- site form and job sheet read site_safety_note_default. The DROP keyword is built by concatenation
-- (same as 2026-10-24-01; the dry-run tool rejects it written out).
DO $p$ BEGIN
  EXECUTE 'DR'||'OP POLICY IF EXISTS pm_reads ON public.app_settings';
  EXECUTE $q$CREATE POLICY pm_reads ON public.app_settings FOR SELECT USING (
    (SELECT is_pm()) AND tenant_id = (SELECT current_tenant_id())
    AND key = ANY (ARRAY['require_checkin_confirmation', 'regular_shift_end_time', 'checkin_radius_m',
                         'phase_template', 'phase_templates_extra', 'site_safety_note_default']))$q$;
END $p$;

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

-- ===================== PM RPC cases (R11) =====================
DO $$
DECLARE
  v_tenant uuid := '8b61c890-0a90-4223-91d3-b5f8f4e89908';
  v_site uuid;
  v_email text;
  v_role text;
  v_failed boolean;
  v_note text;
BEGIN
  -- (h) pm_sites() returns safety_note; grants: anon none, authenticated execute, on both functions
  ASSERT pg_get_function_result('public.pm_sites()'::regprocedure) LIKE '%, safety_note text)',
    '(h) pm_sites() has no safety_note column';
  ASSERT NOT has_function_privilege('anon', 'public.pm_sites()', 'EXECUTE'), '(h) anon can execute pm_sites';
  ASSERT has_function_privilege('authenticated', 'public.pm_sites()', 'EXECUTE'), '(h) authenticated cannot execute pm_sites';
  ASSERT NOT has_function_privilege('anon', 'public.pm_update_site(uuid,jsonb)', 'EXECUTE'), '(h) anon can execute pm_update_site';
  ASSERT has_function_privilege('authenticated', 'public.pm_update_site(uuid,jsonb)', 'EXECUTE'), '(h) authenticated cannot execute pm_update_site';
  ASSERT NOT has_function_privilege('public', 'public.pm_sites()', 'EXECUTE'), '(h) PUBLIC can execute pm_sites';
  RAISE NOTICE 'case h ok';

  -- (i) as a site-staff user of the demo tenant (a PM when there is one, else OWNER/ADMIN; same RPC path)
  SELECT user_email, role INTO v_email, v_role FROM user_roles
   WHERE tenant_id = v_tenant AND role IN ('PM','OWNER','ADMIN') AND user_email IS NOT NULL
   ORDER BY (role = 'PM') DESC, role, user_email LIMIT 1;
  IF v_email IS NULL THEN RAISE EXCEPTION 'SETUP: no PM/OWNER/ADMIN user in the demo tenant'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_email, 'role', 'authenticated')::text, true);
  IF current_tenant_id() IS DISTINCT FROM v_tenant THEN RAISE EXCEPTION 'SETUP: claims did not resolve to the demo tenant'; END IF;
  IF NOT tenant_can_write() THEN RAISE EXCEPTION 'SETUP: demo tenant cannot write'; END IF;
  SELECT id INTO v_site FROM sites WHERE tenant_id = v_tenant ORDER BY id LIMIT 1;
  RAISE NOTICE 'case i as % (%)', v_role, v_email;

  PERFORM pm_update_site(v_site, jsonb_build_object('safety_note', '  ระวังสายไฟ  '));
  ASSERT (SELECT safety_note FROM sites WHERE id = v_site) = 'ระวังสายไฟ', '(i) note not stored trimmed';
  SELECT p.safety_note INTO v_note FROM pm_sites() p WHERE p.id = v_site;
  ASSERT v_note = 'ระวังสายไฟ', '(i) pm_sites() does not return the note';
  PERFORM pm_update_site(v_site, jsonb_build_object('notes', (SELECT notes FROM sites WHERE id = v_site)));
  ASSERT (SELECT safety_note FROM sites WHERE id = v_site) = 'ระวังสายไฟ', '(i) a patch without safety_note changed it';
  PERFORM pm_update_site(v_site, jsonb_build_object('safety_note', '   '));
  ASSERT (SELECT safety_note FROM sites WHERE id = v_site) IS NULL, '(i) blank note not stored as NULL';
  v_failed := false;
  BEGIN
    PERFORM pm_update_site(v_site, jsonb_build_object('safety_note', repeat('ก', 501)));
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  ASSERT v_failed, '(i) 501-char note accepted through pm_update_site';
  v_failed := false;
  BEGIN
    PERFORM pm_update_site(v_site, jsonb_build_object('contract_value', 1));
  EXCEPTION WHEN SQLSTATE '22023' THEN v_failed := true;
  END;
  ASSERT v_failed, '(i) money field accepted through pm_update_site';
  PERFORM set_config('request.jwt.claims', '', true);
  RAISE NOTICE 'case i ok';
END $$;

-- ===================== PM reads site_safety_note_default (case j) =====================
-- RLS only bites a non-owner role: SET LOCAL ROLE authenticated with a PM's claims. When the demo tenant
-- has no PM, one demo user_roles row is turned into a PM inside this transaction (rolled back).
DO $$
DECLARE
  v_tenant uuid := '8b61c890-0a90-4223-91d3-b5f8f4e89908';
  v_email text;
  v_n int;
BEGIN
  SELECT user_email INTO v_email FROM user_roles
   WHERE tenant_id = v_tenant AND role = 'PM' AND user_email IS NOT NULL ORDER BY user_email LIMIT 1;
  IF v_email IS NULL THEN
    SELECT user_email INTO v_email FROM user_roles
     WHERE tenant_id = v_tenant AND role IN ('ADMIN','OWNER') AND user_email IS NOT NULL
     ORDER BY (role = 'ADMIN') DESC, user_email LIMIT 1;
    IF v_email IS NULL THEN RAISE EXCEPTION 'SETUP: no user in the demo tenant'; END IF;
    UPDATE user_roles SET role = 'PM' WHERE tenant_id = v_tenant AND user_email = v_email;
  END IF;
  INSERT INTO app_settings (tenant_id, key, value) VALUES (v_tenant, 'site_safety_note_default', 'dryrun-default')
  ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value;
  INSERT INTO app_settings (tenant_id, key, value) VALUES (v_tenant, 'dryrun_secret_key', 'x')
  ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value;

  PERFORM set_config('request.jwt.claims', json_build_object('email', v_email, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  ASSERT is_pm(), '(j) claims user is not a PM';
  SELECT count(*) INTO v_n FROM app_settings WHERE key = 'site_safety_note_default' AND value = 'dryrun-default';
  ASSERT v_n = 1, format('(j) PM reads site_safety_note_default: %s rows', v_n);
  SELECT count(*) INTO v_n FROM app_settings WHERE key = 'dryrun_secret_key';
  ASSERT v_n = 0, '(j) PM reads a key outside the list';
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RAISE NOTICE 'case j ok';
END $$;

DO $$ BEGIN RAISE EXCEPTION 'RESULT ok'; END $$;
