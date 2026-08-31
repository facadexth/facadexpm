-- supabase/migrations/2026-09-02-04-invoice-photos.sql
-- Work-completion photos attached to an invoice, printed as their own
-- document ("รูปประกอบการส่งงาน") -- a photo + short description per
-- item, 6 to an A4 page. Separate from AttachmentsSection's generic
-- reference-only file attachments (quotations/sites) because each photo
-- here carries its own caption and print order, not just a filename.
--
-- Single FOR ALL policy on both the table and the storage bucket (not
-- split into per-command policies) -- see
-- 2026-09-02-03-fix-tenant-logos-missing-select-policy.sql for exactly
-- why a split INSERT/UPDATE/DELETE-only policy set silently breaks any
-- upload that relies on Supabase Storage's INSERT ... RETURNING *.
CREATE TABLE invoice_photos (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  invoice_id    UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  photo_path    TEXT NOT NULL,
  description   TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_invoice_photos_invoice_id ON invoice_photos(invoice_id);
CREATE INDEX idx_invoice_photos_tenant_id ON invoice_photos(tenant_id);

ALTER TABLE invoice_photos ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON invoice_photos FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id());

INSERT INTO storage.buckets (id, name, public) VALUES ('invoice-photos', 'invoice-photos', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY invoice_photos_tenant_access ON storage.objects FOR ALL TO authenticated
  USING (
    bucket_id = 'invoice-photos'
    AND is_admin_or_owner()
    AND (storage.foldername(name))[1] = current_tenant_id()::text
  )
  WITH CHECK (
    bucket_id = 'invoice-photos'
    AND is_admin_or_owner()
    AND (storage.foldername(name))[1] = current_tenant_id()::text
  );
