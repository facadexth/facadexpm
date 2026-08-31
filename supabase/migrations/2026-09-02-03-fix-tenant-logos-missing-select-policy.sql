-- supabase/migrations/2026-09-02-03-fix-tenant-logos-missing-select-policy.sql
-- Real bug: uploading a company logo always failed with "new row violates
-- row-level security policy", even for the tenant's actual OWNER. Root
-- cause -- tenant-logos' storage.objects policies were split into separate
-- INSERT/UPDATE/DELETE policies (tenant_logos_owner_insert/update/delete)
-- with NO SELECT policy at all. Supabase's Storage API always issues
-- `INSERT ... ON CONFLICT DO UPDATE ... RETURNING *` -- the INSERT/UPDATE
-- itself was satisfied by WITH CHECK just fine, but the RETURNING clause
-- needs to read the row back, which requires a SELECT policy match. With
-- none, Postgres blocks the RETURNING and the client sees an RLS error,
-- even though the write would otherwise have gone through (confirmed live:
-- the same INSERT with no RETURNING clause succeeds silently).
--
-- Every other bucket in this app (document-receipts, site-attachments,
-- po-attachments) uses one FOR ALL policy, which implicitly covers SELECT
-- too -- that's why only this bucket, added separately, had the gap.
-- Fixed by collapsing to the same FOR ALL shape.
DROP POLICY IF EXISTS tenant_logos_owner_insert ON storage.objects;
DROP POLICY IF EXISTS tenant_logos_owner_update ON storage.objects;
DROP POLICY IF EXISTS tenant_logos_owner_delete ON storage.objects;

CREATE POLICY tenant_logos_owner_access ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'tenant-logos' AND is_owner() AND (storage.foldername(name))[1] = current_tenant_id()::text)
  WITH CHECK (bucket_id = 'tenant-logos' AND is_owner() AND (storage.foldername(name))[1] = current_tenant_id()::text);
