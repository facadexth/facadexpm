-- supabase/migrations/2026-11-05-01-alu-provider-logo.sql
-- Extruder logo: a path in the private estimation-images bucket (<tenant>/logos/<provider id>-<ts>.png),
-- signed on read like alu_profiles.image_path. No view selects alu_providers.* (checked 2026-11-05).
ALTER TABLE alu_providers ADD COLUMN IF NOT EXISTS logo_path TEXT;
