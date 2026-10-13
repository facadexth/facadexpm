-- supabase/tests/layouts_all_types_test.sql
-- RUN ONLY INSIDE ONE TRANSACTION THAT ENDS IN ROLLBACK (fixtures are real rows).
--   BEGIN; <2026-10-15-01 and earlier estimation migrations if not applied>; 2026-10-17-01; <this file>; ROLLBACK;
-- Tenant A holds 'estimation'.

CREATE TEMP TABLE _la_fx (a_tenant UUID);
DO $$
DECLARE owner_id UUID; ta UUID;
BEGIN
  SELECT id INTO owner_id FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__LA TEST A__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO ta;
  INSERT INTO tenant_modules (tenant_id, module_key) VALUES (ta, 'estimation');
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES ('__la_a__@example.com', 'OWNER', 'approved', ta);
  INSERT INTO _la_fx (a_tenant) VALUES (ta);
END $$;

DO $$
DECLARE kinds TEXT[] := ARRAY['sliding_2','sliding_n','sliding_3track','sliding_2_fixed_2','fixed_grid','awning_grid','casement_n',
                              'swing_door','frameless_door','hanging_door','folding_door','curtain_wall','frameless_wall'];
        k TEXT; typ UUID; tpl UUID; n INT; state TEXT; lp JSONB; lk TEXT;
BEGIN
  -- the three columns exist
  SELECT count(*) INTO n FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'layout_params' AND data_type = 'jsonb'
      AND table_name IN ('door_window_types','bom_templates','estimation_openings');
  IF n <> 3 THEN RAISE EXCEPTION 'layout_params should exist (jsonb) on 3 tables, found %', n; END IF;
  SELECT count(*) INTO n FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'layout_kind' AND table_name IN ('door_window_types','bom_templates');
  IF n <> 2 THEN RAISE EXCEPTION 'layout_kind should exist on door_window_types and bom_templates, found %', n; END IF;

  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__la_a__@example.com"}';

  -- accepted: awning_grid with params
  INSERT INTO door_window_types (name, category, layout_kind, layout_params)
    VALUES ('LA-TYPE', 'window', 'awning_grid', '{"rows":2,"cols":2}') RETURNING id INTO typ;
  SELECT layout_kind, layout_params INTO lk, lp FROM door_window_types WHERE id = typ;
  IF lk <> 'awning_grid' OR lp <> '{"rows":2,"cols":2}'::jsonb THEN RAISE EXCEPTION 'type did not keep layout_kind / layout_params'; END IF;

  -- default params are {}
  INSERT INTO bom_templates (name, category) VALUES ('LA-TPL', 'window') RETURNING id INTO tpl;
  SELECT layout_params INTO lp FROM bom_templates WHERE id = tpl;
  IF lp <> '{}'::jsonb THEN RAISE EXCEPTION 'layout_params default should be {}, got %', lp; END IF;

  -- every one of the 13 kinds is accepted on both tables
  FOREACH k IN ARRAY kinds LOOP
    UPDATE door_window_types SET layout_kind = k WHERE id = typ;
    UPDATE bom_templates SET layout_kind = k WHERE id = tpl;
  END LOOP;
  UPDATE door_window_types SET layout_kind = NULL WHERE id = typ;
  UPDATE bom_templates SET layout_kind = 'awning_grid', layout_params = '{"rows":2,"cols":2}' WHERE id = tpl;
  SELECT layout_kind INTO lk FROM bom_templates WHERE id = tpl;
  IF lk <> 'awning_grid' THEN RAISE EXCEPTION 'bom_templates should accept awning_grid'; END IF;

  -- rejected: bogus kind on door_window_types
  BEGIN
    INSERT INTO door_window_types (name, category, layout_kind) VALUES ('LA-BAD', 'window', 'bogus');
    RAISE EXCEPTION 'constraint missing: door_window_types.layout_kind = bogus';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
    IF state <> '23514' THEN RAISE EXCEPTION 'door_window_types bogus kind: expected 23514, got %', state; END IF;
  END;
  -- rejected: bogus kind on bom_templates
  BEGIN
    UPDATE bom_templates SET layout_kind = 'bogus' WHERE id = tpl;
    RAISE EXCEPTION 'constraint missing: bom_templates.layout_kind = bogus';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
    IF state <> '23514' THEN RAISE EXCEPTION 'bom_templates bogus kind: expected 23514, got %', state; END IF;
  END;
  -- rejected: non-object layout_params
  BEGIN
    INSERT INTO door_window_types (name, category, layout_params) VALUES ('LA-BAD2', 'window', '[]');
    RAISE EXCEPTION 'constraint missing: door_window_types.layout_params = []';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
    IF state <> '23514' THEN RAISE EXCEPTION 'door_window_types layout_params []: expected 23514, got %', state; END IF;
  END;
  BEGIN
    UPDATE bom_templates SET layout_params = '[]' WHERE id = tpl;
    RAISE EXCEPTION 'constraint missing: bom_templates.layout_params = []';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
    IF state <> '23514' THEN RAISE EXCEPTION 'bom_templates layout_params []: expected 23514, got %', state; END IF;
  END;

  RESET role;
  RAISE NOTICE 'layouts_all_types: TEST PASSED';
END $$;
