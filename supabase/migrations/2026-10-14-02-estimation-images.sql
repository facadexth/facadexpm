-- Phase 3: pictures for catalog entries (private bucket, tenant-folder scoped, estimation module only).
ALTER TABLE alu_profiles  ADD COLUMN image_path TEXT;
ALTER TABLE infill_types  ADD COLUMN image_path TEXT;
ALTER TABLE alu_parts     ADD COLUMN image_path TEXT;
ALTER TABLE alu_finishes  ADD COLUMN image_path TEXT;

INSERT INTO storage.buckets (id, name, public) VALUES ('estimation-images', 'estimation-images', false)
ON CONFLICT (id) DO NOTHING;
CREATE POLICY estimation_images_tenant_access ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'estimation-images' AND is_admin_or_owner() AND has_module_access('estimation')
         AND (storage.foldername(name))[1] = current_tenant_id()::text)
  WITH CHECK (bucket_id = 'estimation-images' AND is_admin_or_owner() AND has_module_access('estimation')
         AND (storage.foldername(name))[1] = current_tenant_id()::text);
