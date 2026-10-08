-- supabase/tests/alu_catalog_test.sql
-- Aluminium cost catalog: RLS isolation, uniqueness and CHECK constraints.
-- RUN ONLY INSIDE A TRANSACTION THAT ROLLS BACK:
--   BEGIN; <migrations 01..03>; <this file>; ROLLBACK;
-- Tenants: A and B have ONLY the 'estimation' module (the catalog must not need purchase_orders), C has no module (expired trial).

CREATE TEMP TABLE _alu_fx (a_tenant UUID, b_tenant UUID, c_tenant UUID);
DO $$
DECLARE owner_id UUID; ta UUID; tb UUID; tc UUID;
BEGIN
  SELECT id INTO owner_id FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__ALU TEST A__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO ta;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__ALU TEST B__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO tb;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__ALU TEST C__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO tc;
  INSERT INTO tenant_modules (tenant_id, module_key) VALUES (ta, 'estimation'), (tb, 'estimation');
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES
    ('__alu_a__@example.com', 'OWNER', 'approved', ta),
    ('__alu_b__@example.com', 'OWNER', 'approved', tb),
    ('__alu_c__@example.com', 'OWNER', 'approved', tc);
  INSERT INTO _alu_fx VALUES (ta, tb, tc);
END $$;

-- ── Test 1: hierarchy tables ──
DO $$
DECLARE
  prov UUID; prov2 UUID; ser UUID; typ UUID; n INT;
BEGIN
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__alu_a__@example.com"}';

  INSERT INTO alu_providers (name, short_name, price_basis) VALUES ('TYK', 'TYK', 'per_kg') RETURNING id INTO prov;
  INSERT INTO alu_providers (name, short_name, price_basis) VALUES ('KC', 'KC', 'both') RETURNING id INTO prov2;
  INSERT INTO alu_series (provider_id, name, is_base) VALUES (prov, 'กล่องร่อง', true) RETURNING id INTO ser;
  -- the same series name under a different provider is allowed
  INSERT INTO alu_series (provider_id, name) VALUES (prov2, 'กล่องร่อง');
  INSERT INTO door_window_types (name, category, default_labour_per_sqm) VALUES ('บานเลื่อน', 'window', 140) RETURNING id INTO typ;
  INSERT INTO alu_series_types (series_id, type_id) VALUES (ser, typ);

  -- invalid price_basis
  BEGIN
    INSERT INTO alu_providers (name, short_name, price_basis) VALUES ('BAD', 'BAD', 'per_sheet');
    RAISE EXCEPTION 'price_basis CHECK did not fire';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- duplicate provider name inside one tenant
  BEGIN
    INSERT INTO alu_providers (name, short_name) VALUES ('TYK', 'TYK2');
    RAISE EXCEPTION 'provider unique did not fire';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  -- duplicate series<->type link
  BEGIN
    INSERT INTO alu_series_types (series_id, type_id) VALUES (ser, typ);
    RAISE EXCEPTION 'series_types unique did not fire';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  -- tenant B: sees nothing of A, and may reuse the same provider name
  SET LOCAL request.jwt.claims = '{"email":"__alu_b__@example.com"}';
  SELECT count(*) INTO n FROM alu_providers;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant B sees % of tenant A providers', n; END IF;
  INSERT INTO alu_providers (name, short_name) VALUES ('TYK', 'TYK');

  -- tenant C (no estimation module): reads nothing, cannot write
  SET LOCAL request.jwt.claims = '{"email":"__alu_c__@example.com"}';
  SELECT count(*) INTO n FROM alu_providers;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant C sees providers'; END IF;
  BEGIN
    INSERT INTO alu_providers (name, short_name) VALUES ('NOPE', 'NOPE');
    RAISE EXCEPTION 'tenant C insert was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  RESET role;
  RAISE NOTICE 'Test 1 (hierarchy): TEST PASSED';
END $$;
