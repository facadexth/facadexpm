-- supabase/migrations/2026-10-13-01-estimation-contract.sql
-- Aluminium cost catalog, Phase 2b "contract" step. APPLY ONLY AT DEPLOY TIME: after the Phase 2b code is live and
-- every item has been opened and saved once. It drops the legacy columns and the legacy colour table. It refuses
-- to run while any item still relies on them: an item is fine when its own series_id / alu_finish_id is set OR it
-- inherits the project's default_series_id / default_finish_id (an inheriting item legitimately has NULL there).
-- It refuses only when NOTHING resolves the legacy series / colour.
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM estimation_openings o JOIN estimation_projects p ON p.id = o.project_id
    WHERE o.series IS NOT NULL AND COALESCE(o.series_id, p.default_series_id) IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'contract refused: % item(s) still rely on the legacy series text; open and save them first', n;
  END IF;
  SELECT count(*) INTO n FROM estimation_openings o JOIN estimation_projects p ON p.id = o.project_id
    WHERE o.finish_id IS NOT NULL AND COALESCE(o.alu_finish_id, p.default_finish_id) IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'contract refused: % item(s) still rely on the legacy colour; open and save them first', n;
  END IF;
END $$;

ALTER TABLE estimation_openings DROP COLUMN series, DROP COLUMN finish_id;
-- No CASCADE: if anything else still references the legacy colours this must fail loudly, not silently drop it.
DROP TABLE aluminum_finishes;
