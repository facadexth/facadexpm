-- supabase/migrations/2026-10-10-02-alu-catalog-components.sql
-- Aluminium cost catalog, part 2 of 3: profiles, colours, variants, parts.
-- Deliberately separate from the legacy aluminum_profiles (read by PO
-- receiving, gated by the purchase_orders module) and aluminum_finishes
-- (has price_per_kg, read by the current estimation engine): neither is
-- altered. Phase 2 repoints the engine here; a link to the PO side can be
-- added later. Prices live only in the price tables (migration 03).

CREATE TABLE alu_profiles (
  id                     UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id              UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  provider_id            UUID NOT NULL REFERENCES alu_providers(id) ON DELETE RESTRICT,
  name                   TEXT NOT NULL,
  drawing_no             TEXT,
  family                 TEXT,
  thickness_mm           NUMERIC CHECK (thickness_mm IS NULL OR thickness_mm > 0),
  linear_weight_kg_per_m NUMERIC NOT NULL CHECK (linear_weight_kg_per_m >= 0),
  default_length_m       NUMERIC NOT NULL DEFAULT 6.4 CHECK (default_length_m > 0),
  image_url              TEXT,
  active                 BOOLEAN NOT NULL DEFAULT true,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE alu_finishes (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  provider_id UUID NOT NULL REFERENCES alu_providers(id) ON DELETE RESTRICT,
  name        TEXT NOT NULL,
  code        TEXT,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, name)
);
CREATE INDEX idx_alu_profiles_provider_id ON alu_profiles(provider_id);
CREATE INDEX idx_alu_finishes_provider_id ON alu_finishes(provider_id);

CREATE TABLE alu_series_profiles (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id  UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  series_id  UUID NOT NULL REFERENCES alu_series(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL REFERENCES alu_profiles(id) ON DELETE CASCADE,
  family     TEXT,
  UNIQUE (series_id, profile_id)
);

CREATE TABLE alu_profile_variants (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id  UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  profile_id UUID NOT NULL REFERENCES alu_profiles(id) ON DELETE CASCADE,
  finish_id  UUID NOT NULL REFERENCES alu_finishes(id) ON DELETE RESTRICT,
  length_m   NUMERIC NOT NULL CHECK (length_m > 0),
  UNIQUE (profile_id, finish_id, length_m)
);

CREATE TABLE alu_parts (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  provider_id UUID REFERENCES alu_providers(id) ON DELETE RESTRICT,
  code        TEXT NOT NULL,  -- system-numbered P-0001, P-0002 ... per tenant; never typed, never edited
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'hardware' CHECK (kind IN ('hardware','hardware_set','accessory')),
  unit        TEXT NOT NULL DEFAULT 'ชิ้น',
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

-- Auto-number: when no code is supplied, take the tenant's next P-nnnn.
-- The advisory lock serialises concurrent inserts for the same tenant so two
-- parts cannot compute the same number. An explicit code is left alone (the
-- UNIQUE constraint still protects it).
CREATE FUNCTION alu_parts_assign_code() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE next_n INT;
BEGIN
  IF NEW.code IS NULL OR NEW.code = '' THEN
    PERFORM pg_advisory_xact_lock(hashtext('alu_parts_code:' || NEW.tenant_id::text));
    SELECT COALESCE(max(substring(code FROM 3)::int), 0) + 1 INTO next_n
      FROM alu_parts
     WHERE tenant_id = NEW.tenant_id AND code ~ '^P-[0-9]{1,9}$';
    NEW.code := 'P-' || lpad(next_n::text, 4, '0');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER alu_parts_assign_code BEFORE INSERT ON alu_parts
  FOR EACH ROW EXECUTE FUNCTION alu_parts_assign_code();

-- The code is permanent once assigned.
CREATE FUNCTION alu_parts_lock_code() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'alu_parts.code cannot be changed';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER alu_parts_lock_code BEFORE UPDATE ON alu_parts
  FOR EACH ROW EXECUTE FUNCTION alu_parts_lock_code();

CREATE TABLE alu_part_set_items (
  id        UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  set_id    UUID NOT NULL REFERENCES alu_parts(id) ON DELETE CASCADE,
  part_id   UUID NOT NULL REFERENCES alu_parts(id) ON DELETE RESTRICT,
  quantity  NUMERIC NOT NULL DEFAULT 1 CHECK (quantity > 0),
  UNIQUE (set_id, part_id),
  CHECK (set_id <> part_id)
);

CREATE TABLE alu_series_parts (
  id        UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  series_id UUID NOT NULL REFERENCES alu_series(id) ON DELETE CASCADE,
  type_id   UUID REFERENCES door_window_types(id) ON DELETE CASCADE,
  part_id   UUID NOT NULL REFERENCES alu_parts(id) ON DELETE CASCADE
);
-- one row per (series, type-or-any, part); type_id NULL means "every type"
CREATE UNIQUE INDEX uq_alu_series_parts
  ON alu_series_parts (series_id, COALESCE(type_id, '00000000-0000-0000-0000-000000000000'::uuid), part_id);

CREATE INDEX idx_alu_series_profiles_profile_id ON alu_series_profiles(profile_id);
CREATE INDEX idx_alu_profile_variants_finish_id ON alu_profile_variants(finish_id);
CREATE INDEX idx_alu_parts_provider_id          ON alu_parts(provider_id);
CREATE INDEX idx_alu_part_set_items_part_id     ON alu_part_set_items(part_id);
CREATE INDEX idx_alu_series_parts_part_id       ON alu_series_parts(part_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['alu_profiles','alu_finishes','alu_series_profiles','alu_profile_variants','alu_parts','alu_part_set_items','alu_series_parts'] LOOP
    EXECUTE format('CREATE INDEX idx_%s_tenant_id ON %I(tenant_id)', t, t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY admin_full_access ON %I FOR ALL TO authenticated
      USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
      WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))$p$, t);
  END LOOP;
END $$;
