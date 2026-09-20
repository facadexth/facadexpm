-- Two new crew actions (เช็คอิน/เช็คเอาท์ + รูปภาพหน้างาน), added to the
-- LINE crew Rich Menu alongside the original three. Both resolve "which
-- site" from the worker's own worker_assignments row for today (user's
-- explicit choice -- no extra prompt asking which site).
--
-- line_site_photos is deliberately its own table, NOT invoice_photos --
-- invoice_photos is scoped to an already-existing invoice_id (see
-- supabase/migrations/2026-09-02-04-invoice-photos.sql), but a photo
-- taken on site via LINE has no invoice yet. This table is the
-- site+date-scoped pool; office staff later pick from it when building
-- an invoice's own photo set (a future UI addition, out of scope here).

CREATE TABLE line_checkins (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id      UUID NOT NULL,
  worker_id      UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  site_id        UUID REFERENCES sites(id),
  date           DATE NOT NULL,
  check_in_at    TIMESTAMPTZ,
  check_out_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_line_checkins_worker_date ON line_checkins(worker_id, date);

ALTER TABLE line_checkins ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_reads ON line_checkins FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id());
-- No client write policy -- only ever written by line-webhook via its
-- service-role client, same as line_issue_reports.

CREATE TABLE line_site_photos (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id    UUID NOT NULL,
  worker_id    UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  site_id      UUID REFERENCES sites(id),
  date         DATE NOT NULL,
  photo_path   TEXT NOT NULL,
  description  TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_line_site_photos_site_date ON line_site_photos(site_id, date);

ALTER TABLE line_site_photos ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_reads ON line_site_photos FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id());

-- Storage bucket for LINE-captured site photos -- private, same pattern
-- as the existing invoice-photos bucket (signed URLs for display, not
-- public). Path convention: ${tenant_id}/${site_id}/${timestamp}-${worker_id}.jpg
INSERT INTO storage.buckets (id, name, public)
VALUES ('line-site-photos', 'line-site-photos', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY line_site_photos_tenant_access ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'line-site-photos' AND (storage.foldername(name))[1] = current_tenant_id()::text AND is_admin_or_owner());
