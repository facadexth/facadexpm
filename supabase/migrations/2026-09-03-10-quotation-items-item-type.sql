-- supabase/migrations/2026-09-03-10-quotation-items-item-type.sql
-- Lets a quotation_items row be a free-text "additional info" line
-- instead of a priced item -- e.g. a note/description sitting under a
-- specific item, or a section separator. Note rows keep quantity=0,
-- unit_price=0 (already the column defaults), so line_total stays 0
-- and calcQuotationTotals() needs no change at all.
ALTER TABLE quotation_items ADD COLUMN item_type TEXT NOT NULL DEFAULT 'item' CHECK (item_type IN ('item','note'));
