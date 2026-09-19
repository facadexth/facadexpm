-- supabase/migrations/2026-09-19-01-line-integration.sql
--
-- LINE crew comms + office reminders -- spec:
-- docs/superpowers/specs/2026-09-19-line-notifications-design.md
--
-- line_settings is a real table (not app_settings) specifically because
-- the inbound webhook has to find "which tenant does this LINE channel
-- belong to" from an unauthenticated request in one indexed lookup --
-- a generic key/value store can't do that without scanning every
-- tenant's blob. Everything else this feature needs that's just a
-- per-tenant preference (not looked up from a webhook) lives in the
-- existing app_settings table instead -- see Task 6.

CREATE TABLE line_settings (
  tenant_id             UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id            TEXT NOT NULL,
  channel_access_token  TEXT NOT NULL,
  channel_secret        TEXT NOT NULL,
  crew_group_id         TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_line_settings_channel_id ON line_settings(channel_id);

ALTER TABLE line_settings ENABLE ROW LEVEL SECURITY;
-- OWNER-only, both ways -- this table holds a channel secret + access
-- token, same sensitivity tier as this app's other credential-holding
-- settings (bank accounts, e-sign config).
CREATE POLICY owner_reads ON line_settings FOR SELECT TO authenticated
  USING (is_owner() AND tenant_id = current_tenant_id());
CREATE POLICY owner_writes ON line_settings FOR ALL TO authenticated
  USING (is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

-- Track A: "งานมีปัญหา" structured capture (not a full Knowledge
-- Management system yet -- see spec's Out of Scope).
CREATE TABLE line_issue_reports (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID NOT NULL,
  site_id     UUID REFERENCES sites(id),
  worker_id   UUID REFERENCES workers(id),
  message     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_line_issue_reports_tenant_id ON line_issue_reports(tenant_id);

ALTER TABLE line_issue_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_reads ON line_issue_reports FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id());
CREATE POLICY admin_updates ON line_issue_reports FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
-- No admin_inserts: these rows are only ever created by line-webhook
-- using the service-role key, never directly by a client.

-- Bootstrap for Track A: the first time an unrecognized LINE user posts
-- in the crew group, line-webhook records them here instead of
-- silently dropping the message, so an admin has something to resolve
-- (Task 7) rather than a worker's first message just vanishing.
CREATE TABLE line_unlinked_senders (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id         UUID NOT NULL,
  line_user_id      TEXT NOT NULL,
  display_name      TEXT,
  first_seen_at     TIMESTAMPTZ DEFAULT NOW(),
  linked_worker_id  UUID REFERENCES workers(id)
);
CREATE UNIQUE INDEX idx_line_unlinked_senders_tenant_user ON line_unlinked_senders(tenant_id, line_user_id);

ALTER TABLE line_unlinked_senders ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_reads ON line_unlinked_senders FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id());
CREATE POLICY admin_updates ON line_unlinked_senders FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_deletes ON line_unlinked_senders FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

-- Track A: map a worker to their own LINE account, so an inbound
-- message's sender can be resolved to a real workers row.
ALTER TABLE workers ADD COLUMN line_user_id TEXT;
CREATE UNIQUE INDEX idx_workers_line_user_id ON workers(line_user_id) WHERE line_user_id IS NOT NULL;

-- Track B: individual OWNER/ADMIN LINE linking, via a one-time code
-- (see Task 6) rather than a full OAuth flow -- line_link_code is
-- generated and shown once in that user's own Settings, consumed by
-- line-webhook the moment they DM it to the tenant's LINE OA.
ALTER TABLE user_roles ADD COLUMN line_user_id TEXT;
ALTER TABLE user_roles ADD COLUMN line_link_code TEXT;
CREATE UNIQUE INDEX idx_user_roles_line_user_id ON user_roles(line_user_id) WHERE line_user_id IS NOT NULL;
CREATE UNIQUE INDEX idx_user_roles_line_link_code ON user_roles(line_link_code) WHERE line_link_code IS NOT NULL;

-- Track B: per-quotation follow-up, set at send time (Task 5) --
-- created_by/sent_at didn't exist before this (confirmed live: only
-- created_at existed) and are both needed so the daily scan (Task 4)
-- has a real anchor date and a real recipient.
ALTER TABLE quotations ADD COLUMN created_by TEXT;
ALTER TABLE quotations ADD COLUMN sent_at TIMESTAMPTZ;
ALTER TABLE quotations ADD COLUMN follow_up_after_days INT;
ALTER TABLE quotations ADD COLUMN follow_up_sent_at TIMESTAMPTZ;

-- Track B: cheque reminders can't target an individual creator without
-- this -- cheques had no creator-tracking column at all (confirmed
-- live), same gap quotations had.
ALTER TABLE cheques ADD COLUMN created_by TEXT;
