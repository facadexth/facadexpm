-- supabase/migrations/2026-08-29-10-fix-cumulative-pct-precision.sql
-- Root cause of a real, recurring user-facing failure: creating an
-- invoice against โครงการศูนย์เวชศาสตร์ฯ kept failing with "แก้ไขโดย
-- ผู้ใช้อื่น" (optimistic-lock conflict) on every single retry (3 times
-- in a row, INV-2026-067/068/069), even though nothing else was touching
-- the row.
--
-- quotation_item_units.cumulative_pct was written directly by this
-- session's earlier backfill migrations (07/08/09) using raw Postgres
-- NUMERIC division (`amount_no_vat / unit_price * 100`), which computes
-- to ~20 decimal digits by default. The live app's own JS code
-- (waterfall() in invoiceCalc.js) never has this problem -- it computes
-- in float64, which naturally self-limits to ~17 significant digits, a
-- value that always round-trips exactly through JSON. But a 20-digit
-- Postgres NUMERIC does NOT fit in a float64 exactly: the browser reads
-- it, JS silently rounds it to the nearest representable float, and the
-- optimistic lock's `.eq('cumulative_pct', thatValue)` WHERE clause then
-- compares against the full-precision original -- which never matches,
-- forever, no matter how many times the user retries.
--
-- Fix: round every existing over-precise value to 9 decimal places (a
-- difference of 0.000000001% of even a 100M-baht contract is a fraction
-- of a millisatang -- utterly negligible for money, unlike the earlier
-- 2-decimal-place rounding bug this table deliberately avoids), and add
-- a trigger so no future direct-SQL write (by a migration or anything
-- else bypassing the app's own JS layer) can reintroduce this.
UPDATE quotation_item_units
SET cumulative_pct = ROUND(cumulative_pct, 9), updated_at = now()
WHERE length(split_part(cumulative_pct::text, '.', 2)) > 9;

-- The 3 stuck half-written invoices at โครงการศูนย์เวชศาสตร์ฯ never
-- actually moved the ledger (each one's own draw's prior_pct matched the
-- live cumulative_pct exactly -- confirmed before voiding), so voiding
-- them is a pure status flip with no ledger side effect.
UPDATE invoices SET status = 'void'
WHERE invoice_number IN ('INV-2026-067', 'INV-2026-068', 'INV-2026-069') AND status = 'unpaid';

CREATE OR REPLACE FUNCTION round_quotation_item_units_cumulative_pct()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.cumulative_pct := ROUND(NEW.cumulative_pct, 9);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_round_cumulative_pct
  BEFORE INSERT OR UPDATE ON quotation_item_units
  FOR EACH ROW
  EXECUTE FUNCTION round_quotation_item_units_cumulative_pct();
