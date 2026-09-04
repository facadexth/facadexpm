-- 2026-09-04-02-tenant-document-style.sql
-- Per-tenant document header style overrides (spec:
-- docs/superpowers/specs/2026-09-04-document-style-customizer-design.md).
-- NULL means "use DEFAULT_DOCUMENT_STYLE" (src/lib/documentStyle.js) --
-- no backfill needed, every existing tenant is unaffected until an OWNER
-- opens the new Settings customizer and saves.
ALTER TABLE tenants
  ADD COLUMN document_style JSONB;
