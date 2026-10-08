-- supabase/tests/alu_catalog_test.sql
-- Aluminium cost catalog: RLS isolation, uniqueness and CHECK constraints.
-- RUN ONLY INSIDE ONE TRANSACTION THAT ENDS IN ROLLBACK (the fixtures are real rows).
-- A failing test leaves the session role set to 'authenticated'; ROLLBACK (or RESET role) before reusing the session.
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
  ta UUID; tb UUID; tc UUID;
  prov UUID; prov2 UUID; ser UUID; typ UUID; n INT; tid UUID;
BEGIN
  -- read fixtures BEFORE switching role (authenticated cannot read the temp table)
  SELECT a_tenant, b_tenant, c_tenant INTO ta, tb, tc FROM _alu_fx;

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

  -- WITH CHECK: A cannot write a row into tenant B
  BEGIN
    INSERT INTO alu_providers (tenant_id, name, short_name) VALUES (tb, 'X', 'X');
    RAISE EXCEPTION 'tenant A inserted a provider into tenant B (WITH CHECK failed)';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  -- tenant B: sees nothing of A
  SET LOCAL request.jwt.claims = '{"email":"__alu_b__@example.com"}';
  SELECT count(*) INTO n FROM alu_providers;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant B sees % of tenant A providers', n; END IF;
  SELECT count(*) INTO n FROM door_window_types;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant B sees % of tenant A door_window_types', n; END IF;
  SELECT count(*) INTO n FROM alu_series;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant B sees % of tenant A alu_series', n; END IF;
  SELECT count(*) INTO n FROM alu_series_types;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant B sees % of tenant A alu_series_types', n; END IF;

  -- WITH CHECK: B cannot write a row into tenant A
  BEGIN
    INSERT INTO alu_providers (tenant_id, name, short_name) VALUES (ta, 'X', 'X');
    RAISE EXCEPTION 'tenant B inserted a provider into tenant A (WITH CHECK failed)';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  -- B may reuse the same provider name, and then sees exactly its own single row
  INSERT INTO alu_providers (name, short_name) VALUES ('TYK', 'TYK');
  SELECT count(*) INTO n FROM alu_providers;
  IF n <> 1 THEN RAISE EXCEPTION 'tenant B should see exactly 1 provider, saw %', n; END IF;
  SELECT tenant_id INTO tid FROM alu_providers LIMIT 1;
  IF tid IS DISTINCT FROM tb THEN RAISE EXCEPTION 'tenant B provider row has wrong tenant_id %', tid; END IF;

  -- tenant A is unaffected: still exactly its own 2 providers (TYK, KC)
  SET LOCAL request.jwt.claims = '{"email":"__alu_a__@example.com"}';
  SELECT count(*) INTO n FROM alu_providers;
  IF n <> 2 THEN RAISE EXCEPTION 'tenant A should see exactly 2 providers, saw %', n; END IF;
  SELECT count(*) INTO n FROM alu_providers WHERE tenant_id <> ta;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant A sees % providers of another tenant', n; END IF;

  -- tenant C (no estimation module): reads nothing, cannot write anywhere
  SET LOCAL request.jwt.claims = '{"email":"__alu_c__@example.com"}';
  SELECT count(*) INTO n FROM alu_providers;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant C sees providers'; END IF;
  SELECT count(*) INTO n FROM door_window_types;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant C sees door_window_types'; END IF;
  SELECT count(*) INTO n FROM alu_series;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant C sees alu_series'; END IF;
  SELECT count(*) INTO n FROM alu_series_types;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant C sees alu_series_types'; END IF;

  BEGIN
    INSERT INTO alu_providers (name, short_name) VALUES ('NOPE', 'NOPE');
    RAISE EXCEPTION 'tenant C alu_providers insert was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO door_window_types (name, category) VALUES ('NOPE', 'door');
    RAISE EXCEPTION 'tenant C door_window_types insert was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO alu_series (provider_id, name) VALUES (prov, 'NOPE');
    RAISE EXCEPTION 'tenant C alu_series insert was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO alu_series_types (series_id, type_id) VALUES (ser, typ);
    RAISE EXCEPTION 'tenant C alu_series_types insert was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  RESET role;
  RAISE NOTICE 'Test 1 (hierarchy): TEST PASSED';
END $$;

-- ── Test 2: components ──
DO $$
DECLARE
  ta UUID; tb UUID; tc UUID; t TEXT;
  prov UUID; ser UUID; typ UUID; prof UUID; fin UUID; setp UUID; partp UUID; n INT;
  code1 TEXT; code2 TEXT; raised BOOLEAN;
BEGIN
  -- read fixtures BEFORE switching role (authenticated cannot read the temp table)
  SELECT a_tenant, b_tenant, c_tenant INTO ta, tb, tc FROM _alu_fx;

  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__alu_a__@example.com"}';

  SELECT id INTO prov FROM alu_providers WHERE name = 'TYK';
  SELECT id INTO ser  FROM alu_series WHERE provider_id = prov AND name = 'กล่องร่อง';
  SELECT id INTO typ  FROM door_window_types WHERE name = 'บานเลื่อน';

  INSERT INTO alu_profiles (name, linear_weight_kg_per_m, provider_id, drawing_no, thickness_mm)
    VALUES ('กล่องร่อง 1.2', 0.8, prov, 'FX-001', 1.2) RETURNING id INTO prof;
  INSERT INTO alu_finishes (name, provider_id, code) VALUES ('ขาว', prov, 'W01') RETURNING id INTO fin;
  INSERT INTO alu_series_profiles (series_id, profile_id, family) VALUES (ser, prof, 'กล่องร่อง');
  INSERT INTO alu_profile_variants (profile_id, finish_id, length_m) VALUES (prof, fin, 6.4);

  BEGIN
    INSERT INTO alu_series_profiles (series_id, profile_id) VALUES (ser, prof);
    RAISE EXCEPTION 'series_profiles unique did not fire';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  BEGIN
    INSERT INTO alu_profile_variants (profile_id, finish_id, length_m) VALUES (prof, fin, 0);
    RAISE EXCEPTION 'length CHECK did not fire';
  EXCEPTION WHEN check_violation THEN NULL; END;

  INSERT INTO alu_parts (name, kind) VALUES ('ชุดล็อกบานเลื่อน', 'hardware_set') RETURNING id INTO setp;
  INSERT INTO alu_parts (name, kind, unit) VALUES ('ยางขอบ', 'accessory', 'ม.') RETURNING id INTO partp;
  INSERT INTO alu_part_set_items (set_id, part_id, quantity) VALUES (setp, partp, 2);

  -- auto-numbered code: distinct, well-formed, increasing
  SELECT code INTO code1 FROM alu_parts WHERE id = setp;
  SELECT code INTO code2 FROM alu_parts WHERE id = partp;
  IF code1 IS NULL OR code1 !~ '^P-[0-9]{4}$' THEN RAISE EXCEPTION 'first part code malformed: %', code1; END IF;
  IF code2 IS NULL OR code2 !~ '^P-[0-9]{4}$' THEN RAISE EXCEPTION 'second part code malformed: %', code2; END IF;
  IF code1 = code2 THEN RAISE EXCEPTION 'part codes are not distinct: %', code1; END IF;
  IF substring(code2 FROM 3)::int <= substring(code1 FROM 3)::int THEN
    RAISE EXCEPTION 'part codes do not increase: % then %', code1, code2;
  END IF;

  -- name may change
  UPDATE alu_parts SET name = 'ชุดล็อกบานเลื่อน (แก้ไข)' WHERE id = setp;
  SELECT count(*) INTO n FROM alu_parts WHERE id = setp AND name = 'ชุดล็อกบานเลื่อน (แก้ไข)';
  IF n <> 1 THEN RAISE EXCEPTION 'part name update did not apply'; END IF;

  -- code may not change
  raised := false;
  BEGIN
    UPDATE alu_parts SET code = 'P-9999' WHERE id = setp;
  EXCEPTION WHEN raise_exception THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'alu_parts.code update was allowed'; END IF;
  SELECT code INTO code2 FROM alu_parts WHERE id = setp;
  IF code2 <> code1 THEN RAISE EXCEPTION 'alu_parts.code changed to %', code2; END IF;

  -- explicit duplicate code in the same tenant
  BEGIN
    INSERT INTO alu_parts (name, code) VALUES ('ซ้ำ', code1);
    RAISE EXCEPTION 'alu_parts (tenant, code) unique did not fire';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  BEGIN
    INSERT INTO alu_part_set_items (set_id, part_id) VALUES (setp, setp);
    RAISE EXCEPTION 'set_id <> part_id CHECK did not fire';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- NULL type_id means "every type"; two such rows for the same part must collide
  INSERT INTO alu_series_parts (series_id, part_id) VALUES (ser, partp);
  BEGIN
    INSERT INTO alu_series_parts (series_id, part_id) VALUES (ser, partp);
    RAISE EXCEPTION 'series_parts NULL-type unique did not fire';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  INSERT INTO alu_series_parts (series_id, type_id, part_id) VALUES (ser, typ, partp);  -- a typed row is a different row

  -- tenant A: every component table has rows (so the zero-counts below cannot pass vacuously)
  FOREACH t IN ARRAY ARRAY['alu_profiles','alu_finishes','alu_series_profiles','alu_profile_variants','alu_parts','alu_part_set_items','alu_series_parts'] LOOP
    EXECUTE format('SELECT count(*) FROM %I', t) INTO n;
    IF n < 1 THEN RAISE EXCEPTION 'tenant A sees no rows in %', t; END IF;
  END LOOP;

  -- WITH CHECK: A cannot write a component row into tenant B
  BEGIN
    INSERT INTO alu_profiles (tenant_id, provider_id, name, linear_weight_kg_per_m) VALUES (tb, prov, 'X', 1);
    RAISE EXCEPTION 'tenant A inserted an alu_profiles row into tenant B (WITH CHECK failed)';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO alu_finishes (tenant_id, provider_id, name) VALUES (tb, prov, 'X');
    RAISE EXCEPTION 'tenant A inserted an alu_finishes row into tenant B (WITH CHECK failed)';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  -- tenant B: sees nothing of A in any component table
  SET LOCAL request.jwt.claims = '{"email":"__alu_b__@example.com"}';
  FOREACH t IN ARRAY ARRAY['alu_profiles','alu_finishes','alu_series_profiles','alu_profile_variants','alu_parts','alu_part_set_items','alu_series_parts'] LOOP
    EXECUTE format('SELECT count(*) FROM %I', t) INTO n;
    IF n <> 0 THEN RAISE EXCEPTION 'tenant B sees % rows in %', n, t; END IF;
  END LOOP;

  -- tenant B numbers its own parts from P-0001, independent of A's count
  INSERT INTO alu_parts (name) VALUES ('B part') RETURNING code INTO code2;
  IF code2 <> 'P-0001' THEN RAISE EXCEPTION 'tenant B first part code should be P-0001, got %', code2; END IF;
  -- the same explicit code as one of A's is allowed in another tenant
  INSERT INTO alu_parts (name, code) VALUES ('B part 2', code1);
  SELECT count(*) INTO n FROM alu_parts WHERE code = code1;
  IF n <> 1 THEN RAISE EXCEPTION 'tenant B should see exactly 1 part with code %, saw %', code1, n; END IF;

  -- tenant C (no estimation module): sees nothing, cannot write to any component table
  SET LOCAL request.jwt.claims = '{"email":"__alu_c__@example.com"}';
  FOREACH t IN ARRAY ARRAY['alu_profiles','alu_finishes','alu_series_profiles','alu_profile_variants','alu_parts','alu_part_set_items','alu_series_parts'] LOOP
    EXECUTE format('SELECT count(*) FROM %I', t) INTO n;
    IF n <> 0 THEN RAISE EXCEPTION 'tenant C sees % rows in %', n, t; END IF;
  END LOOP;

  BEGIN
    INSERT INTO alu_profiles (provider_id, name, linear_weight_kg_per_m) VALUES (prov, 'NOPE', 1);
    RAISE EXCEPTION 'tenant C alu_profiles insert was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO alu_finishes (provider_id, name) VALUES (prov, 'NOPE');
    RAISE EXCEPTION 'tenant C alu_finishes insert was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO alu_series_profiles (series_id, profile_id) VALUES (ser, prof);
    RAISE EXCEPTION 'tenant C alu_series_profiles insert was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO alu_profile_variants (profile_id, finish_id, length_m) VALUES (prof, fin, 1);
    RAISE EXCEPTION 'tenant C alu_profile_variants insert was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO alu_parts (name) VALUES ('NOPE');
    RAISE EXCEPTION 'tenant C alu_parts insert was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO alu_part_set_items (set_id, part_id) VALUES (setp, partp);
    RAISE EXCEPTION 'tenant C alu_part_set_items insert was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO alu_series_parts (series_id, part_id) VALUES (ser, partp);
    RAISE EXCEPTION 'tenant C alu_series_parts insert was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  RESET role;
  RAISE NOTICE 'Test 2 (components): TEST PASSED';
END $$;

-- ── Test 3: price history ──
DO $$
DECLARE
  ta UUID; tb UUID; tc UUID; t TEXT;
  prov UUID; ser UUID; prof UUID; fin UUID; var UUID; partp UUID; n INT;
BEGIN
  -- read fixtures BEFORE switching role (authenticated cannot read the temp table)
  SELECT a_tenant, b_tenant, c_tenant INTO ta, tb, tc FROM _alu_fx;

  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__alu_a__@example.com"}';

  SELECT id INTO prov FROM alu_providers WHERE name = 'TYK';
  SELECT id INTO ser  FROM alu_series WHERE provider_id = prov;
  SELECT id INTO prof FROM alu_profiles WHERE provider_id = prov;
  SELECT id INTO fin  FROM alu_finishes WHERE provider_id = prov;
  SELECT id INTO var  FROM alu_profile_variants WHERE profile_id = prof;
  SELECT id INTO partp FROM alu_parts WHERE name = 'ยางขอบ';

  INSERT INTO alu_kg_prices (provider_id, finish_id, price_per_kg, effective_from) VALUES (prov, fin, 95, '2026-01-01');
  INSERT INTO alu_kg_prices (provider_id, finish_id, price_per_kg, effective_from) VALUES (prov, fin, 98, '2026-06-01');  -- history: a later date is a new row
  INSERT INTO alu_kg_prices (provider_id, finish_id, series_id, price_per_kg, effective_from) VALUES (prov, fin, ser, 101, '2026-01-01');  -- series override, same date is fine

  BEGIN
    INSERT INTO alu_kg_prices (provider_id, finish_id, price_per_kg, effective_from) VALUES (prov, fin, 99, '2026-01-01');
    RAISE EXCEPTION 'kg price same-date unique did not fire';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  BEGIN
    INSERT INTO alu_kg_prices (provider_id, finish_id, series_id, profile_id, price_per_kg, effective_from)
      VALUES (prov, fin, ser, prof, 90, '2026-02-01');
    RAISE EXCEPTION 'series/profile exclusive CHECK did not fire';
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    INSERT INTO alu_kg_prices (provider_id, finish_id, price_per_kg, effective_from) VALUES (prov, fin, -1, '2026-03-01');
    RAISE EXCEPTION 'negative price CHECK did not fire';
  EXCEPTION WHEN check_violation THEN NULL; END;

  INSERT INTO alu_piece_prices (variant_id, price_per_piece, effective_from) VALUES (var, 1200, '2026-01-01');
  INSERT INTO alu_part_prices (part_id, list_price, discount_pct, effective_from) VALUES (partp, 1000, 22, '2026-01-01');

  BEGIN
    INSERT INTO alu_part_prices (part_id, list_price, discount_pct, effective_from) VALUES (partp, 1000, 101, '2026-02-01');
    RAISE EXCEPTION 'discount_pct CHECK did not fire';
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    INSERT INTO alu_part_prices (part_id, list_price, effective_from) VALUES (partp, 900, '2026-01-01');
    RAISE EXCEPTION 'part price same-date unique did not fire';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  -- tenant A: every price table has rows (so the zero-counts below cannot pass vacuously)
  FOREACH t IN ARRAY ARRAY['alu_kg_prices','alu_piece_prices','alu_part_prices'] LOOP
    EXECUTE format('SELECT count(*) FROM %I', t) INTO n;
    IF n < 1 THEN RAISE EXCEPTION 'tenant A sees no rows in %', t; END IF;
  END LOOP;

  -- WITH CHECK: A cannot write a price row into tenant B
  BEGIN
    INSERT INTO alu_kg_prices (tenant_id, provider_id, finish_id, price_per_kg, effective_from) VALUES (tb, prov, fin, 1, '2026-04-01');
    RAISE EXCEPTION 'tenant A inserted an alu_kg_prices row into tenant B (WITH CHECK failed)';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO alu_part_prices (tenant_id, part_id, list_price, effective_from) VALUES (tb, partp, 1, '2026-04-01');
    RAISE EXCEPTION 'tenant A inserted an alu_part_prices row into tenant B (WITH CHECK failed)';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  -- tenant B: sees nothing of A in any price table
  SET LOCAL request.jwt.claims = '{"email":"__alu_b__@example.com"}';
  FOREACH t IN ARRAY ARRAY['alu_kg_prices','alu_piece_prices','alu_part_prices'] LOOP
    EXECUTE format('SELECT count(*) FROM %I', t) INTO n;
    IF n <> 0 THEN RAISE EXCEPTION 'tenant B sees % rows in %', n, t; END IF;
  END LOOP;

  -- tenant C (no estimation module): sees nothing, cannot write to any price table
  SET LOCAL request.jwt.claims = '{"email":"__alu_c__@example.com"}';
  FOREACH t IN ARRAY ARRAY['alu_kg_prices','alu_piece_prices','alu_part_prices'] LOOP
    EXECUTE format('SELECT count(*) FROM %I', t) INTO n;
    IF n <> 0 THEN RAISE EXCEPTION 'tenant C sees % rows in %', n, t; END IF;
  END LOOP;

  BEGIN
    INSERT INTO alu_kg_prices (provider_id, finish_id, price_per_kg, effective_from) VALUES (prov, fin, 1, '2026-05-01');
    RAISE EXCEPTION 'tenant C alu_kg_prices insert was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO alu_piece_prices (variant_id, price_per_piece, effective_from) VALUES (var, 1, '2026-05-01');
    RAISE EXCEPTION 'tenant C alu_piece_prices insert was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO alu_part_prices (part_id, list_price, effective_from) VALUES (partp, 1, '2026-05-01');
    RAISE EXCEPTION 'tenant C alu_part_prices insert was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  RESET role;
  RAISE NOTICE 'Test 3 (prices): TEST PASSED';
END $$;
