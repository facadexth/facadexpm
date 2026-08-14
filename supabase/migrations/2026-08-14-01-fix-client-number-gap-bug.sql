-- Fix generate_client_number(): same gap bug already fixed for
-- generate_site_number() in 2026-07-10-01-fix-site-number-gap-bug.sql.
-- COUNT(*)-based numbering breaks after any client deletion leaves a gap
-- in the sequence, causing duplicate client_number collisions on the next
-- insert (e.g. CL-2026-090 deleted -> COUNT(*)+1 regenerates an
-- already-used number, since COUNT(*) still counts the remaining
-- CL-2026-091 row). Switch to MAX(existing numeric suffix)+1 instead,
-- which is immune to gaps from past deletions.
CREATE OR REPLACE FUNCTION generate_client_number()
RETURNS TRIGGER AS $$
DECLARE
  year_part TEXT := TO_CHAR(NOW(), 'YYYY');
  seq_num   INT;
BEGIN
  SELECT COALESCE(MAX(SUBSTRING(client_number FROM 'CL-\d{4}-(\d+)$')::INT), 0) + 1
  INTO seq_num
  FROM clients
  WHERE client_number LIKE 'CL-' || year_part || '-%';
  NEW.client_number := 'CL-' || year_part || '-' || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
