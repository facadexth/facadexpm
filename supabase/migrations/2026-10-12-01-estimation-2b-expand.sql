-- supabase/migrations/2026-10-12-01-estimation-2b-expand.sql
-- Aluminium cost catalog, Phase 2b "expand" step #2. ADDITIVE ONLY (new columns with defaults / nullable, new tables):
-- nothing is dropped, renamed or retyped, so the deployed code keeps working before and after this migration.
-- FacadeX only: every new table is gated by has_module_access('estimation'), like the rest of the catalog.
-- Needs migrations 2026-10-10-01..03 and 2026-10-11-01. The matching contract step is a separate file applied at deploy time.

-- 1. Profile dimensions and files. drawing_no (already there) is the extruder's DIE NO.; one die = one profile row.
--    primary_contact = the face a butting bar rests against; the bar is shortened by the dimension perpendicular to it:
--      'width' (default) = the wide face (e.g. 101.6) -> shortened by depth_mm (44.45); 'depth' = the narrow face -> by width_mm.
ALTER TABLE alu_profiles
  ADD COLUMN shape_group     TEXT,
  ADD COLUMN width_mm        NUMERIC CHECK (width_mm IS NULL OR width_mm > 0),
  ADD COLUMN depth_mm        NUMERIC CHECK (depth_mm IS NULL OR depth_mm > 0),
  ADD COLUMN primary_contact TEXT NOT NULL DEFAULT 'width' CHECK (primary_contact IN ('width','depth'));

-- Drawing files per profile (supplier catalogue PDFs, the company's own DWG for approval drawings, DXF/SVG/images).
-- Columns match what src/components/AttachmentsSection.jsx reads and writes. One file = one profile (the owner splits
-- multi-profile PDFs / DWGs himself before uploading). Private bucket, tenant-prefixed path, one FOR ALL policy on both
-- the table and the bucket (see 2026-09-02-04-invoice-photos.sql for why not split per command).
CREATE TABLE alu_profile_files (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  profile_id  UUID NOT NULL REFERENCES alu_profiles(id) ON DELETE CASCADE,
  file_path   TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_alu_profile_files_profile_id ON alu_profile_files(profile_id);

INSERT INTO storage.buckets (id, name, public) VALUES ('alu-profile-files', 'alu-profile-files', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY alu_profile_files_tenant_access ON storage.objects FOR ALL TO authenticated
  USING (
    bucket_id = 'alu-profile-files'
    AND is_admin_or_owner() AND has_module_access('estimation')
    AND (storage.foldername(name))[1] = current_tenant_id()::text
  )
  WITH CHECK (
    bucket_id = 'alu-profile-files'
    AND is_admin_or_owner() AND has_module_access('estimation')
    AND (storage.foldername(name))[1] = current_tenant_id()::text
  );

-- 2. Frame and sash may use different thicknesses (government specs: frame 2.0 mm, sash 1.5 mm) only where the
--    series + type allows it. A component is tagged thickness_role 'sash' (NULL = frame/main) in step 4.
ALTER TABLE alu_series_types
  ADD COLUMN allow_mixed_thickness BOOLEAN NOT NULL DEFAULT false;

-- 3. Template: which bars run full length (drives the preview) and how the preview decorates the type.
ALTER TABLE bom_templates
  ADD COLUMN main_axis    TEXT NOT NULL DEFAULT 'vertical' CHECK (main_axis IN ('vertical','horizontal')),
  ADD COLUMN preview_kind TEXT NOT NULL DEFAULT 'fixed'    CHECK (preview_kind IN ('fixed','slide','swing'));

-- 4. Joints of a template: main bar family, secondary bar family, deduction, cut style.
CREATE TABLE bom_template_joints (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id        UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  template_id      UUID NOT NULL REFERENCES bom_templates(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  main_family      TEXT NOT NULL,
  secondary_family TEXT NOT NULL,
  deduction_mode   TEXT NOT NULL DEFAULT 'auto' CHECK (deduction_mode IN ('auto','manual')),
  deduction_mm     NUMERIC CHECK (deduction_mm IS NULL OR deduction_mm >= 0),
  cut_style        TEXT NOT NULL DEFAULT 'square' CHECK (cut_style IN ('square','notch','miter45')),
  notch_width_mm   NUMERIC CHECK (notch_width_mm IS NULL OR notch_width_mm > 0),
  notch_depth_mm   NUMERIC CHECK (notch_depth_mm IS NULL OR notch_depth_mm > 0),
  sort_order       INT NOT NULL DEFAULT 0,
  CHECK (deduction_mode <> 'manual' OR deduction_mm IS NOT NULL)
);

ALTER TABLE bom_template_components
  ADD COLUMN joint_id       UUID REFERENCES bom_template_joints(id) ON DELETE SET NULL,
  ADD COLUMN joint_ends     SMALLINT NOT NULL DEFAULT 2 CHECK (joint_ends IN (1,2)),
  ADD COLUMN thickness_role TEXT CHECK (thickness_role IS NULL OR thickness_role = 'sash');

-- 5. Tenant-wide constants (one row per tenant; every value is universal across projects).
CREATE TABLE estimation_settings (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  stock_length_m      NUMERIC NOT NULL DEFAULT 6.4 CHECK (stock_length_m > 0),
  kerf_square_mm      NUMERIC NOT NULL DEFAULT 3   CHECK (kerf_square_mm >= 0),
  kerf_miter_mm       NUMERIC NOT NULL DEFAULT 10  CHECK (kerf_miter_mm >= 0),
  min_keep_offcut_m   NUMERIC NOT NULL DEFAULT 0.5 CHECK (min_keep_offcut_m >= 0),
  sealant_m_per_tube  NUMERIC NOT NULL DEFAULT 10  CHECK (sealant_m_per_tube > 0),
  fixing_pitch_m      NUMERIC NOT NULL DEFAULT 0.6 CHECK (fixing_pitch_m > 0),
  fixing_min_per_side INT     NOT NULL DEFAULT 2   CHECK (fixing_min_per_side >= 1),
  sealant_part_id     UUID REFERENCES alu_parts(id) ON DELETE SET NULL,
  shim_part_id        UUID REFERENCES alu_parts(id) ON DELETE SET NULL,
  screw_part_id       UUID REFERENCES alu_parts(id) ON DELETE SET NULL,
  plug_part_id        UUID REFERENCES alu_parts(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)
);

-- 6. Project: main extruder, description format, stock length, and per-profile stock length overrides.
ALTER TABLE estimation_projects
  ADD COLUMN primary_provider_id    UUID REFERENCES alu_providers(id) ON DELETE SET NULL,
  ADD COLUMN default_sash_thickness_mm NUMERIC CHECK (default_sash_thickness_mm IS NULL OR default_sash_thickness_mm > 0),
  ADD COLUMN stock_length_m      NUMERIC CHECK (stock_length_m IS NULL OR stock_length_m > 0),
  ADD COLUMN description_format  JSONB NOT NULL DEFAULT '["item_name","type","size","alu_color"]'::jsonb;

CREATE TABLE estimation_project_stock (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id  UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  project_id UUID NOT NULL REFERENCES estimation_projects(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL REFERENCES alu_profiles(id) ON DELETE CASCADE,
  length_m   NUMERIC NOT NULL CHECK (length_m > 0),
  UNIQUE (project_id, profile_id)
);

-- 7. Items: add-on position/offset and the saved preview snapshots (always the double-line drawing).
ALTER TABLE estimation_openings
  ADD COLUMN sash_thickness_mm NUMERIC CHECK (sash_thickness_mm IS NULL OR sash_thickness_mm > 0),
  ADD COLUMN addon_position  TEXT CHECK (addon_position IS NULL OR addon_position IN ('top','bottom','left','right')),
  ADD COLUMN addon_offset_m  NUMERIC CHECK (addon_offset_m IS NULL OR addon_offset_m >= 0),
  ADD COLUMN preview_svg_out TEXT,
  ADD COLUMN preview_svg_in  TEXT,
  ADD COLUMN preview_sig     TEXT,
  ADD COLUMN preview_saved_at TIMESTAMPTZ;

-- 8. Layout templates: main type + optional add-on type, position and proportions. No series / colour / price.
CREATE TABLE estimation_layout_templates (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id          UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name               TEXT NOT NULL,
  main_type_id       UUID NOT NULL REFERENCES door_window_types(id) ON DELETE CASCADE,
  addon_type_id      UUID REFERENCES door_window_types(id) ON DELETE CASCADE,
  addon_position     TEXT CHECK (addon_position IS NULL OR addon_position IN ('top','bottom','left','right')),
  addon_offset_ratio NUMERIC NOT NULL DEFAULT 0    CHECK (addon_offset_ratio >= 0 AND addon_offset_ratio <= 1),
  addon_width_ratio  NUMERIC NOT NULL DEFAULT 1    CHECK (addon_width_ratio > 0),
  addon_height_ratio NUMERIC NOT NULL DEFAULT 0.33 CHECK (addon_height_ratio > 0),
  main_panel_count   INT NOT NULL DEFAULT 1 CHECK (main_panel_count >= 1),
  addon_panel_count  INT NOT NULL DEFAULT 1 CHECK (addon_panel_count >= 1),
  active             BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  CHECK ((addon_type_id IS NULL) = (addon_position IS NULL))
);

-- Foreign-key indexes.
CREATE INDEX idx_bom_template_joints_template_id      ON bom_template_joints(template_id);
CREATE INDEX idx_bom_template_components_joint_id     ON bom_template_components(joint_id);
CREATE INDEX idx_estimation_projects_primary_provider ON estimation_projects(primary_provider_id);
CREATE INDEX idx_estimation_project_stock_project_id  ON estimation_project_stock(project_id);
CREATE INDEX idx_estimation_project_stock_profile_id  ON estimation_project_stock(profile_id);
CREATE INDEX idx_estimation_layout_main_type          ON estimation_layout_templates(main_type_id);
CREATE INDEX idx_estimation_layout_addon_type         ON estimation_layout_templates(addon_type_id);
CREATE INDEX idx_estimation_settings_sealant_part     ON estimation_settings(sealant_part_id);
CREATE INDEX idx_estimation_settings_shim_part        ON estimation_settings(shim_part_id);
CREATE INDEX idx_estimation_settings_screw_part       ON estimation_settings(screw_part_id);
CREATE INDEX idx_estimation_settings_plug_part        ON estimation_settings(plug_part_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['bom_template_joints','estimation_settings','estimation_project_stock','estimation_layout_templates','alu_profile_files'] LOOP
    EXECUTE format('CREATE INDEX idx_%s_tenant_id ON %I(tenant_id)', t, t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY admin_full_access ON %I FOR ALL TO authenticated
      USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
      WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))$p$, t);
  END LOOP;
END $$;
