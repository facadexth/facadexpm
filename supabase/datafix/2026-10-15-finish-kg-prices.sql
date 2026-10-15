-- ============================================================
-- ONE-OFF DATA (2026-10-15, owner pasted the table in chat): 7 finishes with price per kg under provider
-- "ไฟล์ Aluminium calculation", provider-wide (no series / profile), effective 2026-01-01 so projects dated before today
-- (price date 2026-10-09) see them. POWDER COATING SAHARA already exists (part 2 import); the others are added.
-- Idempotent: finishes ON CONFLICT (provider, name) DO NOTHING; a price is skipped when the same
-- (provider, finish, effective_from) provider-wide row exists. Dry run: COMMIT -> ROLLBACK.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TEMP TABLE _fin (name TEXT, price NUMERIC) ON COMMIT DROP;
INSERT INTO _fin VALUES
  ('ANODIZED NA', 170), ('ANODIZED 512', 190), ('ANODIZED 517', 210),
  ('POWDER COATING WHITE', 170), ('POWDER COATING BLACK', 170), ('POWDER COATING SAHARA', 250),
  ('POWDER COATING WOOD GRAIN', 350);
DO $$
DECLARE
  c_tenant CONSTANT UUID := '1b9affc4-2136-4ed1-b168-a36e6624e743';
  c_from   CONSTANT DATE := '2026-01-01';
  v_provider UUID;
BEGIN
  SELECT id INTO v_provider FROM alu_providers WHERE tenant_id = c_tenant AND name = 'ไฟล์ Aluminium calculation';
  IF v_provider IS NULL THEN RAISE EXCEPTION 'ABORT: provider not found'; END IF;
  INSERT INTO alu_finishes (tenant_id, provider_id, name) SELECT c_tenant, v_provider, f.name FROM _fin f
    ON CONFLICT (provider_id, name) DO NOTHING;
  INSERT INTO alu_kg_prices (tenant_id, provider_id, finish_id, price_per_kg, effective_from, source)
    SELECT c_tenant, v_provider, af.id, f.price, c_from, 'owner chat 2026-10-15'
    FROM _fin f JOIN alu_finishes af ON af.provider_id = v_provider AND af.name = f.name
    WHERE NOT EXISTS (SELECT 1 FROM alu_kg_prices k WHERE k.provider_id = v_provider AND k.finish_id = af.id
                        AND k.series_id IS NULL AND k.profile_id IS NULL AND k.effective_from = c_from);
END $$;
COMMIT;
