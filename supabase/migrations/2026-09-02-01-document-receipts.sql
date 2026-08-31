-- supabase/migrations/2026-09-02-01-document-receipts.sql
-- General-purpose "document receipt" system: capture a signature (drawn on
-- a tablet/mobile/laptop handed to the other party) as proof a document was
-- physically received. Built generically (document_type + document_id, no
-- rigid FK to a single table) since it's meant to be reused for other
-- document types later (delivery notes, invoices) -- v1 only wires up
-- cheques, since that's the only real use case today.
--
-- Cheques gets a third status: issued -> received (signed for) -> cashed.
-- Signing is optional and never gates cashing -- an issued cheque can be
-- marked cashed directly if nobody signed for it, same as before this
-- feature existed.
CREATE TABLE document_receipts (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  document_type   TEXT NOT NULL CHECK (document_type IN ('cheque')),
  document_id     UUID NOT NULL,
  signer_name     TEXT NOT NULL,
  signer_note     TEXT,
  signature_path  TEXT NOT NULL,
  signed_by       TEXT NOT NULL,
  signed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_document_receipts_document ON document_receipts(tenant_id, document_type, document_id);

ALTER TABLE document_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON document_receipts FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id());

INSERT INTO storage.buckets (id, name, public) VALUES ('document-receipts', 'document-receipts', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY document_receipts_tenant_access ON storage.objects FOR ALL TO authenticated
  USING (
    bucket_id = 'document-receipts'
    AND is_admin_or_owner()
    AND (storage.foldername(name))[1] = current_tenant_id()::text
  )
  WITH CHECK (
    bucket_id = 'document-receipts'
    AND is_admin_or_owner()
    AND (storage.foldername(name))[1] = current_tenant_id()::text
  );

ALTER TABLE cheques DROP CONSTRAINT cheques_status_check;
ALTER TABLE cheques ADD CONSTRAINT cheques_status_check CHECK (status IN ('issued', 'received', 'cashed'));
