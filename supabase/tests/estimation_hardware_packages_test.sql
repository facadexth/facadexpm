-- supabase/tests/estimation_hardware_packages_test.sql
-- RUN ONLY INSIDE ONE TRANSACTION THAT ENDS IN ROLLBACK (fixtures are real rows).
--   BEGIN; <catalog migrations 2026-10-10-01..03 if not applied>; 2026-10-12-03; <this file>; ROLLBACK;
-- Tenants: A and B hold only 'estimation'; C holds nothing.

CREATE TEMP TABLE _hwp_fx (a_tenant UUID, b_tenant UUID, c_tenant UUID, a_pkg UUID, a_type UUID, a_proj UUID);
DO $$
DECLARE owner_id UUID; ta UUID; tb UUID; tc UUID;
BEGIN
  SELECT id INTO owner_id FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__HWP TEST A__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO ta;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__HWP TEST B__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO tb;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__HWP TEST C__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO tc;
  INSERT INTO tenant_modules (tenant_id, module_key) VALUES (ta, 'estimation'), (tb, 'estimation');
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES
    ('__hwp_a__@example.com', 'OWNER', 'approved', ta),
    ('__hwp_b__@example.com', 'OWNER', 'approved', tb),
    ('__hwp_c__@example.com', 'OWNER', 'approved', tc);
  INSERT INTO _hwp_fx (a_tenant, b_tenant, c_tenant) VALUES (ta, tb, tc);
END $$;

-- ── Test 1: the rules (as tenant A) ──
DO $$
DECLARE t1 UUID; t2 UUID; part UUID; pkg UUID; proj UUID; n INT; hw UUID; state TEXT;
BEGIN
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__hwp_a__@example.com"}';

  INSERT INTO door_window_types (name, category) VALUES ('HWP-T1', 'door') RETURNING id INTO t1;
  INSERT INTO door_window_types (name, category) VALUES ('HWP-T2', 'window') RETURNING id INTO t2;
  INSERT INTO alu_parts (name, kind) VALUES ('HWP-SET', 'hardware_set') RETURNING id INTO part;

  INSERT INTO alu_hardware_packages (name, series_id) VALUES ('HWP-PKG', NULL) RETURNING id INTO pkg;
  INSERT INTO alu_hardware_package_items (package_id, type_id, hardware_set_id) VALUES (pkg, t1, part);
  INSERT INTO alu_hardware_package_items (package_id, type_id, hardware_set_id) VALUES (pkg, t2, NULL);
  SELECT count(*) INTO n FROM alu_hardware_package_items WHERE package_id = pkg;
  IF n <> 2 THEN RAISE EXCEPTION 'package should have 2 rows, has %', n; END IF;
  SELECT hardware_set_id INTO hw FROM alu_hardware_package_items WHERE package_id = pkg AND type_id = t2;
  IF hw IS NOT NULL THEN RAISE EXCEPTION 'the "no hardware set" row should keep a NULL set'; END IF;

  -- duplicate (package, type)
  BEGIN
    INSERT INTO alu_hardware_package_items (package_id, type_id, hardware_set_id) VALUES (pkg, t1, NULL);
    RAISE EXCEPTION 'a duplicate (package, type) was allowed';
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
    IF state <> '23505' THEN RAISE EXCEPTION 'expected 23505, got %', state; END IF;
  END;

  -- duplicate package name
  BEGIN
    INSERT INTO alu_hardware_packages (name) VALUES ('HWP-PKG');
    RAISE EXCEPTION 'a duplicate package name was allowed';
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
    IF state <> '23505' THEN RAISE EXCEPTION 'expected 23505, got %', state; END IF;
  END;

  -- a project can take the package
  INSERT INTO estimation_projects (name, hardware_package_id) VALUES ('HWP-PROJ', pkg) RETURNING id INTO proj;
  SELECT count(*) INTO n FROM estimation_projects WHERE id = proj AND hardware_package_id = pkg;
  IF n <> 1 THEN RAISE EXCEPTION 'the project did not take hardware_package_id'; END IF;

  RESET role;
  INSERT INTO _hwp_fx (a_pkg, a_type, a_proj) VALUES (pkg, t1, proj);
  RAISE NOTICE 'Test 1 (rules): TEST PASSED';
END $$;

-- ── Test 2: isolation and module gate, BEFORE any delete ──
DO $$
DECLARE pkg UUID; n INT; state TEXT;
BEGIN
  SELECT a_pkg INTO pkg FROM _hwp_fx WHERE a_pkg IS NOT NULL;
  SET LOCAL role = 'authenticated';

  -- tenant A sees its own rows (otherwise the zero-counts below prove nothing)
  SET LOCAL request.jwt.claims = '{"email":"__hwp_a__@example.com"}';
  SELECT count(*) INTO n FROM alu_hardware_packages;
  IF n < 1 THEN RAISE EXCEPTION 'tenant A should see its own package'; END IF;
  SELECT count(*) INTO n FROM alu_hardware_package_items;
  IF n < 2 THEN RAISE EXCEPTION 'tenant A should see its own package rows'; END IF;

  -- tenant B (has estimation) sees none of A's rows
  PERFORM set_config('request.jwt.claims', '{"email":"__hwp_b__@example.com"}', true);
  SELECT count(*) INTO n FROM alu_hardware_packages;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant B sees % of A packages', n; END IF;
  SELECT count(*) INTO n FROM alu_hardware_package_items;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant B sees % of A package rows', n; END IF;

  -- tenant C (no estimation module) sees nothing and cannot insert
  PERFORM set_config('request.jwt.claims', '{"email":"__hwp_c__@example.com"}', true);
  SELECT count(*) INTO n FROM alu_hardware_packages;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant without the module sees % packages', n; END IF;
  SELECT count(*) INTO n FROM alu_hardware_package_items;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant without the module sees % package rows', n; END IF;
  BEGIN
    INSERT INTO alu_hardware_packages (name) VALUES ('HWP-C');
    RAISE EXCEPTION 'tenant without the estimation module could insert a package';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
    IF state <> '42501' THEN RAISE EXCEPTION 'expected 42501, got %', state; END IF;
  END;

  RESET role;
  RAISE NOTICE 'Test 2 (isolation and module gate): TEST PASSED';
END $$;

-- ── Test 3: deletes (as tenant A) ──
DO $$
DECLARE prov UUID; ser UUID; t3 UUID; t4 UUID; part2 UUID; pkg2 UUID; pkg UUID; proj UUID; n INT; sid UUID; hw UUID;
BEGIN
  SELECT a_pkg, a_proj INTO pkg, proj FROM _hwp_fx WHERE a_pkg IS NOT NULL;
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__hwp_a__@example.com"}';

  -- deleting the type removes its rows
  INSERT INTO door_window_types (name, category) VALUES ('HWP-T3', 'door') RETURNING id INTO t3;
  INSERT INTO alu_hardware_package_items (package_id, type_id, hardware_set_id) VALUES (pkg, t3, NULL);
  DELETE FROM door_window_types WHERE id = t3;
  SELECT count(*) INTO n FROM alu_hardware_package_items WHERE package_id = pkg AND type_id = t3;
  IF n <> 0 THEN RAISE EXCEPTION 'deleting the type should remove its package rows'; END IF;

  -- deleting the part removes the rows that used it
  INSERT INTO door_window_types (name, category) VALUES ('HWP-T4', 'door') RETURNING id INTO t4;
  INSERT INTO alu_parts (name, kind) VALUES ('HWP-SET2', 'hardware_set') RETURNING id INTO part2;
  INSERT INTO alu_hardware_package_items (package_id, type_id, hardware_set_id) VALUES (pkg, t4, part2);
  DELETE FROM alu_parts WHERE id = part2;
  SELECT count(*) INTO n FROM alu_hardware_package_items WHERE package_id = pkg AND type_id = t4;
  IF n <> 0 THEN RAISE EXCEPTION 'deleting the part should remove the package rows that used it'; END IF;

  -- deleting a series sets the package's series_id to NULL
  INSERT INTO alu_providers (name, short_name) VALUES ('HWP-PROV', 'HP') RETURNING id INTO prov;
  INSERT INTO alu_series (provider_id, name) VALUES (prov, 'HWP-SER') RETURNING id INTO ser;
  INSERT INTO alu_hardware_packages (name, series_id) VALUES ('HWP-PKG2', ser) RETURNING id INTO pkg2;
  DELETE FROM alu_series WHERE id = ser;
  SELECT series_id INTO sid FROM alu_hardware_packages WHERE id = pkg2;
  IF sid IS NOT NULL THEN RAISE EXCEPTION 'deleting the series should set the package series_id to NULL'; END IF;
  SELECT count(*) INTO n FROM alu_hardware_packages WHERE id = pkg2;
  IF n <> 1 THEN RAISE EXCEPTION 'deleting the series must keep the package'; END IF;

  -- deleting the package removes its rows and clears the project's pointer
  DELETE FROM alu_hardware_packages WHERE id = pkg;
  SELECT count(*) INTO n FROM alu_hardware_package_items WHERE package_id = pkg;
  IF n <> 0 THEN RAISE EXCEPTION 'deleting the package should remove its rows'; END IF;
  SELECT hardware_package_id INTO hw FROM estimation_projects WHERE id = proj;
  IF hw IS NOT NULL THEN RAISE EXCEPTION 'deleting the package should set the project hardware_package_id to NULL'; END IF;
  SELECT count(*) INTO n FROM estimation_projects WHERE id = proj;
  IF n <> 1 THEN RAISE EXCEPTION 'deleting the package must keep the project'; END IF;

  RESET role;
  RAISE NOTICE 'Test 3 (deletes): TEST PASSED';
END $$;
