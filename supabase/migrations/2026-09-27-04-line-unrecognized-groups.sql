-- supabase/migrations/2026-09-27-04-line-unrecognized-groups.sql
-- Closes a real gap found live: CommunicationCenter.jsx's "Crew Group
-- ID" field has always had the placeholder "จับได้จากข้อความจริงในกลุ่ม"
-- (captured from a real message in the group) implying the app already
-- surfaces a new group's ID somewhere -- it never did. line-webhook
-- silently `continue`s on any message from a group that isn't already
-- the configured crew_group_id, so switching to a new/different group
-- chat had no in-app way to discover that group's ID at all.
--
-- Same shape as line_unlinked_senders (2026-09-19-01-line-integration.sql)
-- but for GROUPS instead of individual DMs: every message from an
-- unrecognized group gets upserted here (sample_text/sample_sender kept
-- fresh on every new message, so the admin can tell which real-world
-- group chat this row corresponds to), and an admin can promote one
-- straight to crew_group_id from the Communication Center UI.
CREATE TABLE line_unrecognized_groups (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id      UUID NOT NULL,
  group_id       TEXT NOT NULL,
  sample_text    TEXT,
  sample_sender  TEXT,
  first_seen_at  TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_line_unrecognized_groups_tenant_group ON line_unrecognized_groups(tenant_id, group_id);

ALTER TABLE line_unrecognized_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_reads ON line_unrecognized_groups FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id());
CREATE POLICY admin_deletes ON line_unrecognized_groups FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
