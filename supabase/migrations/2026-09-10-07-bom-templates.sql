-- supabase/migrations/2026-09-10-07-bom-templates.sql
-- BOM Template Engine, part 2 of 3: the template itself and its children.
-- See spec's Data model / Decision 10 for the grid rationale.
CREATE TABLE bom_templates (
  id                           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id                    UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name                         TEXT NOT NULL,
  category                     TEXT NOT NULL CHECK (category IN ('door','window')),
  waste_pct                    NUMERIC NOT NULL DEFAULT 10,
  glass_width_deduction_mm     NUMERIC NOT NULL DEFAULT 0,
  glass_height_deduction_mm    NUMERIC NOT NULL DEFAULT 0,
  grid_row_weights             JSONB NOT NULL DEFAULT '[1]',
  grid_horizontal_rail_family  TEXT,
  grid_vertical_mullion_family TEXT,
  active                       BOOLEAN NOT NULL DEFAULT true,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bom_templates_tenant_id ON bom_templates(tenant_id);
ALTER TABLE bom_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON bom_templates FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'));

CREATE TABLE bom_template_components (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  template_id         UUID NOT NULL REFERENCES bom_templates(id) ON DELETE CASCADE,
  role_name           TEXT NOT NULL,
  profile_family      TEXT NOT NULL,
  length_rule_type    TEXT NOT NULL CHECK (length_rule_type IN
                       ('width','height','width_minus','height_minus','perimeter')),
  length_deduction_mm NUMERIC NOT NULL DEFAULT 0,
  quantity_basis      TEXT NOT NULL CHECK (quantity_basis IN ('fixed','per_cell')),
  quantity_value      NUMERIC NOT NULL DEFAULT 1,
  sort_order          INT NOT NULL DEFAULT 0
);

CREATE INDEX idx_bom_template_components_template_id ON bom_template_components(template_id);
CREATE INDEX idx_bom_template_components_tenant_id ON bom_template_components(tenant_id);
ALTER TABLE bom_template_components ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON bom_template_components FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'));

CREATE TABLE bom_template_hardware (
  id                   UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id            UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  template_id          UUID NOT NULL REFERENCES bom_templates(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  reference_unit_price NUMERIC NOT NULL,
  inventory_item_id    UUID REFERENCES inventory_items(id) ON DELETE SET NULL,
  quantity_basis       TEXT NOT NULL CHECK (quantity_basis IN ('fixed','per_cell','per_perimeter_m')),
  quantity_value       NUMERIC NOT NULL DEFAULT 1,
  sort_order           INT NOT NULL DEFAULT 0
);

CREATE INDEX idx_bom_template_hardware_template_id ON bom_template_hardware(template_id);
CREATE INDEX idx_bom_template_hardware_tenant_id ON bom_template_hardware(tenant_id);
ALTER TABLE bom_template_hardware ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON bom_template_hardware FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'));

CREATE TABLE bom_template_constraints (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  template_id UUID NOT NULL REFERENCES bom_templates(id) ON DELETE CASCADE,
  rule_type   TEXT NOT NULL CHECK (rule_type IN
              ('max_width_mm','max_height_mm','max_span_mm','max_panel_count')),
  value       NUMERIC NOT NULL,
  message     TEXT NOT NULL
);

CREATE INDEX idx_bom_template_constraints_template_id ON bom_template_constraints(template_id);
CREATE INDEX idx_bom_template_constraints_tenant_id ON bom_template_constraints(tenant_id);
ALTER TABLE bom_template_constraints ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON bom_template_constraints FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'));
