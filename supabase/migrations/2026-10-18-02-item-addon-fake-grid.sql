-- Fake dividers (ซอยหลอก) on an item's inline add-ons: per glass pane, fake_rows x fake_cols decorative bars drawn at half
-- the frame width (owner 2026-10-15). Drawing only — no BOM piece yet. Additive, re-runnable; needs 2026-10-18-01.
-- No view selects estimation_item_addons.* (grepped supabase/migrations and supabase/schema.sql). Nothing to recreate.
ALTER TABLE estimation_item_addons ADD COLUMN IF NOT EXISTS fake_rows INT NOT NULL DEFAULT 1;
ALTER TABLE estimation_item_addons ADD COLUMN IF NOT EXISTS fake_cols INT NOT NULL DEFAULT 1;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'estimation_item_addons_fake_rows_check') THEN
    ALTER TABLE estimation_item_addons ADD CONSTRAINT estimation_item_addons_fake_rows_check CHECK (fake_rows BETWEEN 1 AND 12);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'estimation_item_addons_fake_cols_check') THEN
    ALTER TABLE estimation_item_addons ADD CONSTRAINT estimation_item_addons_fake_cols_check CHECK (fake_cols BETWEEN 1 AND 12);
  END IF;
END $$;
