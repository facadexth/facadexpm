-- Fix generate_site_number(): COUNT(*)-based numbering breaks after any site
-- deletion leaves a gap in the sequence, causing duplicate site_number
-- collisions on the next insert (e.g. FX-2026-006 deleted -> COUNT(*)+1
-- regenerates an already-used number). Switch to MAX(existing numeric
-- suffix)+1 instead, which is immune to gaps from past deletions.
CREATE OR REPLACE FUNCTION generate_site_number()
RETURNS TRIGGER AS $$
DECLARE
  year_part TEXT := TO_CHAR(NOW(), 'YYYY');
  seq_num   INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(site_number FROM 'FX-\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM sites
  WHERE site_number LIKE 'FX-' || year_part || '-%';
  NEW.site_number := 'FX-' || year_part || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
