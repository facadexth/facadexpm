-- supabase/migrations/2026-09-10-09-estimation-solo-tier-revoke.sql
-- estimation was granted to every paid tier in the prior migration, but
-- Solo tenants can never populate aluminum_profiles (gated on
-- has_module_access('purchase_orders'), which Solo doesn't have) -- so
-- Solo got a module that silently renders every BOM line unresolved.
-- Narrow the grant to Pro Team and above.
DELETE FROM package_modules
WHERE module_key = 'estimation'
  AND package_id = (SELECT id FROM packages WHERE name = 'Solo');

-- One live tenant was already on Solo when the prior migration backfilled
-- tenant_modules -- revoke it directly too, not just the package seed.
DELETE FROM tenant_modules
WHERE module_key = 'estimation'
  AND tenant_id IN (
    SELECT t.id FROM tenants t
    JOIN packages p ON p.id = t.package_id
    WHERE p.name = 'Solo'
  );
