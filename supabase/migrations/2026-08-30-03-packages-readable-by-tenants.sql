-- supabase/migrations/2026-08-30-03-packages-readable-by-tenants.sql
-- packages/package_modules were platform-admin-only (no SELECT for regular
-- tenant users at all) -- needed to build a live tier-comparison view for
-- tenants (Settings.jsx). Pricing/limits/module lists are not sensitive
-- (equivalent to a public pricing page), so opened broadly to any
-- authenticated user; write access stays platform-admin-only via the
-- existing platform_admin_full_access (FOR ALL) policy.
CREATE POLICY authenticated_read ON packages FOR SELECT TO authenticated USING (true);
CREATE POLICY authenticated_read ON package_modules FOR SELECT TO authenticated USING (true);
