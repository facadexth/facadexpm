-- Delivery report (Plan B task 4 fix round 1): office/PM accounts with no linked worker can
-- upload a photo onto a card from the DR card picker. Those rows carry worker_id NULL; the UI
-- labels them "สำนักงาน". LINE webhook rows still always set worker_id.
ALTER TABLE public.line_site_photos ALTER COLUMN worker_id DROP NOT NULL;
