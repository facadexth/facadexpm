-- Widens line_pending_actions.action to allow 'site_photo' -- the
-- two-step รูปภาพหน้างาน flow (tap/type -> ask for a photo -> next DM
-- must be an image) added alongside the original three actions.
ALTER TABLE line_pending_actions DROP CONSTRAINT line_pending_actions_action_check;
ALTER TABLE line_pending_actions ADD CONSTRAINT line_pending_actions_action_check
  CHECK (action = ANY (ARRAY['issue_report'::text, 'material_request'::text, 'leave'::text, 'site_photo'::text]));
