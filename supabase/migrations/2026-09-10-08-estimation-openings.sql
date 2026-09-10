-- supabase/migrations/2026-09-10-08-estimation-openings.sql
-- BOM Template Engine, part 3 of 3: projects and their openings. No AI
-- drawing extraction yet (spec Non-goals) -- rows come from the manual
-- entry form Task 10 builds.
CREATE TABLE estimation_projects (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id  UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name       TEXT NOT NULL,
  client_id  UUID REFERENCES clients(id) ON DELETE SET NULL,
  status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','reviewed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_estimation_projects_tenant_id ON estimation_projects(tenant_id);
ALTER TABLE estimation_projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON estimation_projects FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'));

CREATE TABLE estimation_openings (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  project_id    UUID NOT NULL REFERENCES estimation_projects(id) ON DELETE CASCADE,
  opening_no    TEXT NOT NULL,
  template_id   UUID NOT NULL REFERENCES bom_templates(id) ON DELETE RESTRICT,
  series        TEXT NOT NULL,
  thickness_mm  NUMERIC NOT NULL,
  finish_id     UUID NOT NULL REFERENCES aluminum_finishes(id) ON DELETE RESTRICT,
  glass_type_id UUID REFERENCES bom_glass_types(id) ON DELETE RESTRICT,
  width_m       NUMERIC NOT NULL,
  height_m      NUMERIC NOT NULL,
  panel_count   INT NOT NULL DEFAULT 1,
  quantity      INT NOT NULL DEFAULT 1,
  extra_lines   JSONB NOT NULL DEFAULT '[]',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_estimation_openings_project_id ON estimation_openings(project_id);
CREATE INDEX idx_estimation_openings_tenant_id ON estimation_openings(tenant_id);
ALTER TABLE estimation_openings ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON estimation_openings FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'));
