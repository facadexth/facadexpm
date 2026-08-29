-- supabase/migrations/2026-08-30-01-seat-limit-sites-update.sql
-- Closes a loophole in the ongoing-site limit: since tenant_under_seat_limit
-- only counts status='Ongoing' sites, and the previous migration only gated
-- INSERT, a tenant at the cap could mark an Ongoing site Completed (frees a
-- "slot"), create a new Ongoing site, then flip the Completed one back to
-- Ongoing via UPDATE -- which was never checked. Same no-op exemption
-- pattern as the user_roles fix: only blocks when status is actually
-- transitioning INTO Ongoing from something else.
DROP POLICY admin_updates ON sites;
CREATE POLICY admin_updates ON sites FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (
    is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write()
    AND (
      status IS DISTINCT FROM 'Ongoing'
      OR EXISTS (SELECT 1 FROM sites old WHERE old.id = sites.id AND old.status = 'Ongoing')
      OR tenant_under_seat_limit('sites')
    )
  );
