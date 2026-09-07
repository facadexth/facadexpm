-- Lets a quotation optionally price each line as material + labor
-- separately instead of one combined unit_price, per tenant request.
-- Default 'combined' preserves today's behavior for every existing
-- quotation. unit_price/line_total stay the canonical total either way --
-- downstream consumers (accept-into-invoice, revision snapshots,
-- quotation_item_units progress-billing ledger) never need to change.
ALTER TABLE quotations ADD COLUMN pricing_mode TEXT NOT NULL DEFAULT 'combined'
  CHECK (pricing_mode IN ('combined', 'split'));

ALTER TABLE quotation_items ADD COLUMN unit_price_material NUMERIC;
ALTER TABLE quotation_items ADD COLUMN unit_price_labor NUMERIC;
