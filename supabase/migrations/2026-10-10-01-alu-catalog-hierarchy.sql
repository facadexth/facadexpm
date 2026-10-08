-- supabase/migrations/2026-10-10-01-alu-catalog-hierarchy.sql
-- Aluminium cost catalog, part 1 of 3: extruder -> series -> door/window type.
-- FacadeX only: every policy is gated by has_module_access('estimation').
-- Spec: docs/superpowers/specs/2026-10-08-aluminium-cost-catalog-design.md

CREATE TABLE alu_providers (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name        TEXT NOT NULL,
  short_name  TEXT NOT NULL,
  price_basis TEXT NOT NULL DEFAULT 'per_kg' CHECK (price_basis IN ('per_kg','per_piece','both')),
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE door_window_types (
  id                     UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id              UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name                   TEXT NOT NULL,
  category               TEXT NOT NULL CHECK (category IN ('door','window')),
  default_labour_per_sqm NUMERIC CHECK (default_labour_per_sqm IS NULL OR default_labour_per_sqm >= 0),
  active                 BOOLEAN NOT NULL DEFAULT true,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE alu_series (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  provider_id UUID NOT NULL REFERENCES alu_providers(id) ON DELETE RESTRICT,
  name        TEXT NOT NULL,
  is_base     BOOLEAN NOT NULL DEFAULT false,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, name)
);

CREATE TABLE alu_series_types (
  id        UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  series_id UUID NOT NULL REFERENCES alu_series(id) ON DELETE CASCADE,
  type_id   UUID NOT NULL REFERENCES door_window_types(id) ON DELETE CASCADE,
  UNIQUE (series_id, type_id)
);

CREATE INDEX idx_alu_series_provider_id   ON alu_series(provider_id);
CREATE INDEX idx_alu_series_types_type_id ON alu_series_types(type_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['alu_providers','door_window_types','alu_series','alu_series_types'] LOOP
    EXECUTE format('CREATE INDEX idx_%s_tenant_id ON %I(tenant_id)', t, t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY admin_full_access ON %I FOR ALL TO authenticated
      USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
      WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))$p$, t);
  END LOOP;
END $$;
