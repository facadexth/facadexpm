-- supabase/migrations/2026-08-29-11-tenant-management-packages.sql
-- Phase 1 of tenant management -- see
-- docs/superpowers/specs/2026-08-29-tenant-management-page-design.md.
-- platform_admins allowlist + packages (named module bundles) +
-- SECURITY DEFINER functions that let platform admins list every
-- tenant and assign a package, syncing tenant_modules to match.

CREATE TABLE platform_admins (
  user_email  TEXT PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO platform_admins (user_email) VALUES ('contact@facadex.co.th');

ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
CREATE POLICY platform_admins_read_own ON platform_admins FOR SELECT TO authenticated
  USING (user_email = auth.email());

CREATE TABLE packages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE package_modules (
  package_id  UUID NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  module_key  TEXT NOT NULL CHECK (module_key IN
    ('payroll','labor_subcontractors','purchase_orders','client_deposits','quotations','invoices')),
  PRIMARY KEY (package_id, module_key)
);

ALTER TABLE packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE package_modules ENABLE ROW LEVEL SECURITY;
CREATE POLICY platform_admin_full_access ON packages FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()))
  WITH CHECK (EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()));
CREATE POLICY platform_admin_full_access ON package_modules FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()))
  WITH CHECK (EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()));

ALTER TABLE tenants ADD COLUMN package_id UUID REFERENCES packages(id) ON DELETE SET NULL;

-- Starter tiers, exact supersets of each other (Basic ⊂ Standard ⊂ Full).
INSERT INTO packages (name, sort_order) VALUES
  ('Basic', 1), ('Standard', 2), ('Full', 3);

INSERT INTO package_modules (package_id, module_key)
SELECT id, 'quotations' FROM packages WHERE name = 'Basic'
UNION ALL SELECT id, 'invoices' FROM packages WHERE name = 'Basic';

INSERT INTO package_modules (package_id, module_key)
SELECT id, m FROM packages, unnest(ARRAY['quotations','invoices','purchase_orders','client_deposits']) m
WHERE name = 'Standard';

INSERT INTO package_modules (package_id, module_key)
SELECT id, m FROM packages,
  unnest(ARRAY['quotations','invoices','purchase_orders','client_deposits','payroll','labor_subcontractors']) m
WHERE name = 'Full';

CREATE FUNCTION platform_list_tenants()
RETURNS TABLE (
  id UUID, company_name TEXT, plan TEXT, trial_ends_at TIMESTAMPTZ,
  package_id UUID, package_name TEXT, created_at TIMESTAMPTZ
)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT t.id, t.company_name, t.plan, t.trial_ends_at, t.package_id, p.name, t.created_at
  FROM tenants t
  LEFT JOIN packages p ON p.id = t.package_id
  WHERE EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email())
  ORDER BY t.company_name;
$$;

CREATE FUNCTION platform_set_tenant_package(p_tenant_id UUID, p_package_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()) THEN
    RAISE EXCEPTION 'not a platform admin';
  END IF;

  UPDATE tenants SET package_id = p_package_id WHERE id = p_tenant_id;

  DELETE FROM tenant_modules
  WHERE tenant_id = p_tenant_id
    AND module_key NOT IN (SELECT module_key FROM package_modules WHERE package_id = p_package_id);

  INSERT INTO tenant_modules (tenant_id, module_key)
  SELECT p_tenant_id, module_key FROM package_modules WHERE package_id = p_package_id
  ON CONFLICT (tenant_id, module_key) DO NOTHING;
END;
$$;

REVOKE EXECUTE ON FUNCTION platform_list_tenants() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION platform_set_tenant_package(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION platform_list_tenants() TO authenticated;
GRANT EXECUTE ON FUNCTION platform_set_tenant_package(UUID, UUID) TO authenticated;

-- Backfill: the FacadeX bootstrap tenant (the only real tenant in active
-- use today; company_name is Thai -- "บริษัท ฟาซาด เอ๊กซ์ จำกัด" --
-- matched by id, not name, to avoid exactly this kind of mismatch) goes
-- on Full per explicit instruction. Inlined rather than calling
-- platform_set_tenant_package() -- that function checks auth.email()
-- against platform_admins, which resolves to NULL with no real user
-- session (i.e. from a migration), so it would reject its own caller
-- here. A migration already runs with full privilege; this is exactly
-- what that function does internally, minus the auth check.
UPDATE tenants SET package_id = (SELECT id FROM packages WHERE name = 'Full')
WHERE id = '1b9affc4-2136-4ed1-b168-a36e6624e743';

DELETE FROM tenant_modules
WHERE tenant_id = '1b9affc4-2136-4ed1-b168-a36e6624e743'
  AND module_key NOT IN (SELECT module_key FROM package_modules WHERE package_id = (SELECT id FROM packages WHERE name = 'Full'));

INSERT INTO tenant_modules (tenant_id, module_key)
SELECT '1b9affc4-2136-4ed1-b168-a36e6624e743', module_key
FROM package_modules WHERE package_id = (SELECT id FROM packages WHERE name = 'Full')
ON CONFLICT (tenant_id, module_key) DO NOTHING;

-- Every OTHER existing tenant: assign the smallest starter package whose
-- module set is a superset of that tenant's current tenant_modules, via
-- a plain UPDATE (never platform_set_tenant_package, which would delete
-- modules) -- so a tenant whose real module set doesn't cleanly fit a
-- tier is simply left at package_id = NULL, tenant_modules untouched.
WITH tenant_mods AS (
  SELECT tenant_id, array_agg(module_key ORDER BY module_key) AS mods
  FROM tenant_modules
  GROUP BY tenant_id
),
best_fit AS (
  SELECT tm.tenant_id, p.id AS package_id
  FROM tenant_mods tm
  JOIN packages p ON true
  JOIN LATERAL (
    SELECT array_agg(module_key ORDER BY module_key) AS mods
    FROM package_modules WHERE package_id = p.id
  ) pm ON true
  WHERE tm.mods <@ pm.mods
  ORDER BY tm.tenant_id, (SELECT count(*) FROM package_modules WHERE package_id = p.id) ASC
)
UPDATE tenants t
SET package_id = (SELECT bf.package_id FROM best_fit bf WHERE bf.tenant_id = t.id LIMIT 1)
WHERE t.id != '1b9affc4-2136-4ed1-b168-a36e6624e743'
  AND EXISTS (SELECT 1 FROM best_fit bf WHERE bf.tenant_id = t.id);
