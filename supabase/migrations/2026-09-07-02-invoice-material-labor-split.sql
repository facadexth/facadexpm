-- Carries a split-pricing quotation's material/labor unit prices forward
-- onto each invoice's progress-billing draw, so ใบแจ้งหนี้/ใบเสร็จ/
-- ใบกำกับภาษี (which all render from invoice_items via the same
-- DocumentPaper) can show the same "ค่าของ / ค่าแรง" breakdown as the
-- source quotation. Null on every existing/combined-pricing invoice item --
-- unit_price/line_total remain the canonical total either way, so nothing
-- else downstream needs to change.
ALTER TABLE invoice_items ADD COLUMN unit_price_material NUMERIC;
ALTER TABLE invoice_items ADD COLUMN unit_price_labor NUMERIC;
