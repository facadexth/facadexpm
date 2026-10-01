-- Recreate Tokyo's 9 storage buckets on CHANG.
-- All buckets have file_size_limit = NULL and allowed_mime_types = NULL
-- (no restrictions configured on any bucket, verified against Tokyo).
-- Only tenant-logos is public.
INSERT INTO storage.buckets (id, name, public) VALUES
  ('document-receipts', 'document-receipts', false),
  ('invoice-photos', 'invoice-photos', false),
  ('line-site-photos', 'line-site-photos', false),
  ('po-attachments', 'po-attachments', false),
  ('site-attachments', 'site-attachments', false),
  ('supplier-doc-examples', 'supplier-doc-examples', false),
  ('tenant-logos', 'tenant-logos', true),
  ('user-signatures', 'user-signatures', false),
  ('worker-id-cards', 'worker-id-cards', false)
ON CONFLICT (id) DO NOTHING;
