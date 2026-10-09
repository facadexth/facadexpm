-- Phase 3: price structure + quotation export. Additive; estimation-only. The only references to standard tables are
-- foreign keys FROM estimation tables TO quotations / quotation_items (nothing is added to those tables).
ALTER TABLE estimation_projects
  ADD COLUMN waste_pct       NUMERIC CHECK (waste_pct IS NULL OR (waste_pct >= 0 AND waste_pct <= 1000)),
  ADD COLUMN pm_pct          NUMERIC CHECK (pm_pct IS NULL OR (pm_pct >= 0 AND pm_pct <= 1000)),
  ADD COLUMN transport_total NUMERIC CHECK (transport_total IS NULL OR transport_total >= 0),
  ADD COLUMN round_step      NUMERIC NOT NULL DEFAULT 100 CHECK (round_step > 0);

ALTER TABLE estimation_settings
  ADD COLUMN default_waste_pct  NUMERIC CHECK (default_waste_pct IS NULL OR (default_waste_pct >= 0 AND default_waste_pct <= 1000)),
  ADD COLUMN default_profit_pct NUMERIC CHECK (default_profit_pct IS NULL OR (default_profit_pct >= 0 AND default_profit_pct <= 1000)),
  ADD COLUMN default_pm_pct     NUMERIC CHECK (default_pm_pct IS NULL OR (default_pm_pct >= 0 AND default_pm_pct <= 1000)),
  ADD COLUMN default_round_step NUMERIC CHECK (default_round_step IS NULL OR default_round_step > 0);

ALTER TABLE estimation_openings
  ADD COLUMN fire_barrier_cost NUMERIC CHECK (fire_barrier_cost IS NULL OR fire_barrier_cost >= 0),
  ADD COLUMN bracket_cost      NUMERIC CHECK (bracket_cost IS NULL OR bracket_cost >= 0),
  ADD COLUMN bend_alu_cost     NUMERIC CHECK (bend_alu_cost IS NULL OR bend_alu_cost >= 0),
  ADD COLUMN bend_glass_cost   NUMERIC CHECK (bend_glass_cost IS NULL OR bend_glass_cost >= 0);

ALTER TABLE infill_types ADD COLUMN code TEXT;          -- glass code, e.g. TP6
ALTER TABLE alu_finishes ADD COLUMN color_hex TEXT CHECK (color_hex IS NULL OR color_hex ~ '^#[0-9A-Fa-f]{6}$');

CREATE TABLE estimation_quotation_links (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  project_id          UUID NOT NULL UNIQUE REFERENCES estimation_projects(id) ON DELETE CASCADE,
  quotation_id        UUID REFERENCES quotations(id) ON DELETE SET NULL,
  attach_enabled      BOOLEAN NOT NULL DEFAULT true,
  attach_mode         TEXT NOT NULL DEFAULT 'pages' CHECK (attach_mode IN ('pages','thumb','both')),
  attach_view         TEXT NOT NULL DEFAULT 'both'  CHECK (attach_view IN ('both','out','in')),
  split_enabled       BOOLEAN NOT NULL DEFAULT false,
  split_material_pct  NUMERIC NOT NULL DEFAULT 80 CHECK (split_material_pct >= 0 AND split_material_pct <= 100),
  last_pushed_at      TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE estimation_quotation_lines (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id          UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  project_id         UUID NOT NULL REFERENCES estimation_projects(id) ON DELETE CASCADE,
  -- Deleting an opening must NOT delete this row (it is the only record of which quotation rows we generated): the
  -- opening is nulled and the app treats a null opening as "removed from the project" on the next send.
  opening_id         UUID REFERENCES estimation_openings(id) ON DELETE SET NULL,
  item_row_id        UUID REFERENCES quotation_items(id) ON DELETE SET NULL,
  description_row_id UUID REFERENCES quotation_items(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, opening_id)   -- several NULL openings per project are allowed
);
CREATE TABLE estimation_price_snapshots (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  project_id    UUID NOT NULL REFERENCES estimation_projects(id) ON DELETE CASCADE,
  quotation_id  UUID REFERENCES quotations(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('sent','agreed')),
  revision      INT  NOT NULL DEFAULT 1 CHECK (revision >= 1),
  sub_no        INT  NOT NULL DEFAULT 1 CHECK (sub_no >= 1),
  price_as_of   DATE,
  factors       JSONB NOT NULL DEFAULT '{}'::jsonb,
  items         JSONB NOT NULL DEFAULT '[]'::jsonb,
  totals        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_eql_quotation_id   ON estimation_quotation_links(quotation_id);
CREATE INDEX idx_eqlines_project    ON estimation_quotation_lines(project_id);
CREATE INDEX idx_eqlines_item_row   ON estimation_quotation_lines(item_row_id);
CREATE INDEX idx_eqlines_desc_row   ON estimation_quotation_lines(description_row_id);
CREATE INDEX idx_eps_project        ON estimation_price_snapshots(project_id, created_at);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['estimation_quotation_links','estimation_quotation_lines','estimation_price_snapshots'] LOOP
    EXECUTE format('CREATE INDEX idx_%s_tenant_id ON %I(tenant_id)', t, t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY admin_full_access ON %I FOR ALL TO authenticated
      USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
      WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))$p$, t);
  END LOOP;
END $$;
