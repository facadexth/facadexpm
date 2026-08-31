-- supabase/migrations/2026-09-02-08-document-prints.sql
-- Print/download tracking -- every PDF/JPG export of a quotation, invoice,
-- or receipt logs one row here. The document's own "ต้นฉบับ" (original)
-- badge is derived from the row count at render time (see
-- printTagFor() in lib/pdf.js): the first export shows "ต้นฉบับ",
-- every export after that shows "สำเนาที่ N" instead -- so a document
-- can't be reprinted multiple times all claiming to be the one original,
-- and there's an audit trail (who, when) if a copy count is ever
-- questioned. Deliberately generic over document_type/document_id, same
-- pattern as document_receipts.
CREATE TABLE document_prints (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  document_type TEXT NOT NULL CHECK (document_type IN ('quotation', 'invoice', 'receipt')),
  document_id   UUID NOT NULL,
  format        TEXT NOT NULL CHECK (format IN ('pdf', 'jpg')),
  printed_by    TEXT NOT NULL,
  printed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_document_prints_document ON document_prints(tenant_id, document_type, document_id);

ALTER TABLE document_prints ENABLE ROW LEVEL SECURITY;
-- Any tenant member can log/view prints (not gated to ADMIN/OWNER like
-- document_receipts) -- printing a document isn't an admin-only action on
-- these pages (canEdit gates editing, not viewing/downloading).
CREATE POLICY tenant_access ON document_prints FOR ALL TO authenticated
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
