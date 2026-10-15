-- supabase/tests/item_addons_test.sql
-- RUN ONLY INSIDE ONE TRANSACTION THAT ENDS IN ROLLBACK (fixtures are real rows).
--   BEGIN; <catalog + estimation migrations through 2026-10-15-01> if not applied; 2026-10-18-01; <this file>; ROLLBACK;
-- Tenants: A and B hold only 'estimation'; C holds nothing.

CREATE TEMP TABLE _ao_fx (a_tenant UUID, b_tenant UUID, c_tenant UUID, a_tpl UUID, a_tpl2 UUID, a_op UUID);
DO $$
DECLARE owner_id UUID; ta UUID; tb UUID; tc UUID;
BEGIN
  SELECT id INTO owner_id FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__AO TEST A__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO ta;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__AO TEST B__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO tb;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__AO TEST C__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO tc;
  INSERT INTO tenant_modules (tenant_id, module_key) VALUES (ta, 'estimation'), (tb, 'estimation');
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES
    ('__ao_a__@example.com', 'OWNER', 'approved', ta),
    ('__ao_b__@example.com', 'OWNER', 'approved', tb),
    ('__ao_c__@example.com', 'OWNER', 'approved', tc);
  INSERT INTO _ao_fx (a_tenant, b_tenant, c_tenant) VALUES (ta, tb, tc);
END $$;

-- Test 1: good rows insert (as tenant A); builds the fixtures used by later tests
DO $$
DECLARE tpl UUID; tpl2 UUID; proj UUID; op UUID; n INT; fac NUMERIC; qr TEXT;
BEGIN
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__ao_a__@example.com"}';

  INSERT INTO bom_templates (name, category) VALUES ('AO-TPL', 'window') RETURNING id INTO tpl;
  INSERT INTO bom_templates (name, category) VALUES ('AO-TPL2', 'window') RETURNING id INTO tpl2;
  INSERT INTO estimation_projects (name) VALUES ('AO-PROJ') RETURNING id INTO proj;
  INSERT INTO estimation_openings (project_id, opening_no, template_id, width_m, height_m)
    VALUES (proj, 'AO1', tpl, 2, 2) RETURNING id INTO op;

  INSERT INTO bom_template_addon_pieces (template_id, mode, kind, position, piece_key, ref_input)
    VALUES (tpl, 'merge', 'fixed', 'top', 'ext', 'th');
  INSERT INTO bom_template_addon_pieces (template_id, mode, kind, position, piece_key, ref_input)
    VALUES (tpl, 'attach', 'fixed', NULL, 'frame_top', 'w');
  SELECT count(*) INTO n FROM bom_template_addon_pieces WHERE template_id = tpl;
  IF n <> 2 THEN RAISE EXCEPTION 'expected 2 piece rows, got %', n; END IF;
  SELECT length_factor, qty_rule INTO fac, qr FROM bom_template_addon_pieces WHERE template_id = tpl AND mode = 'merge';
  IF fac <> 1 OR qr <> 'fixed' THEN RAISE EXCEPTION 'piece defaults should be factor 1 / qty_rule fixed'; END IF;

  INSERT INTO estimation_item_addons (opening_id, mode, kind, position, len_m, thick_m)
    VALUES (op, 'merge', 'fixed', 'top', 1.5, 0.4);
  SELECT count(*) INTO n FROM estimation_item_addons WHERE opening_id = op AND offset_m = 0 AND rows = 1 AND cols = 1;
  IF n <> 1 THEN RAISE EXCEPTION 'item add-on row or defaults wrong'; END IF;

  RESET role;
  UPDATE _ao_fx SET a_tpl = tpl, a_tpl2 = tpl2, a_op = op;
  RAISE NOTICE 'Test 1 (good rows): TEST PASSED';
END $$;

-- Test 2: template piece rejects (as tenant A). Each case must raise the given SQLSTATE.
DO $$
DECLARE tpl UUID; c RECORD; state TEXT;
        pre TEXT; base_m TEXT; base_a TEXT;
BEGIN
  SELECT a_tpl INTO tpl FROM _ao_fx WHERE a_tpl IS NOT NULL;
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__ao_a__@example.com"}';
  pre := format('INSERT INTO bom_template_addon_pieces (template_id, mode, kind, position, piece_key, ref_input%%s) VALUES (%L, %%s)', tpl);
  FOR c IN SELECT * FROM (VALUES
    ('merge with position NULL',        format(pre, '', '''merge'',''fixed'',NULL,''ext'',''th'''), '23514'),
    ('attach with position top',        format(pre, '', '''attach'',''fixed'',''top'',''frame_top'',''w'''), '23514'),
    ('attach piece_key ext',            format(pre, '', '''attach'',''fixed'',NULL,''ext'',''w'''), '23514'),
    ('merge piece_key frame_side',      format(pre, '', '''merge'',''fixed'',''left'',''frame_side'',''w'''), '23514'),
    ('attach ref_input tw',             format(pre, '', '''attach'',''fixed'',NULL,''mullion'',''tw'''), '23514'),
    ('bad mode',                        format(pre, '', '''x'',''fixed'',''top'',''ext'',''th'''), '23514'),
    ('bad kind',                        format(pre, '', '''merge'',''x'',''top'',''ext'',''th'''), '23514'),
    ('bad position',                    format(pre, '', '''merge'',''fixed'',''middle'',''ext'',''th'''), '23514'),
    ('bad piece_key',                   format(pre, '', '''merge'',''fixed'',''top'',''x'',''th'''), '23514'),
    ('bad ref_input',                   format(pre, '', '''merge'',''fixed'',''top'',''divider'',''x'''), '23514'),
    ('qty_fixed -1',                    format(pre, ', qty_fixed', '''merge'',''fixed'',''top'',''divider'',''th'', -1'), '23514'),
    ('qty_fixed 1001',                  format(pre, ', qty_fixed', '''merge'',''fixed'',''top'',''divider'',''th'', 1001'), '23514'),
    ('length_factor 0',                 format(pre, ', length_factor', '''merge'',''fixed'',''top'',''divider'',''th'', 0'), '23514'),
    ('deduction_mm -1',                 format(pre, ', deduction_mm', '''merge'',''fixed'',''top'',''divider'',''th'', -1'), '23514'),
    ('bad qty_rule',                    format(pre, ', qty_rule', '''merge'',''fixed'',''top'',''divider'',''th'', ''x'''), '23514'),
    ('bad thickness_role',              format(pre, ', thickness_role', '''merge'',''fixed'',''top'',''divider'',''th'', ''x'''), '23514'),
    ('note of 121 chars',               format(pre, ', note', '''merge'',''fixed'',''top'',''divider'',''th'', ' || quote_literal(repeat('x', 121))), '23514'),
    ('duplicate merge set key',         format(pre, '', '''merge'',''fixed'',''top'',''ext'',''th'''), '23505'),
    ('duplicate attach (position NULL)', format(pre, '', '''attach'',''fixed'',NULL,''frame_top'',''w'''), '23505')
  ) AS v(label, stmt, want) LOOP
    BEGIN
      EXECUTE c.stmt;
      RAISE EXCEPTION 'constraint missing: %', c.label;
    EXCEPTION
      WHEN check_violation OR unique_violation THEN
        GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
        IF state <> c.want THEN RAISE EXCEPTION '%: expected %, got %', c.label, c.want, state; END IF;
    END;
  END LOOP;

  -- boundary values that must be accepted: 120-char note, qty_fixed 0 and 1000, deduction 0
  INSERT INTO bom_template_addon_pieces (template_id, mode, kind, position, piece_key, ref_input, note, qty_fixed)
    VALUES (tpl, 'merge', 'fixed', 'top', 'divider', 'th', repeat('x', 120), 0);
  INSERT INTO bom_template_addon_pieces (template_id, mode, kind, position, piece_key, ref_input, qty_fixed)
    VALUES (tpl, 'merge', 'awning', 'top', 'ao_bead', 'tw', 1000);

  RESET role;
  RAISE NOTICE 'Test 2 (piece rejects): TEST PASSED';
END $$;

-- Test 3: item add-on rejects (as tenant A). Each case is one INSERT with a single bad value.
DO $$
DECLARE op UUID; c RECORD; state TEXT; pre TEXT;
BEGIN
  SELECT a_op INTO op FROM _ao_fx WHERE a_op IS NOT NULL;
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__ao_a__@example.com"}';
  pre := format('INSERT INTO estimation_item_addons (opening_id, %%s) VALUES (%L, %%s)', op);
  FOR c IN SELECT * FROM (VALUES
    ('rows 7',          format(pre, 'mode, kind, position, len_m, thick_m, rows', '''merge'',''fixed'',''top'',1,0.4,7')),
    ('rows 0',          format(pre, 'mode, kind, position, len_m, thick_m, rows', '''merge'',''fixed'',''top'',1,0.4,0')),
    ('cols 13',         format(pre, 'mode, kind, position, len_m, thick_m, cols', '''merge'',''fixed'',''top'',1,0.4,13')),
    ('cols 0',          format(pre, 'mode, kind, position, len_m, thick_m, cols', '''merge'',''fixed'',''top'',1,0.4,0')),
    ('len_m 0',         format(pre, 'mode, kind, position, len_m, thick_m', '''merge'',''fixed'',''top'',0,0.4')),
    ('len_m 21',        format(pre, 'mode, kind, position, len_m, thick_m', '''merge'',''fixed'',''top'',21,0.4')),
    ('thick_m 0',       format(pre, 'mode, kind, position, len_m, thick_m', '''merge'',''fixed'',''top'',1,0')),
    ('thick_m 21',      format(pre, 'mode, kind, position, len_m, thick_m', '''merge'',''fixed'',''top'',1,21')),
    ('offset_m -1',     format(pre, 'mode, kind, position, len_m, thick_m, offset_m', '''merge'',''fixed'',''top'',1,0.4,-1')),
    ('position middle', format(pre, 'mode, kind, position, len_m, thick_m', '''merge'',''fixed'',''middle'',1,0.4')),
    ('mode x',          format(pre, 'mode, kind, position, len_m, thick_m', '''x'',''fixed'',''top'',1,0.4')),
    ('kind x',          format(pre, 'mode, kind, position, len_m, thick_m', '''merge'',''x'',''top'',1,0.4'))
  ) AS v(label, stmt) LOOP
    BEGIN
      EXECUTE c.stmt;
      RAISE EXCEPTION 'constraint missing: %', c.label;
    EXCEPTION
      WHEN check_violation THEN
        GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
        IF state <> '23514' THEN RAISE EXCEPTION '%: expected 23514, got %', c.label, state; END IF;
    END;
  END LOOP;

  -- boundary values that must be accepted
  INSERT INTO estimation_item_addons (opening_id, mode, kind, position, len_m, thick_m, rows, cols)
    VALUES (op, 'attach', 'awning', 'left', 20, 20, 6, 12);

  RESET role;
  RAISE NOTICE 'Test 3 (item add-on rejects): TEST PASSED';
END $$;

-- Test 4: isolation and module gate, BEFORE any delete
DO $$
DECLARE n INT; state TEXT; tpl UUID; op UUID; ta UUID;
BEGIN
  SELECT a_tpl, a_op, a_tenant INTO tpl, op, ta FROM _ao_fx WHERE a_tpl IS NOT NULL;
  SET LOCAL role = 'authenticated';

  SET LOCAL request.jwt.claims = '{"email":"__ao_a__@example.com"}';
  SELECT count(*) INTO n FROM bom_template_addon_pieces; IF n < 4 THEN RAISE EXCEPTION 'tenant A should see its pieces, sees %', n; END IF;
  SELECT count(*) INTO n FROM estimation_item_addons;    IF n < 2 THEN RAISE EXCEPTION 'tenant A should see its add-ons, sees %', n; END IF;

  PERFORM set_config('request.jwt.claims', '{"email":"__ao_b__@example.com"}', true);
  SELECT count(*) INTO n FROM bom_template_addon_pieces; IF n <> 0 THEN RAISE EXCEPTION 'tenant B sees % pieces of A', n; END IF;
  SELECT count(*) INTO n FROM estimation_item_addons;    IF n <> 0 THEN RAISE EXCEPTION 'tenant B sees % add-ons of A', n; END IF;
  BEGIN
    INSERT INTO bom_template_addon_pieces (tenant_id, template_id, mode, kind, position, piece_key, ref_input)
      VALUES (ta, tpl, 'merge', 'fixed', 'bottom', 'ext', 'th');
    RAISE EXCEPTION 'tenant B could insert a piece into A';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
    IF state <> '42501' THEN RAISE EXCEPTION 'expected 42501, got %', state; END IF;
  END;
  BEGIN
    INSERT INTO estimation_item_addons (tenant_id, opening_id, mode, kind, position, len_m, thick_m)
      VALUES (ta, op, 'merge', 'fixed', 'bottom', 1, 1);
    RAISE EXCEPTION 'tenant B could insert an add-on into A';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
    IF state <> '42501' THEN RAISE EXCEPTION 'expected 42501, got %', state; END IF;
  END;

  PERFORM set_config('request.jwt.claims', '{"email":"__ao_c__@example.com"}', true);
  SELECT count(*) INTO n FROM bom_template_addon_pieces; IF n <> 0 THEN RAISE EXCEPTION 'tenant without the module sees % pieces', n; END IF;
  SELECT count(*) INTO n FROM estimation_item_addons;    IF n <> 0 THEN RAISE EXCEPTION 'tenant without the module sees % add-ons', n; END IF;
  BEGIN
    INSERT INTO estimation_item_addons (opening_id, mode, kind, position, len_m, thick_m)
      VALUES (op, 'merge', 'fixed', 'bottom', 1, 1);
    RAISE EXCEPTION 'tenant without the estimation module could insert an add-on';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
    IF state <> '42501' THEN RAISE EXCEPTION 'expected 42501, got %', state; END IF;
  END;

  RESET role;
  RAISE NOTICE 'Test 4 (isolation and module gate): TEST PASSED';
END $$;

-- Test 5: the migration's RLS DO block is re-runnable (policy guard). Copy of the block in 2026-10-18-01; keep in sync.
DO $$
DECLARE t TEXT; n INT; i INT;
BEGIN
  FOR i IN 1..2 LOOP
    FOREACH t IN ARRAY ARRAY['bom_template_addon_pieces','estimation_item_addons'] LOOP
      EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_tenant_id ON %I(tenant_id)', t, t);
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'admin_full_access') THEN
        EXECUTE format($p$CREATE POLICY admin_full_access ON %I FOR ALL TO authenticated
          USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
          WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))$p$, t);
      END IF;
    END LOOP;
  END LOOP;
  SELECT count(*) INTO n FROM pg_policies
    WHERE tablename IN ('bom_template_addon_pieces','estimation_item_addons') AND policyname = 'admin_full_access';
  IF n <> 2 THEN RAISE EXCEPTION 'expected exactly 2 admin_full_access policies, got %', n; END IF;
  RAISE NOTICE 'Test 5 (re-runnable policy guard): TEST PASSED';
END $$;

-- Test 6: cascades (as tenant A)
DO $$
DECLARE tpl2 UUID; tpl UUID; op UUID; n INT;
BEGIN
  SELECT a_tpl, a_tpl2, a_op INTO tpl, tpl2, op FROM _ao_fx WHERE a_tpl IS NOT NULL;
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__ao_a__@example.com"}';

  -- delete template -> its pieces go (tpl2 has no opening, so ON DELETE RESTRICT does not interfere)
  INSERT INTO bom_template_addon_pieces (template_id, mode, kind, position, piece_key, ref_input)
    VALUES (tpl2, 'merge', 'fixed', 'top', 'ext', 'th'), (tpl2, 'attach', 'fixed', NULL, 'rail', 'h');
  DELETE FROM bom_templates WHERE id = tpl2;
  SELECT count(*) INTO n FROM bom_template_addon_pieces WHERE template_id = tpl2;
  IF n <> 0 THEN RAISE EXCEPTION '% pieces left after deleting the template', n; END IF;
  SELECT count(*) INTO n FROM bom_template_addon_pieces WHERE template_id = tpl;
  IF n = 0 THEN RAISE EXCEPTION 'deleting another template must not remove the pieces of tpl'; END IF;

  -- delete opening -> its add-ons go
  SELECT count(*) INTO n FROM estimation_item_addons WHERE opening_id = op;
  IF n = 0 THEN RAISE EXCEPTION 'fixture: opening should hold add-ons'; END IF;
  DELETE FROM estimation_openings WHERE id = op;
  SELECT count(*) INTO n FROM estimation_item_addons WHERE opening_id = op;
  IF n <> 0 THEN RAISE EXCEPTION '% add-ons left after deleting the opening', n; END IF;

  RESET role;
  RAISE NOTICE 'Test 6 (cascades): TEST PASSED';
END $$;
