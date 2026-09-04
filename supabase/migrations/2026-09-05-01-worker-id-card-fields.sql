-- supabase/migrations/2026-09-05-01-worker-id-card-fields.sql
ALTER TABLE workers
  ADD COLUMN id_card_number TEXT,
  ADD COLUMN address TEXT,
  ADD COLUMN id_card_photo_path TEXT;

-- Path convention: {tenant_id}/{worker_id}/id-card.{ext} -- worker_id, not
-- email, since a worker record doesn't necessarily have a linked login
-- account. Private bucket + ADMIN/OWNER-only access, matching who can
-- already write the workers table itself (admin_writes_workers/
-- admin_updates_workers) -- ID card number + photo is sensitive PII, kept
-- to the same access level as the rest of a worker's payroll record, not
-- opened up to the worker's own login even if one exists.
INSERT INTO storage.buckets (id, name, public) VALUES ('worker-id-cards', 'worker-id-cards', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY worker_id_cards_admin_access ON storage.objects FOR ALL TO authenticated
  USING (
    bucket_id = 'worker-id-cards'
    AND (storage.foldername(name))[1] = current_tenant_id()::text
    AND is_admin_or_owner()
    AND has_module_access('payroll')
  )
  WITH CHECK (
    bucket_id = 'worker-id-cards'
    AND (storage.foldername(name))[1] = current_tenant_id()::text
    AND is_admin_or_owner()
    AND has_module_access('payroll')
  );
