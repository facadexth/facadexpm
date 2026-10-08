-- supabase/tests/estimation_expand_test.sql
-- RUN ONLY INSIDE ONE TRANSACTION THAT ENDS IN ROLLBACK (fixtures are real rows).
--   BEGIN; <alu catalog migrations 01..03 if not applied>; <2026-10-11-01 expand migration>; <this file>; ROLLBACK;
-- Tenants: A and B hold only 'estimation'; C holds nothing.

CREATE TEMP TABLE _est_fx (a_tenant UUID, b_tenant UUID, c_tenant UUID);
DO $$
DECLARE owner_id UUID; ta UUID; tb UUID; tc UUID;
BEGIN
  SELECT id INTO owner_id FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__EST TEST A__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO ta;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__EST TEST B__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO tb;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__EST TEST C__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO tc;
  INSERT INTO tenant_modules (tenant_id, module_key) VALUES (ta, 'estimation'), (tb, 'estimation');
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES
    ('__est_a__@example.com', 'OWNER', 'approved', ta),
    ('__est_b__@example.com', 'OWNER', 'approved', tb),
    ('__est_c__@example.com', 'OWNER', 'approved', tc);
  INSERT INTO _est_fx VALUES (ta, tb, tc);
END $$;

-- ── Test 1: the new columns work, defaults and inheritance-by-NULL are accepted ──
DO $$
DECLARE
  ta UUID; tb UUID; tc UUID;
  prov UUID; ser UUID; fin UUID; setp UUID; typ UUID; tpl UUID; inf UUID; proj UUID; op UUID; n INT; pasof DATE; raised BOOLEAN;
BEGIN
  SELECT a_tenant, b_tenant, c_tenant INTO ta, tb, tc FROM _est_fx;
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__est_a__@example.com"}';

  INSERT INTO alu_providers (name, short_name, price_basis) VALUES ('EST P', 'EP', 'per_kg') RETURNING id INTO prov;
  INSERT INTO alu_series (provider_id, name) VALUES (prov, 'EST S') RETURNING id INTO ser;
  INSERT INTO alu_finishes (provider_id, name) VALUES (prov, 'EST F') RETURNING id INTO fin;
  INSERT INTO alu_parts (name, kind) VALUES ('EST SET', 'hardware_set') RETURNING id INTO setp;
  INSERT INTO door_window_types (name, category) VALUES ('EST TYPE', 'window') RETURNING id INTO typ;
  INSERT INTO infill_types (name, price_per_sqm) VALUES ('EST INFILL', 100) RETURNING id INTO inf;
  INSERT INTO bom_templates (name, category, type_id) VALUES ('EST TPL', 'window', typ) RETURNING id INTO tpl;
  INSERT INTO bom_template_hardware (template_id, name, reference_unit_price, quantity_basis, part_id)
    VALUES (tpl, 'EST HW', 10, 'fixed', setp);

  -- a project with no defaults at all still inserts, and price_as_of defaults to today
  INSERT INTO estimation_projects (name) VALUES ('EST PROJ') RETURNING id, price_as_of INTO proj, pasof;
  IF pasof IS NULL THEN RAISE EXCEPTION 'price_as_of was not defaulted'; END IF;
  UPDATE estimation_projects SET default_series_id = ser, default_finish_id = fin, default_infill_id = inf,
    default_hardware_set_id = setp, default_thickness_mm = 1.2, labour_per_sqm = 0, profit_pct = 15 WHERE id = proj;
  SELECT count(*) INTO n FROM estimation_projects WHERE id = proj AND labour_per_sqm = 0 AND default_thickness_mm = 1.2;
  IF n <> 1 THEN RAISE EXCEPTION 'project defaults did not round-trip (labour 0 must be stored as 0)'; END IF;

  -- an item that inherits everything: series/colour/thickness/infill/set all NULL
  INSERT INTO estimation_openings (project_id, opening_no, template_id, width_m, height_m)
    VALUES (proj, 'D1', tpl, 2, 2) RETURNING id INTO op;
  -- and one that overrides with catalog ids and an item name
  INSERT INTO estimation_openings (project_id, opening_no, template_id, width_m, height_m, series_id, alu_finish_id,
      hardware_set_id, thickness_mm, item_name, item_description, labour_per_sqm, profit_pct)
    VALUES (proj, 'D2', tpl, 2, 2, ser, fin, setp, 1.5, 'ประตู', 'รายละเอียด', 0, 20);

  -- explicit "none" flags are accepted, and cannot be combined with an explicit value
  UPDATE estimation_openings SET no_infill = true, no_hardware_set = true WHERE id = op;
  raised := false;
  BEGIN
    UPDATE estimation_openings SET infill_type_id = inf WHERE id = op;  -- no_infill is still true
  EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'no_infill together with infill_type_id was allowed'; END IF;
  raised := false;
  BEGIN
    UPDATE estimation_openings SET hardware_set_id = setp WHERE id = op;  -- no_hardware_set is still true
  EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'no_hardware_set together with hardware_set_id was allowed'; END IF;

  -- CHECK constraints
  raised := false;
  BEGIN UPDATE estimation_projects SET labour_per_sqm = -1 WHERE id = proj;
  EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'negative project labour was allowed'; END IF;
  raised := false;
  BEGIN UPDATE estimation_projects SET profit_pct = 1001 WHERE id = proj;
  EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'profit_pct over 1000 was allowed'; END IF;
  raised := false;
  BEGIN UPDATE estimation_projects SET default_thickness_mm = 0 WHERE id = proj;
  EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'default_thickness_mm = 0 was allowed'; END IF;
  raised := false;
  BEGIN UPDATE estimation_openings SET labour_per_sqm = -5 WHERE id = op;
  EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'negative item labour was allowed'; END IF;

  RESET role;
  RAISE NOTICE 'Test 1 (columns, defaults, checks): TEST PASSED';
END $$;

-- ── Test 2: delete behaviour (defaults are SET NULL, items RESTRICT) ──
DO $$
DECLARE
  ta UUID; tb UUID; tc UUID;
  prov UUID; ser UUID; ser2 UUID; fin UUID; setp UUID; typ UUID; tpl UUID; proj UUID; hw UUID; n INT; raised BOOLEAN;
BEGIN
  SELECT a_tenant, b_tenant, c_tenant INTO ta, tb, tc FROM _est_fx;
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__est_a__@example.com"}';

  SELECT id INTO prov FROM alu_providers WHERE name = 'EST P';
  SELECT id INTO ser FROM alu_series WHERE name = 'EST S';
  SELECT id INTO fin FROM alu_finishes WHERE name = 'EST F';
  SELECT id INTO setp FROM alu_parts WHERE name = 'EST SET';
  SELECT id INTO tpl FROM bom_templates WHERE name = 'EST TPL';
  SELECT id INTO proj FROM estimation_projects WHERE name = 'EST PROJ';

  -- a series used by an item cannot be deleted
  raised := false;
  BEGIN DELETE FROM alu_series WHERE id = ser;
  EXCEPTION WHEN foreign_key_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'deleting a series used by an item was allowed'; END IF;

  -- a series used only as a project default can be deleted; the default becomes NULL
  INSERT INTO alu_series (provider_id, name) VALUES (prov, 'EST S2') RETURNING id INTO ser2;
  UPDATE estimation_projects SET default_series_id = ser2 WHERE id = proj;
  DELETE FROM alu_series WHERE id = ser2;
  SELECT count(*) INTO n FROM estimation_projects WHERE id = proj AND default_series_id IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'project default series was not cleared on delete'; END IF;

  -- a colour used by an item cannot be deleted
  raised := false;
  BEGIN DELETE FROM alu_finishes WHERE id = fin;
  EXCEPTION WHEN foreign_key_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'deleting a colour used by an item was allowed'; END IF;

  -- template hardware keeps working when its catalog part disappears (part_id -> NULL)
  -- (the set is still the project default and an item's set, so detach those first)
  UPDATE estimation_openings SET hardware_set_id = NULL WHERE hardware_set_id = setp;
  DELETE FROM alu_parts WHERE id = setp;
  SELECT count(*) INTO n FROM bom_template_hardware WHERE name = 'EST HW' AND part_id IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'template hardware part_id was not cleared on part delete'; END IF;
  SELECT count(*) INTO n FROM estimation_projects WHERE id = proj AND default_hardware_set_id IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'project default hardware set was not cleared on part delete'; END IF;

  RESET role;
  RAISE NOTICE 'Test 2 (delete behaviour): TEST PASSED';
END $$;

-- ── Test 3: other tenants see none of it ──
DO $$
DECLARE ta UUID; tb UUID; tc UUID; n INT; t TEXT;
BEGIN
  SELECT a_tenant, b_tenant, c_tenant INTO ta, tb, tc FROM _est_fx;
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__est_a__@example.com"}';
  SELECT count(*) INTO n FROM estimation_projects WHERE name = 'EST PROJ';
  IF n <> 1 THEN RAISE EXCEPTION 'tenant A should see its project, saw %', n; END IF;
  SELECT count(*) INTO n FROM estimation_openings WHERE item_name = 'ประตู';
  IF n <> 1 THEN RAISE EXCEPTION 'tenant A should see its item, saw %', n; END IF;

  FOREACH t IN ARRAY ARRAY['b','c'] LOOP
    PERFORM set_config('request.jwt.claims', format('{"email":"__est_%s__@example.com"}', t), true);
    SELECT count(*) INTO n FROM estimation_projects;
    IF n <> 0 THEN RAISE EXCEPTION 'tenant % sees % projects', t, n; END IF;
    SELECT count(*) INTO n FROM estimation_openings;
    IF n <> 0 THEN RAISE EXCEPTION 'tenant % sees % items', t, n; END IF;
  END LOOP;

  RESET role;
  RAISE NOTICE 'Test 3 (isolation): TEST PASSED';
END $$;
