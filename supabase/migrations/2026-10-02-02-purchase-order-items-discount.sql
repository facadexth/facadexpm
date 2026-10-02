-- PO document-scan reader was misreading documents with a per-item
-- discount column (only SOME line items discounted) -- the extraction
-- schema and purchase_order_items had no discount field at all, forcing
-- the model to silently fold any discount it saw into unit_price with
-- nowhere to record which rows it applied to. Adding a real column gives
-- the model (and the human reviewing its output) a structured place to
-- see and correct per-item discounts.
ALTER TABLE purchase_order_items ADD COLUMN discount_pct NUMERIC NOT NULL DEFAULT 0;
