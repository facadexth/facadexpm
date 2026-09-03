-- supabase/migrations/2026-09-03-11-quotation-item-description-and-ever-sent.sql
-- Two independent refinements requested together:
--
-- 1. quotation_items.item_type gains 'item_description' alongside the
--    existing 'item'/'note'. A note-type row attached to a specific item
--    (e.g. the catalog picker's auto-added description line) is now
--    distinguishable from a standalone/section note -- by position (it
--    always sits immediately after the item it describes, since that's
--    the only way either the UI or the catalog picker ever creates one),
--    not a new FK -- keeping the save path a single insert, not a
--    two-pass id-resolution dance. Both render identically on the
--    printed document (a merged, italic row); the distinction is for
--    future systems (e.g. an estimate tool) to query cleanly.
--
-- 2. quotations.ever_sent tracks whether a quotation has EVER been sent,
--    independent of its current status (pulling a sent quotation back to
--    'draft' for editing does not clear this). Editing a quotation that
--    has never been sent is just normal draft iteration -- no revision
--    snapshot, no revision-counter bump. Editing one that has been sent
--    at least once (whether it's currently 'sent' again after a pull-back,
--    or already 'accepted'/'rejected'/'expired') is a real revision.
--    Backfilled true for every quotation already past 'draft' today.
ALTER TABLE quotation_items DROP CONSTRAINT quotation_items_item_type_check;
ALTER TABLE quotation_items ADD CONSTRAINT quotation_items_item_type_check CHECK (item_type IN ('item','note','item_description'));
ALTER TABLE quotations ADD COLUMN ever_sent BOOLEAN NOT NULL DEFAULT false;
UPDATE quotations SET ever_sent = true WHERE status IN ('sent','accepted','rejected','expired');
