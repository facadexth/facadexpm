-- ============================================================
-- Fix bundle for inventory Phase 1 final-review Fix 4: record_stock_movement()
-- was missing the REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated that every
-- other SECURITY DEFINER function in this codebase carries (e.g.
-- perform_worker_checkin(), supabase/schema.sql). Postgres grants EXECUTE to
-- PUBLIC by default on function creation, so anon/PUBLIC could call this
-- function (verified live via pg_proc.proacl before this fix). Not currently
-- exploitable -- the function's first check is is_admin_or_owner(), which is
-- false for an anon session -- but this closes the gap to match the
-- established convention. See docs/superpowers/plans/2026-09-05-inventory-phase1-plan.md
-- and the final-review fix bundle report.
-- ============================================================
REVOKE EXECUTE ON FUNCTION record_stock_movement(UUID, UUID, TEXT, NUMERIC, NUMERIC, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_stock_movement(UUID, UUID, TEXT, NUMERIC, NUMERIC, TEXT, UUID, TEXT) TO authenticated;
