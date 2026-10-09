-- supabase/tests/estimation_type_parent_test.sql
-- RUN ONLY INSIDE ONE TRANSACTION THAT ENDS IN ROLLBACK (fixtures are real rows).
--   BEGIN; <catalog migrations 2026-10-10-01..03 if not applied>; 2026-10-12-02; <this file>; ROLLBACK;
-- Tenants: A and B hold only 'estimation'; C holds nothing.

CREATE TEMP TABLE _tpar_fx (a_tenant UUID, b_tenant UUID, c_tenant UUID);
DO $$
DECLARE owner_id UUID; ta UUID; tb UUID; tc UUID;
BEGIN
  SELECT id INTO owner_id FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__TPAR TEST A__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO ta;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__TPAR TEST B__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO tb;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__TPAR TEST C__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO tc;
  INSERT INTO tenant_modules (tenant_id, module_key) VALUES (ta, 'estimation'), (tb, 'estimation');
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES
    ('__tpar_a__@example.com', 'OWNER', 'approved', ta),
    ('__tpar_b__@example.com', 'OWNER', 'approved', tb),
    ('__tpar_c__@example.com', 'OWNER', 'approved', tc);
  INSERT INTO _tpar_fx VALUES (ta, tb, tc);
END $$;

-- ── Test 1: the rules (as tenant A) ──
DO $$
DECLARE l1 UUID; l2 UUID; l3 UUID; w UUID; x UUID; xc UUID; y UUID; l4 UUID; raised BOOLEAN; n INT;
BEGIN
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__tpar_a__@example.com"}';

  -- categories
  INSERT INTO door_window_types (name, category) VALUES ('T-CW', 'curtain_wall');
  raised := false; BEGIN INSERT INTO door_window_types (name, category) VALUES ('T-ROOF', 'roof'); EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'category roof was allowed'; END IF;

  -- three levels
  INSERT INTO door_window_types (name, category) VALUES ('T-L1', 'door') RETURNING id INTO l1;
  INSERT INTO door_window_types (name, category, parent_id) VALUES ('T-L2', 'door', l1) RETURNING id INTO l2;
  INSERT INTO door_window_types (name, category, parent_id) VALUES ('T-L3', 'door', l2) RETURNING id INTO l3;

  -- a fourth level
  raised := false; BEGIN INSERT INTO door_window_types (name, category, parent_id) VALUES ('T-L4', 'door', l3); EXCEPTION WHEN raise_exception THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'a fourth level was allowed'; END IF;

  -- category mismatch with the parent
  INSERT INTO door_window_types (name, category) VALUES ('T-W', 'window') RETURNING id INTO w;
  raised := false; BEGIN INSERT INTO door_window_types (name, category, parent_id) VALUES ('T-BAD', 'door', w); EXCEPTION WHEN raise_exception THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'a door under a window parent was allowed'; END IF;

  -- self parent
  raised := false; BEGIN UPDATE door_window_types SET parent_id = id WHERE id = l1; EXCEPTION WHEN raise_exception THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'self parent was allowed'; END IF;

  -- loop: L1 under its own grandchild
  raised := false; BEGIN UPDATE door_window_types SET parent_id = l3 WHERE id = l1; EXCEPTION WHEN raise_exception THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'moving a type under its own descendant was allowed'; END IF;

  -- moving a subtree must keep it within three levels (depth 2 above + height 2 = 4)
  INSERT INTO door_window_types (name, category) VALUES ('T-X', 'door') RETURNING id INTO x;
  INSERT INTO door_window_types (name, category, parent_id) VALUES ('T-XC', 'door', x) RETURNING id INTO xc;
  raised := false; BEGIN UPDATE door_window_types SET parent_id = l2 WHERE id = x; EXCEPTION WHEN raise_exception THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'moving a type with a child under a level-2 type was allowed'; END IF;
  INSERT INTO door_window_types (name, category) VALUES ('T-Y', 'door') RETURNING id INTO y;
  UPDATE door_window_types SET parent_id = l2 WHERE id = y;   -- childless: becomes level 3, fine
  SELECT count(*) INTO n FROM door_window_types WHERE parent_id = l2;
  IF n <> 2 THEN RAISE EXCEPTION 'T-L2 should now have 2 children, has %', n; END IF;

  -- category cannot change while children have another category
  raised := false; BEGIN UPDATE door_window_types SET category = 'window' WHERE id = l1; EXCEPTION WHEN raise_exception THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'category change under door children was allowed'; END IF;

  -- delete is restricted while a child exists, then works from the leaves up
  raised := false; BEGIN DELETE FROM door_window_types WHERE id = l1; EXCEPTION WHEN foreign_key_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'deleting a type with a child was allowed'; END IF;
  DELETE FROM door_window_types WHERE id IN (l3, y);
  DELETE FROM door_window_types WHERE id = l2;
  DELETE FROM door_window_types WHERE id = l1;
  SELECT count(*) INTO n FROM door_window_types WHERE id = l1;
  IF n <> 0 THEN RAISE EXCEPTION 'T-L1 should be deleted'; END IF;

  RESET role;
  RAISE NOTICE 'Test 1 (rules): TEST PASSED';
END $$;

-- ── Test 2: isolation (runs BEFORE any bulk delete; tenant A keeps rows) ──
DO $$
DECLARE b_type UUID; raised BOOLEAN; n INT;
BEGIN
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__tpar_b__@example.com"}';
  INSERT INTO door_window_types (name, category) VALUES ('T-B-ONLY', 'door') RETURNING id INTO b_type;

  PERFORM set_config('request.jwt.claims', '{"email":"__tpar_a__@example.com"}', true);
  SELECT count(*) INTO n FROM door_window_types WHERE name = 'T-B-ONLY';
  IF n <> 0 THEN RAISE EXCEPTION 'tenant A sees tenant B types'; END IF;
  SELECT count(*) INTO n FROM door_window_types;
  IF n < 1 THEN RAISE EXCEPTION 'tenant A should still see its own types (a vacuous pass otherwise)'; END IF;
  raised := false; BEGIN INSERT INTO door_window_types (name, category, parent_id) VALUES ('T-A-CHILD', 'door', b_type); EXCEPTION WHEN raise_exception THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'a parent owned by another tenant was allowed'; END IF;

  -- tenant C has no estimation module: sees nothing, cannot insert
  PERFORM set_config('request.jwt.claims', '{"email":"__tpar_c__@example.com"}', true);
  SELECT count(*) INTO n FROM door_window_types;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant without the module sees % types', n; END IF;
  raised := false;
  BEGIN INSERT INTO door_window_types (name, category) VALUES ('T-C', 'door'); EXCEPTION WHEN insufficient_privilege THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'tenant without the estimation module could insert a type'; END IF;

  RESET role;
  RAISE NOTICE 'Test 2 (isolation and module gate): TEST PASSED';
END $$;

-- ── Test 3: existing rows unchanged ──
DO $$
DECLARE tid UUID; p UUID;
BEGIN
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__tpar_a__@example.com"}';
  INSERT INTO door_window_types (name, category) VALUES ('T-PLAIN-D', 'door') RETURNING id, parent_id INTO tid, p;
  IF p IS NOT NULL THEN RAISE EXCEPTION 'parent_id should default to NULL'; END IF;
  INSERT INTO door_window_types (name, category) VALUES ('T-PLAIN-W', 'window');
  UPDATE door_window_types SET name = 'T-PLAIN-D2' WHERE id = tid;
  RESET role;
  RAISE NOTICE 'Test 3 (existing rows unchanged): TEST PASSED';
END $$;
