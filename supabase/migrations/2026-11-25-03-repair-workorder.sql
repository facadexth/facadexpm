-- 2026-11-25-03: repair work order (ใบงานซ่อม, CRM phase 2a) — schema only.
-- 1) line_deep_link_tokens: new action_type 'repair_workorder' (a crew member's link to one ticket's
--    work order) and repair_ticket_id (which ticket). A CHECK ties them: the ticket id is set exactly when
--    action_type = 'repair_workorder', so no other token kind carries a ticket and a work-order token
--    always does. All 7 live action types are kept (live constraint name line_deep_link_tokens_action_type_check,
--    last redefined in 2026-10-21-02-assembly-checkin.sql).
--    site_id / checkin_location_id (2026-10-20-03, 2026-10-21-01) have no CHECK tying them to action_type,
--    so nothing here conflicts with them.
-- 2) document_receipts / document_receipt_links: document_type gains 'repair_ticket' (the customer signs
--    the work order). Constraint names as in 2026-10-23-01-delivery-reports.sql.
-- DROP CONSTRAINT has no IF EXISTS on purpose: a missing name means live drifted from this file — stop.
-- No view selects line_deep_link_tokens.* (grep of supabase/migrations 2026-11-25), so no view to recreate.

BEGIN;

-- ---------------------------------------------------------------- line_deep_link_tokens
ALTER TABLE public.line_deep_link_tokens
  ADD COLUMN repair_ticket_id uuid NULL REFERENCES public.repair_tickets(id) ON DELETE CASCADE;

CREATE INDEX line_deep_link_tokens_repair_ticket ON public.line_deep_link_tokens (repair_ticket_id)
  WHERE repair_ticket_id IS NOT NULL;

ALTER TABLE public.line_deep_link_tokens DROP CONSTRAINT line_deep_link_tokens_action_type_check;
ALTER TABLE public.line_deep_link_tokens ADD CONSTRAINT line_deep_link_tokens_action_type_check
  CHECK (action_type = ANY (ARRAY['material_request','leave','check_in','check_out','advance','payslip','time_clock',
                                  'repair_workorder']));

ALTER TABLE public.line_deep_link_tokens ADD CONSTRAINT line_deep_link_tokens_repair_ticket_check
  CHECK ((action_type = 'repair_workorder') = (repair_ticket_id IS NOT NULL));

-- Service role only (field-form / repair-workorder edge functions); anon never reads tokens.
REVOKE ALL ON public.line_deep_link_tokens FROM PUBLIC, anon;

-- ---------------------------------------------------------------- document_type CHECKs
ALTER TABLE public.document_receipts DROP CONSTRAINT document_receipts_document_type_check;
ALTER TABLE public.document_receipts ADD CONSTRAINT document_receipts_document_type_check
  CHECK (document_type IN ('cheque', 'quotation', 'invoice', 'delivery_report', 'repair_ticket'));

ALTER TABLE public.document_receipt_links DROP CONSTRAINT document_receipt_links_document_type_check;
ALTER TABLE public.document_receipt_links ADD CONSTRAINT document_receipt_links_document_type_check
  CHECK (document_type IN ('cheque', 'quotation', 'invoice', 'delivery_report', 'repair_ticket'));

COMMIT;
