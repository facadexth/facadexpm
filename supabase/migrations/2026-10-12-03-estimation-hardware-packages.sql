-- Project hardware packages: a hardware set per door/window type, chosen once per estimation project. Additive; estimation-only.
CREATE TABLE alu_hardware_packages (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id  UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name       TEXT NOT NULL,
  series_id  UUID REFERENCES alu_series(id) ON DELETE SET NULL,    -- NULL = usable with any series
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
CREATE TABLE alu_hardware_package_items (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  package_id      UUID NOT NULL REFERENCES alu_hardware_packages(id) ON DELETE CASCADE,
  type_id         UUID NOT NULL REFERENCES door_window_types(id) ON DELETE CASCADE,
  hardware_set_id UUID REFERENCES alu_parts(id) ON DELETE CASCADE,  -- NULL = no hardware set on purpose
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (package_id, type_id)
);
ALTER TABLE estimation_projects
  ADD COLUMN IF NOT EXISTS hardware_package_id UUID REFERENCES alu_hardware_packages(id) ON DELETE SET NULL;

CREATE INDEX idx_alu_hardware_packages_series_id      ON alu_hardware_packages(series_id);
CREATE INDEX idx_alu_hardware_package_items_type_id   ON alu_hardware_package_items(type_id);
CREATE INDEX idx_alu_hardware_package_items_set_id    ON alu_hardware_package_items(hardware_set_id);
CREATE INDEX idx_estimation_projects_hw_package       ON estimation_projects(hardware_package_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['alu_hardware_packages','alu_hardware_package_items'] LOOP
    EXECUTE format('CREATE INDEX idx_%s_tenant_id ON %I(tenant_id)', t, t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY admin_full_access ON %I FOR ALL TO authenticated
      USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
      WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))$p$, t);
  END LOOP;
END $$;
