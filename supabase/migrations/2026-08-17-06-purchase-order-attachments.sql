-- supabase/migrations/2026-08-17-06-purchase-order-attachments.sql
-- Reference-only file attachments for a PO (supplier quotations, product
-- photos) — never parsed, just stored for viewing/downloading. First use
-- of Supabase Storage in this app: files live in a private bucket under
-- a tenant-prefixed path so bucket RLS can enforce isolation
-- independently of the attachments table's own RLS.

CREATE TABLE purchase_order_attachments (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  po_id       UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  file_path   TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_po_attachments_po_id ON purchase_order_attachments(po_id);
CREATE INDEX idx_po_attachments_tenant_id ON purchase_order_attachments(tenant_id);

ALTER TABLE purchase_order_attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON purchase_order_attachments FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));

INSERT INTO storage.buckets (id, name, public) VALUES ('po-attachments', 'po-attachments', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY po_attachments_tenant_access ON storage.objects FOR ALL TO authenticated
  USING (
    bucket_id = 'po-attachments'
    AND is_admin_or_owner()
    AND (storage.foldername(name))[1] = current_tenant_id()::text
    AND has_module_access('purchase_orders')
  )
  WITH CHECK (
    bucket_id = 'po-attachments'
    AND is_admin_or_owner()
    AND (storage.foldername(name))[1] = current_tenant_id()::text
    AND has_module_access('purchase_orders')
  );
