-- Assign redesign: site distance from factory + google maps link
-- Applied to project yyzbgdmgyvvypfcjuhtr on 2026-07-02

ALTER TABLE sites ADD COLUMN IF NOT EXISTS distance_km NUMERIC;  -- one-way km from factory
ALTER TABLE sites ADD COLUMN IF NOT EXISTS map_url TEXT;          -- google maps link
