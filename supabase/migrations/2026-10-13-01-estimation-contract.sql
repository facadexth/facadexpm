-- supabase/migrations/2026-10-13-01-estimation-contract.sql
-- Aluminium cost catalog, Phase 2b "contract" step. APPLY ONLY AT DEPLOY TIME: after the Phase 2b code is live and
-- every item has been opened and saved once (so it carries series_id / alu_finish_id). It drops the legacy columns
-- and the legacy colour table. It refuses to run while any item still relies on them.
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM estimation_openings WHERE series IS NOT NULL AND series_id IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'contract refused: % item(s) still rely on the legacy series text; open and save them first', n;
  END IF;
  SELECT count(*) INTO n FROM estimation_openings WHERE finish_id IS NOT NULL AND alu_finish_id IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'contract refused: % item(s) still rely on the legacy colour; open and save them first', n;
  END IF;
END $$;

ALTER TABLE estimation_openings DROP COLUMN series, DROP COLUMN finish_id;
-- No CASCADE: if anything else still references the legacy colours this must fail loudly, not silently drop it.
DROP TABLE aluminum_finishes;
