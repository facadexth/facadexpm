-- supabase/migrations/2026-09-19-07-line-pending-actions.sql
--
-- Tracks a crew member's in-progress two-step Rich Menu action (tap a
-- button -> we ask for detail -> their next DM is the detail). One row
-- per worker at a time (a second tap before finishing the first just
-- overwrites it, upsert-style) with a short expiry so a stray unrelated
-- DM days later can never get misread as an old action's detail.

CREATE TABLE line_pending_actions (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID NOT NULL,
  worker_id   UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  action      TEXT NOT NULL CHECK (action IN ('issue_report','material_request','leave')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX idx_line_pending_actions_worker ON line_pending_actions(worker_id);

ALTER TABLE line_pending_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_reads ON line_pending_actions FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id());
-- No client insert/update/delete policy -- only ever written by
-- line-webhook via its service-role client, same as line_issue_reports.

-- This tenant's real LINE OA is ALSO used for sales/customer info (user
-- confirmed live) -- the crew Rich Menu must NOT become this bot's
-- default menu for every friend, or real customers would see "แจ้ง
-- ปัญหา/ขอเบิกของ/ขอลา" buttons. LINE supports linking a Rich Menu to a
-- SPECIFIC user id instead of setting a bot-wide default -- this column
-- holds the one crew menu's id (set once, in Step 6) so the webhook can
-- link it to individual workers as they're recognized, rather than
-- ever calling the "set as default for all users" endpoint.
ALTER TABLE line_settings ADD COLUMN crew_rich_menu_id TEXT;

-- Tracks whether a given worker has already had the crew Rich Menu
-- linked to their personal LINE account, so the webhook doesn't
-- re-call LINE's per-user-link API on every single message (idempotent
-- either way, but no reason to pay the extra HTTP round-trip
-- repeatedly).
ALTER TABLE workers ADD COLUMN line_rich_menu_linked_at TIMESTAMPTZ;
