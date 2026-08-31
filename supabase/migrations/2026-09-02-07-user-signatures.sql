-- supabase/migrations/2026-09-02-07-user-signatures.sql
-- Personal saved signature -- draw once in Settings, reused automatically
-- wherever a document already has a blank staff-side signature line
-- (QuotationPaper's "ผู้เสนอราคา", DocumentPaper's signatures[0] slot used
-- by both invoice/receipt, WorkPhotosDocumentModal's "ผู้จัดทำ") showing
-- whoever is CURRENTLY viewing/printing the document -- not tied to a
-- specific document instance, same convenience model as a scanned
-- signature stamp. Deliberately available to every role (not gated by
-- is_admin_or_owner() like document_receipts/cheque signing is) -- this is
-- each person's own signature, not an admin action on someone else's
-- document.
CREATE TABLE user_signatures (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  user_email      TEXT NOT NULL,
  signature_path  TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_email)
);

ALTER TABLE user_signatures ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_signature_access ON user_signatures FOR ALL TO authenticated
  USING (tenant_id = current_tenant_id() AND user_email = auth.email())
  WITH CHECK (tenant_id = current_tenant_id() AND user_email = auth.email());

INSERT INTO storage.buckets (id, name, public) VALUES ('user-signatures', 'user-signatures', false)
ON CONFLICT (id) DO NOTHING;

-- Path convention: {tenant_id}/{user_email}/signature.png -- email must be
-- its own folder segment (not baked into the filename) or
-- storage.foldername() has nothing at index 2 to compare against auth.email()
-- with. RLS checks that second segment directly (no join needed, unlike
-- document-receipts which checks is_admin_or_owner() instead of identity).
CREATE POLICY user_signatures_own_access ON storage.objects FOR ALL TO authenticated
  USING (
    bucket_id = 'user-signatures'
    AND (storage.foldername(name))[1] = current_tenant_id()::text
    AND (storage.foldername(name))[2] = auth.email()
  )
  WITH CHECK (
    bucket_id = 'user-signatures'
    AND (storage.foldername(name))[1] = current_tenant_id()::text
    AND (storage.foldername(name))[2] = auth.email()
  );
