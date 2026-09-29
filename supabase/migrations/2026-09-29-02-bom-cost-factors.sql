-- supabase/migrations/2026-09-29-02-bom-cost-factors.sql
-- Extends the BOM Template Engine (Phase 1) per
-- docs/superpowers/specs/2026-09-29-bom-cost-factors-design.md.
--
-- Decisions 1-2: generalize glass -> infill. A rename, not a new table --
-- existing rows keep working (material_kind defaults to 'glass'). RLS
-- policies survive a table/column rename automatically; no policy
-- changes needed.
ALTER TABLE bom_glass_types RENAME TO infill_types;
ALTER TABLE infill_types ADD COLUMN material_kind TEXT NOT NULL DEFAULT 'glass'
  CHECK (material_kind IN ('glass','mesh','solid_panel','acp'));

ALTER TABLE estimation_openings RENAME COLUMN glass_type_id TO infill_type_id;
ALTER TABLE bom_templates RENAME COLUMN glass_width_deduction_mm TO infill_width_deduction_mm;
ALTER TABLE bom_templates RENAME COLUMN glass_height_deduction_mm TO infill_height_deduction_mm;

-- Decision 3: labor/silicone/felt per-template rate fields, same
-- precedent as waste_pct (template default, DEFAULT 0 so existing
-- templates keep computing the same total_cost until filled in).
ALTER TABLE bom_templates ADD COLUMN labor_price_per_sqm  NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE bom_templates ADD COLUMN silicone_price_per_m NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE bom_templates ADD COLUMN felt_price_per_m     NUMERIC NOT NULL DEFAULT 0;

-- Decision 5: one optional add-on unit per opening. All four nullable --
-- an opening with no add-on leaves them null and the add-on computation
-- is skipped entirely. addon_panel_count defaults to 1 like the main
-- unit's panel_count does. ON DELETE RESTRICT matches template_id's
-- existing behavior (a template with any opening referencing it can't
-- be hard-deleted).
ALTER TABLE estimation_openings ADD COLUMN addon_template_id UUID REFERENCES bom_templates(id) ON DELETE RESTRICT;
ALTER TABLE estimation_openings ADD COLUMN addon_width_m     NUMERIC;
ALTER TABLE estimation_openings ADD COLUMN addon_height_m    NUMERIC;
ALTER TABLE estimation_openings ADD COLUMN addon_panel_count INT NOT NULL DEFAULT 1;
