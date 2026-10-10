-- supabase/tests/bom_part_editor_test.sql
-- RUN ONLY INSIDE ONE TRANSACTION THAT ENDS IN ROLLBACK (fixtures are real rows).
--   BEGIN; <catalog + estimation migrations through 2026-10-14-02 (needs bom_template_components with the joint
--   columns, alu_profiles with width_mm, estimation_settings) if not applied>; 2026-10-15-01; <this file>; ROLLBACK;
-- Tenants: A and B hold only 'estimation'; C holds nothing.

CREATE TEMP TABLE _pe_fx (a_tenant UUID, b_tenant UUID, c_tenant UUID, a_tpl UUID, a_comp UUID);
DO $$
DECLARE owner_id UUID; ta UUID; tb UUID; tc UUID;
BEGIN
  SELECT id INTO owner_id FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__PE TEST A__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO ta;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__PE TEST B__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO tb;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__PE TEST C__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO tc;
  INSERT INTO tenant_modules (tenant_id, module_key) VALUES (ta, 'estimation'), (tb, 'estimation');
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES
    ('__pe_a__@example.com', 'OWNER', 'approved', ta),
    ('__pe_b__@example.com', 'OWNER', 'approved', tb),
    ('__pe_c__@example.com', 'OWNER', 'approved', tc);
  INSERT INTO _pe_fx (a_tenant, b_tenant, c_tenant) VALUES (ta, tb, tc);
END $$;

-- Test 1: build a sliding_2 template and check every rule (as tenant A)
DO $$
DECLARE tpl UUID; frame_part UUID; sash_part UUID; pos_key UUID; pos_hook UUID; pos_side UUID; pos_top UUID;
        pp1 UUID; pp2 UUID; prov UUID; prof UUID; comp UUID; n INT; state TEXT; fac NUMERIC; ded NUMERIC; tgt UUID; k INT;
BEGIN
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__pe_a__@example.com"}';

  INSERT INTO bom_templates (name, category, layout_kind) VALUES ('PE-TPL', 'window', 'sliding_2') RETURNING id INTO tpl;
  INSERT INTO bom_template_parts (template_id, part_key, name, count) VALUES (tpl, 'frame', 'PE frame', 1) RETURNING id INTO frame_part;
  INSERT INTO bom_template_parts (template_id, part_key, name, count) VALUES (tpl, 'sash', 'PE sash', 2) RETURNING id INTO sash_part;
  SELECT overlap_mode INTO state FROM bom_template_parts WHERE id = sash_part;
  IF state <> 'auto_hook' THEN RAISE EXCEPTION 'overlap_mode should default to auto_hook, got %', state; END IF;

  INSERT INTO bom_template_positions (part_id, position_key, name) VALUES (frame_part, 'frame_top', 't');
  INSERT INTO bom_template_positions (part_id, position_key, name) VALUES (frame_part, 'frame_bottom', 'b');
  INSERT INTO bom_template_positions (part_id, position_key, name) VALUES (frame_part, 'frame_side', 's') RETURNING id INTO pos_side;
  INSERT INTO bom_template_positions (part_id, position_key, name) VALUES (sash_part, 'sash_top', 'st') RETURNING id INTO pos_top;
  INSERT INTO bom_template_positions (part_id, position_key, name) VALUES (sash_part, 'sash_bottom', 'sb');
  INSERT INTO bom_template_positions (part_id, position_key, name) VALUES (sash_part, 'key_stile', 'ks') RETURNING id INTO pos_key;
  INSERT INTO bom_template_positions (part_id, position_key, name) VALUES (sash_part, 'hook_stile', 'hs') RETURNING id INTO pos_hook;
  SELECT count(*) INTO n FROM bom_template_positions WHERE part_id IN (frame_part, sash_part);
  IF n <> 7 THEN RAISE EXCEPTION 'expected 7 positions, got %', n; END IF;

  INSERT INTO bom_template_position_profiles (position_id, profile_family, length_rule_type) VALUES (pos_key, 'KEY', 'height') RETURNING id INTO pp1;
  INSERT INTO bom_template_position_profiles (position_id, profile_family, length_rule_type) VALUES (pos_top, 'RAIL', 'width_minus') RETURNING id INTO pp2;
  SELECT length_factor, length_deduction_mm INTO fac, ded FROM bom_template_position_profiles WHERE id = pp1;
  IF fac <> 1 OR ded <> 0 THEN RAISE EXCEPTION 'profile line should default to factor 1 / deduction 0'; END IF;
  -- the rail's two ends butt the key stile line
  INSERT INTO bom_template_piece_ends (position_profile_id, piece_index, end_index, mode, butt_to_profile_id) VALUES (pp2, 0, 0, 'butt', pp1);
  INSERT INTO bom_template_piece_ends (position_profile_id, piece_index, end_index, mode, butt_to_profile_id, deduction_mm) VALUES (pp2, 0, 1, 'butt', pp1, 25);
  -- a through end on the stile (also used by the duplicate test below)
  INSERT INTO bom_template_piece_ends (position_profile_id, piece_index, end_index, mode) VALUES (pp1, 0, 0, 'through');
  INSERT INTO alu_providers (name, short_name, price_basis) VALUES ('PE P', 'PE', 'per_kg') RETURNING id INTO prov;
  INSERT INTO alu_profiles (provider_id, name, linear_weight_kg_per_m, width_mm) VALUES (prov, 'PE-PROF', 0.5, 50) RETURNING id INTO prof;
  UPDATE alu_profiles SET butt_distance_mm = 38.1 WHERE id = prof;
  UPDATE alu_profiles SET butt_distance_mm = NULL WHERE id = prof;
  UPDATE bom_templates SET layout_kind = NULL WHERE id = tpl;
  UPDATE bom_templates SET layout_kind = 'sliding_2' WHERE id = tpl;
  INSERT INTO bom_template_components (template_id, role_name, profile_family, length_rule_type, quantity_basis)
    VALUES (tpl, 'PE-COMP', 'F', 'width', 'fixed') RETURNING id, length_factor, end_deduction_mm INTO comp, fac, ded;
  IF fac <> 1 OR ded <> 0 THEN RAISE EXCEPTION 'component should default to factor 1 / end deduction 0'; END IF;
  -- legacy row defaults (components created before the migration keep factor 1 / deduction 0 via the column defaults)
  SELECT count(*) INTO n FROM bom_template_components WHERE length_factor <> 1 OR end_deduction_mm <> 0;
  IF n <> 0 THEN RAISE EXCEPTION '% component rows do not carry the default factor / end deduction', n; END IF;

  BEGIN
    INSERT INTO bom_template_parts (template_id, part_key, name, count) VALUES (tpl, 'sash', 'x', 0);
    RAISE EXCEPTION 'constraint missing: part count = 0';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
    IF state <> '23514' THEN RAISE EXCEPTION 'part count = 0: expected 23514, got %', state; END IF;
  END;
  BEGIN
    INSERT INTO bom_template_position_profiles (position_id, profile_family, length_rule_type, length_factor) VALUES (pos_key, 'F', 'width', 0);
    RAISE EXCEPTION 'constraint missing: length_factor = 0 (profile line)';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
    IF state <> '23514' THEN RAISE EXCEPTION 'length_factor = 0 (profile line): expected 23514, got %', state; END IF;
  END;
  BEGIN
    INSERT INTO bom_template_piece_ends (position_profile_id, piece_index, end_index, mode) VALUES (pp1, 5, 2, 'through');
    RAISE EXCEPTION 'constraint missing: end_index = 2';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
    IF state <> '23514' THEN RAISE EXCEPTION 'end_index = 2: expected 23514, got %', state; END IF;
  END;
  BEGIN
    INSERT INTO bom_template_piece_ends (position_profile_id, piece_index, end_index, mode) VALUES (pp1, 5, 0, 'x');
    RAISE EXCEPTION 'constraint missing: mode = x';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
    IF state <> '23514' THEN RAISE EXCEPTION 'mode = x: expected 23514, got %', state; END IF;
  END;
  BEGIN
    INSERT INTO bom_template_piece_ends (position_profile_id, piece_index, end_index, mode, deduction_mm) VALUES (pp1, 5, 0, 'butt', -1);
    RAISE EXCEPTION 'constraint missing: negative piece-end deduction_mm';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
    IF state <> '23514' THEN RAISE EXCEPTION 'negative piece-end deduction_mm: expected 23514, got %', state; END IF;
  END;
  BEGIN
    UPDATE bom_templates SET layout_kind = 'x' WHERE id = tpl;
    RAISE EXCEPTION 'constraint missing: layout_kind = x';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
    IF state <> '23514' THEN RAISE EXCEPTION 'layout_kind = x: expected 23514, got %', state; END IF;
  END;
  BEGIN
    INSERT INTO bom_template_components (template_id, role_name, profile_family, length_rule_type, quantity_basis, length_factor) VALUES (tpl, 'c', 'F', 'width', 'fixed', 0);
    RAISE EXCEPTION 'constraint missing: component length_factor = 0';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
    IF state <> '23514' THEN RAISE EXCEPTION 'component length_factor = 0: expected 23514, got %', state; END IF;
  END;
  BEGIN
    INSERT INTO bom_template_components (template_id, role_name, profile_family, length_rule_type, quantity_basis, end_deduction_mm) VALUES (tpl, 'c', 'F', 'width', 'fixed', -1);
    RAISE EXCEPTION 'constraint missing: negative component end_deduction_mm';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
    IF state <> '23514' THEN RAISE EXCEPTION 'negative component end_deduction_mm: expected 23514, got %', state; END IF;
  END;
  BEGIN
    UPDATE alu_profiles SET butt_distance_mm = -1 WHERE id = prof;
    RAISE EXCEPTION 'constraint missing: negative butt_distance_mm';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
    IF state <> '23514' THEN RAISE EXCEPTION 'negative butt_distance_mm: expected 23514, got %', state; END IF;
  END;
  BEGIN
    INSERT INTO bom_template_positions (part_id, position_key, name) VALUES (sash_part, 'key_stile', 'dup');
    RAISE EXCEPTION 'constraint missing: duplicate (part, position_key)';
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
    IF state <> '23505' THEN RAISE EXCEPTION 'duplicate (part, position_key): expected 23505, got %', state; END IF;
  END;
  BEGIN
    INSERT INTO bom_template_piece_ends (position_profile_id, piece_index, end_index, mode) VALUES (pp1, 0, 0, 'through');
    RAISE EXCEPTION 'constraint missing: duplicate (profile, piece, end)';
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
    IF state <> '23505' THEN RAISE EXCEPTION 'duplicate (profile, piece, end): expected 23505, got %', state; END IF;
  END;

  RESET role;
  INSERT INTO _pe_fx (a_tpl, a_comp) VALUES (tpl, comp);
  RAISE NOTICE 'Test 1 (rules): TEST PASSED';
END $$;

-- Test 2: isolation and module gate, BEFORE any delete
DO $$
DECLARE n INT; state TEXT; tpl UUID; pp UUID;
BEGIN
  SELECT a_tpl INTO tpl FROM _pe_fx WHERE a_tpl IS NOT NULL;
  SET LOCAL role = 'authenticated';

  SET LOCAL request.jwt.claims = '{"email":"__pe_a__@example.com"}';
  SELECT count(*) INTO n FROM bom_template_parts;       IF n <> 2 THEN RAISE EXCEPTION 'tenant A should see 2 parts, sees %', n; END IF;
  SELECT count(*) INTO n FROM bom_template_positions;   IF n <> 7 THEN RAISE EXCEPTION 'tenant A should see 7 positions, sees %', n; END IF;
  SELECT count(*) INTO n FROM bom_template_position_profiles; IF n <> 2 THEN RAISE EXCEPTION 'tenant A should see 2 profile lines, sees %', n; END IF;
  SELECT count(*) INTO n FROM bom_template_piece_ends;  IF n <> 3 THEN RAISE EXCEPTION 'tenant A should see 3 ends, sees %', n; END IF;

  PERFORM set_config('request.jwt.claims', '{"email":"__pe_b__@example.com"}', true);
  SELECT count(*) INTO n FROM bom_template_parts;       IF n <> 0 THEN RAISE EXCEPTION 'tenant B sees % parts of A', n; END IF;
  SELECT count(*) INTO n FROM bom_template_positions;   IF n <> 0 THEN RAISE EXCEPTION 'tenant B sees % positions of A', n; END IF;
  SELECT count(*) INTO n FROM bom_template_position_profiles; IF n <> 0 THEN RAISE EXCEPTION 'tenant B sees % profile lines of A', n; END IF;
  SELECT count(*) INTO n FROM bom_template_piece_ends;  IF n <> 0 THEN RAISE EXCEPTION 'tenant B sees % ends of A', n; END IF;

  PERFORM set_config('request.jwt.claims', '{"email":"__pe_c__@example.com"}', true);
  SELECT count(*) INTO n FROM bom_template_parts;       IF n <> 0 THEN RAISE EXCEPTION 'tenant without the module sees % parts', n; END IF;
  SELECT count(*) INTO n FROM bom_template_piece_ends;  IF n <> 0 THEN RAISE EXCEPTION 'tenant without the module sees % ends', n; END IF;
  BEGIN
    INSERT INTO bom_template_parts (template_id, part_key, name) VALUES (tpl, 'frame', 'C');
    RAISE EXCEPTION 'tenant without the estimation module could insert a part';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
    IF state <> '42501' THEN RAISE EXCEPTION 'expected 42501, got %', state; END IF;
  END;
  BEGIN
    INSERT INTO bom_template_piece_ends (position_profile_id, piece_index, end_index, mode)
      VALUES (gen_random_uuid(), 9, 0, 'through');
    RAISE EXCEPTION 'tenant without the estimation module could insert an end';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
    IF state <> '42501' THEN RAISE EXCEPTION 'expected 42501, got %', state; END IF;
  END;

  RESET role;
  RAISE NOTICE 'Test 2 (isolation and module gate): TEST PASSED';
END $$;

-- Test 3: deletes (as tenant A)
DO $$
DECLARE tpl UUID; stile UUID; rail UUID; n INT; mode_after TEXT; tgt UUID;
BEGIN
  SELECT a_tpl INTO tpl FROM _pe_fx WHERE a_tpl IS NOT NULL;
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__pe_a__@example.com"}';

  SELECT id INTO stile FROM bom_template_position_profiles WHERE profile_family = 'KEY';
  SELECT id INTO rail  FROM bom_template_position_profiles WHERE profile_family = 'RAIL';
  SELECT count(*) INTO n FROM bom_template_piece_ends WHERE butt_to_profile_id = stile;
  IF n <> 2 THEN RAISE EXCEPTION 'fixture: 2 ends should butt the stile line, got %', n; END IF;

  -- deleting the target profile line: ends survive with butt_to_profile_id NULL
  DELETE FROM bom_template_position_profiles WHERE id = stile;
  SELECT count(*) INTO n FROM bom_template_piece_ends WHERE position_profile_id = rail;
  IF n <> 2 THEN RAISE EXCEPTION 'the rail ends must survive deleting their target, % left', n; END IF;
  SELECT count(*) INTO n FROM bom_template_piece_ends WHERE position_profile_id = rail AND butt_to_profile_id IS NULL AND mode = 'butt';
  IF n <> 2 THEN RAISE EXCEPTION 'the rail ends should keep mode butt with a NULL target, % do', n; END IF;
  SELECT count(*) INTO n FROM bom_template_piece_ends WHERE position_profile_id = stile;
  IF n <> 0 THEN RAISE EXCEPTION 'the deleted line own ends should cascade, % left', n; END IF;

  -- deleting the template cascades every child
  DELETE FROM bom_templates WHERE id = tpl;
  SELECT count(*) INTO n FROM bom_template_parts;             IF n <> 0 THEN RAISE EXCEPTION '% parts left', n; END IF;
  SELECT count(*) INTO n FROM bom_template_positions;         IF n <> 0 THEN RAISE EXCEPTION '% positions left', n; END IF;
  SELECT count(*) INTO n FROM bom_template_position_profiles; IF n <> 0 THEN RAISE EXCEPTION '% profile lines left', n; END IF;
  SELECT count(*) INTO n FROM bom_template_piece_ends;        IF n <> 0 THEN RAISE EXCEPTION '% ends left', n; END IF;
  SELECT count(*) INTO n FROM bom_template_components;        IF n <> 0 THEN RAISE EXCEPTION '% components left', n; END IF;

  RESET role;
  RAISE NOTICE 'Test 3 (deletes): TEST PASSED';
END $$;
