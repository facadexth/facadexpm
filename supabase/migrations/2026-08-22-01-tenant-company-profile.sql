-- Company profile for client-facing document letterheads (Quotation now,
-- Invoice later — see docs/superpowers/specs/2026-08-22-quotation-module-design.md).
-- Nothing beyond company_name exists on tenants today. All nullable —
-- existing tenants (including FacadeX's own bootstrap tenant) simply have
-- an incomplete letterhead until an OWNER fills these in via Settings.
-- Covered by tenants' EXISTING RLS (member_reads_own_tenant /
-- owner_updates_own_tenant) — no new policy needed for plain columns.
ALTER TABLE tenants
  ADD COLUMN address           TEXT,
  ADD COLUMN tax_id            TEXT,
  ADD COLUMN phone             TEXT,
  ADD COLUMN logo_url          TEXT,
  ADD COLUMN bank_name         TEXT,
  ADD COLUMN bank_account_name TEXT,
  ADD COLUMN bank_account_no   TEXT;

-- Logo bucket: PUBLIC (unlike po-attachments/site-attachments, which are
-- private) — a company logo isn't sensitive, it's meant to be shown to
-- clients on the PDF, and html2canvas needs to load it directly in the
-- browser without a signed-URL round trip. Public buckets serve reads
-- without going through storage.objects RLS at all, so only
-- INSERT/UPDATE/DELETE need policies here.
INSERT INTO storage.buckets (id, name, public) VALUES ('tenant-logos', 'tenant-logos', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY tenant_logos_owner_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'tenant-logos'
    AND is_owner()
    AND (storage.foldername(name))[1] = current_tenant_id()::text
  );

CREATE POLICY tenant_logos_owner_update ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'tenant-logos'
    AND is_owner()
    AND (storage.foldername(name))[1] = current_tenant_id()::text
  )
  WITH CHECK (
    bucket_id = 'tenant-logos'
    AND is_owner()
    AND (storage.foldername(name))[1] = current_tenant_id()::text
  );

CREATE POLICY tenant_logos_owner_delete ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'tenant-logos'
    AND is_owner()
    AND (storage.foldername(name))[1] = current_tenant_id()::text
  );
