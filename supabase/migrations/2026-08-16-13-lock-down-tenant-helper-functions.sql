-- current_tenant_id(), has_module_access(), tenant_can_write() were left
-- with default grants, making them callable directly by anon via
-- /rest/v1/rpc/* (flagged by the security advisor during Task 10's
-- end-to-end verification). No actual data leaks (auth.email() resolves
-- NULL for anon, so all three return null/false — verified live), but
-- this doesn't match the established pattern from
-- 2026-08-16-05-security-advisor-fixes.sql, which explicitly locked down
-- the equivalent RLS-helper functions (current_user_role, is_admin_or_owner,
-- is_owner) to `authenticated` only. Matching that pattern here: these
-- functions are used inside RLS policies (which need `authenticated` to
-- retain EXECUTE for policy evaluation to work), but anon has no
-- legitimate reason to call them directly.
REVOKE EXECUTE ON FUNCTION current_tenant_id() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION has_module_access(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION tenant_can_write() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION current_tenant_id() TO authenticated;
GRANT EXECUTE ON FUNCTION has_module_access(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION tenant_can_write() TO authenticated;
