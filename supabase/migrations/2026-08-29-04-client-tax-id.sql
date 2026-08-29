-- supabase/migrations/2026-08-29-04-client-tax-id.sql
-- clients had no tax ID column at all -- a real gap for a legally-complete
-- ใบกำกับภาษี (tax invoice), flagged during the invoice-document redesign
-- but deferred until now. Nullable: most existing clients won't have one
-- entered yet.
ALTER TABLE clients ADD COLUMN tax_id TEXT;
