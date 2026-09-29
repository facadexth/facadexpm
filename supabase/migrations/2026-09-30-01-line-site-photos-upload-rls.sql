-- supabase/migrations/2026-09-30-01-line-site-photos-upload-rls.sql
-- Kanban Photo Upload & Assignment (docs/superpowers/specs/2026-09-29-kanban-photo-upload-design.md)
--
-- line_site_photos and the line-site-photos storage bucket currently have
-- exactly one RLS policy each (SELECT, ADMIN/OWNER only) -- every row
-- today is written by the LINE webhook's service-role client, which
-- bypasses RLS entirely. This adds INSERT/UPDATE so the web app can
-- write too, mirroring the existing admin-vs-worker split phase_tasks/
-- phase_task_workers already use (my_assigned_phase_task_ids(), see
-- 2026-09-17-05-fix-phase-tasks-rls-recursion.sql) rather than a new
-- model. Does not touch the existing SELECT policies at all.
--
-- Storage vs table split (deliberate): the object path
-- (<tenant_id>/<site_id>/<timestamp>-<worker_id>.jpg) only has tenant_id
-- and site_id as real FOLDER segments -- storage.foldername() can't see
-- worker_id, it's baked into the filename. So the storage policy below
-- only gates by tenant + "is this caller allowed to upload at all"; the
-- REAL per-worker ownership and per-task-assignment checks live on the
-- table's own INSERT/UPDATE policies, which can reference those as real
-- columns.

CREATE OR REPLACE FUNCTION my_worker_id()
RETURNS UUID
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT id FROM workers WHERE email = (select auth.email()) AND tenant_id = current_tenant_id() LIMIT 1;
$$;
REVOKE EXECUTE ON FUNCTION my_worker_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_worker_id() TO authenticated;

-- ── line_site_photos: INSERT ──
CREATE POLICY admin_inserts ON line_site_photos FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

-- task_id, if set, must be one of the worker's own assigned tasks --
-- closes the loophole of attaching to an unauthorized task at INSERT
-- time instead of via the (separately restricted) UPDATE path below.
CREATE POLICY worker_inserts_own ON line_site_photos FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = current_tenant_id() AND tenant_can_write()
    AND worker_id = my_worker_id()
    AND (task_id IS NULL OR task_id IN (SELECT my_assigned_phase_task_ids()))
  );

-- ── line_site_photos: UPDATE (setting/changing task_id after upload) ──
CREATE POLICY admin_updates ON line_site_photos FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

CREATE POLICY worker_updates_own ON line_site_photos FOR UPDATE TO authenticated
  USING (tenant_id = current_tenant_id() AND worker_id = my_worker_id())
  WITH CHECK (
    tenant_id = current_tenant_id() AND tenant_can_write()
    AND worker_id = my_worker_id()
    AND (task_id IS NULL OR task_id IN (SELECT my_assigned_phase_task_ids()))
  );

-- ── storage.objects (line-site-photos bucket): INSERT ──
CREATE POLICY line_site_photos_uploads ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'line-site-photos'
    AND (storage.foldername(name))[1] = current_tenant_id()::text
    AND (is_admin_or_owner() OR my_worker_id() IS NOT NULL)
  );
