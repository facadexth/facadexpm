-- Reference-only file attachments for a site (contracts, drawings, permit
-- photos) — same pattern as 2026-08-17-06-purchase-order-attachments.sql:
-- private per-entity bucket, tenant-prefixed storage path, bucket RLS
-- independent of the table's own RLS. Unlike PO attachments, sites is a
-- core (non-gated) feature, so no has_module_access() check here.

CREATE TABLE site_attachments (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  site_id     UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  file_path   TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_site_attachments_site_id ON site_attachments(site_id);
CREATE INDEX idx_site_attachments_tenant_id ON site_attachments(tenant_id);

ALTER TABLE site_attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON site_attachments FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id());

INSERT INTO storage.buckets (id, name, public) VALUES ('site-attachments', 'site-attachments', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY site_attachments_tenant_access ON storage.objects FOR ALL TO authenticated
  USING (
    bucket_id = 'site-attachments'
    AND is_admin_or_owner()
    AND (storage.foldername(name))[1] = current_tenant_id()::text
  )
  WITH CHECK (
    bucket_id = 'site-attachments'
    AND is_admin_or_owner()
    AND (storage.foldername(name))[1] = current_tenant_id()::text
  );
