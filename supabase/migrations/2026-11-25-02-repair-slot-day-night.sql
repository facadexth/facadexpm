-- supabase/migrations/2026-11-25-02-repair-slot-day-night.sql
-- Owner 2026-11-25: the repair form's preferred time is กลางวัน (day) / กลางคืน (night); ทั้งวัน is gone.
-- Rows from 1.40.0 (morning / afternoon / all_day, 2 test tickets on 2026-11-25) all become 'day'.
BEGIN;
ALTER TABLE public.repair_tickets DROP CONSTRAINT repair_tickets_preferred_slot_check;
UPDATE public.repair_tickets SET preferred_slot = 'day' WHERE preferred_slot IN ('morning', 'afternoon', 'all_day');
ALTER TABLE public.repair_tickets ADD CONSTRAINT repair_tickets_preferred_slot_check
  CHECK (preferred_slot IN ('day', 'night'));
COMMIT;
