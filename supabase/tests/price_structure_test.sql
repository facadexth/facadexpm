-- supabase/tests/price_structure_test.sql
-- RUN ONLY INSIDE ONE TRANSACTION THAT ENDS IN ROLLBACK (fixtures are real rows).
--   BEGIN; <catalog + estimation migrations through 2026-10-12-03 if not applied>; 2026-10-14-01; <this file>; ROLLBACK;
-- Tenants: A and B hold only 'estimation'; C holds nothing. Quotation fixtures are inserted as the superuser
-- (tenant A does not hold the quotations module); the estimation tables are exercised as tenant A.

CREATE TEMP TABLE _ps_fx (a_tenant UUID, b_tenant UUID, c_tenant UUID, a_proj UUID, a_open UUID, a_quo UUID, a_item1 UUID, a_item2 UUID);
DO $$
DECLARE owner_id UUID; ta UUID; tb UUID; tc UUID;
BEGIN
  SELECT id INTO owner_id FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__PS TEST A__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO ta;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__PS TEST B__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO tb;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__PS TEST C__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO tc;
  INSERT INTO tenant_modules (tenant_id, module_key) VALUES (ta, 'estimation'), (tb, 'estimation');
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES
    ('__ps_a__@example.com', 'OWNER', 'approved', ta),
    ('__ps_b__@example.com', 'OWNER', 'approved', tb),
    ('__ps_c__@example.com', 'OWNER', 'approved', tc);
  INSERT INTO _ps_fx (a_tenant, b_tenant, c_tenant) VALUES (ta, tb, tc);
END $$;

-- ── Fixtures: a client, a quotation and two quotation items for tenant A (as the superuser) ──
DO $$
DECLARE ta UUID; cl UUID; q UUID; i1 UUID; i2 UUID;
BEGIN
  SELECT a_tenant INTO ta FROM _ps_fx;
  INSERT INTO clients (name, tenant_id) VALUES ('__PS CLIENT__', ta) RETURNING id INTO cl;
  INSERT INTO quotations (client_id, date, tenant_id) VALUES (cl, CURRENT_DATE, ta) RETURNING id INTO q;
  INSERT INTO quotation_items (quotation_id, description, tenant_id) VALUES (q, 'PS ITEM 1', ta) RETURNING id INTO i1;
  INSERT INTO quotation_items (quotation_id, description, tenant_id) VALUES (q, 'PS ITEM 2', ta) RETURNING id INTO i2;
  UPDATE _ps_fx SET a_quo = q, a_item1 = i1, a_item2 = i2;
END $$;

-- ── Test 1: the rules (as tenant A) ──
DO $$
DECLARE
  typ UUID; tpl UUID; proj UUID; op UUID; q UUID; i1 UUID; i2 UUID; n INT; state TEXT; fb NUMERIC;
BEGIN
  SELECT a_quo, a_item1, a_item2 INTO q, i1, i2 FROM _ps_fx;
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__ps_a__@example.com"}';

  INSERT INTO door_window_types (name, category) VALUES ('PS-TYPE', 'window') RETURNING id INTO typ;
  INSERT INTO bom_templates (name, category, type_id) VALUES ('PS-TPL', 'window', typ) RETURNING id INTO tpl;
  INSERT INTO estimation_projects (name) VALUES ('PS-PROJ') RETURNING id INTO proj;
  INSERT INTO estimation_openings (project_id, opening_no, template_id, width_m, height_m, fire_barrier_cost)
    VALUES (proj, 'D1', tpl, 2, 2, 100) RETURNING id INTO op;
  SELECT fire_barrier_cost INTO fb FROM estimation_openings WHERE id = op;
  IF fb IS DISTINCT FROM 100 THEN RAISE EXCEPTION 'fire_barrier_cost did not round-trip'; END IF;
  SELECT count(*) INTO n FROM estimation_projects WHERE id = proj AND round_step = 100;
  IF n <> 1 THEN RAISE EXCEPTION 'round_step should default to 100'; END IF;

  INSERT INTO estimation_quotation_links (project_id, quotation_id) VALUES (proj, q);
  INSERT INTO estimation_quotation_lines (project_id, opening_id, item_row_id, description_row_id) VALUES (proj, op, i1, i2);
  INSERT INTO estimation_price_snapshots (project_id, quotation_id, kind, revision, sub_no) VALUES (proj, q, 'sent', 1, 1);
  INSERT INTO estimation_price_snapshots (project_id, quotation_id, kind, revision, sub_no) VALUES (proj, q, 'agreed', 1, 2);
  SELECT count(*) INTO n FROM estimation_price_snapshots WHERE project_id = proj;
  IF n <> 2 THEN RAISE EXCEPTION 'expected 2 snapshots, got %', n; END IF;

  -- CHECK constraints (each must raise 23514)
  BEGIN UPDATE estimation_projects SET round_step = 0 WHERE id = proj;
    RAISE EXCEPTION 'round_step = 0 was allowed';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE estimation_quotation_links SET split_material_pct = 120 WHERE project_id = proj;
    RAISE EXCEPTION 'split_material_pct = 120 was allowed';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE estimation_quotation_links SET attach_mode = 'x' WHERE project_id = proj;
    RAISE EXCEPTION 'attach_mode = x was allowed';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO estimation_price_snapshots (project_id, kind, sub_no) VALUES (proj, 'sent', 0);
    RAISE EXCEPTION 'sub_no = 0 was allowed';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE estimation_openings SET bracket_cost = -1 WHERE id = op;
    RAISE EXCEPTION 'negative bracket_cost was allowed';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- duplicates (23505)
  BEGIN
    INSERT INTO estimation_quotation_links (project_id) VALUES (proj);
    RAISE EXCEPTION 'a second link for the same project was allowed';
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
    IF state <> '23505' THEN RAISE EXCEPTION 'expected 23505, got %', state; END IF;
  END;
  BEGIN
    INSERT INTO estimation_quotation_lines (project_id, opening_id) VALUES (proj, op);
    RAISE EXCEPTION 'a duplicate (project, opening) line was allowed';
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
    IF state <> '23505' THEN RAISE EXCEPTION 'expected 23505, got %', state; END IF;
  END;

  RESET role;
  UPDATE _ps_fx SET a_proj = proj, a_open = op;
  RAISE NOTICE 'Test 1 (rules): TEST PASSED';
END $$;

-- ── Test 2: isolation and module gate, BEFORE any delete ──
DO $$
DECLARE n INT; state TEXT; proj UUID;
BEGIN
  SELECT a_proj INTO proj FROM _ps_fx;
  SET LOCAL role = 'authenticated';

  SET LOCAL request.jwt.claims = '{"email":"__ps_a__@example.com"}';
  SELECT count(*) INTO n FROM estimation_quotation_links;
  IF n < 1 THEN RAISE EXCEPTION 'tenant A should see its own link'; END IF;
  SELECT count(*) INTO n FROM estimation_quotation_lines;
  IF n < 1 THEN RAISE EXCEPTION 'tenant A should see its own line'; END IF;
  SELECT count(*) INTO n FROM estimation_price_snapshots;
  IF n < 2 THEN RAISE EXCEPTION 'tenant A should see its own snapshots'; END IF;

  PERFORM set_config('request.jwt.claims', '{"email":"__ps_b__@example.com"}', true);
  SELECT count(*) INTO n FROM estimation_quotation_links;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant B sees % of A links', n; END IF;
  SELECT count(*) INTO n FROM estimation_quotation_lines;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant B sees % of A lines', n; END IF;
  SELECT count(*) INTO n FROM estimation_price_snapshots;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant B sees % of A snapshots', n; END IF;

  PERFORM set_config('request.jwt.claims', '{"email":"__ps_c__@example.com"}', true);
  SELECT count(*) INTO n FROM estimation_quotation_links;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant without the module sees % links', n; END IF;
  SELECT count(*) INTO n FROM estimation_quotation_lines;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant without the module sees % lines', n; END IF;
  SELECT count(*) INTO n FROM estimation_price_snapshots;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant without the module sees % snapshots', n; END IF;
  BEGIN
    INSERT INTO estimation_price_snapshots (project_id, kind) VALUES (proj, 'sent');
    RAISE EXCEPTION 'tenant without the estimation module could insert a snapshot';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
    IF state <> '42501' THEN RAISE EXCEPTION 'expected 42501, got %', state; END IF;
  END;

  RESET role;
  RAISE NOTICE 'Test 2 (isolation and module gate): TEST PASSED';
END $$;

-- ── Test 3: deleting the quotation keeps the rows and nulls the pointers ──
DO $$
DECLARE q UUID; proj UUID; n INT; r RECORD;
BEGIN
  SELECT a_quo, a_proj INTO q, proj FROM _ps_fx;
  -- as the superuser: tenant A does not hold the quotations module
  DELETE FROM quotations WHERE id = q;

  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__ps_a__@example.com"}';
  SELECT count(*) INTO n FROM estimation_quotation_links WHERE project_id = proj AND quotation_id IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'deleting the quotation should keep the link and null quotation_id'; END IF;
  SELECT * INTO r FROM estimation_quotation_lines WHERE project_id = proj;
  IF r.id IS NULL THEN RAISE EXCEPTION 'deleting the quotation must keep the line'; END IF;
  IF r.item_row_id IS NOT NULL OR r.description_row_id IS NOT NULL THEN
    RAISE EXCEPTION 'deleting the quotation (and its items) should null item_row_id and description_row_id';
  END IF;
  SELECT count(*) INTO n FROM estimation_price_snapshots WHERE project_id = proj AND quotation_id IS NULL;
  IF n <> 2 THEN RAISE EXCEPTION 'deleting the quotation should keep both snapshots with quotation_id NULL (got %)', n; END IF;

  -- deleting the project cascades to all three tables
  DELETE FROM estimation_projects WHERE id = proj;
  SELECT count(*) INTO n FROM estimation_quotation_links WHERE project_id = proj;
  IF n <> 0 THEN RAISE EXCEPTION 'deleting the project should remove its link'; END IF;
  SELECT count(*) INTO n FROM estimation_quotation_lines WHERE project_id = proj;
  IF n <> 0 THEN RAISE EXCEPTION 'deleting the project should remove its lines'; END IF;
  SELECT count(*) INTO n FROM estimation_price_snapshots WHERE project_id = proj;
  IF n <> 0 THEN RAISE EXCEPTION 'deleting the project should remove its snapshots'; END IF;

  RESET role;
  RAISE NOTICE 'Test 3 (deletes): TEST PASSED';
END $$;
