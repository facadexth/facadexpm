-- supabase/migrations/2026-08-29-13-package-pricing-5-tier.sql
-- Restructures the 3 starter packages (Basic/Standard/Full) into the
-- 5-tier pricing the user drafted externally (Free/Solo/Pro Team/
-- Business/Enterprise), with real prices.
--
-- IMPORTANT SCOPE NOTE: the external pricing deck also describes seat
-- limits ("1 Admin, 5 Workers, 1 Site"), per-month usage caps ("10
-- quotations/เดือน"), and an Inventory Management module -- none of
-- which exist anywhere in this app today (no seat/usage counting
-- infrastructure, no inventory tables at all). This migration only sets
-- up what's actually enforceable: real prices + the existing binary
-- module toggles. Limits/inventory are a separate future scope, not
-- silently promised by this pricing table.
--
-- Also NOT changed here: Retention stays ungated (module: null in
-- App.jsx, same as it's always been) even though the deck shows it as
-- Business-tier-and-up -- paywalling something currently free for the
-- one real tenant is a real behavior change that wasn't explicitly
-- confirmed, so left alone pending an explicit decision.
ALTER TABLE packages ADD COLUMN price_monthly NUMERIC;
ALTER TABLE packages ADD COLUMN price_yearly NUMERIC;

-- Deleting packages cascades to package_modules (ON DELETE CASCADE) and
-- nulls tenants.package_id (ON DELETE SET NULL) -- reassigned explicitly
-- below, after the new rows exist.
DELETE FROM packages;

INSERT INTO packages (name, sort_order, price_monthly, price_yearly) VALUES
  ('Free', 1, 0, 0),
  ('Solo', 2, 990, 9480),
  ('Pro Team', 3, 2990, 28680),
  ('Business', 4, 6990, 67080),
  ('Enterprise', 5, NULL, NULL); -- NULL price = "Custom / contact us"

INSERT INTO package_modules (package_id, module_key)
SELECT id, 'quotations' FROM packages WHERE name = 'Free';

INSERT INTO package_modules (package_id, module_key)
SELECT id, m FROM packages, unnest(ARRAY['quotations','invoices']) m
WHERE name = 'Solo';

INSERT INTO package_modules (package_id, module_key)
SELECT id, m FROM packages,
  unnest(ARRAY['quotations','invoices','purchase_orders','client_deposits']) m
WHERE name = 'Pro Team';

INSERT INTO package_modules (package_id, module_key)
SELECT id, m FROM packages,
  unnest(ARRAY['quotations','invoices','purchase_orders','client_deposits','payroll','labor_subcontractors']) m
WHERE name = 'Business';

-- Same module set as Business today (no more module keys exist to
-- differentiate further) -- Enterprise's real differentiation would be
-- seat limits/custom terms, which aren't build yet.
INSERT INTO package_modules (package_id, module_key)
SELECT id, m FROM packages,
  unnest(ARRAY['quotations','invoices','purchase_orders','client_deposits','payroll','labor_subcontractors']) m
WHERE name = 'Enterprise';

-- Reassign the one real tenant (was on old "Full", exact same module set
-- as new "Business") so nothing changes functionally for them.
UPDATE tenants SET package_id = (SELECT id FROM packages WHERE name = 'Business')
WHERE id = '1b9affc4-2136-4ed1-b168-a36e6624e743';

-- platform_list_tenants() needs the price columns too.
DROP FUNCTION platform_list_tenants();

CREATE FUNCTION platform_list_tenants()
RETURNS TABLE (
  id UUID, company_name TEXT, plan TEXT, trial_ends_at TIMESTAMPTZ, plan_expires_at TIMESTAMPTZ,
  package_id UUID, package_name TEXT, price_monthly NUMERIC, price_yearly NUMERIC, created_at TIMESTAMPTZ
)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT t.id, t.company_name, t.plan, t.trial_ends_at, t.plan_expires_at, t.package_id, p.name,
         p.price_monthly, p.price_yearly, t.created_at
  FROM tenants t
  LEFT JOIN packages p ON p.id = t.package_id
  WHERE EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email())
  ORDER BY t.company_name;
$$;

REVOKE EXECUTE ON FUNCTION platform_list_tenants() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION platform_list_tenants() TO authenticated;
