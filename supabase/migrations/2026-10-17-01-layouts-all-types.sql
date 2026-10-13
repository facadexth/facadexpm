-- Part-editor layouts for every catalogue type (spec 2026-10-13). Additive; re-runnable.
-- Order-independent: door_window_types.layout_kind is created here if absent (ADD COLUMN IF NOT EXISTS); if a
-- one-kind layout_kind CHECK already exists (bom_templates from 2026-10-15-01, or door_window_types from a
-- parent-plan migration applied earlier), the DROP CONSTRAINT IF EXISTS lines replace it with the 13-kind list.
-- No view selects door_window_types.*, bom_templates.* or estimation_openings.* (grep for ".*" over
-- supabase/migrations and supabase/schema.sql checked: only expenses_view uses e.*), so no view needs recreating.

-- door_window_types.layout_kind
ALTER TABLE door_window_types ADD COLUMN IF NOT EXISTS layout_kind TEXT;
ALTER TABLE door_window_types DROP CONSTRAINT IF EXISTS door_window_types_layout_kind_check;
ALTER TABLE door_window_types ADD CONSTRAINT door_window_types_layout_kind_check CHECK (layout_kind IS NULL OR layout_kind IN (
  'sliding_2','sliding_n','sliding_3track','sliding_2_fixed_2','fixed_grid','awning_grid','casement_n',
  'swing_door','frameless_door','hanging_door','folding_door','curtain_wall','frameless_wall'));

-- bom_templates.layout_kind: widen the one-kind CHECK from 2026-10-15-01 to the same 13 kinds
ALTER TABLE bom_templates DROP CONSTRAINT IF EXISTS bom_templates_layout_kind_check;
ALTER TABLE bom_templates ADD CONSTRAINT bom_templates_layout_kind_check CHECK (layout_kind IS NULL OR layout_kind IN (
  'sliding_2','sliding_n','sliding_3track','sliding_2_fixed_2','fixed_grid','awning_grid','casement_n',
  'swing_door','frameless_door','hanging_door','folding_door','curtain_wall','frameless_wall'));

-- layout_params
ALTER TABLE door_window_types   ADD COLUMN IF NOT EXISTS layout_params JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE bom_templates       ADD COLUMN IF NOT EXISTS layout_params JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE estimation_openings ADD COLUMN IF NOT EXISTS layout_params JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE door_window_types   DROP CONSTRAINT IF EXISTS door_window_types_layout_params_obj;
ALTER TABLE bom_templates       DROP CONSTRAINT IF EXISTS bom_templates_layout_params_obj;
ALTER TABLE estimation_openings DROP CONSTRAINT IF EXISTS estimation_openings_layout_params_obj;
ALTER TABLE door_window_types   ADD CONSTRAINT door_window_types_layout_params_obj   CHECK (jsonb_typeof(layout_params) = 'object');
ALTER TABLE bom_templates       ADD CONSTRAINT bom_templates_layout_params_obj       CHECK (jsonb_typeof(layout_params) = 'object');
ALTER TABLE estimation_openings ADD CONSTRAINT estimation_openings_layout_params_obj CHECK (jsonb_typeof(layout_params) = 'object');
