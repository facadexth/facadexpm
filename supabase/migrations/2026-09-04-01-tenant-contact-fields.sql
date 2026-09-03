-- 2026-09-04-01-tenant-contact-fields.sql
-- Company email/website for the new document-header contact line (spec:
-- docs/superpowers/specs/2026-09-04-document-header-pagination-design.md).
-- Same nullable-column pattern as address/tax_id/phone from
-- 2026-08-22-01-tenant-company-profile.sql.
ALTER TABLE tenants
  ADD COLUMN email   TEXT,
  ADD COLUMN website TEXT;
