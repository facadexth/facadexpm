-- BOM template part editor (spec 2026-10-10-bom-template-part-editor-design.md, section 4). Additive; estimation-only.
-- Needs 2026-10-09..14 migrations (bom_templates, bom_template_components with joint columns, alu_profiles) applied first.
-- No view selects bom_templates.*, bom_template_components.* or alu_profiles.* (checked), so no view needs recreating.

ALTER TABLE bom_templates
  ADD COLUMN layout_kind TEXT CHECK (layout_kind IS NULL OR layout_kind IN ('sliding_2'));   -- NULL = legacy template

ALTER TABLE alu_profiles
  ADD COLUMN butt_distance_mm NUMERIC CHECK (butt_distance_mm IS NULL OR butt_distance_mm >= 0);

ALTER TABLE bom_template_components
  ADD COLUMN length_factor    NUMERIC NOT NULL DEFAULT 1 CHECK (length_factor > 0),
  ADD COLUMN end_deduction_mm NUMERIC NOT NULL DEFAULT 0 CHECK (end_deduction_mm >= 0);

CREATE TABLE bom_template_parts (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id    UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  template_id  UUID NOT NULL REFERENCES bom_templates(id) ON DELETE CASCADE,
  part_key     TEXT NOT NULL CHECK (part_key IN ('frame','sash')),
  name         TEXT NOT NULL,
  count        INT NOT NULL DEFAULT 1 CHECK (count >= 1),
  overlap_mode TEXT NOT NULL DEFAULT 'auto_hook' CHECK (overlap_mode IN ('auto_hook','manual')),
  overlap_mm   NUMERIC CHECK (overlap_mm IS NULL OR overlap_mm >= 0),
  sort_order   INT NOT NULL DEFAULT 0
);

CREATE TABLE bom_template_positions (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id    UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  part_id      UUID NOT NULL REFERENCES bom_template_parts(id) ON DELETE CASCADE,
  position_key TEXT NOT NULL CHECK (position_key IN
                ('frame_top','frame_bottom','frame_side','sash_top','sash_bottom','key_stile','hook_stile')),
  name         TEXT NOT NULL,
  sort_order   INT NOT NULL DEFAULT 0,
  UNIQUE (part_id, position_key)
);

CREATE TABLE bom_template_position_profiles (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  position_id         UUID NOT NULL REFERENCES bom_template_positions(id) ON DELETE CASCADE,
  profile_family      TEXT NOT NULL,
  length_rule_type    TEXT NOT NULL CHECK (length_rule_type IN
                       ('width','height','width_minus','height_minus','perimeter')),
  length_deduction_mm NUMERIC NOT NULL DEFAULT 0 CHECK (length_deduction_mm >= 0),
  deduction_auto      BOOLEAN NOT NULL DEFAULT true,
  length_factor       NUMERIC NOT NULL DEFAULT 1 CHECK (length_factor > 0),
  quantity_value      NUMERIC NOT NULL DEFAULT 1 CHECK (quantity_value >= 0),
  thickness_role      TEXT CHECK (thickness_role IS NULL OR thickness_role = 'sash'),
  sort_order          INT NOT NULL DEFAULT 0
);

CREATE TABLE bom_template_piece_ends (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  position_profile_id UUID NOT NULL REFERENCES bom_template_position_profiles(id) ON DELETE CASCADE,
  piece_index         INT NOT NULL CHECK (piece_index >= 0),
  end_index           SMALLINT NOT NULL CHECK (end_index IN (0,1)),
  mode                TEXT NOT NULL CHECK (mode IN ('through','butt')),
  butt_to_profile_id  UUID REFERENCES bom_template_position_profiles(id) ON DELETE SET NULL,
  deduction_mm        NUMERIC CHECK (deduction_mm IS NULL OR deduction_mm >= 0),   -- NULL = default from the butted profile
  UNIQUE (position_profile_id, piece_index, end_index)
);

-- The tables hang off their parent (cascade chain); tenant_id is stored on each row for RLS.
CREATE INDEX idx_bom_template_parts_template_id                 ON bom_template_parts(template_id);
CREATE INDEX idx_bom_template_positions_part_id                 ON bom_template_positions(part_id);
CREATE INDEX idx_bom_template_position_profiles_position_id     ON bom_template_position_profiles(position_id);
CREATE INDEX idx_bom_template_piece_ends_butt_to_profile_id     ON bom_template_piece_ends(butt_to_profile_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['bom_template_parts','bom_template_positions','bom_template_position_profiles','bom_template_piece_ends'] LOOP
    EXECUTE format('CREATE INDEX idx_%s_tenant_id ON %I(tenant_id)', t, t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY admin_full_access ON %I FOR ALL TO authenticated
      USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
      WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))$p$, t);
  END LOOP;
END $$;
