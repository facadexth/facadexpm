-- supabase/migrations/2026-10-10-03-alu-catalog-prices.sql
-- Aluminium cost catalog, part 3 of 3: price history (append-only by convention;
-- a price is looked up as "latest row with effective_from <= the date asked").

CREATE TABLE alu_kg_prices (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  provider_id    UUID NOT NULL REFERENCES alu_providers(id) ON DELETE RESTRICT,
  finish_id      UUID NOT NULL REFERENCES alu_finishes(id) ON DELETE RESTRICT,
  series_id      UUID REFERENCES alu_series(id) ON DELETE CASCADE,
  profile_id     UUID REFERENCES alu_profiles(id) ON DELETE CASCADE,
  price_per_kg   NUMERIC NOT NULL CHECK (price_per_kg >= 0),
  effective_from DATE NOT NULL,
  source         TEXT NOT NULL DEFAULT 'manual',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (series_id IS NULL OR profile_id IS NULL)
);
CREATE UNIQUE INDEX uq_alu_kg_prices ON alu_kg_prices (
  provider_id, finish_id,
  COALESCE(series_id,  '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(profile_id, '00000000-0000-0000-0000-000000000000'::uuid),
  effective_from
);

CREATE TABLE alu_piece_prices (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  variant_id      UUID NOT NULL REFERENCES alu_profile_variants(id) ON DELETE CASCADE,
  price_per_piece NUMERIC NOT NULL CHECK (price_per_piece >= 0),
  effective_from  DATE NOT NULL,
  source          TEXT NOT NULL DEFAULT 'manual',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (variant_id, effective_from)
);

CREATE TABLE alu_part_prices (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  part_id        UUID NOT NULL REFERENCES alu_parts(id) ON DELETE CASCADE,
  list_price     NUMERIC NOT NULL CHECK (list_price >= 0),
  discount_pct   NUMERIC NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 100),
  effective_from DATE NOT NULL,
  source         TEXT NOT NULL DEFAULT 'manual',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (part_id, effective_from)
);

CREATE INDEX idx_alu_kg_prices_finish_id ON alu_kg_prices(finish_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['alu_kg_prices','alu_piece_prices','alu_part_prices'] LOOP
    EXECUTE format('CREATE INDEX idx_%s_tenant_id ON %I(tenant_id)', t, t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY admin_full_access ON %I FOR ALL TO authenticated
      USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
      WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))$p$, t);
  END LOOP;
END $$;
