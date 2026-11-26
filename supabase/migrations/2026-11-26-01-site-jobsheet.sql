-- 2026-11-26-01: crew daily job sheet (ใบงานประจำวัน, CRM G) — schema only.
-- 1) line_deep_link_tokens: new action_type 'site_jobsheet' (a crew member's link to one site's job sheet for
--    today). The site is carried in the existing site_id column (2026-10-20-03); a new CHECK makes a
--    site_jobsheet token always carry it. Other token kinds keep site_id optional (check-in/out use it, others
--    don't), so the CHECK is one-way. All 8 live action types are kept (live constraint name
--    line_deep_link_tokens_action_type_check, last redefined in 2026-11-25-03-repair-workorder.sql).
--    line_deep_link_tokens_repair_ticket_check (2026-11-25-03) already forces repair_ticket_id NULL on a
--    site_jobsheet token; nothing here conflicts with it.
-- 2) sites.safety_note: per-site safety text shown on the job sheet (fallback: tenant setting
--    site_safety_note_default, then the built-in default). At most 500 characters.
-- DROP CONSTRAINT has no IF EXISTS on purpose: a missing name means live drifted from this file — stop.
-- No view selects line_deep_link_tokens.* or sites.* (grep of supabase/ 2026-11-26; the only x.* views are
-- expenses_view e.*), so no view to recreate.

BEGIN;

-- ---------------------------------------------------------------- line_deep_link_tokens
ALTER TABLE public.line_deep_link_tokens DROP CONSTRAINT line_deep_link_tokens_action_type_check;
ALTER TABLE public.line_deep_link_tokens ADD CONSTRAINT line_deep_link_tokens_action_type_check
  CHECK (action_type = ANY (ARRAY['material_request','leave','check_in','check_out','advance','payslip','time_clock',
                                  'repair_workorder','site_jobsheet']));

ALTER TABLE public.line_deep_link_tokens ADD CONSTRAINT line_deep_link_tokens_site_jobsheet_check
  CHECK (action_type <> 'site_jobsheet' OR site_id IS NOT NULL);

-- ---------------------------------------------------------------- sites.safety_note
ALTER TABLE public.sites ADD COLUMN safety_note text NULL;
ALTER TABLE public.sites ADD CONSTRAINT sites_safety_note_length_check
  CHECK (char_length(safety_note) <= 500);

COMMIT;
