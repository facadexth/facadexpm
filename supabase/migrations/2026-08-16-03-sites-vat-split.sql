-- Adds a VAT/no-VAT distinction to site contract values. Previously
-- contract_value was a single number the user typed directly, implicitly
-- assumed to already include VAT (per its old form placeholder). Now the
-- user enters the pre-VAT base (contract_value_no_vat) plus a มี VAT/ไม่มี
-- VAT toggle (has_vat), and contract_value is computed as the VAT-inclusive
-- total (has_vat ? no_vat * 1.07 : no_vat) — contract_value itself keeps
-- its existing meaning and is still what billing_pct divides against.
ALTER TABLE sites ADD COLUMN has_vat BOOLEAN DEFAULT true;
ALTER TABLE sites ADD COLUMN contract_value_no_vat NUMERIC;

-- Backfill: derive the pre-VAT base for existing rows from the assumption
-- their contract_value was always VAT-inclusive.
UPDATE sites SET contract_value_no_vat = ROUND(contract_value / 1.07, 2)
WHERE contract_value IS NOT NULL;
