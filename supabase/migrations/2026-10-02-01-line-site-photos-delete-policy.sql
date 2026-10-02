-- Kanban photo management (switch site / bulk delete): the viewer modal
-- in PhaseKanbanBoard.jsx needs to let an admin/owner delete photos
-- outright, but line_site_photos had no DELETE policy at all -- only
-- admin_reads/admin_updates/worker_inserts_own/worker_updates_own existed.
-- Mirrors admin_updates' own gate exactly (same tenant scoping + write-lock
-- check) rather than inventing a new pattern.
CREATE POLICY admin_deletes ON public.line_site_photos FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
