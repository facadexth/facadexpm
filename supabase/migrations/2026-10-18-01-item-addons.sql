-- Inline add-ons (ช่องแสง) on items, piece sets per template. Additive; re-runnable (also over an earlier run of this
-- file without estimation_item_addons.align: the column and its named check are added when missing). Needs 2026-10-15-01.
-- Spec 2026-10-12 §4.2/§4.3 as amended by plan 2026-10-15-sliding2-addons.md (AO-9: sets keyed by position; note column).
-- Independent of 2026-10-17-01-layouts-all-types.sql (does not need it applied, in either order).
-- No view selects bom_templates.* or estimation_openings.*: re-grepped supabase/migrations and supabase/schema.sql for
-- "openings.*" / "templates.*"; the only hits are comments in 2026-10-15-01 and 2026-10-17-01. Nothing to recreate.
CREATE TABLE IF NOT EXISTS bom_template_addon_pieces (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  template_id    UUID NOT NULL REFERENCES bom_templates(id) ON DELETE CASCADE,
  mode           TEXT NOT NULL CHECK (mode IN ('merge','attach')),
  kind           TEXT NOT NULL CHECK (kind IN ('fixed','awning')),
  position       TEXT CHECK (position IS NULL OR position IN ('top','bottom','left','right')),
  piece_key      TEXT NOT NULL CHECK (piece_key IN ('ext','divider','main_facing','ao_frame_side','ao_bead','ao_frame_far','frame_top','frame_bottom','frame_side','mullion','rail')),
  profile_family TEXT,
  ref_input      TEXT NOT NULL CHECK (ref_input IN ('w','h','len','mw','mh','tw','th')),
  length_factor  NUMERIC NOT NULL DEFAULT 1 CHECK (length_factor > 0),
  deduction_mm   NUMERIC NOT NULL DEFAULT 0 CHECK (deduction_mm >= 0),
  qty_rule       TEXT NOT NULL DEFAULT 'fixed' CHECK (qty_rule IN ('fixed','cols-1','rows-1','cols','rows','rows*cols')),
  qty_fixed      INT NOT NULL DEFAULT 1 CHECK (qty_fixed >= 0 AND qty_fixed <= 1000),
  thickness_role TEXT CHECK (thickness_role IS NULL OR thickness_role IN ('sash')),
  note           TEXT CHECK (note IS NULL OR char_length(note) <= 120),
  sort_order     INT NOT NULL DEFAULT 0,
  -- merge sets are per position; attach sets are position-free
  CHECK ((mode = 'merge' AND position IS NOT NULL) OR (mode = 'attach' AND position IS NULL)),
  CHECK ((mode = 'merge' AND piece_key NOT IN ('frame_top','frame_bottom','frame_side'))
      OR (mode = 'attach' AND piece_key IN ('frame_top','frame_bottom','frame_side','mullion','rail'))),
  CHECK (mode = 'merge' OR ref_input IN ('w','h'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bom_template_addon_pieces_set
  ON bom_template_addon_pieces (template_id, mode, kind, COALESCE(position, ''), piece_key);

CREATE TABLE IF NOT EXISTS estimation_item_addons (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id  UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  opening_id UUID NOT NULL REFERENCES estimation_openings(id) ON DELETE CASCADE,
  mode       TEXT NOT NULL CHECK (mode IN ('merge','attach')),
  kind       TEXT NOT NULL CHECK (kind IN ('fixed','awning')),
  position   TEXT NOT NULL CHECK (position IN ('top','bottom','left','right')),
  len_m      NUMERIC NOT NULL CHECK (len_m > 0 AND len_m <= 20),
  thick_m    NUMERIC NOT NULL CHECK (thick_m > 0 AND thick_m <= 20),
  offset_m   NUMERIC NOT NULL DEFAULT 0 CHECK (offset_m >= 0),
  align      TEXT NOT NULL DEFAULT 'start' CONSTRAINT estimation_item_addons_align_check CHECK (align IN ('start','end')),
  rows       INT NOT NULL DEFAULT 1 CHECK (rows BETWEEN 1 AND 6),
  cols       INT NOT NULL DEFAULT 1 CHECK (cols BETWEEN 1 AND 12),
  sort_order INT NOT NULL DEFAULT 0
);
-- align came after a first version of this table: a database that ran the earlier file already has the table, so
-- CREATE TABLE IF NOT EXISTS skips it. Add the column and its (same-named) check when missing.
ALTER TABLE estimation_item_addons ADD COLUMN IF NOT EXISTS align TEXT NOT NULL DEFAULT 'start';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'estimation_item_addons_align_check') THEN
    ALTER TABLE estimation_item_addons ADD CONSTRAINT estimation_item_addons_align_check CHECK (align IN ('start','end'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_bom_template_addon_pieces_template_id ON bom_template_addon_pieces(template_id);
CREATE INDEX IF NOT EXISTS idx_estimation_item_addons_opening_id    ON estimation_item_addons(opening_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['bom_template_addon_pieces','estimation_item_addons'] LOOP
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_tenant_id ON %I(tenant_id)', t, t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'admin_full_access') THEN
      EXECUTE format($p$CREATE POLICY admin_full_access ON %I FOR ALL TO authenticated
        USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
        WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))$p$, t);
    END IF;
  END LOOP;
END $$;
