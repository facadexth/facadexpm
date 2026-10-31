-- Dry run for 2026-10-23-02 (controller only). Always rolls back via the final RAISE.
BEGIN;
ALTER TABLE public.line_site_photos ALTER COLUMN worker_id DROP NOT NULL;
DO $z$
DECLARE
  s record;
  new_id uuid := gen_random_uuid();
  nullable text;
  got int;
BEGIN
  SELECT id, tenant_id INTO s FROM public.sites ORDER BY created_at LIMIT 1;
  INSERT INTO public.line_site_photos (id, tenant_id, worker_id, site_id, date, photo_path, task_id)
  VALUES (new_id, s.tenant_id, NULL, s.id, (now() AT TIME ZONE 'Asia/Bangkok')::date,
          s.tenant_id || '/' || s.id || '/dryrun-office.jpg', NULL);
  SELECT count(*) INTO got FROM public.line_site_photos WHERE id = new_id AND worker_id IS NULL;
  SELECT is_nullable INTO nullable FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'line_site_photos' AND column_name = 'worker_id';
  RAISE EXCEPTION 'RESULTS: worker_id is_nullable=% (expect YES) | null-worker row inserted=% (expect 1)', nullable, got;
END
$z$;
ROLLBACK;
