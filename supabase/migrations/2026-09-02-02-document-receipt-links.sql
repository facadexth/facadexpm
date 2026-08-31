-- supabase/migrations/2026-09-02-02-document-receipt-links.sql
-- Remote signing: a secure, unguessable link (/sign/<id>) that lets someone
-- sign for a document (cheque, etc.) on their OWN device without an
-- account or physical handoff -- staff generates the link in-app and sends
-- it themselves through whatever channel they already use (LINE, SMS,
-- email). The public page never talks to the DB directly with the anon
-- key; it goes through the sign-link Edge Function (service role), which
-- is the only thing allowed to validate a link and write the signature.
-- No RLS policy here ever grants anon access -- this table is
-- authenticated-only (staff create/view their own links); the Edge
-- Function bypasses RLS entirely via the service role.
CREATE TABLE document_receipt_links (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  document_type   TEXT NOT NULL CHECK (document_type IN ('cheque')),
  document_id     UUID NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  signed_at       TIMESTAMPTZ,
  receipt_id      UUID REFERENCES document_receipts(id)
);

CREATE INDEX idx_document_receipt_links_document ON document_receipt_links(tenant_id, document_type, document_id);

ALTER TABLE document_receipt_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON document_receipt_links FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id());
