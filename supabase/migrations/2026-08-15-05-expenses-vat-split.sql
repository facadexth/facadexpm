-- Split expenses.amount into amount_no_vat + vat, mirroring the pattern
-- incomes already uses. `amount` stays the VAT-inclusive total (unchanged
-- meaning, existing rows keep working); the two new columns are nullable
-- so existing rows and the manual ExpenseForm (unchanged) aren't affected
-- — only the new Excel import path populates them.
ALTER TABLE expenses ADD COLUMN amount_no_vat NUMERIC;
ALTER TABLE expenses ADD COLUMN vat NUMERIC;
