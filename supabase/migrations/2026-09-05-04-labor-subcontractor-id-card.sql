-- supabase/migrations/2026-09-05-04-labor-subcontractor-id-card.sql
-- Needed for the withholding-tax certificate (หนังสือรับรองการหักภาษี ณ
-- ที่จ่าย, ภ.ง.ด.3) issued per labor_payments row -- the payee section
-- requires both เลขประจำตัวประชาชน and ที่อยู่, neither of which
-- labor_subcontractors previously stored.
ALTER TABLE labor_subcontractors ADD COLUMN id_card_number TEXT, ADD COLUMN address TEXT;
