-- supabase/tests/estimation_images_test.sql
-- RUN ONLY INSIDE ONE TRANSACTION THAT ENDS IN ROLLBACK (fixtures are real rows).
--   BEGIN; <catalog migrations if not applied>; 2026-10-14-02; <this file>; ROLLBACK;
-- Tenants: A and B hold only 'estimation'; C holds nothing.

CREATE TEMP TABLE _ei_fx (a_tenant UUID, b_tenant UUID, c_tenant UUID);
DO $$
DECLARE owner_id UUID; ta UUID; tb UUID; tc UUID;
BEGIN
  SELECT id INTO owner_id FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__EI TEST A__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO ta;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__EI TEST B__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO tb;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__EI TEST C__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO tc;
  INSERT INTO tenant_modules (tenant_id, module_key) VALUES (ta, 'estimation'), (tb, 'estimation');
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES
    ('__ei_a__@example.com', 'OWNER', 'approved', ta),
    ('__ei_b__@example.com', 'OWNER', 'approved', tb),
    ('__ei_c__@example.com', 'OWNER', 'approved', tc);
  INSERT INTO _ei_fx VALUES (ta, tb, tc);
END $$;

-- ── Test 1: the four image_path columns exist and the bucket is private ──
DO $$
DECLARE n INT; pub BOOLEAN;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'image_path'
      AND table_name IN ('alu_profiles','infill_types','alu_parts','alu_finishes');
  IF n <> 4 THEN RAISE EXCEPTION 'expected image_path on 4 tables, found %', n; END IF;
  SELECT public INTO pub FROM storage.buckets WHERE id = 'estimation-images';
  IF pub IS NULL THEN RAISE EXCEPTION 'bucket estimation-images is missing'; END IF;
  IF pub THEN RAISE EXCEPTION 'bucket estimation-images must be private'; END IF;
  RAISE NOTICE 'Test 1 (columns and bucket): TEST PASSED';
END $$;

-- ── Test 2: storage policy (own tenant folder only; module gate) ──
DO $$
DECLARE ta UUID; tb UUID; n INT; state TEXT;
BEGIN
  SELECT a_tenant, b_tenant INTO ta, tb FROM _ei_fx;
  SET LOCAL role = 'authenticated';

  -- tenant A: own folder ok, other tenant's folder rejected
  SET LOCAL request.jwt.claims = '{"email":"__ei_a__@example.com"}';
  INSERT INTO storage.objects (bucket_id, name) VALUES ('estimation-images', ta::text || '/ps-test.png');
  BEGIN
    INSERT INTO storage.objects (bucket_id, name) VALUES ('estimation-images', tb::text || '/ps-test.png');
    RAISE EXCEPTION 'tenant A could write into tenant B folder';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
    IF state <> '42501' THEN RAISE EXCEPTION 'expected 42501, got %', state; END IF;
  END;

  -- tenant B (has the module) cannot see A's object
  PERFORM set_config('request.jwt.claims', '{"email":"__ei_b__@example.com"}', true);
  SELECT count(*) INTO n FROM storage.objects WHERE bucket_id = 'estimation-images' AND name = ta::text || '/ps-test.png';
  IF n <> 0 THEN RAISE EXCEPTION 'tenant B sees A image'; END IF;

  -- tenant C (no estimation module) cannot insert even into its own folder
  PERFORM set_config('request.jwt.claims', '{"email":"__ei_c__@example.com"}', true);
  BEGIN
    INSERT INTO storage.objects (bucket_id, name)
      VALUES ('estimation-images', (SELECT c_tenant FROM _ei_fx)::text || '/ps-test.png');
    RAISE EXCEPTION 'tenant without the estimation module could insert an image';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
    IF state <> '42501' THEN RAISE EXCEPTION 'expected 42501, got %', state; END IF;
  END;

  RESET role;
  RAISE NOTICE 'Test 2 (storage policy): TEST PASSED';
END $$;
