-- supabase/tests/estimation_2b_expand_test.sql
-- RUN ONLY INSIDE ONE TRANSACTION THAT ENDS IN ROLLBACK (fixtures are real rows).
--   BEGIN; <catalog migrations 2026-10-10-01..03 if not applied>; <2026-10-11-01 if not applied>; <2026-10-12-01>; <this file>; ROLLBACK;
-- Tenants: A and B hold only 'estimation'; C holds nothing.

CREATE TEMP TABLE _est2_fx (a_tenant UUID, b_tenant UUID, c_tenant UUID);
DO $$
DECLARE owner_id UUID; ta UUID; tb UUID; tc UUID;
BEGIN
  SELECT id INTO owner_id FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__EST2 TEST A__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO ta;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__EST2 TEST B__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO tb;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__EST2 TEST C__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO tc;
  INSERT INTO tenant_modules (tenant_id, module_key) VALUES (ta, 'estimation'), (tb, 'estimation');
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES
    ('__est2_a__@example.com', 'OWNER', 'approved', ta),
    ('__est2_b__@example.com', 'OWNER', 'approved', tb),
    ('__est2_c__@example.com', 'OWNER', 'approved', tc);
  INSERT INTO _est2_fx VALUES (ta, tb, tc);
END $$;

-- ── Test 1: new columns, defaults and CHECK constraints ──
DO $$
DECLARE
  prov UUID; prof UUID; ser UUID; typ UUID; typ2 UUID; tpl UUID; joint UUID; comp UUID; proj UUID; op UUID; part UUID;
  n INT; raised BOOLEAN; pc TEXT; ma TEXT; pk TEXT; mixed BOOLEAN; ds NUMERIC;
BEGIN
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__est2_a__@example.com"}';

  INSERT INTO alu_providers (name, short_name, price_basis) VALUES ('EST2 P', 'E2', 'per_kg') RETURNING id INTO prov;
  INSERT INTO alu_series (provider_id, name) VALUES (prov, 'EST2 S') RETURNING id INTO ser;
  INSERT INTO door_window_types (name, category) VALUES ('EST2 T', 'window') RETURNING id INTO typ;
  INSERT INTO door_window_types (name, category) VALUES ('EST2 T2', 'window') RETURNING id INTO typ2;
  INSERT INTO alu_parts (name, kind) VALUES ('EST2 SHIM', 'accessory') RETURNING id INTO part;

  -- profile dimensions
  INSERT INTO alu_profiles (provider_id, name, drawing_no, thickness_mm, linear_weight_kg_per_m, width_mm, depth_mm, shape_group)
    VALUES (prov, 'กล่องเรียบ', 'U1613', 1.5, 0.871, 101.6, 44.45, 'กล่องเรียบ') RETURNING id, primary_contact INTO prof, pc;
  IF pc <> 'width' THEN RAISE EXCEPTION 'primary_contact should default to width, got %', pc; END IF;
  UPDATE alu_profiles SET primary_contact = 'depth' WHERE id = prof;
  raised := false; BEGIN UPDATE alu_profiles SET primary_contact = 'diagonal' WHERE id = prof; EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'bad primary_contact was allowed'; END IF;
  raised := false; BEGIN UPDATE alu_profiles SET width_mm = 0 WHERE id = prof; EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'width_mm = 0 was allowed'; END IF;

  -- mixed thickness defaults to off per series + type
  INSERT INTO alu_series_types (series_id, type_id) VALUES (ser, typ) RETURNING allow_mixed_thickness INTO mixed;
  IF mixed THEN RAISE EXCEPTION 'allow_mixed_thickness should default to false'; END IF;
  UPDATE alu_series_types SET allow_mixed_thickness = true WHERE series_id = ser AND type_id = typ;

  -- template defaults + joint + component link
  INSERT INTO bom_templates (name, category, type_id) VALUES ('EST2 TPL', 'window', typ) RETURNING id, main_axis, preview_kind INTO tpl, ma, pk;
  IF ma <> 'vertical' OR pk <> 'fixed' THEN RAISE EXCEPTION 'template defaults wrong: %, %', ma, pk; END IF;
  raised := false; BEGIN UPDATE bom_templates SET main_axis = 'diagonal' WHERE id = tpl; EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'bad main_axis was allowed'; END IF;
  raised := false; BEGIN UPDATE bom_templates SET preview_kind = 'sliding' WHERE id = tpl; EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'bad preview_kind was allowed'; END IF;

  INSERT INTO bom_template_joints (template_id, name, main_family, secondary_family) VALUES (tpl, 'corner', 'กล่องเรียบ', 'ตัวนอน') RETURNING id INTO joint;
  raised := false; BEGIN INSERT INTO bom_template_joints (template_id, name, main_family, secondary_family, deduction_mode) VALUES (tpl, 'x', 'a', 'b', 'manual'); EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'manual joint without deduction_mm was allowed'; END IF;
  INSERT INTO bom_template_joints (template_id, name, main_family, secondary_family, deduction_mode, deduction_mm, cut_style, notch_width_mm, notch_depth_mm)
    VALUES (tpl, 'm', 'a', 'b', 'manual', 0, 'notch', 40, 20);
  raised := false; BEGIN UPDATE bom_template_joints SET cut_style = 'bevel' WHERE id = joint; EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'bad cut_style was allowed'; END IF;

  INSERT INTO bom_template_components (template_id, role_name, profile_family, length_rule_type, quantity_basis, joint_id, thickness_role)
    VALUES (tpl, 'ตัวนอน', 'ตัวนอน', 'width', 'fixed', joint, 'sash') RETURNING id INTO comp;
  raised := false; BEGIN UPDATE bom_template_components SET thickness_role = 'frame' WHERE id = comp; EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'thickness_role other than sash was allowed'; END IF;
  raised := false; BEGIN UPDATE bom_template_components SET joint_ends = 3 WHERE id = comp; EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'joint_ends = 3 was allowed'; END IF;

  -- profile files: one row per uploaded file, removed with the profile (the storage object is removed by the app)
  INSERT INTO alu_profile_files (profile_id, file_path, file_name) VALUES (prof, 'x/y/1-a.pdf', 'a.pdf');

  -- settings: defaults, one row per tenant
  INSERT INTO estimation_settings DEFAULT VALUES RETURNING stock_length_m INTO ds;
  IF ds <> 6.4 THEN RAISE EXCEPTION 'stock_length_m default should be 6.4, got %', ds; END IF;
  raised := false; BEGIN INSERT INTO estimation_settings DEFAULT VALUES; EXCEPTION WHEN unique_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'a second settings row for one tenant was allowed'; END IF;
  raised := false; BEGIN UPDATE estimation_settings SET sealant_m_per_tube = 0; EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'sealant_m_per_tube = 0 was allowed'; END IF;
  UPDATE estimation_settings SET shim_part_id = part;

  -- project: format default, stock overrides (one per profile)
  INSERT INTO estimation_projects (name) VALUES ('EST2 PROJ') RETURNING id INTO proj;
  SELECT count(*) INTO n FROM estimation_projects WHERE id = proj AND description_format = '["item_name","type","size","alu_color"]'::jsonb AND stock_length_m IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'project description_format default wrong'; END IF;
  UPDATE estimation_projects SET primary_provider_id = prov, stock_length_m = 6, default_sash_thickness_mm = 1.5 WHERE id = proj;
  raised := false; BEGIN UPDATE estimation_projects SET default_sash_thickness_mm = 0 WHERE id = proj; EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'default_sash_thickness_mm = 0 was allowed'; END IF;
  raised := false; BEGIN UPDATE estimation_projects SET stock_length_m = 0 WHERE id = proj; EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'project stock_length_m = 0 was allowed'; END IF;
  INSERT INTO estimation_project_stock (project_id, profile_id, length_m) VALUES (proj, prof, 6.0);
  raised := false; BEGIN INSERT INTO estimation_project_stock (project_id, profile_id, length_m) VALUES (proj, prof, 5.8); EXCEPTION WHEN unique_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'two stock lengths for one profile in one project were allowed'; END IF;

  -- item: add-on position, offset, saved previews
  INSERT INTO estimation_openings (project_id, opening_no, template_id, width_m, height_m, thickness_mm, sash_thickness_mm, addon_position, addon_offset_m, preview_svg_out, preview_sig)
    VALUES (proj, 'D1', tpl, 2, 2, 2, 1.5, 'bottom', 0.5, '<svg/>', 'sig') RETURNING id INTO op;
  raised := false; BEGIN UPDATE estimation_openings SET sash_thickness_mm = 0 WHERE id = op; EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'sash_thickness_mm = 0 was allowed'; END IF;
  raised := false; BEGIN UPDATE estimation_openings SET addon_position = 'diagonal' WHERE id = op; EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'bad addon_position was allowed'; END IF;
  raised := false; BEGIN UPDATE estimation_openings SET addon_offset_m = -1 WHERE id = op; EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'negative addon_offset_m was allowed'; END IF;

  -- layout templates: add-on type and position come together
  INSERT INTO estimation_layout_templates (name, main_type_id) VALUES ('no addon', typ);
  INSERT INTO estimation_layout_templates (name, main_type_id, addon_type_id, addon_position, addon_offset_ratio) VALUES ('with addon', typ, typ2, 'top', 0.25);
  raised := false; BEGIN INSERT INTO estimation_layout_templates (name, main_type_id, addon_type_id) VALUES ('bad1', typ, typ2); EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'add-on type without a position was allowed'; END IF;
  raised := false; BEGIN INSERT INTO estimation_layout_templates (name, main_type_id, addon_position) VALUES ('bad2', typ, 'top'); EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'a position without an add-on type was allowed'; END IF;
  raised := false; BEGIN INSERT INTO estimation_layout_templates (name, main_type_id, addon_type_id, addon_position, addon_offset_ratio) VALUES ('bad3', typ, typ2, 'top', 1.5); EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'addon_offset_ratio over 1 was allowed'; END IF;
  raised := false; BEGIN INSERT INTO estimation_layout_templates (name, main_type_id) VALUES ('no addon', typ); EXCEPTION WHEN unique_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'duplicate layout template name was allowed'; END IF;

  RESET role;
  RAISE NOTICE 'Test 1 (columns, defaults, checks): TEST PASSED';
END $$;

-- ── Test 2: other tenants and a tenant without the module see and write nothing ──
-- (runs BEFORE the delete test so every table still holds a row for tenant A: an empty table would pass vacuously)
DO $$
DECLARE n INT; t TEXT; raised BOOLEAN; tbl TEXT;
BEGIN
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__est2_a__@example.com"}';
  SELECT count(*) INTO n FROM estimation_settings;
  IF n <> 1 THEN RAISE EXCEPTION 'tenant A should see its settings row, saw %', n; END IF;
  SELECT count(*) INTO n FROM estimation_layout_templates;
  IF n <> 2 THEN RAISE EXCEPTION 'tenant A should see its 2 layout templates, saw %', n; END IF;
  SELECT count(*) INTO n FROM estimation_project_stock;
  IF n <> 1 THEN RAISE EXCEPTION 'tenant A should see its stock override, saw %', n; END IF;
  SELECT count(*) INTO n FROM alu_profile_files;
  IF n <> 1 THEN RAISE EXCEPTION 'tenant A should see its profile file row, saw %', n; END IF;
  SELECT count(*) INTO n FROM bom_template_joints;
  IF n <> 2 THEN RAISE EXCEPTION 'tenant A should see its 2 joints, saw %', n; END IF;

  FOREACH t IN ARRAY ARRAY['b','c'] LOOP
    PERFORM set_config('request.jwt.claims', format('{"email":"__est2_%s__@example.com"}', t), true);
    FOREACH tbl IN ARRAY ARRAY['estimation_settings','estimation_layout_templates','estimation_project_stock','bom_template_joints','alu_profile_files'] LOOP
      EXECUTE format('SELECT count(*) FROM %I', tbl) INTO n;
      IF n <> 0 THEN RAISE EXCEPTION 'tenant % sees % rows of %', t, n, tbl; END IF;
    END LOOP;
  END LOOP;

  -- tenant C has no estimation module: it cannot create settings either
  PERFORM set_config('request.jwt.claims', '{"email":"__est2_c__@example.com"}', true);
  raised := false;
  BEGIN INSERT INTO estimation_settings DEFAULT VALUES; EXCEPTION WHEN insufficient_privilege THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'tenant without the estimation module could insert settings'; END IF;

  RESET role;
  RAISE NOTICE 'Test 2 (isolation and module gate): TEST PASSED';
END $$;

-- ── Test 3: delete behaviour ──
DO $$
DECLARE prof UUID; tpl UUID; joint UUID; proj UUID; part UUID; n INT;
BEGIN
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__est2_a__@example.com"}';
  SELECT id INTO tpl FROM bom_templates WHERE name = 'EST2 TPL';
  SELECT id INTO joint FROM bom_template_joints WHERE name = 'corner';
  SELECT id INTO prof FROM alu_profiles WHERE drawing_no = 'U1613';
  SELECT id INTO proj FROM estimation_projects WHERE name = 'EST2 PROJ';
  SELECT id INTO part FROM alu_parts WHERE name = 'EST2 SHIM';

  -- deleting a joint keeps the component (joint_id -> NULL)
  DELETE FROM bom_template_joints WHERE id = joint;
  SELECT count(*) INTO n FROM bom_template_components WHERE template_id = tpl AND joint_id IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'component should survive its joint being deleted'; END IF;

  -- deleting a profile removes that project's stock length override and its file rows
  DELETE FROM alu_profiles WHERE id = prof;
  SELECT count(*) INTO n FROM estimation_project_stock WHERE project_id = proj;
  IF n <> 0 THEN RAISE EXCEPTION 'stock override should go with its profile'; END IF;
  SELECT count(*) INTO n FROM alu_profile_files WHERE profile_id = prof;
  IF n <> 0 THEN RAISE EXCEPTION 'file rows should go with their profile'; END IF;

  -- deleting a part clears the settings link instead of failing
  DELETE FROM alu_parts WHERE id = part;
  SELECT count(*) INTO n FROM estimation_settings WHERE shim_part_id IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'settings shim_part_id should be cleared when the part is deleted'; END IF;

  -- deleting a template removes its remaining joints
  DELETE FROM estimation_openings WHERE template_id = tpl;
  DELETE FROM bom_templates WHERE id = tpl;
  SELECT count(*) INTO n FROM bom_template_joints WHERE template_id = tpl;
  IF n <> 0 THEN RAISE EXCEPTION 'joints should go with their template'; END IF;

  RESET role;
  RAISE NOTICE 'Test 3 (delete behaviour): TEST PASSED';
END $$;
