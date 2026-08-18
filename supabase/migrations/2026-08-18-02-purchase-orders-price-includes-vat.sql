-- Some suppliers quote a unit price that already includes VAT, rather than
-- the pre-VAT price 2026-08-17-05's has_vat toggle assumed. This adds a
-- second, independent per-PO flag: when true, the entered line-item prices
-- are treated as VAT-inclusive, so the grand total equals the raw item sum
-- and subtotal/VAT are backed out of it (subtotal = total / 1.07) instead
-- of VAT being added on top. Only meaningful when has_vat is true; ignored
-- (and kept false) when a PO has no VAT at all.
ALTER TABLE purchase_orders ADD COLUMN price_includes_vat BOOLEAN NOT NULL DEFAULT false;
