-- supabase/migrations/2026-09-03-09-worker-safe-site-names.sql
-- WORKER-safe site name lookup, matching this feature's established
-- SECURITY DEFINER pattern (see perform_worker_checkin/checkout):
-- `sites` itself is admin/owner-read-only (admin_reads policy), and
-- MySchedule.jsx (the WORKER-only schedule view -- see its header
-- comment: "no cost figures, RLS also enforces this") has no legitimate
-- read path to site names at all today, so every site-name lookup on
-- that page silently returns nothing. Rather than adding a WORKER SELECT
-- policy directly on `sites` (which would also expose contract_value and
-- other financial columns to any direct-table query, not just the
-- name/number this needs), this function returns only the 3 safe columns,
-- scoped to sites the calling worker currently has an assignment at.
CREATE OR REPLACE FUNCTION get_my_site_names()
RETURNS TABLE(id UUID, site_number TEXT, name TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT s.id, s.site_number, s.name
  FROM sites s
  JOIN worker_assignments wa ON wa.site_id = s.id AND wa.tenant_id = current_tenant_id()
  JOIN workers w ON w.id = wa.worker_id AND w.tenant_id = current_tenant_id()
  WHERE w.email = auth.email() AND s.tenant_id = current_tenant_id();
$$;

REVOKE EXECUTE ON FUNCTION get_my_site_names() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_my_site_names() TO authenticated;
