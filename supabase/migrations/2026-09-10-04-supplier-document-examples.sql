-- supabase/migrations/2026-09-10-04-supplier-document-examples.sql
--
-- Calibration examples for the PO document-scan extraction feature (see
-- docs/superpowers/specs/2026-09-10-po-document-scan-extraction-design.md).
-- A "few-shot calibration" example: a verified-correct (document image,
-- extracted line items) pair for one supplier, used to prime future
-- extraction calls for that same supplier. Capped at 3 per supplier by
-- the application layer (saveSupplierDocumentExample in useSupabase.js),
-- not by a DB constraint.
CREATE TABLE supplier_document_examples (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  supplier_id   UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  file_path     TEXT NOT NULL,
  extracted     JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_supplier_document_examples_supplier_id ON supplier_document_examples(supplier_id);
CREATE INDEX idx_supplier_document_examples_tenant_id ON supplier_document_examples(tenant_id);

ALTER TABLE supplier_document_examples ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON supplier_document_examples FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));

INSERT INTO storage.buckets (id, name, public) VALUES ('supplier-doc-examples', 'supplier-doc-examples', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY supplier_doc_examples_tenant_access ON storage.objects FOR ALL TO authenticated
  USING (
    bucket_id = 'supplier-doc-examples'
    AND is_admin_or_owner()
    AND (storage.foldername(name))[1] = current_tenant_id()::text
    AND has_module_access('purchase_orders')
  )
  WITH CHECK (
    bucket_id = 'supplier-doc-examples'
    AND is_admin_or_owner()
    AND (storage.foldername(name))[1] = current_tenant_id()::text
    AND has_module_access('purchase_orders')
  );
