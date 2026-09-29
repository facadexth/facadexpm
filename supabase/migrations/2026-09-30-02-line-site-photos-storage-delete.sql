-- supabase/migrations/2026-09-30-02-line-site-photos-storage-delete.sql
-- Final-review fix (Kanban Photo Upload & Assignment plan): the INSERT-only
-- storage policy added in 2026-09-30-01 left uploadSitePhoto's own orphan
-- cleanup (storage.remove() on a failed DB insert) silently unable to
-- delete anything for any real (non-service-role) caller -- the plan's own
-- "no orphaned files" constraint was unimplementable. Every other bucket in
-- this project (site-attachments, po-attachments, invoice-photos, ...) uses
-- a single FOR ALL policy; splitting line-site-photos into SELECT+INSERT
-- only is what let this slip through. Adding DELETE closes the gap, using
-- the same tenant + admin-or-linked-worker gate as the existing INSERT
-- policy. Also adds tenant_can_write() to the INSERT policy, which was
-- missing there (a lapsed-trial tenant could previously upload to storage,
-- fail at the table's WITH CHECK, and be unable to clean up -- permanent
-- orphan on every such attempt).

DROP POLICY line_site_photos_uploads ON storage.objects;

CREATE POLICY line_site_photos_uploads ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'line-site-photos'
    AND (storage.foldername(name))[1] = current_tenant_id()::text
    AND (is_admin_or_owner() OR my_worker_id() IS NOT NULL)
    AND tenant_can_write()
  );

CREATE POLICY line_site_photos_deletes ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'line-site-photos'
    AND (storage.foldername(name))[1] = current_tenant_id()::text
    AND (is_admin_or_owner() OR my_worker_id() IS NOT NULL)
  );
