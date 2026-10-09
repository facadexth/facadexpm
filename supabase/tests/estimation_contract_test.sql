-- supabase/tests/estimation_contract_test.sql
-- RUN ONLY INSIDE ONE TRANSACTION THAT ENDS IN ROLLBACK (fixtures are real rows).
--   BEGIN; <catalog + estimation migrations as applied, up to 2026-10-12-01>; <this file>; ROLLBACK;
-- The contract migration (2026-10-13-01) is NOT included: this test copies its two guard SELECT count(*) queries
-- verbatim (plus a tenant filter, so real data is ignored) and asserts the counts. Fixtures are inserted as the
-- connecting role with an explicit tenant_id.

CREATE TEMP TABLE _con_fx (t UUID, tpl UUID, ser UUID, fin UUID, afin UUID, proj_def UUID, proj_none UUID);
DO $$
DECLARE owner_id UUID; tid UUID; prov UUID; ser UUID; fin UUID; afin UUID; tpl UUID; pd UUID; pn UUID;
BEGIN
  SELECT id INTO owner_id FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__CON TEST A__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO tid;
  INSERT INTO alu_providers (tenant_id, name, short_name, price_basis) VALUES (tid, 'CON P', 'CP', 'per_kg') RETURNING id INTO prov;
  INSERT INTO alu_series (tenant_id, provider_id, name) VALUES (tid, prov, 'CON S') RETURNING id INTO ser;
  INSERT INTO alu_finishes (tenant_id, provider_id, name) VALUES (tid, prov, 'CON F') RETURNING id INTO afin;
  INSERT INTO aluminum_finishes (tenant_id, name, price_per_kg) VALUES (tid, 'CON LEGACY F', 100) RETURNING id INTO fin;
  INSERT INTO bom_templates (tenant_id, name, category) VALUES (tid, 'CON TPL', 'window') RETURNING id INTO tpl;
  INSERT INTO estimation_projects (tenant_id, name, default_series_id, default_finish_id)
    VALUES (tid, 'CON PROJ DEFAULTS', ser, afin) RETURNING id INTO pd;
  INSERT INTO estimation_projects (tenant_id, name) VALUES (tid, 'CON PROJ NO DEFAULTS') RETURNING id INTO pn;
  INSERT INTO _con_fx VALUES (tid, tpl, ser, fin, afin, pd, pn);
END $$;

-- Helper: add one item (legacy text series + legacy colour set; catalog ids as given).
CREATE FUNCTION pg_temp.con_item(p_proj UUID, p_no TEXT, p_series_id UUID, p_alu_finish_id UUID) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE f _con_fx%ROWTYPE;
BEGIN
  SELECT * INTO f FROM _con_fx;
  INSERT INTO estimation_openings (tenant_id, project_id, opening_no, template_id, series, finish_id, thickness_mm, width_m, height_m, series_id, alu_finish_id)
    VALUES (f.t, p_proj, p_no, f.tpl, 'legacy series', f.fin, 1.5, 1, 1, p_series_id, p_alu_finish_id);
END $$;

-- Guard counts. The two SELECTs are the contract migration's, verbatim, plus "AND o.tenant_id = (SELECT t FROM _con_fx)".
DO $$
DECLARE f _con_fx%ROWTYPE; n INT;
BEGIN
  SELECT * INTO f FROM _con_fx;

  -- 1. own series_id + own colour: both pass
  PERFORM pg_temp.con_item(f.proj_none, 'own', f.ser, f.afin);
  SELECT count(*) INTO n FROM estimation_openings o JOIN estimation_projects p ON p.id = o.project_id
    WHERE o.series IS NOT NULL AND COALESCE(o.series_id, p.default_series_id) IS NULL AND o.tenant_id = f.t;
  IF n <> 0 THEN RAISE EXCEPTION 'series guard: item with its own series_id was counted (%)', n; END IF;
  SELECT count(*) INTO n FROM estimation_openings o JOIN estimation_projects p ON p.id = o.project_id
    WHERE o.finish_id IS NOT NULL AND COALESCE(o.alu_finish_id, p.default_finish_id) IS NULL AND o.tenant_id = f.t;
  IF n <> 0 THEN RAISE EXCEPTION 'colour guard: item with its own alu_finish_id was counted (%)', n; END IF;

  -- 2. legacy text, ids NULL, but the project has defaults (inherits): passes
  PERFORM pg_temp.con_item(f.proj_def, 'inherit', NULL, NULL);
  SELECT count(*) INTO n FROM estimation_openings o JOIN estimation_projects p ON p.id = o.project_id
    WHERE o.series IS NOT NULL AND COALESCE(o.series_id, p.default_series_id) IS NULL AND o.tenant_id = f.t;
  IF n <> 0 THEN RAISE EXCEPTION 'series guard: inheriting item was counted (%)', n; END IF;
  SELECT count(*) INTO n FROM estimation_openings o JOIN estimation_projects p ON p.id = o.project_id
    WHERE o.finish_id IS NOT NULL AND COALESCE(o.alu_finish_id, p.default_finish_id) IS NULL AND o.tenant_id = f.t;
  IF n <> 0 THEN RAISE EXCEPTION 'colour guard: inheriting item was counted (%)', n; END IF;

  -- 3. legacy text, ids NULL and no project default: counted (the guard would refuse), series and colour each once
  PERFORM pg_temp.con_item(f.proj_none, 'unresolved', NULL, NULL);
  SELECT count(*) INTO n FROM estimation_openings o JOIN estimation_projects p ON p.id = o.project_id
    WHERE o.series IS NOT NULL AND COALESCE(o.series_id, p.default_series_id) IS NULL AND o.tenant_id = f.t;
  IF n <> 1 THEN RAISE EXCEPTION 'series guard: unresolved item should be counted once, got %', n; END IF;
  SELECT count(*) INTO n FROM estimation_openings o JOIN estimation_projects p ON p.id = o.project_id
    WHERE o.finish_id IS NOT NULL AND COALESCE(o.alu_finish_id, p.default_finish_id) IS NULL AND o.tenant_id = f.t;
  IF n <> 1 THEN RAISE EXCEPTION 'colour guard: unresolved item should be counted once, got %', n; END IF;

  -- 4. series resolves but colour does not (own series_id, no colour anywhere): only the colour guard counts it
  PERFORM pg_temp.con_item(f.proj_none, 'series-only', f.ser, NULL);
  SELECT count(*) INTO n FROM estimation_openings o JOIN estimation_projects p ON p.id = o.project_id
    WHERE o.series IS NOT NULL AND COALESCE(o.series_id, p.default_series_id) IS NULL AND o.tenant_id = f.t;
  IF n <> 1 THEN RAISE EXCEPTION 'series guard should still count 1, got %', n; END IF;
  SELECT count(*) INTO n FROM estimation_openings o JOIN estimation_projects p ON p.id = o.project_id
    WHERE o.finish_id IS NOT NULL AND COALESCE(o.alu_finish_id, p.default_finish_id) IS NULL AND o.tenant_id = f.t;
  IF n <> 2 THEN RAISE EXCEPTION 'colour guard should now count 2, got %', n; END IF;

  RAISE NOTICE 'Test 1 (contract guard logic): TEST PASSED';
END $$;
