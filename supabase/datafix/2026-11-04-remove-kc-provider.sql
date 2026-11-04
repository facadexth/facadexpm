-- Owner 2026-11-04: "kc เอาออกจาก โรงรีดได้เลย" — KC is a wholesaler, not an extruder.
-- Checked live: KC has 2 empty series (BUILDING SYSTEM, STANDARD) with 4 type links and nothing else
-- (no profiles, colours, prices, parts, families, projects, openings, hardware sets). Refuses if that changed.
BEGIN;
DO $$
DECLARE kc uuid; n int;
BEGIN
  SELECT id INTO kc FROM alu_providers WHERE tenant_id = '1b9affc4-2136-4ed1-b168-a36e6624e743' AND name = 'บริษัท เค ซี อินเตอร์เฟรม จำกัด';
  IF kc IS NULL THEN RAISE EXCEPTION 'KC not found'; END IF;
  SELECT (SELECT count(*) FROM alu_profiles WHERE provider_id = kc) + (SELECT count(*) FROM alu_finishes WHERE provider_id = kc)
       + (SELECT count(*) FROM alu_kg_prices WHERE provider_id = kc) + (SELECT count(*) FROM alu_parts WHERE provider_id = kc)
       + (SELECT count(*) FROM alu_series_families WHERE provider_id = kc)
       + (SELECT count(*) FROM estimation_projects WHERE primary_provider_id = kc OR default_series_id IN (SELECT id FROM alu_series WHERE provider_id = kc))
       + (SELECT count(*) FROM estimation_openings WHERE series_id IN (SELECT id FROM alu_series WHERE provider_id = kc))
       + (SELECT count(*) FROM alu_hardware_packages WHERE series_id IN (SELECT id FROM alu_series WHERE provider_id = kc))
       + (SELECT count(*) FROM alu_series_profiles WHERE series_id IN (SELECT id FROM alu_series WHERE provider_id = kc))
    INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'KC is in use (% rows) — not removed', n; END IF;
  DELETE FROM alu_series WHERE provider_id = kc;      -- cascades its 4 alu_series_types rows
  DELETE FROM alu_providers WHERE id = kc;
  SELECT count(*) INTO n FROM alu_providers WHERE tenant_id = '1b9affc4-2136-4ed1-b168-a36e6624e743';
  RAISE NOTICE 'providers left: %', n;
END $$;
SELECT name FROM alu_providers WHERE tenant_id = '1b9affc4-2136-4ed1-b168-a36e6624e743' ORDER BY name;
COMMIT;
