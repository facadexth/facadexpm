-- supabase/migrations/2026-10-11-01-estimation-catalog-expand.sql
-- Aluminium cost catalog, Phase 2a "expand" step. ADDITIVE ONLY: nothing is dropped, renamed or
-- retyped, and the three NOT NULL drops only loosen rules, so the currently deployed estimation
-- screens (which still write series / finish_id / thickness_mm) keep working before and after this
-- migration. The matching "contract" step (drop series, finish_id, aluminum_finishes) is Phase 2b
-- and is applied only at deploy time. Spec: 2026-10-08-aluminium-cost-catalog-design.md, Estimation changes.
-- Needs migrations 2026-10-10-01..03 (the catalog tables) to be applied first.

-- A template is "the BOM for type X"; a hardware line can point at a catalog part for its price.
ALTER TABLE bom_templates
  ADD COLUMN type_id UUID REFERENCES door_window_types(id) ON DELETE SET NULL;
ALTER TABLE bom_template_hardware
  ADD COLUMN part_id UUID REFERENCES alu_parts(id) ON DELETE SET NULL;

-- Project defaults (an item that leaves a field NULL inherits it) and the price lock date.
-- price_as_of is set when the project is created and never moves by itself.
ALTER TABLE estimation_projects
  ADD COLUMN default_series_id       UUID REFERENCES alu_series(id)    ON DELETE SET NULL,
  ADD COLUMN default_finish_id       UUID REFERENCES alu_finishes(id)  ON DELETE SET NULL,
  ADD COLUMN default_infill_id       UUID REFERENCES infill_types(id)  ON DELETE SET NULL,
  ADD COLUMN default_hardware_set_id UUID REFERENCES alu_parts(id)     ON DELETE SET NULL,
  ADD COLUMN default_thickness_mm    NUMERIC CHECK (default_thickness_mm IS NULL OR default_thickness_mm > 0),
  ADD COLUMN labour_per_sqm          NUMERIC CHECK (labour_per_sqm IS NULL OR labour_per_sqm >= 0),
  ADD COLUMN profit_pct              NUMERIC CHECK (profit_pct IS NULL OR (profit_pct >= 0 AND profit_pct <= 1000)),
  ADD COLUMN price_as_of             DATE NOT NULL DEFAULT current_date;

-- Items: the old text series / legacy colour / thickness become optional, the catalog columns are added.
-- The colour column is alu_finish_id (not finish_id) because finish_id still points at the legacy
-- aluminum_finishes table until the contract step.
ALTER TABLE estimation_openings
  ALTER COLUMN series       DROP NOT NULL,
  ALTER COLUMN finish_id    DROP NOT NULL,
  ALTER COLUMN thickness_mm DROP NOT NULL,
  ADD COLUMN series_id        UUID REFERENCES alu_series(id)   ON DELETE RESTRICT,
  ADD COLUMN alu_finish_id    UUID REFERENCES alu_finishes(id) ON DELETE RESTRICT,
  ADD COLUMN hardware_set_id  UUID REFERENCES alu_parts(id)    ON DELETE RESTRICT,
  ADD COLUMN no_infill        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN no_hardware_set  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN profit_pct       NUMERIC CHECK (profit_pct IS NULL OR (profit_pct >= 0 AND profit_pct <= 1000)),
  ADD COLUMN labour_per_sqm   NUMERIC CHECK (labour_per_sqm IS NULL OR labour_per_sqm >= 0),
  ADD COLUMN item_name        TEXT,
  ADD COLUMN item_description TEXT,
  ADD CONSTRAINT estimation_openings_infill_flag_ck CHECK (NOT (no_infill AND infill_type_id IS NOT NULL)),
  ADD CONSTRAINT estimation_openings_hwset_flag_ck  CHECK (NOT (no_hardware_set AND hardware_set_id IS NOT NULL));

-- Foreign-key indexes (deleting a series / colour / part scans these).
CREATE INDEX idx_bom_templates_type_id               ON bom_templates(type_id);
CREATE INDEX idx_bom_template_hardware_part_id       ON bom_template_hardware(part_id);
CREATE INDEX idx_estimation_projects_default_series  ON estimation_projects(default_series_id);
CREATE INDEX idx_estimation_projects_default_finish  ON estimation_projects(default_finish_id);
CREATE INDEX idx_estimation_projects_default_infill  ON estimation_projects(default_infill_id);
CREATE INDEX idx_estimation_projects_default_hwset   ON estimation_projects(default_hardware_set_id);
CREATE INDEX idx_estimation_openings_series_id       ON estimation_openings(series_id);
CREATE INDEX idx_estimation_openings_alu_finish_id   ON estimation_openings(alu_finish_id);
CREATE INDEX idx_estimation_openings_hardware_set_id ON estimation_openings(hardware_set_id);
